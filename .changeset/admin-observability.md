---
"@openrampkit/server": minor
---

Admin and observability tools. New `admin` config: a time index of new sessions on the store queues (no lost entries when sessions are created at the same time), and `openramp.admin.list`, `get`, `findByRef`, `findByTx`, `stats`, `resolve` (a forced final state with an audit note and the matching webhook) and `replayWebhooks`. With `admin.token` (at least 32 characters, compared in constant time), the HTTP routes `/admin/*` and a self-contained ops dashboard at `GET /admin` (CSP nonce, no external scripts, token in sessionStorage only) are on. New `telemetry.onMetric(name, value, tags)` callback for quote latency, start errors, webhook verify and delivery failures, dead letters, outbox depth and sweep lag. Sessions now keep `updatedAt` and a short timeline. `StoreQueue` has an optional `range` (all built-in stores have it).
