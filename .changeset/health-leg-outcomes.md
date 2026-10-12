---
"@openrampkit/server": patch
---

Provider health: a leg that failed because of the user (`PAYMENT_FAILED`, `KYC_REJECTED`, `PROVIDER_DECLINED`, `QUOTE_EXPIRED` and the other user codes) no longer counts as a provider failure, and each leg's outcome counts once, also when a save is retried after a conflict.
