# OpenRampSettlement runbook

This runbook tells the owner how to operate `OpenRampSettlement`. Read it before a mainnet deploy. Keep it near the people who hold the owner keys.

All commands use `cast` (Foundry). Set these values first:

```sh
export SETTLEMENT=0xYourSettlementContract
export RPC_URL=https://your-rpc
```

When the owner is a Safe multisig (recommended), do not send the transaction with `cast send`. Use `cast calldata` to make the data. Then make a Safe transaction to `$SETTLEMENT` with value 0 and that data, in the Safe app or the Safe Transaction Builder. Get the necessary signatures, then execute it.

## Roles

| Role | Who | Power |
|---|---|---|
| Owner | A Safe multisig in production | Pause, unpause, set the intent signer, change the allowlist, sweep, transfer ownership |
| Intent signer | The OpenRampKit server key (KMS or HSM in production) | Signs `SettlementIntent` and `BalanceSettlementIntent`. It decides which recipient, token, amount and calls are valid. |
| Monitor | Your on-call team | Watches `Settled`, `IntentSignerUpdated`, `AllowedTargetUpdated`, `Paused`, `Unpaused`, `Swept` and `OwnershipTransferStarted` |

The owner cannot renounce ownership. The contract always has an owner that can pause it.

## Before a mainnet deploy

1. Make sure that the chain supports EIP-1153 (transient storage, Cancun). The contract uses `ReentrancyGuardTransient`. On a chain without it, every settlement reverts.
2. Set `SETTLEMENT_INTENT_SIGNER`. The deploy script stops on a chain that is not a known testnet when it is not set (`IntentSignerRequired`).
3. Set `SETTLEMENT_OWNER` to the Safe address. If you deploy with the deployer as owner, transfer ownership to the Safe immediately (see [Transfer ownership to a Safe](#transfer-ownership-to-a-safe)).
4. Set `SETTLEMENT_ALLOWED_TARGETS` to the reviewed call targets only.
5. After the deploy, read the state and compare it with the plan:

```sh
cast call $SETTLEMENT 'owner()(address)' --rpc-url $RPC_URL
cast call $SETTLEMENT 'intentSigner()(address)' --rpc-url $RPC_URL
cast call $SETTLEMENT 'isAllowedTarget(address)(bool)' 0xVault --rpc-url $RPC_URL
cast call $SETTLEMENT 'paused()(bool)' --rpc-url $RPC_URL
```

## Pause

Pause stops `settle` and `settleFromBalance`. Views, `sweep` and owner functions continue to work.

```sh
cast calldata 'pause()'
# EOA owner only (testnets):
cast send $SETTLEMENT 'pause()' --rpc-url $RPC_URL --private-key $OWNER_KEY
```

Check: `cast call $SETTLEMENT 'paused()(bool)' --rpc-url $RPC_URL` returns `true`.

While the contract is paused, wallets that try to settle get a revert (`EnforcedPause`). The server does not mark those sessions as complete. Tell support that deposits are on hold.

## Unpause

Unpause only after you know the cause of the incident and you fixed it.

```sh
cast calldata 'unpause()'
```

Check: `paused()` returns `false`. Then do one small settlement on the contract and verify it with `verifySettlement`.

## Rotate the intent signer

Do this on a schedule, and immediately when you think that the signer key is exposed.

1. Make the new key in your KMS or HSM. Do not export it.
2. Deploy the server with the new signer, but keep the old signer active in the contract for now.
3. Set the new signer in the contract:

   ```sh
   cast calldata 'setIntentSigner(address)' 0xNewSigner
   ```

4. Check: `intentSigner()` returns the new address, and an `IntentSignerUpdated` event shows the old and new address.
5. Intents that the old key signed are not valid after this step. Wallets that hold an old intent get `InvalidSignature`. They must request a new quote.
6. Disable the old key in the KMS.

If the key is exposed: pause first, then rotate, then unpause. A stolen key can sign intents for any recipient until the rotation.

Never set the signer to zero on a mainnet. Zero turns intents off. Then `settle` is open to any payer and anyone can settle a session id first, and `settleFromBalance` reverts.

## Change the call target allowlist

Add a target only after a review of its code. A target gets an allowance of the settled amount for each call.

```sh
cast calldata 'setAllowedTarget(address,bool)' 0xVault true    # add
cast calldata 'setAllowedTarget(address,bool)' 0xVault false   # remove
```

Rules:

- The contract rejects a target that has no code (`NotAContract`).
- Remove a target immediately when it is upgraded, paused or compromised. Settlements that use it then revert with `TargetNotAllowed`.
- Check: `isAllowedTarget(address)` and the `AllowedTargetUpdated` event.

## Sweep stray tokens

In the normal flow, the contract holds no tokens between transactions. Tokens can stay in the contract when a user sends them by mistake, or when a bridge fill waits for `settleFromBalance`.

Before a sweep, make sure that no pending `settleFromBalance` needs those tokens. Compare the balance with the fills that the server expects and did not settle.

```sh
cast call 0xToken 'balanceOf(address)(uint256)' $SETTLEMENT --rpc-url $RPC_URL
cast calldata 'sweep(address,address,uint256)' 0xToken 0xTo 1000000
```

## Transfer ownership to a Safe

Ownership moves in two steps (`Ownable2Step`). The old owner stays in control until the Safe accepts.

1. Make the Safe. Use at least 2 of 3 signers on separate devices.
2. From the current owner, start the transfer:

   ```sh
   cast send $SETTLEMENT 'transferOwnership(address)' 0xSafe --rpc-url $RPC_URL --private-key $OWNER_KEY
   ```

3. Check: `pendingOwner()` returns the Safe.
4. From the Safe, execute a transaction to `$SETTLEMENT` with this data:

   ```sh
   cast calldata 'acceptOwnership()'
   ```

5. Check: `owner()` returns the Safe and `pendingOwner()` returns zero.
6. Do one owner action from the Safe (for example `pause()` then `unpause()` on a testnet) to prove that the Safe can operate the contract.

To change a transfer before it is accepted, call `transferOwnership` again with the correct address. To cancel it, call `transferOwnership` with the zero address.

## Incident steps

1. **Detect.** An alert fires, for example a `Settled` event that does not agree with a quote, an unexpected `IntentSignerUpdated` or `AllowedTargetUpdated`, a balance in the contract with no pending fill, or a report from a user.
2. **Pause.** Pause the contract first. Do not wait for the full analysis. Pause is safe: it does not move funds.
3. **Contain.**
   - Exposed signer key: rotate the signer (see above).
   - Bad call target: remove it from the allowlist.
   - Exposed owner key: from the other Safe signers, remove the signer from the Safe. With an EOA owner, transfer ownership to a Safe at once.
4. **Find the scope.** List all `Settled` events since the last known good block. Compare each with the server sessions (token, recipient, amount, `callsHash`). Read the token balance of the contract.
5. **Recover.** Sweep stray funds to a safe address only after step 4. The contract cannot reverse a settlement that completed.
6. **Communicate.** Tell the affected integrators which session ids are affected, what you know, and when you will send the next update. Do not publish a fix for an open bug before the contract is paused.
7. **Resume.** Unpause only after the fix. Do one small settlement and verify it.
8. **Review.** Write a short report: timeline, cause, impact, and the changes to the code, the monitoring and this runbook.

A bug in the contract code cannot be fixed in place. The contract has no upgrade path. Deploy a fixed contract, move the server to the new address, and keep the old contract paused.
