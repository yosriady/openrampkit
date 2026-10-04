# OpenRampKit contracts

[![CI](https://github.com/yosriady/openrampkit/actions/workflows/ci.yml/badge.svg)](https://github.com/yosriady/openrampkit/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/forge_tests-47_passing-brightgreen)](test/OpenRampSettlement.t.sol)
[![Invariants](https://img.shields.io/badge/invariants-3_passing-brightgreen)](test/OpenRampSettlement.invariant.t.sol)
[![Coverage](https://img.shields.io/badge/coverage-100%25_lines_and_branches-brightgreen)](audit/coverage.md)
[![Slither](https://img.shields.io/badge/Slither-0_high_%2F_0_medium-brightgreen)](audit/static-analysis.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](../LICENSE)
[![Arbitrum Sepolia](https://img.shields.io/badge/deployed-Arbitrum_Sepolia-28A0F0)](https://sepolia.arbiscan.io/address/0xBF66696115128B8f9f794780061348b4213A7132#code)
[![Robinhood Chain Testnet](https://img.shields.io/badge/deployed-Robinhood_Chain_Testnet-CCFF00)](https://explorer.testnet.chain.robinhood.com/address/0xBF66696115128B8f9f794780061348b4213A7132?tab=contract)

`OpenRampSettlement` is the on-chain settlement point for OpenRampKit deposit sessions. A payer settles one session: the contract takes the amount, then pays the recipient or runs an allowlisted call bundle (for example an ERC-4626 deposit for the recipient), in one transaction. It records each session id one time only, so the server verifies a payment by reading one receipt and one `Settled` event.

Read the concept page: [docs/concepts/settlement.md](../docs/concepts/settlement.md).

## Deployments

Live on Arbitrum Sepolia and Robinhood Chain Testnet at `0xBF66696115128B8f9f794780061348b4213A7132`. See [deployments.md](deployments.md) for the explorer links and the demo settlements.

## Design

| Property | How |
|---|---|
| One settlement per session | `receiptOf(sessionId)` is written before any external call. A second settlement reverts with `AlreadySettled`. |
| No redirection of funds | Optional EIP-712 intent from the OpenRampKit server. It binds session id, payer, token, recipient, minimum amount, calls and deadline. EOA and ERC-1271 signers. |
| Safe call bundles | Owner allowlist of targets. The token and the contract itself are never targets. Allowance of the amount per call, reset to zero after. The balance of the contract must not drop below its balance before the settlement, so a bundle cannot spend other funds. Unused funds go to the recipient. |
| Atomic | Any failed call reverts the whole settlement (`CallFailed(index, reason)`). |
| Token checks | Fee-on-transfer and other tokens that deliver less than `amount` are rejected (`UnsupportedToken`). |
| Pre-funded flows | `settleFromBalance` for a bridge or solver that fills the contract. Always needs a signed intent. |
| Admin | `Ownable2Step`, `Pausable`, no renounce, no upgradeability. `sweep` recovers stray tokens only (the contract holds nothing between settlements). |
| Reentrancy | `ReentrancyGuardTransient` (EIP-1153, Cancun). |

Stack: Solidity 0.8.28, EVM `cancun`, OpenZeppelin Contracts 5.1 and forge-std (git submodules in `lib/`).

## Security model

### What the contract guarantees

| Guarantee | How | Tests |
|---|---|---|
| Each session settles once | The receipt for `sessionId` is written before any external call. A second settlement reverts with `AlreadySettled`. | `test_settle_replayReverts`, `test_settleFromBalance_replayReverts`, `testFuzz_settle_eachSessionOnce` |
| No redirection of funds when intents are on | The EIP-712 intent binds session id, payer (optional), token, recipient, minimum amount, call bundle and deadline. The domain binds the chain id and the contract address. | `test_intent_bindsRecipient`, `test_intent_bindsCalls`, `test_intent_bindsTokenAndSession`, `testFuzz_intent_onlyExactRecipientVerifies` |
| Funds come only from the caller | `settle` pulls from `msg.sender` only. A standing approval can not be used by another caller. | `test_settle_pullsOnlyFromCaller` |
| Allowlisted call targets only | A target must be on the owner allowlist. The token and the contract itself are never targets. | `test_settle_rejectsTargetNotAllowed`, `test_settle_rejectsTokenAsTarget`, `test_settle_rejectsSelfAsTarget` |
| Allowance reset | The contract approves `amount` to a target for one call and sets the allowance to zero after. | `test_settle_callBundleCannotExceedAllowance`, `invariant_noStandingAllowance` |
| A bundle can not spend other funds | After the bundle, the contract balance must not be below its balance before the settlement (`BalanceInvariant`). Unused funds go to the recipient. | `test_settle_callBundleCannotSpendStrayFunds`, `test_settle_leftoverGoesToRecipient`, `invariant_holdsOnlyStrayFunds`, `invariant_recipientGetsEverything` |
| Fee-on-transfer tokens rejected | The contract must receive exactly `amount`, or the settlement reverts with `UnsupportedToken`. | `test_settle_rejectsFeeOnTransferToken` |
| Reentrancy guard | `settle` and `settleFromBalance` use `ReentrancyGuardTransient`. | `test_settle_reentrancyBlocked` |
| Pause | The owner can stop all new settlements. | `test_settle_whenPausedReverts` |
| Safe ownership | `Ownable2Step`. Renounce is disabled, so the contract always has an owner that can pause it. | `test_ownership_twoStep`, `test_renounceOwnership_disabled` |
| No upgrade path | No proxy, no `delegatecall`, no self-destruct. The deployed code can not change. | |

### What the contract does not cover

- **Trust in the owner.** The owner can pause, change the allowlist, change or remove the intent signer, and sweep tokens that the contract holds outside a settlement. Use a multisig as owner in production.
- **Trust in the intent signer.** When intents are on, the server key decides which recipient, token and call bundle are valid. A stolen signer key can authorize bad settlements for payers who use them. When intents are off, any caller can settle any unused session id. The server must then check the receipt (payer, token, recipient, amount) before it accepts a deposit.
- **Token behavior.** The contract assumes standard ERC-20 behavior. Fee-on-transfer tokens are rejected, but rebasing tokens, pausable or blocklist tokens, and tokens with hooks are not supported. The owner and the server must choose the tokens and the call targets.
- **Testnet only.** The contract is deployed on Arbitrum Sepolia and Robinhood Chain Testnet only. It is not deployed on a mainnet.
- **No external audit yet.** The checks below are automated. They do not replace a manual audit.

## Verification

| Check | Result | Details |
|---|---|---|
| Static analysis (Slither, Aderyn, `forge lint`) | 0 high, 0 medium. Each low and informational finding is reviewed. | [audit/static-analysis.md](audit/static-analysis.md) |
| Test coverage | 100% lines, statements, branches and functions of `OpenRampSettlement.sol` | [audit/coverage.md](audit/coverage.md) |
| Invariant tests | 3 invariants with random settlements and stray donations | [test/OpenRampSettlement.invariant.t.sol](test/OpenRampSettlement.invariant.t.sol) |
| Fuzz tests | 4 properties, 1,024 runs locally, 4,096 in CI | [test/OpenRampSettlement.t.sol](test/OpenRampSettlement.t.sol) |
| CI | `forge fmt --check`, `forge build`, `forge test` and Slither on each push and pull request | [.github/workflows/ci.yml](../.github/workflows/ci.yml) |
| Source verification | Verified on Blockscout and Arbiscan (Arbitrum Sepolia), and on the Robinhood Chain Testnet explorer | [Arbiscan](https://sepolia.arbiscan.io/address/0xBF66696115128B8f9f794780061348b4213A7132#code), [Blockscout](https://arbitrum-sepolia.blockscout.com/address/0xBF66696115128B8f9f794780061348b4213A7132?tab=contract), [Robinhood Chain Testnet](https://explorer.testnet.chain.robinhood.com/address/0xBF66696115128B8f9f794780061348b4213A7132?tab=contract) |

Run the checks yourself from `contracts/`:

```sh
forge test                                  # unit, fuzz and invariant tests
forge coverage --no-match-coverage '(script|test)' --report summary
slither .                                   # uses slither.config.json
```

## Build and test

```sh
git submodule update --init --recursive   # once, after clone
cd contracts
forge fmt --check
forge build
forge test                                 # unit, fuzz and invariant tests
forge snapshot --no-match-test invariant   # updates .gas-snapshot
```

Gas (isolated, one call, cold storage):

| Path | Gas |
|---|---|
| `settle`, plain transfer | ~166k |
| `settle`, ERC-4626 deposit | ~236k |
| `settle`, signed intent and ERC-4626 deposit | ~246k |
| `settleFromBalance`, signed intent and ERC-4626 deposit | ~232k |

Gas report (`forge test --gas-report --no-match-test invariant`, forge 1.8.3, optimizer 10,000 runs). The minimum includes revert paths. Runtime size: 10,185 bytes (the limit is 24,576). Init code size: 11,878 bytes (`forge build --sizes`).

| Function | Min | Median | Max |
|---|---|---|---|
| `settle` | 26,575 | 168,988 | 301,558 |
| `settleFromBalance` | 28,741 | 134,728 | 256,605 |
| `setAllowedTarget` | 24,204 | 50,528 | 50,528 |
| `setIntentSigner` | 23,997 | 47,778 | 47,778 |
| `pause` | 23,493 | 35,164 | 46,836 |
| `unpause` | 23,515 | 26,625 | 29,735 |
| `sweep` | 24,447 | 24,672 | 59,406 |
| `transferOwnership` | 47,794 | 47,794 | 47,794 |
| `acceptOwnership` | 33,059 | 33,059 | 33,059 |
| `receiptOf` (view) | 9,332 | 9,332 | 9,332 |
| `isSettled` (view) | 2,509 | 2,509 | 2,509 |

`.gas-snapshot` holds the gas of each test. `forge snapshot --check --no-match-test invariant` compares a change with it.

The TypeScript helpers (`buildSettlementTxs`, `verifySettlement`, the ABI) are in `@openrampkit/adapter`. After an ABI change, run `node scripts/export-settlement-abi.mjs` from the repo root. A unit test fails when the committed ABI differs from `contracts/out`. `packages/adapter/src/settlement.anvil.test.ts` deploys the real contract on Anvil and runs the helpers against it.

## Deploy

The deploy script reads these environment variables. `forge` loads `contracts/.env` (see `.env.example`). Never commit a key.

| Variable | Required | Meaning |
|---|---|---|
| `DEPLOYER_PRIVATE_KEY` | yes | The deployer key |
| `SETTLEMENT_OWNER` | no | Owner. Default: the deployer. Use a multisig in production. |
| `SETTLEMENT_INTENT_SIGNER` | no | The server intent signer. Default: none (intents off). |
| `SETTLEMENT_ALLOWED_TARGETS` | no | Comma-separated call targets, for example ERC-4626 vaults |

### Local dry run (Anvil)

```sh
anvil
# in another terminal; the key is Anvil's public dev account 0
DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  forge script script/Deploy.s.sol --rpc-url anvil --broadcast
```

### Arbitrum Sepolia (chain 421614)

1. Get Sepolia ETH on Arbitrum Sepolia for the deployer, for example from a faucet listed at https://docs.arbitrum.io/for-devs/dev-tools-and-resources/chain-info#faucets, or bridge Sepolia ETH at https://bridge.arbitrum.io.
2. Simulate first (no `--broadcast`):
   ```sh
   forge script script/Deploy.s.sol --rpc-url arbitrum_sepolia
   ```
3. Deploy and verify:
   ```sh
   forge script script/Deploy.s.sol --rpc-url arbitrum_sepolia --broadcast \
     --verify --etherscan-api-key $ARBISCAN_API_KEY
   ```

Arbitrum One: the same command with `--rpc-url arbitrum`.

### Robinhood Chain Testnet (chain 46630)

Robinhood Chain is an Arbitrum Orbit L2. Network data from https://docs.robinhood.com/chain/connecting:

| Item | Value |
|---|---|
| Chain id | 46630 (mainnet: 4663) |
| Public RPC | https://rpc.testnet.chain.robinhood.com (rate-limited) |
| Explorer | https://explorer.testnet.chain.robinhood.com |
| Faucet | https://faucet.testnet.chain.robinhood.com |

```sh
forge script script/Deploy.s.sol --rpc-url robinhood_testnet --broadcast \
  --verify --verifier blockscout --verifier-url https://explorer.testnet.chain.robinhood.com/api/
```

TODO: Circle does not list a USDC deployment on Robinhood Chain yet. Use any ERC-20 on the testnet, or deploy a test token, until one is published.

## Files

| Path | Content |
|---|---|
| `src/OpenRampSettlement.sol` | The contract |
| `test/OpenRampSettlement.t.sol` | Unit and fuzz tests |
| `test/OpenRampSettlement.invariant.t.sol` | Invariant tests (no funds kept, no standing allowance) |
| `test/mocks/Mocks.sol` | Mock USDC, ERC-4626 vault, fee-on-transfer token, hostile targets |
| `script/Deploy.s.sol` | Deploy script |
| `script/Demo.s.sol` | Demo settlements on a testnet |
| `slither.config.json` | Slither configuration (see `audit/static-analysis.md`) |
| `audit/` | Static analysis, coverage and raw tool outputs |
