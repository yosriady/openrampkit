---
'@openrampkit/core': minor
'@openrampkit/server': minor
---

The server now compares each leg's reported output with the leg's quote. When a provider reports less than the quote by more than the new `policy.outputToleranceBps` (default 100, that is 1%), the leg keeps its result, but the session result gets the new `amountMismatch` field (`legIndex`, `expected`, `received`, `shortfall`), so every webhook shows it. The server also adds a `leg.amount_mismatch` timeline entry, logs a warning and reports the `leg.amount_mismatch` metric. The admin page shows the shortfall on the leg. Core has the new `AmountMismatch` type.
