---
'@openrampkit/core': minor
'@openrampkit/adapter': minor
'@openrampkit/server': patch
---

Provider events now move a leg only forward. Core has `LEG_STATUS_RANK` and `isLegalLegMove(from, to)`. The server ignores a provider event that would move a leg back (for example `pending` after `processing`), logs it, adds 1 to the new `event.out_of_order` metric, and answers the provider with `200`. One move back stays allowed: from `processing` to `awaiting_user` with a new surface, before the leg has a transaction. `LegEvent` has a new optional `eventId`. The server keeps the last 50 applied ids per session and ignores an event with an id that it already applied.
