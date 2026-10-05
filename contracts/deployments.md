# Deployments

`OpenRampSettlement` has the same address on every testnet. The source is verified on Blockscout (Arbitrum Sepolia), on Arbiscan (Arbitrum Sepolia), on the Robinhood Chain Testnet explorer (Blockscout) and on the Tempo contract verifier (Sourcify API, shown in the Tempo Explorer).

| Chain | Chain id | OpenRampSettlement | Explorer |
|---|---|---|---|
| Arbitrum Sepolia | 421614 | `0xBF66696115128B8f9f794780061348b4213A7132` | [Blockscout](https://arbitrum-sepolia.blockscout.com/address/0xBF66696115128B8f9f794780061348b4213A7132?tab=contract) · [Arbiscan](https://sepolia.arbiscan.io/address/0xBF66696115128B8f9f794780061348b4213A7132#code) |
| Robinhood Chain Testnet | 46630 | `0xBF66696115128B8f9f794780061348b4213A7132` | [Blockscout](https://explorer.testnet.chain.robinhood.com/address/0xBF66696115128B8f9f794780061348b4213A7132?tab=contract) |
| Tempo Testnet (Moderato) | 42431 | `0xBF66696115128B8f9f794780061348b4213A7132` | [Tempo Explorer](https://explore.testnet.tempo.xyz/address/0xBF66696115128B8f9f794780061348b4213A7132) · deploy tx [0xf4d552bd…](https://explore.testnet.tempo.xyz/tx/0xf4d552bd942c095e08652a48050a26106b2a9b83ade01f08eef31504c9ebb4f0) |

Settings: owner and deployer `0x13B95aeC9277B3aD809737a9A1435bb2e8e77D89` (a testnet key), no intent signer, no call targets at deploy.

## Demo settlements

`script/Demo.s.sol` settled two sessions on each chain with a **test token that has no value** (open mint) and a test ERC-4626 vault:

- `ors_demo_plain`: 25 test USDC straight to the recipient.
- `ors_demo_vault`: 25 test USDC deposited into the vault for the recipient, in the same transaction.

| Chain | Test USDC | Test vault | Settle, plain | Settle, into vault |
|---|---|---|---|---|
| Arbitrum Sepolia | `0x9A38C55160186C3E1e770e193fA96997e60ed425` | `0xA83fE1B79cEd7772f5d90D19833b2fDD844c7801` | [0x48a50e39…](https://sepolia.arbiscan.io/tx/0x48a50e39f7e929f7d96baee13b489fe95b7ba3f58068df386e293cdff182c3da) | [0x7e6a3848…](https://sepolia.arbiscan.io/tx/0x7e6a3848d92ea11ae833d05b9584f3f83481b9bb4f3ed849843b2ffffeea87ac) |
| Robinhood Chain Testnet | `0x9A38C55160186C3E1e770e193fA96997e60ed425` | `0xA83fE1B79cEd7772f5d90D19833b2fDD844c7801` | [0xc609f135…](https://explorer.testnet.chain.robinhood.com/tx/0xc609f1350ec874512c59481e03ffb34ab4b9a77773cb153352f647569b5d4a87) | [0xf6c54dc3…](https://explorer.testnet.chain.robinhood.com/tx/0xf6c54dc3302d3b4b498ccf8457e7d64820f9e7a705ff4e7709ccb670a42e34e3) |
| Tempo Testnet | `0x9A38C55160186C3E1e770e193fA96997e60ed425` | `0xA83fE1B79cEd7772f5d90D19833b2fDD844c7801` | [0xdab923c3…](https://explore.testnet.tempo.xyz/tx/0xdab923c348a6f6c8065f2baf2b63f9f51f9b85d30a5fb26e5a55eee86eb051f7) | [0x53381320…](https://explore.testnet.tempo.xyz/tx/0x5338132038877ab4f5033e48a79503b83f30efce23afeb97aa0961a5ffa5b7ee) |

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

## Tempo Testnet

Tempo has no gas token. Every transaction above is a standard EIP-1559 transaction (type 2) that names no fee token, so Tempo took the fee in pathUSD (`0x20c0000000000000000000000000000000000000`), the default fee token. The deployer got pathUSD and AlphaUSD from the faucet RPC method, with no sign-in:

```bash
cast rpc tempo_fundAddress 0x13B95aeC9277B3aD809737a9A1435bb2e8e77D89 --rpc-url https://rpc.moderato.tempo.xyz
```

Two more settlements pay a real TIP-20 stablecoin, AlphaUSD (`0x20c0000000000000000000000000000000000001`, 6 decimals, test value only), from the deployer to the deployer (5 October 2026):

| Session | How | Transactions |
|---|---|---|
| `ors_tempo_tip20` | `cast send`: `approve`, then `settle` (5 AlphaUSD) | [approve 0x45cb72b8…](https://explore.testnet.tempo.xyz/tx/0x45cb72b82e7e4290a49157b7cbc3853cdae2ff0aa5cb5f0b1ec33fb14596527e) · [settle 0x40570f5d…](https://explore.testnet.tempo.xyz/tx/0x40570f5d1c5715637171d60097b2890574aba4bc87101c005a0d4f2e22054c68) |
| `ors_9cc8cbcb1970793ab895e70d` | `NETWORK=tempo-testnet pnpm testnet:settle`: the TypeScript client path (5 AlphaUSD) | [approve 0x507e855b…](https://explore.testnet.tempo.xyz/tx/0x507e855bfd280011036e9e688b2f45072c3e922a494bd5aad2d0a00a7c905997) · [settle 0xfe332cd5…](https://explore.testnet.tempo.xyz/tx/0xfe332cd5ca1993847ec5e06c49a7e985d38930e6b2217fffdac812930fa1e595) |

For the second session, the server checked the settlement with `verifySettlement` and set the state to `COMPLETED`. The script checked it again: 5000000 base units, block 38242616.

```bash
cast call 0xBF66696115128B8f9f794780061348b4213A7132 'isSettled(bytes32)(bool)' \
  $(cast format-bytes32-string ors_tempo_tip20) --rpc-url https://rpc.moderato.tempo.xyz
```

## Solana devnet (no contract)

Solana payments do not use OpenRampSettlement. The server verifies the SPL transfer on chain and allows one signature per session. Proof: [1 devnet USDC](https://explorer.solana.com/tx/4cAv4h7Pv8FGBx55yidQwJcww5uqF54usUy7juR8hnViRm4UBbAZ7NEdTuZuwWJXtyBQ9eLvozWjRPi7MYnBxiKY?cluster=devnet), session `ors_0a715aa02e6fa759a3c522e3`. Details in [docs/guide/solana.md](../docs/guide/solana.md#proof-on-devnet).
