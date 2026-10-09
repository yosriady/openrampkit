---
'@openrampkit/core': patch
'@openrampkit/server': minor
---

Late payments after expiry. When the sweep expires a session whose payment still waits for the user (for example a bank transfer or a deposit address), it now keeps the session on a grace list and polls the payment at a slower rate: the new `latePayments` option, `{ graceHours: 72, pollMinutes: 10 }` by default (`graceHours: 0` turns it off). When the payment arrives (by this poll or by a provider webhook), the session moves on from `EXPIRED` and completes, and the server sends `session.late_payment` with `reason: 'after_expiry'`, then `session.completed`. `session.late_payment` for an earlier attempt now has `reason: 'earlier_attempt'`. `SweepResult.sessions` has a new `grace` count. In the core table, `EXPIRED` can now move to `PROCESSING` or `COMPLETED`.
