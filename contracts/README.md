# OpenRampKit contracts

`OpenRampSettlement` is the on-chain settlement point for OpenRampKit deposit sessions. A payer settles one session: the contract takes the amount, then pays the recipient or runs an allowlisted call bundle (for example an ERC-4626 deposit for the recipient), in one transaction. It records each session id one time only, so the server verifies a payment by reading one receipt and one `Settled` event.

Read the concept page: [docs/concepts/settlement.md](../docs/concepts/settlement.md).

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
