---
'@openrampkit/core': patch
'@openrampkit/adapter': patch
'@openrampkit/server': patch
'@openrampkit/mcp': patch
'@openrampkit/adapter-relay': patch
'@openrampkit/adapter-lifi': patch
---

The session now shows the transaction that paid into each leg, next to the fill:

- New optional field `LegStep.sourceTxHash` (and `LegEvent.sourceTxHash`): the transaction that paid into the leg, for example the origin chain transaction that the user's wallet sent with `submit_tx`. The server keeps the last value when a later step leaves it out.
- `step.progress.legs[].sourceTxHash` and `result.sourceTxHashes` show it. `result.sourceTxHashes` is absent when no leg reports one. `result.txHashes` does not change: for a bridge or swap it is the fill on the destination chain.
- Relay: the `wallet` leg reports the origin transaction (`submit_tx`, else Relay's `inTxHashes`) as `sourceTxHash`. Before, a completed session showed only the fill. The `transfer` and `bridge` legs report the transfer into the deposit address. Same-chain transfers report the same hash in both fields.
- LI.FI: the `wallet` leg reports the source transaction as `sourceTxHash`.
- The admin session detail has `sourceTxHashes`, and the MCP `get_session_status` tool has `source_tx_hashes`.
