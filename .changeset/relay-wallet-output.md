---
'@openrampkit/adapter-relay': patch
---

Relay `wallet` leg: a completed leg now reports the delivered `output`. Relay's intent status has no amount, so on `success` the adapter reads the request (`GET /requests/v3?id=`, or `/requests/v2` without a key) and takes `data.route.actual.destination.outputCurrency`, else `data.metadata.currencyOut`. The server then checks the real amount against the quote, and `result.outputConfirmed` is `true`. Before, it was `false` for every Relay wallet payment. When the lookup fails, the leg completes as before, without an output.

An output in the same asset as the quote now has the quote's asset. Before, when the destination token was `native`, a delivery of native ETH (Relay address `0x0000...0000`) on a `transfer` or `bridge` leg gave `amountMismatch` with `asset_mismatch`.
