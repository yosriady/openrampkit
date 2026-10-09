---
'@openrampkit/core': patch
'@openrampkit/server': minor
---

Late payments after expiry. When the sweep expires a session whose payment still waits for the user (for example a bank transfer or a deposit address), it now keeps the session on a grace list and polls the payment at a slower rate: the new `latePayments` option, `{ graceHours: 72, pollMinutes: 10 }` by default (`graceHours: 0` turns it off). When the payment arrives inside the grace window (by this poll or by a provider webhook for the leg that waited at expiry), the session moves on from `EXPIRED` and completes, and the server sends `session.late_payment` with `reason: 'after_expiry'`, then `session.succeeded`. After the window, the session stays `EXPIRED` and the server sends `session.late_payment` with `reason: 'after_grace'`. A failure event, an event for an earlier attempt, or a browser request never changes an expired session. `session.late_payment` for an earlier attempt now has `reason: 'earlier_attempt'`. `SweepResult.sessions` has a new `grace` count. In the core table, `EXPIRED` can now move to `PROCESSING` or `COMPLETED`.
