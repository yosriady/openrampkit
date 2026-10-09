---
'@openrampkit/server': patch
---

Withdraw: a late payment of an earlier attempt no longer completes the session when the user picked another target after the `restart`. Before, the session completed and `withdrawal.completed` showed the new target as the destination, but the funds went to the old one. The server now keeps the destination of each payment attempt, and sends `session.late_payment` (`reason: 'earlier_attempt'`) instead.
