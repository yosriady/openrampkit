---
'@openrampkit/adapter': minor
'@openrampkit/server': minor
'@openrampkit/adapter-onramper': minor
'@openrampkit/adapter-swapped': minor
'@openrampkit/adapter-xendit': minor
---

Replay protection for provider webhooks that have no timestamp. `Adapter.webhook` has a new optional `replayKey(req, rawBody, ctx)`. After `verify`, the server claims the key for 7 days in the adapter's shared store with the new `claimWebhook` (built on `claimOnce`). A repeat gets `200` with `{ "received": true, "duplicate": true }`, changes nothing, and adds 1 to the new `webhook.replayed` metric. When the server cannot apply the events yet (`503`), it gives the key back with `releaseWebhook`, so the provider's retry still applies. New helpers: `webhookBodyKey(rawBody)` (SHA-256 of the body), `claimWebhook`, `releaseWebhook` and `WEBHOOK_REPLAY_TTL_SEC`. The Onramper, Swapped and Xendit adapters now give the body hash as the replay key and as the `eventId` of their events.
