# Security

This page tells you what the OpenRampKit server protects, what it does not protect, and what you must do in your app. To report a vulnerability, see [SECURITY.md](https://github.com/yosriady/openrampkit/blob/main/SECURITY.md).

## Trust model

| Part | Trust |
|---|---|
| Your backend | Trusted. It creates sessions, sets the destination, and credits users from signed webhooks. |
| OpenRampKit server | Trusted. It holds the provider keys and runs in your infrastructure. |
| Browser (client, web component, React) | Not trusted. The user can change any request. |
| Provider pages and webhooks | Trusted only after the adapter verifies the signature. |
| Chain RPCs | Trusted for same-chain checks. Use your own RPC URLs in production. |

The browser gets one client secret per session. The secret acts only on its own session. It cannot read or change another session.

## What the server does

### Sessions and secrets

- Each session has a random secret (24 bytes). The server keeps only its SHA-256 hash, and compares hashes in constant time.
- The session id in the URL must match the id in the secret. Else the answer is `401`.
- After `expiresAt`, a session cannot plan, quote, select or restart. A payment that started before the deadline can still finish.
- `secret` must have at least 32 characters. `webhooks.secret` and `tasksToken` must have at least 16. The server does not start with a shorter value.

### Input checks

- `CreateSessionInput`: the server checks `userId`, `metadata`, `ttlMinutes`, `country`, `amountBounds` and the destination. See [CreateSessionInput](../api/server.md#createsessioninput).
- Browser routes: the server checks amounts (decimal strings), wallet addresses, chains (CAIP-2), tokens, withdraw targets and `Idempotency-Key`.
- Body size: at most 64 KiB for a JSON body and 1 MiB for a provider webhook. A larger body gets `413`.
- Quote ids are looked up as own keys only. A value such as `__proto__` finds nothing.

### Idempotency and rate limits

- An `Idempotency-Key` is scoped to the session and the route. A key cannot replay the answer of another session or another route.
- Each session can make at most `limits.providerCallsPerMinute` (default 60) requests per minute to the routes that call providers.

### Surface URLs

Provider URLs reach the browser as popups, iframes and links. The server checks them before the client sees them:

- `REDIRECT`, `IFRAME` and a `PROVIDER_SDK` `redirectUrl` must use `https:`. In test mode, `http:` is also accepted.
- `DEEPLINK` can use an app scheme, for example `gcash://`.
- A `javascript:`, `data:`, `vbscript:`, `blob:`, `file:` or `about:` URL fails the leg with `PROVIDER_UNAVAILABLE`.

The client and the web component do the same checks again. They never open or embed a `javascript:` or `data:` URL.

A `REDIRECT` goes through a start URL on your server: `{baseUrl}/start/{session}.{token}.{signature}`. The signature is an HMAC with `secret`. The link expires after 10 minutes. The redirect has `cache-control: no-store` and `referrer-policy: no-referrer`. When the surface sets `keepReferrer: true` (Transak), it uses `referrer-policy: strict-origin`.

### Provider webhooks in

Each adapter verifies its provider's webhook with the raw body, before the server parses it:

| Adapter | Check | Replay window |
|---|---|---|
| Coinbase | HMAC-SHA256 of `{t}.{body}` (`X-Hook0-Signature`) | 5 minutes |
| Meld | HMAC-SHA256 of `{timestamp}.{url}.{body}` | 5 minutes |
| MoonPay | HMAC-SHA256 of `{t}.{body}` (`Moonpay-Signature-V2`) | 5 minutes |
| Stripe | HMAC-SHA256 of `{t}.{body}` (`Stripe-Signature`) | 5 minutes |
| Peer | HMAC-SHA256 of `{timestamp}.{body}` | 5 minutes |
| Onramper | HMAC-SHA256 of the body | none (the provider signs no time) |
| Swapped | HMAC-SHA256 of the body | none (the provider signs no time) |
| Transak | HS256 JWT signed with the access token | JWT `exp` |
| Xendit | Static callback token | none (the provider signs nothing) |

An adapter without its webhook key refuses every webhook. All comparisons are constant time. A replayed event cannot change a leg that is already final.

### Webhooks out

The server signs each webhook with HMAC-SHA256 over `{id}.{timestamp}.{body}`. `verifyWebhook` refuses a timestamp more than 5 minutes old. Webhooks are at least once: credit by event id or session id, one time only. See [Webhooks to your backend](./webhooks.md).

### Withdrawals

- The target address must have a valid format. The zero EVM address is refused.
- `allowedTargets` limits the chains and currencies.
- `screenAddress` fails closed: `false`, any other value, or an error refuses the address.
- With `custody: 'app'`, the server saves the session (with the version check) before it calls `treasury.send`. Two requests at the same time cannot both send. The `idempotencyKey` lets your hook drop a retry.

### Same-chain payments (Relay)

A same-chain `wallet` payment completes only when the transaction succeeded, was mined after the payment started, paid the recipient the quoted amount, and did not complete another payment before. See [Same-chain moves](../adapters/relay.md#same-chain-moves).

### Errors and logs

- The browser gets only `OrkError` codes and safe messages. A raw provider error, a stack trace or a key never goes to the browser.
- The server does not log secrets, API keys or request headers.

### CORS

Without `cors`, the server sends no CORS headers. With a list of origins, the server copies the `Origin` header only when it is in the list. The server never sends `access-control-allow-credentials`: the client secret goes in the `Authorization` header, not in a cookie.

### Operational routes

`POST /tasks/sweep` and `GET /health?deep=1` need `Authorization: Bearer {tasksToken}`. Without `tasksToken`, `POST /tasks/sweep` answers 404 and `GET /health?deep=1` answers 401. The plain `GET /health` is public: it lists the adapter ids and calls no provider.

## What you must do

1. Credit users only from a verified webhook, or from `openramp.sessions.retrieve()` on your server. Never trust the browser.
2. Credit each session or event one time only. Store `result.txHashes` with a unique constraint.
3. Keep `secret`, `webhooks.secret`, `tasksToken` and the provider keys in a secret store. Use 32 random bytes for each.
4. Use a shared store with an atomic version check in production: `durableObjectStore` or `redisStore`.
5. In `authorize`, decide `userId` and `destination` on the server. Do not copy them from the request body.
6. With `custody: 'app'`, check and debit the user's balance in `treasury.send`, one time per `idempotencyKey`. Check the amount and the recipient of `txs`. The server does not know the balance.
7. Set `screenAddress` for withdrawals, and set `amountBounds.currency` to the source token symbol, so that the bounds apply.
8. Do not configure the mock adapter in production. It refuses live sessions.
9. Set your own `rpcUrls` for Relay in production.
10. Put your own rate limits in front of `POST /sessions` and the webhook routes (for example at your CDN).

## Known limits

- `x-forwarded-for` and `x-real-ip` can be forged when no proxy sets them. The server gives the IP to providers as a hint only.
- `cloudflareKvStore` has no atomic version check. Two requests at the same time can both write. `memoryStore` is atomic, but only inside one process.
- A same-chain `transfer` to a destination address counts every transfer after the start block, from any sender. See [Same-chain moves](../adapters/relay.md#same-chain-moves).
- Onramper, Swapped and Xendit webhooks have no replay window, because the providers do not sign a time.
