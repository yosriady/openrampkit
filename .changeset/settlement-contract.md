---
"@openrampkit/core": minor
"@openrampkit/adapter": minor
"@openrampkit/adapter-relay": minor
"@openrampkit/server": minor
---

Add on-chain settlement through the `OpenRampSettlement` contract (`contracts/`).

- core: `destination.settlement` (`{ contract }`), the `settlement` leg capability, and chain data for Arbitrum Sepolia, Robinhood Chain and Robinhood Chain Testnet. USDC on Arbitrum Sepolia.
- adapter: `OPEN_RAMP_SETTLEMENT_ABI`, `buildSettlementTxs`, `encodeSettle`, `settlementIntentTypedData`, `hashSettlementCalls`, `sessionIdToBytes32`, `verifySettlement` and `keccak256`.
- relay: the `wallet` leg pays into the settlement contract (approve and settle) and verifies by session id. New options `signSettlementIntent` and `settlementIntentTtlSec`.
- server: `destination.calls` is supported with `destination.settlement`.
