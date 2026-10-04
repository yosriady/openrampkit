---
'@openrampkit/adapter-mock': minor
---

The mock `localChain` leg can pay through OpenRampSettlement. With a destination `settlement`, it asks the wallet for `approve` and `settle` (from `buildSettlementTxs`, with the destination calls). It completes only when `verifySettlement` finds a matching receipt for the session. The leg declares the `settlement` capability. The playground uses it for its testnet mode on Arbitrum Sepolia and Robinhood Chain Testnet.
