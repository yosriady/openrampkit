---
'@openrampkit/core': minor
'@openrampkit/adapter': patch
'@openrampkit/adapter-bridge': patch
'@openrampkit/server': minor
'@openrampkit/client': patch
'@openrampkit/web': minor
'@openrampkit/mcp': patch
---

Refunds and chargebacks after success. A provider event `refunded` for a leg that succeeded, or the new leg status `reversed` (a chargeback or a returned payout), no longer gets lost. The server keeps the leg with its new status, adds it to the timeline, sets the new step state `REVERSED` (error `PAYMENT_REVERSED`) and the new session status `reversed`, and sends the new `session.reversed` webhook once, with a deterministic event id (and `withdrawal.reversed` for a withdrawal). The event data has `index`, `adapterId`, `legId`, `legStatus` and `previous`. Take back or freeze the credit when you get it. A `REVERSED` session refuses `restart`, and a completed or reversed session refuses a new `select`.

Core: new `StateName` `REVERSED` (`COMPLETED` can move to it), `LegStatus` `reversed`, `SessionStatus` `reversed`, event types `session.reversed` and `withdrawal.reversed`, and error code `PAYMENT_REVERSED`. Code that switches on these unions must handle the new members. The modal shows "Payment reversed" (in every built-in language), and the admin page has a filter, a stats card and a detail row for reversed sessions.
