---
"@openrampkit/core": patch
"@openrampkit/server": patch
"@openrampkit/client": patch
"@openrampkit/web": patch
"@openrampkit/adapter-relay": patch
"@openrampkit/adapter-stripe": patch
"@openrampkit/adapter-swapped": patch
"@openrampkit/adapter-mock": patch
---

Security hardening: body size limits (413), input checks on sessions and browser routes, idempotency keys scoped per route, session deadline enforced on quote, select and restart, surface URL checks (no `javascript:` or `data:` URLs) on the server, client and web component, a single treasury send under concurrent requests, a block time check for Relay same-chain payments, minimum lengths for `webhooks.secret` and `tasksToken`, empty webhook keys refused by Stripe and Swapped, and the mock adapter refuses live sessions. New in core: `isWebUrl` and `isSafeLinkUrl`.
