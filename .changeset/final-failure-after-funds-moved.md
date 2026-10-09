---
'@openrampkit/server': patch
---

A failed attempt is final (status `failed`) when money left on that attempt: a later leg started, the treasury sent, or a transaction was submitted. Before, such a session went back to `requires_payment_method`, so a new attempt could make the treasury send a second payout. A treasury `send` that throws counts as "nothing sent" and stays retryable.
