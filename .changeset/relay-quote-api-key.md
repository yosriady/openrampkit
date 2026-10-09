---
'@openrampkit/adapter-relay': patch
---

Relay quotes need an API key: since 2026-10-02, Relay refuses `POST /quote/v2` without a valid key. The no-key warning now says that live quotes and deposit addresses fail without a key, and that `GET /requests/v2` retires on 2026-11-24. A 401 with `errorCode` `UNAUTHORIZED_QUOTE` now maps to `PROVIDER_UNAVAILABLE` (not retryable) with a message that names `RELAY_API_KEY`, and the adapter logs a warning.
