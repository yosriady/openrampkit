---
'@openrampkit/adapter-relay': patch
---

Relay requires an API key for quotes (`POST /quote/v2`) under its announced policy from 2026-10-02. Some keyless requests may still work today, but Relay can refuse them at any time. The no-key warning now says this, tells you to always set `RELAY_API_KEY`, and says that `GET /requests/v2` retires on 2026-11-24. A 401 with `errorCode` `UNAUTHORIZED_QUOTE` now maps to `PROVIDER_UNAVAILABLE` (not retryable) with a message that names `RELAY_API_KEY`, and the adapter logs a warning.
