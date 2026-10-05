# On-chain settlement

`OpenRampSettlement` is a smart contract. It is the on-chain end point of a deposit session. The source is in [`contracts/`](https://github.com/yosriady/openrampkit/tree/main/contracts).

Use it when you want these results:

- The chain records each payment with its session id.
- The server verifies a payment by the session id. It does not trust a transaction hash from the browser.
- The payment and a contract call (for example a vault deposit) occur in one transaction.
- The user cannot send the funds to a different address.

## How it works

1. Your backend creates a session with `destination.settlement`.
2. The user pays from a wallet. The wallet sends two transactions: `approve` on the token, then `settle` on the contract.
3. The contract pulls the amount from the wallet.
4. The contract sends the amount to the recipient. Or, it runs the destination calls with the amount.
5. The contract stores a receipt for the session id and emits `Settled`.
6. The server reads the receipt and the `Settled` log. When they agree with the quote, the leg is complete.

Each session id settles one time only. A second `settle` for the same session id reverts.

## Create a session

```ts
const session = await openramp.sessions.create({
  userId: 'user_123',
  destination: {
    type: 'crypto',
    chain: 'eip155:421614', // Arbitrum Sepolia
    token: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', // USDC
    address: '0xRecipient...',
    settlement: { contract: '0xYourSettlementContract...' },
  },
})
```

Rules:

- The destination chain must be an EVM chain.
- The token must be an ERC-20 token. Native tokens are not supported.
- `address` is the recipient. It gets the funds, or the calls act for it.

## Destination calls

Add `calls` to run contract calls after the payment. `calls` needs `settlement`. The server rejects `calls` without it.

This example deposits the payment into an ERC-4626 vault for the recipient:

```ts
destination: {
  type: 'crypto',
  chain: 'eip155:421614',
  token: TOKEN, // the ERC-20 token address
  address: recipient,
  settlement: { contract: SETTLEMENT },
  calls: [{ to: VAULT, data: encodeFunctionData({ abi: erc4626Abi, functionName: 'deposit', args: [amount, recipient] }) }],
}
```

For each call, the contract does these steps:

1. It gives the call target an allowance of the settled amount.
2. It calls the target.
3. It sets the allowance back to zero.

After the calls, the contract sends the unused part of the amount to the recipient.

Safety rules in the contract:

- The owner must put each call target on the allowlist (`setAllowedTarget`).
- A call cannot target the token or the contract itself.
- The token balance of the contract cannot go below its balance before the settlement. So a call cannot spend funds of other users.
- `value` must be absent. The calls cannot send native value.

## Which methods can settle

The planner offers only pathways whose last leg can pay into the contract. The leg declares the `settlement` capability.

Today these legs have this capability:

- The Relay `wallet` leg. It works when the user pays with the destination token on the destination chain. For other tokens or chains, the quote fails with a clear message.
- The `localChain` leg of `@openrampkit/adapter-mock`. It is for tests and demos only. It pays one token on one chain, for example a testnet or a local Anvil chain. It reads the chain over JSON-RPC and calls no other API.

## Try it in the playground

The [playground](../guide/playground.md#testnet-mode-real-wallet) has a testnet mode. Your browser wallet pays a session on Arbitrum Sepolia, Robinhood Chain Testnet or Tempo Testnet. It uses test tokens with no value.

1. Open the playground. Set **Mode** to **Testnet (real wallet)**.
2. Select the network and connect your wallet. Mint the free test token. You can also use Circle test USDC from the [Circle faucet](https://faucet.circle.com/) on Arbitrum Sepolia, or AlphaUSD from the [Tempo faucet](https://docs.tempo.xyz/quickstart/faucet) on Tempo Testnet.
3. Pay with **Pay with wallet**. Your wallet sends `approve` and `settle`.
4. The server checks the session with `verifySettlement`. The page links to the transaction on the explorers of the network (for example Arbiscan and Blockscout on Arbitrum Sepolia).

Select **Deposit into vault** to run a destination call. The contract deposits the test token into the test ERC-4626 vault, in the same transaction.

The page is static. The server runs in the browser tab, with the mock adapter's `localChain` leg:

```ts
mockAdapter({
  settleMs: 0,
  methods: ['wallet'],
  localChain: { chain: 'eip155:421614', rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc', token: TOKEN, symbol: 'tUSDC', decimals: 6 },
})
```

To run the same path from Node with a testnet key, use `pnpm testnet:settle` ([`scripts/testnet-settle.mjs`](https://github.com/yosriady/openrampkit/blob/main/scripts/testnet-settle.mjs)). It pays 5 Circle test USDC on Arbitrum Sepolia for a new session id. It prints the transaction and the result of `verifySettlement`. `NETWORK=tempo-testnet pnpm testnet:settle` pays 5 AlphaUSD on Tempo Testnet. The script reads `DEPLOYER_PRIVATE_KEY` from the environment or from `contracts/.env`. It never prints the key.

## Signed intents

The owner can set an intent signer (`setIntentSigner`). Then every settlement needs an EIP-712 signature from that signer. The signature binds these values:

| Field | Meaning |
|---|---|
| `sessionId` | The session id |
| `payer` | The only wallet that can use the intent. Zero means any caller. |
| `token` | The token |
| `recipient` | The recipient |
| `minAmount` | The lowest amount that the server accepts |
| `calls` | The call bundle |
| `deadline` | The time after which the intent is not valid |

A payer cannot change the recipient, the token or the calls. The contract checks the signature with `SignatureChecker`, so the signer can be an EOA or an ERC-1271 contract wallet.

To sign intents, give the Relay adapter a signing hook:

```ts
relay({
  signSettlementIntent: (typedData) => account.signTypedData(typedData), // viem account, or your KMS
})
```

We recommend a signer in production. Without a signer, any wallet can settle a session id first, with a different recipient. The server then marks the session as failed, because the receipt does not agree with the quote.

## Funds from a bridge or solver

`settleFromBalance` settles with tokens that are already in the contract. A bridge or solver can fill the contract and call it in the same transaction. This function always needs a signed intent. A front-runner can only complete the settlement as the server signed it.

## Verify a settlement

The server does this for you. You can also call the helper from your backend:

```ts
import { verifySettlement } from '@openrampkit/adapter'

const r = await verifySettlement({
  rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
  contract: SETTLEMENT,
  sessionId: session.id,
  expect: { token: TOKEN, recipient, minAmount: 25_000_000n },
})
if (r.settled && r.ok) {
  // r.record has payer, amount, txHash, blockNumber, callsHash
}
```

The helper uses plain JSON-RPC (`eth_call` and `eth_getLogs`). It has no dependencies. Give `fromBlock` when your RPC limits the block range of `eth_getLogs`.

The package also exports these helpers:

| Export | Use |
|---|---|
| `OPEN_RAMP_SETTLEMENT_ABI` | The contract ABI, for viem or ethers |
| `buildSettlementTxs()` | The `approve` and `settle` transactions |
| `encodeSettle()` | The `settle` calldata |
| `settlementIntentTypedData()` | The EIP-712 typed data to sign |
| `hashSettlementCalls()` | The calls hash, equal to the contract `hashCalls` |
| `sessionIdToBytes32()` | The session id as `bytes32` (UTF-8, padded with zeros) |

## Owner controls

| Function | Effect |
|---|---|
| `setIntentSigner(address)` | Sets the intent signer. Zero turns intents off. |
| `setAllowedTarget(address, bool)` | Adds or removes a call target |
| `pause()` and `unpause()` | Stops or starts new settlements |
| `sweep(token, to, amount)` | Recovers tokens that a user sent to the contract by mistake |

The contract has no upgrade path. Ownership moves in two steps (`transferOwnership`, then `acceptOwnership`). The owner cannot renounce ownership, so the contract always has an owner that can pause it. Use a multisig as the owner in production.

## Networks

| Network | Chain id | OpenRampSettlement | USDC |
|---|---|---|---|
| Arbitrum Sepolia | 421614 | [`0xBF66696115128B8f9f794780061348b4213A7132`](https://arbitrum-sepolia.blockscout.com/address/0xBF66696115128B8f9f794780061348b4213A7132) | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` (Circle) |
| Robinhood Chain Testnet | 46630 | [`0xBF66696115128B8f9f794780061348b4213A7132`](https://explorer.testnet.chain.robinhood.com/address/0xBF66696115128B8f9f794780061348b4213A7132) | Not published yet |
| Tempo Testnet (Moderato) | 42431 | [`0xBF66696115128B8f9f794780061348b4213A7132`](https://explore.testnet.tempo.xyz/address/0xBF66696115128B8f9f794780061348b4213A7132) | No Circle USDC. Test stablecoins from the faucet: AlphaUSD `0x20c0000000000000000000000000000000000001`, pathUSD `0x20c0000000000000000000000000000000000000` (TIP-20) |
| Arbitrum One | 42161 | Not deployed yet | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` (Circle) |

The testnet contracts have verified source code. Their owner is a testnet key, and they have no intent signer. Demo settlements, and a settlement through the TypeScript client, are listed in [`contracts/deployments.md`](https://github.com/yosriady/openrampkit/blob/main/contracts/deployments.md).

On every testnet above, a test token with an open mint (no value) is at `0x9A38C55160186C3E1e770e193fA96997e60ed425`. A test ERC-4626 vault for it is at `0xA83fE1B79cEd7772f5d90D19833b2fDD844c7801`. The vault is an allowed call target on each contract.

Tempo has no gas token. Tempo takes the fee in pathUSD when a transaction names no fee token, so standard EIP-1559 transactions from `forge` or a browser wallet work. The payer needs some pathUSD. The Tempo faucet sends it without a sign-in: `cast rpc tempo_fundAddress <address> --rpc-url https://rpc.moderato.tempo.xyz`. A TIP-20 stablecoin settles like any ERC-20: `approve`, then `settle`.

To deploy the contract, read [`contracts/README.md`](https://github.com/yosriady/openrampkit/tree/main/contracts#deploy).
