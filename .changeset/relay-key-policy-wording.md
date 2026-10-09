---
"@openrampkit/adapter-relay": patch
---

The no-key warning now follows Relay's announced policy: Relay requires an API key for quotes from 2026-10-02. Some keyless requests may still work today, but Relay can refuse them at any time, so always set `RELAY_API_KEY`. The `401 UNAUTHORIZED_QUOTE` mapping does not change.
