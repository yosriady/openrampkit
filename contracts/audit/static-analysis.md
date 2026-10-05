# Static analysis

This page records the static analysis of `src/OpenRampSettlement.sol`. Every finding has a status and a reason. The raw tool outputs are in this folder.

Result: no high or medium findings. No finding is a real issue, so the contract source did not change. The bytecode on `main` is the same as the bytecode deployed on Arbitrum Sepolia and Robinhood Chain Testnet.

> **Update (settleFromBalance amount fix):** The contract source changed after this record. `settleFromBalance` now needs a `BalanceSettlementIntent` that binds the exact amount (see the README "Security model"). The line numbers and the raw tool outputs below refer to the previous source, which is the deployed testnet bytecode. On the new source, Slither 0.11.6 with `slither.config.json` (the CI configuration) reports 0 results. Coverage is still 100% of lines and branches ([coverage.md](coverage.md)). Run Aderyn and `forge lint` again before the external audit.

## Tools

| Tool | Version | Raw output |
|---|---|---|
| Slither | 0.11.6 (solc 0.8.28 through solc-select, forge 1.8.3) | [slither.txt](slither.txt) |
| Aderyn | 0.6.8 | [aderyn-report.md](aderyn-report.md) |
| `forge lint` | forge 1.8.3 | [forge-lint.txt](forge-lint.txt) |

## Commands

Run all commands from `contracts/`.

```sh
# Slither
pip install slither-analyzer==0.11.6 solc-select==1.2.0
solc-select install 0.8.28
solc-select use 0.8.28
slither .                      # uses slither.config.json, fails on medium or high

# Aderyn
npx @cyfrin/aderyn@0.6.8 . -o audit/aderyn-report.md

# forge lint
forge lint src
```

`slither.txt` has two runs. Run 1 uses all detectors with no exclusions. Run 2 uses `slither.config.json`, which is the configuration that CI uses.

## Slither configuration

[`slither.config.json`](../slither.config.json):

| Key | Value | Reason |
|---|---|---|
| `filter_paths` | `lib/,test/,script/` | Analyze the contract only. OpenZeppelin, forge-std, tests and scripts are out of scope. |
| `exclude_dependencies` | `true` | Same reason. |
| `detectors_to_exclude` | `calls-loop,timestamp,low-level-calls` | Each one is reviewed below (S-1, S-2, S-3). They are part of the design. |
| `fail_on` | `medium` | CI fails on any medium or high finding that is not excluded. |

Slither cannot generate its IR for three functions that the contract inherits from OpenZeppelin `EIP712` (`constructor`, `_EIP712Name`, `_EIP712Version`). These functions use the OpenZeppelin `ShortStrings` type. This is a limitation of the Slither parser. It affects library code only. Slither analyzes all functions in `OpenRampSettlement.sol` normally. The EIP-712 digest is tested against a manual EIP-712 computation (`test_intentDigest_matchesManualEip712`) and against the TypeScript helpers (`packages/adapter`).

## Findings

Severity is the severity that the tool reports. Line numbers refer to `src/OpenRampSettlement.sol`.

### Slither

| Id | Severity | Detector | Location | Status | Rationale |
|---|---|---|---|---|---|
| S-1 | Low | `calls-loop` | `_deliver`, L325 | Not an issue (excluded) | The loop runs the call bundle. This is the purpose of the function. Each target must be on the owner allowlist, and it can not be the token or the contract. When `intentSigner` is set, the server signs the full bundle. If one call fails, the full settlement reverts with `CallFailed(index, reason)`. This is intended: a settlement is atomic. A failed call affects only the transaction of that payer. No funds of other users are at risk. Tests: `test_settle_bubblesCallFailure`, `test_settle_rejectsTargetNotAllowed`. |
| S-2 | Low | `timestamp` | `_checkAndRecord`, L290 | Not an issue (excluded) | `block.timestamp` is compared with the intent deadline only. A sequencer or validator can move the timestamp by a few seconds. Intent deadlines are minutes long. A small change can only make an intent valid a few seconds longer or shorter. It can not change where the funds go. Test: `test_intent_expired`. |
| S-3 | Informational | `low-level-calls` | `_deliver`, L325 | Not an issue (excluded) | A call bundle must call arbitrary allowlisted contracts with arbitrary calldata, so a low-level `call` is necessary. The return value is checked. A failure reverts with the revert data. The balance check after the bundle makes sure that the contract balance does not drop below its balance before the settlement. Tests: `test_settle_callBundleCannotSpendStrayFunds`, `test_settle_callBundleCannotExceedAllowance`, `invariant_holdsOnlyStrayFunds`. |

### Aderyn

| Id | Severity | Detector | Location | Status | Rationale |
|---|---|---|---|---|---|
| A-1 | Low | Centralization risk | `onlyOwner` functions | Accepted (documented) | The owner can pause, set the intent signer, change the allowlist and sweep stray tokens. These powers are necessary to operate the contract and to stop it in an incident. The owner can not pull funds from users: the contract pulls funds only from `msg.sender` (`test_settle_pullsOnlyFromCaller`). The contract holds no funds between settlements (`invariant_holdsOnlyStrayFunds`). Ownership uses `Ownable2Step`, and renounce is disabled. The README section "Security model" lists the trust in the owner. Use a multisig as owner in production. |
| A-2 | Low | PUSH0 opcode | L2 pragma | Not an issue | `foundry.toml` pins `evm_version = "cancun"`. The contract needs Cancun anyway for transient storage (`ReentrancyGuardTransient`). Arbitrum Sepolia and Robinhood Chain Testnet (an Arbitrum Orbit chain) support these opcodes. The contract is deployed and works on both chains. |
| A-3 | Low | Loop contains `require`/`revert` | `_deliver`, L318 | Not an issue | Same as S-1. A partial settlement would be worse than a revert. The settlement must apply in full or not at all. |
| A-4 | Low | Address state variable set without checks | `_setIntentSigner`, L349 | Not an issue | Zero is a valid value. It turns intents off, as documented in NatSpec and in the README. Only the owner can call `setIntentSigner`. Each change emits `IntentSignerUpdated`. With a zero signer, `settleFromBalance` reverts with `IntentRequired`. Tests: `test_settleFromBalance_requiresSigner`, `test_setIntentSigner_emits`. |
| A-5 | Low | Uninitialized local variable | L160, L318 | Not an issue | These are loop counters (`uint256 i;`). Solidity sets them to zero. This is a style point only. |
| A-6 | Low | Unspecific Solidity pragma | L2 | Not an issue | The build pins solc 0.8.28 in `foundry.toml`. The deployed bytecode was built with 0.8.28. The range `^0.8.24` lets other projects import the file. 0.8.24 is the lowest version with transient storage. |
| A-7 | Low | Public function not used internally | `intentDigest`, L230 | Not an issue | `public` and `external` give the same ABI. A change to `external` gives a small gas saving on an off-chain view only. It would also change the bytecode, so `main` would differ from the verified deployment. There is no security effect. |

### forge lint

| Id | Severity | Detector | Location | Status | Rationale |
|---|---|---|---|---|---|
| F-1 | Warning | `require-revert-in-loop` | L322, L326, L353 | Not an issue | L322 and L326: same as S-1 and A-3. L353: the constructor reverts when an initial target is not a contract. A deploy with a bad target must fail. Test: `test_constructor_rejectsEoaTarget`. |
| F-2 | Warning | `reentrancy-events` | L181, L199 | Not an issue | `settle` and `settleFromBalance` are `nonReentrant`, so a call target can not enter them again in the same call. The receipt is written before any external call (checks, effects, interactions). `Settled` is emitted last on purpose: it shows a delivery that is complete. If any step fails, the transaction reverts and no event stays. Test: `test_settle_reentrancyBlocked`. |
| F-3 | Warning | `incorrect-strict-equality` | L178 | Not an issue | The strict equality is the fee-on-transfer check. The contract must receive exactly `amount`. A token that delivers more or less is rejected with `UnsupportedToken`. An outside party can only make the settlement of that token revert. It can not take funds. Test: `test_settle_rejectsFeeOnTransferToken`. |
| F-4 | Warning | `block-timestamp` | L290 | Not an issue | Same as S-2. |
| F-5 | Warning | `unsafe-typecast` | L303 | Not an issue | `uint64(block.timestamp)` truncates only after about 584 billion years. |
| F-6 | Warning | `calls-loop` | L325 | Not an issue | Same as S-1. |

## Summary

| Tool | High | Medium | Low | Informational or warning | Real issues |
|---|---|---|---|---|---|
| Slither | 0 | 0 | 2 | 1 | 0 |
| Aderyn | 0 | 0 | 7 | 0 | 0 |
| forge lint | 0 | 0 | 0 | 9 instances (6 detectors) | 0 |

This review added one regression test for a security property: `test_settle_pullsOnlyFromCaller`. It shows that a standing approval to the contract can not be used by another caller.

Static analysis does not replace a manual audit. The contract has no external audit yet.
