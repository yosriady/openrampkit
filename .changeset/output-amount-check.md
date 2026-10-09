---
'@openrampkit/core': minor
'@openrampkit/server': minor
---

The server now compares each leg's reported output with the leg's quote. When a provider reports less than the quote by more than the new `policy.outputToleranceBps` (default 100, that is 1%), the leg keeps its result, but the session result gets the new `amountMismatch` field (`reason`, `legIndex`, `expected`, `received`, `shortfall`), so every webhook shows it. The check fails closed: an output in another asset (`asset_mismatch`) or with an amount that is not a number (`invalid_amount`) is flagged too, is not a confirmed output, and on a leg before the last it stops the pathway (`FAILED`, `DELIVERY_FAILED`) instead of starting the next leg. The server also adds a `leg.amount_mismatch` timeline entry, logs a warning and reports the `leg.amount_mismatch` metric. The admin page shows the shortfall on the leg. Core has the new `AmountMismatch` type.
