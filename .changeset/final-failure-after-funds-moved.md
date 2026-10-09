---
'@openrampkit/server': minor
---

A failed attempt is final (status `failed`) when money left on that attempt: a later leg started, the treasury sent, or a transaction was submitted. Before, such a session went back to `requires_payment_method`, so a new attempt could make the treasury send a second payout.

New `TreasuryRefusedError` (and `isTreasuryRefused`). `treasury.send` throws it to refuse when nothing was sent; the user may then try again. Any other error from the hook is read as "the funds may have left": the failure is final and an operator resolves the session (fail closed).
