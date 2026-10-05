---
"@openrampkit/server": minor
"@openrampkit/core": minor
---

Reliable webhooks and sweeps.

- Server: the webhook outbox and the open-session list are now store queues with atomic add, claim (with a lease) and claim-checked remove. A session or an event that is added while a sweep runs is no longer lost. The sweep takes the entries that waited longest (round robin), and two sweeps at the same time do not take the same entry. `SessionStore` has a new optional `queue`; all built-in stores implement it, and a custom store without it gets a fallback on the version check of `put`. The first sweep moves entries from the old KV array lists.
- Server: webhook events are saved in the session record in the same versioned write as the change, and sent only after that write succeeds. Event ids are deterministic (a hash of the session id and the event), so a retry after a `409` conflict or a failed delivery has the same id. Deduplicate by event id.
- Server: failed webhooks are retried for about 24 hours (`webhooks.retryHours`, backoff up to 2 hours). Then they stay in the session as dead letters, and `openramp.webhooks.replay(sessionId)` sends them again. `webhooks.maxAttempts` no longer has a default.
- Server: `restart` keeps the left payment as an earlier attempt. A late provider event for it still applies: the session completes with it, or the server sends the new `session.late_payment` event when another payment is in progress or complete. The sweep keeps polling such sessions.
- Server: `POST /webhooks/:adapterId` answers `503` (with `retry-after`) when an event could not be applied (unknown ref, or the session kept changing), so the provider sends it again. A verified event that is safe to ignore still gets `200`.
- Core: `createEvent` takes an optional `id`. New event types `session.refunded` and `session.late_payment` in `OrkEventType`.
