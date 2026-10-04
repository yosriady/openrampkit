# Deployments

`OpenRampSettlement` has the same address on both testnets. The source is verified on Blockscout (Arbitrum Sepolia), on Arbiscan (Arbitrum Sepolia) and on the Robinhood Chain Testnet explorer (Blockscout).

| Chain | Chain id | OpenRampSettlement | Explorer |
|---|---|---|---|
| Arbitrum Sepolia | 421614 | `0xBF66696115128B8f9f794780061348b4213A7132` | [Blockscout](https://arbitrum-sepolia.blockscout.com/address/0xBF66696115128B8f9f794780061348b4213A7132?tab=contract) · [Arbiscan](https://sepolia.arbiscan.io/address/0xBF66696115128B8f9f794780061348b4213A7132#code) |
| Robinhood Chain Testnet | 46630 | `0xBF66696115128B8f9f794780061348b4213A7132` | [Blockscout](https://explorer.testnet.chain.robinhood.com/address/0xBF66696115128B8f9f794780061348b4213A7132?tab=contract) |

Settings: owner and deployer `0x13B95aeC9277B3aD809737a9A1435bb2e8e77D89` (a testnet key), no intent signer, no call targets at deploy.

## Demo settlements

`script/Demo.s.sol` settled two sessions on each chain with a **test token that has no value** (open mint) and a test ERC-4626 vault:

- `ors_demo_plain`: 25 test USDC straight to the recipient.
- `ors_demo_vault`: 25 test USDC deposited into the vault for the recipient, in the same transaction.

| Chain | Test USDC | Test vault | Settle, plain | Settle, into vault |
|---|---|---|---|---|
| Arbitrum Sepolia | `0x9A38C55160186C3E1e770e193fA96997e60ed425` | `0xA83fE1B79cEd7772f5d90D19833b2fDD844c7801` | [0x48a50e39…](https://sepolia.arbiscan.io/tx/0x48a50e39f7e929f7d96baee13b489fe95b7ba3f58068df386e293cdff182c3da) | [0x7e6a3848…](https://sepolia.arbiscan.io/tx/0x7e6a3848d92ea11ae833d05b9584f3f83481b9bb4f3ed849843b2ffffeea87ac) |
| Robinhood Chain Testnet | `0x9A38C55160186C3E1e770e193fA96997e60ed425` | `0xA83fE1B79cEd7772f5d90D19833b2fDD844c7801` | [0xc609f135…](https://explorer.testnet.chain.robinhood.com/tx/0xc609f1350ec874512c59481e03ffb34ab4b9a77773cb153352f647569b5d4a87) | [0xf6c54dc3…](https://explorer.testnet.chain.robinhood.com/tx/0xf6c54dc3302d3b4b498ccf8457e7d64820f9e7a705ff4e7709ccb670a42e34e3) |

Check a session on chain:

```bash
cast call 0xBF66696115128B8f9f794780061348b4213A7132 'isSettled(bytes32)(bool)' \
  $(cast format-bytes32-string ors_demo_vault) --rpc-url https://sepolia-rollup.arbitrum.io/rpc
```

## Settlement through the TypeScript client

`scripts/testnet-settle.mjs` runs one settlement through the same code path as the playground's testnet mode: the OpenRampKit server with the mock adapter's settlement leg, then plan, quote and select, then the WALLET_TX step (`approve` and `settle` from `buildSettlementTxs`), then `submit_tx`. The server checks the session with `verifySettlement`, and the script checks it again.

It paid 5 Circle test USDC (`0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`, no value) from the deployer to the deployer, on Arbitrum Sepolia (4 October 2026).

| Session | Step | Transaction |
|---|---|---|
| `ors_3c1b83f06b31d3def280b8bd` | `approve` | [0x6ca35ca9…](https://sepolia.arbiscan.io/tx/0x6ca35ca9a7435ec1e975ea30a1b1a86fc1354bec25ffa70237134193bd7662b1) |
| `ors_3c1b83f06b31d3def280b8bd` | `settle` | [0x803d429a…](https://sepolia.arbiscan.io/tx/0x803d429a38115a65b9f98616fb2e6ca442f3dfdc8ede73288acdc3febe548834) · [Blockscout](https://arbitrum-sepolia.blockscout.com/tx/0x803d429a38115a65b9f98616fb2e6ca442f3dfdc8ede73288acdc3febe548834) |

Session state: `COMPLETED`. `verifySettlement`: settled, 5000000 base units, block 315642124.

Run it again (it reads `DEPLOYER_PRIVATE_KEY` from `contracts/.env` and never prints it):

```bash
pnpm testnet:settle
```
