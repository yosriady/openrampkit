# Deployments

`OpenRampSettlement` has the same address on every testnet, because it is deployed with CREATE2 through the standard deterministic deployer (`SETTLEMENT_SALT` is `keccak256("openrampkit.settlement.v2")`). The source is verified on Blockscout (Arbitrum Sepolia), on the Robinhood Chain Testnet explorer (Blockscout) and on the Tempo contract verifier (Sourcify API, shown in the Tempo Explorer).

| Chain | Chain id | OpenRampSettlement | Explorer |
|---|---|---|---|
| Arbitrum Sepolia | 421614 | `0x12196D55b9009145c9CBAe7e256f3d32F9e27Af5` | [Blockscout](https://arbitrum-sepolia.blockscout.com/address/0x12196D55b9009145c9CBAe7e256f3d32F9e27Af5?tab=contract) · [Arbiscan](https://sepolia.arbiscan.io/address/0x12196D55b9009145c9CBAe7e256f3d32F9e27Af5#code) |
| Robinhood Chain Testnet | 46630 | `0x12196D55b9009145c9CBAe7e256f3d32F9e27Af5` | [Blockscout](https://explorer.testnet.chain.robinhood.com/address/0x12196D55b9009145c9CBAe7e256f3d32F9e27Af5?tab=contract) |
| Tempo Testnet (Moderato) | 42431 | `0x12196D55b9009145c9CBAe7e256f3d32F9e27Af5` | [Tempo Explorer](https://explore.testnet.tempo.xyz/address/0x12196D55b9009145c9CBAe7e256f3d32F9e27Af5) · deploy tx [0x17d8a315…](https://explore.testnet.tempo.xyz/tx/0x17d8a31501a3f704ef1706e579b9f66ab8c28e3945153e8cbeea63b9d6744f7a) |

Settings: owner and deployer `0x13B95aeC9277B3aD809737a9A1435bb2e8e77D89` (a testnet key), no intent signer, the test vault `0xA83fE1B79cEd7772f5d90D19833b2fDD844c7801` allowed as a call target at deploy.

> **History:** The first version of the contract was at `0xBF66696115128B8f9f794780061348b4213A7132`. On 5 October 2026 it was replaced by the current version, which binds the exact amount in `settleFromBalance` (`BalanceSettlementIntent`). Do not use the old address.

## Demo settlements

`script/Demo.s.sol` settled two sessions on each chain with a **test token that has no value** (open mint) and a test ERC-4626 vault:

- `ors_demo_plain`: 25 test USDC straight to the recipient.
- `ors_demo_vault`: 25 test USDC deposited into the vault for the recipient, in the same transaction.

| Chain | Test USDC | Test vault | Settle, plain | Settle, into vault |
|---|---|---|---|---|
| Arbitrum Sepolia | `0x9A38C55160186C3E1e770e193fA96997e60ed425` | `0xA83fE1B79cEd7772f5d90D19833b2fDD844c7801` | [0x13c3d6bf…](https://sepolia.arbiscan.io/tx/0x13c3d6bf9ce2496fc3444f1d8dd2abd991a3dd15efcf03791f6c856254ee3643) | [0xf3707735…](https://sepolia.arbiscan.io/tx/0xf370773565bd5340b17f1a00e969fdd15f84229d73be10346c7f0ab197aa4fdf) |
| Robinhood Chain Testnet | `0x9A38C55160186C3E1e770e193fA96997e60ed425` | `0xA83fE1B79cEd7772f5d90D19833b2fDD844c7801` | [0x2f51eb97…](https://explorer.testnet.chain.robinhood.com/tx/0x2f51eb97d3504eaecce286fbefad832de66ade81161dbc051e65e43d8ef2ddde) | [0x3d935da8…](https://explorer.testnet.chain.robinhood.com/tx/0x3d935da80a4014bd4d6f82941cc37c7514dd67ea79e4f268cb9035abea6dba8e) |
| Tempo Testnet | `0x9A38C55160186C3E1e770e193fA96997e60ed425` | `0xA83fE1B79cEd7772f5d90D19833b2fDD844c7801` | [0x28fe2bb8…](https://explore.testnet.tempo.xyz/tx/0x28fe2bb8d2522af828e3a94812534f6e14e64c8a84aad70d8b45f137342e0173) | [0x40a152bb…](https://explore.testnet.tempo.xyz/tx/0x40a152bb98f2fd9e99d8592381903279eba20a344dc737cc2d7938b728aa44d3) |

Check a session on chain:

```bash
cast call 0x12196D55b9009145c9CBAe7e256f3d32F9e27Af5 'isSettled(bytes32)(bool)' \
  $(cast format-bytes32-string ors_demo_vault) --rpc-url https://sepolia-rollup.arbitrum.io/rpc
```

## Settlement through the TypeScript client

`scripts/testnet-settle.mjs` runs one settlement through the same code path as the playground's testnet mode: the OpenRampKit server with the mock adapter's settlement leg, then plan, quote and select, then the WALLET_TX step (`approve` and `settle` from `buildSettlementTxs`), then `submit_tx`. The server checks the session with `verifySettlement`, and the script checks it again.

It paid 5 Circle test USDC (`0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`, no value) from the deployer to the deployer, on Arbitrum Sepolia (5 October 2026).

| Session | Step | Transaction |
|---|---|---|
| `ors_7b13893dfc105551c383c6c3` | `approve` | [0x7f411239…](https://sepolia.arbiscan.io/tx/0x7f41123976ddaded5f87b28bf8988e1590dff3cab523d5993d86892610772639) |
| `ors_7b13893dfc105551c383c6c3` | `settle` | [0x34b014f3…](https://sepolia.arbiscan.io/tx/0x34b014f3db006fe270e16ea2caa1b8d5fe6c1ac76e3a2b3201dbd559cc0cb342) · [Blockscout](https://arbitrum-sepolia.blockscout.com/tx/0x34b014f3db006fe270e16ea2caa1b8d5fe6c1ac76e3a2b3201dbd559cc0cb342) |

Session state: `COMPLETED`. `verifySettlement`: settled, 5000000 base units, block 316031720.

Run it again (it reads `DEPLOYER_PRIVATE_KEY` from `contracts/.env` and never prints it):

```bash
pnpm testnet:settle
```

## Tempo Testnet

Tempo has no gas token. Every transaction above is a standard EIP-1559 transaction (type 2) that names no fee token, so Tempo took the fee in pathUSD (`0x20c0000000000000000000000000000000000000`), the default fee token. The deployer got pathUSD and AlphaUSD from the faucet RPC method, with no sign-in:

```bash
cast rpc tempo_fundAddress 0x13B95aeC9277B3aD809737a9A1435bb2e8e77D89 --rpc-url https://rpc.moderato.tempo.xyz
```

One more settlement pays a real TIP-20 stablecoin, AlphaUSD (`0x20c0000000000000000000000000000000000001`, 6 decimals, test value only), from the deployer to the deployer (5 October 2026):

| Session | How | Transactions |
|---|---|---|
| `ors_cc871cb11aabc8a4f9805722` | `NETWORK=tempo-testnet pnpm testnet:settle`: the TypeScript client path (5 AlphaUSD) | [approve 0x01341321…](https://explore.testnet.tempo.xyz/tx/0x0134132a136eb96bb4338d17831b2c401b1ef196c73112be0d1ccfb25b892a1b) · [settle 0x2b7125df…](https://explore.testnet.tempo.xyz/tx/0x2b7125df4ee10f0c584cf257d3390d5c306cc59c17b50ee6bae642c65dd36667) |

The server checked the settlement with `verifySettlement` and set the state to `COMPLETED`. The script checked it again: 5000000 base units, block 38283607.

```bash
cast call 0x12196D55b9009145c9CBAe7e256f3d32F9e27Af5 'isSettled(bytes32)(bool)' \
  $(cast format-bytes32-string ors_demo_vault) --rpc-url https://rpc.moderato.tempo.xyz
```

## Solana devnet (no contract)

Solana payments do not use OpenRampSettlement. The server verifies the SPL transfer on chain and allows one signature per session. Proof: [1 devnet USDC](https://explorer.solana.com/tx/4cAv4h7Pv8FGBx55yidQwJcww5uqF54usUy7juR8hnViRm4UBbAZ7NEdTuZuwWJXtyBQ9eLvozWjRPi7MYnBxiKY?cluster=devnet), session `ors_0a715aa02e6fa759a3c522e3`. Details in [docs/guide/solana.md](../docs/guide/solana.md#proof-on-devnet).
