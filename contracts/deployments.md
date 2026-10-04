# Deployments

`OpenRampSettlement` has the same address on both testnets. The source is verified on both explorers.

| Chain | Chain id | OpenRampSettlement | Explorer |
|---|---|---|---|
| Arbitrum Sepolia | 421614 | `0xBF66696115128B8f9f794780061348b4213A7132` | [Blockscout](https://arbitrum-sepolia.blockscout.com/address/0xBF66696115128B8f9f794780061348b4213A7132) · [Arbiscan](https://sepolia.arbiscan.io/address/0xBF66696115128B8f9f794780061348b4213A7132) |
| Robinhood Chain Testnet | 46630 | `0xBF66696115128B8f9f794780061348b4213A7132` | [Explorer](https://explorer.testnet.chain.robinhood.com/address/0xBF66696115128B8f9f794780061348b4213A7132) |

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

## More test settlements (4 October 2026, Arbitrum Sepolia)

| Session | What | Transaction |
|---|---|---|
| `ors_judge_1` | 10 test USDC to the recipient | [0x01530a08…](https://sepolia.arbiscan.io/tx/0x01530a08f45b72dc9f0d0ea9ec20cdeb32c741ef7e1be1effb2953c2346c34e1) |
| `ors_judge_2` | 20 test USDC to the recipient | [0x309cded7…](https://sepolia.arbiscan.io/tx/0x309cded7220c35d848eee938814747dcc1b17b7e64f53c1bd07a7428e0d6dcf7) |
| `ors_judge_vault` | 15 test USDC into the vault, same transaction | [0xb105917d…](https://sepolia.arbiscan.io/tx/0xb105917d84e20c60129f0ea43c7f3453a1f194f7360cefa53574c18c8892b5ab) |
