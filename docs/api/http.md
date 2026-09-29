# HTTP routes

All paths are relative to `baseUrl`. For example, with `baseUrl: 'https://app.example.com/api/openramp'`, `GET /sessions/:id` is `https://app.example.com/api/openramp/sessions/ors_...`.

You rarely call these yourself: `@openrampkit/client` does. They are listed here for custom clients, debugging and proxies.

## Summary

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/sessions` | `authorize` hook | Create a session (only when `authorize` is set) |
| `GET` | `/sessions/:id` | Bearer client secret | Read the session |
| `GET` | `/sessions/:id/step` | Bearer | Read the session after a status check |
| `POST` | `/sessions/:id/plan` | Bearer | Plan pathways and methods |
| `POST` | `/sessions/:id/quotes` | Bearer | Quote a method |
| `POST` | `/sessions/:id/select` | Bearer, `Idempotency-Key` | Confirm a quote and start the first leg |
| `POST` | `/sessions/:id/transitions/:name` | Bearer, `Idempotency-Key` | Fire a transition |
| `GET` | `/start/:token` | Signed token | Popup-safe redirect to a provider |
| `GET` | `/return` | none | "You can close this tab" page |
| `POST` | `/webhooks/:adapterId` | Adapter verifies | Provider webhooks |
| any | `/adapters/:adapterId/*` | Adapter decides | Adapter routes |
| `GET` | `/health` | none | Adapter health |
| `OPTIONS` | any | none | CORS preflight: `204` |

## Authentication

Session routes need the client secret:

```
Authorization: Bearer ors_6a1f0c2b9d8e7f6a5b4c3d2e.4b1f...
```

The session id before the dot must equal `:id`. A missing or wrong secret gets `401 UNAUTHORIZED`. When an open session is past its expiry, loading it moves it to `EXPIRED` first.

Session routes record the caller's IP (`cf-connecting-ip`, `x-real-ip` or the first `x-forwarded-for`) for adapters.

## Errors

Every error is JSON:

```json
{ "error": { "code": "QUOTE_EXPIRED", "message": "The quote expired. Get a new quote to continue.", "retryable": true } }
```

| Status | When |
|---|---|
| `400` | Body is not JSON (`BAD_REQUEST`), or an adapter refused the input |
| `401` | Bad client secret, bad start URL signature, bad webhook signature, or `authorize` returned `null` |
| `404` | Unknown route or adapter (`NOT_FOUND`) |
| `409` | A payment is already in progress; a transition is not allowed now; nothing to continue; or a concurrent change (`The session changed. Try again.`) |
| `410` | Quote expired (`QUOTE_EXPIRED`), or start URL expired (plain text) |
| `422` | No pathway for the method (`NO_QUOTES`), or an adapter error such as `AMOUNT_TOO_LOW` |
| `429` | Provider rate limit (`RATE_LIMITED`) |
| `500` | Unexpected error (`INTERNAL`); the details are logged, not returned |
| `502`, `504` | Provider unavailable or timed out (`PROVIDER_UNAVAILABLE`) |

The concurrent-change `409` uses the code `RATE_LIMITED` with `retryable: true`.

## POST /sessions

Available only when `authorize` is set; otherwise `404`.

- Body: any JSON (default `{}`), passed to `authorize(req, body)`.
- The hook returns a `CreateSessionInput` or `null` (`401`).
- `country` and `region` from geo headers are the defaults; the hook's values win.
- Response `201`: `{ "id": "ors_...", "clientSecret": "ors_....", "expiresAt": "2026-09-29T10:30:00.000Z" }`

## GET /sessions/:id

Response `200`: a `PublicSession`.

```ts
type PublicSession = {
  id: string
  direction: 'deposit' | 'withdraw'
  destination: Destination
  status: 'open' | 'processing' | 'completed' | 'failed' | 'expired' | 'refunded'
  country?: string
  currency?: string             // set after the first plan
  locale?: string               // only when the app set one
  amountBounds?: { min?: string; max?: string; currency: string }
  step: Step
  expiresAt: string
  livemode: boolean
}
```

## GET /sessions/:id/step

Same response as `GET /sessions/:id`. Before answering, the server asks the active leg's adapter for status (`status()`), at most once every 2 seconds per leg. This is the route the client polls.

## POST /sessions/:id/plan

Body (all optional):

```json
{ "walletConnected": true, "walletAddress": "0x...", "surfaces": ["REDIRECT", "IFRAME", "QR"] }
```

`surfaces` defaults to every kind except `PROVIDER_SDK`. The server runs each adapter's `catalog()` (or its static legs), plans, applies the session's `allowedMethods`, and stores the plan.

Response `200`:

```ts
type PlanResult = {
  pathways: Pathway[]
  methods: MethodOption[]   // sorted: connected, recommended, more, unavailable
  currency: string
}
type MethodOption = {
  method: string; name: string; kind: string
  group: 'connected' | 'recommended' | 'more' | 'unavailable'
  reason?: OrkError
  providers: string[]; pathwayIds: string[]
  eta: { min: number; max: number }
  limits?: { min?: string; max?: string; currency: string }
}
```

## POST /sessions/:id/quotes

Body:

```json
{ "method": "vietqr", "amount": "500000", "amountSide": "source", "source": { "chain": "eip155:42161", "token": "0xaf88..." } }
```

| Field | Required | Description |
|---|---|---|
| `method` | yes | A method from the plan |
| `amount` | yes | Decimal string. `"0"` is allowed for `transfer`. |
| `amountSide` | no | `'source'` (default) or `'destination'` (one-leg pathways only) |
| `source` | no | For `wallet` and `transfer`: the token the user pays with |

The server plans first if needed. It quotes up to 5 available pathways for the method in parallel.

Response `200`: `{ "quotes": Quote[], "errors": OrkError[] }`, ranked (see [Quoting](../concepts/pathways.md#quoting)). Errors: `400` without `method` or `amount`; `409` while a payment is in progress; `422 NO_QUOTES` when the method has no available pathway.

## POST /sessions/:id/select

Headers: `Idempotency-Key: <random>` (recommended).

Body: `{ "quoteId": "q_...", "walletAddress": "0x..." }` (`walletAddress` optional).

The server starts the first leg and returns the `PublicSession` with the new step. A `REDIRECT` surface URL is replaced by a start URL. Errors: `410 QUOTE_EXPIRED` when the quote is unknown or expired; `409` while a payment is in progress. If the first leg fails to start, the active pathway is rolled back.

## POST /sessions/:id/transitions/:name

Headers: `Idempotency-Key: <random>` (recommended).

Body: `{ "inputs": { "txHash": "0x..." } }` (`inputs` optional).

- `restart`: back to `SELECT_METHOD`. Allowed with no active payment, during `PAYMENT`, or after a terminal state other than `COMPLETED`. Otherwise `409`.
- Any other name must be a SUBMIT or SURFACE_RESULT transition of the current step, and the adapter must implement `transition()`. Otherwise `409`.

Response `200`: the `PublicSession`.

### Idempotency

When `Idempotency-Key` is present, the server stores the response under `(session, key)` for 24 hours. A repeat returns the stored status and body with `idempotent-replay: true`.

## GET /start/:sessionId.:token.:sig

Checks the HMAC signature (`401` when wrong), then the token's expiry (10 minutes; `410` text when expired), then answers `302` to the provider URL with `cache-control: no-store` and `referrer-policy: no-referrer` (or `strict-origin` when the surface set `keepReferrer`).

## GET /return

A small HTML page: "You can close this tab and go back to the app." It tries `window.close()` after 800 ms.

## POST /webhooks/:adapterId

For provider callbacks. The server reads the raw body, calls the adapter's `webhook.verify()` (`401` when false) and `webhook.parse()`, applies each event to the session that owns its `ref`, and answers `{ "received": true }`. `404` when the adapter has no webhook handler. Events for unknown refs are logged and ignored.

## /adapters/:adapterId/*

Passed to the adapter's `routes(req, subpath, ctx)`. `404` when the adapter has no route for it.

## GET /health

Calls each adapter's `health()` (adapters without it count as ok).

```json
{ "ok": true, "adapters": [{ "id": "relay", "ok": true }, { "id": "swapped", "ok": false, "detail": "HTTP 401 from ..." }] }
```

Status `200` when all are ok, else `503`. This route has no auth and calls provider APIs. Consider blocking it at your edge in production.

## CORS

With `cors: { origins: [...] }`, requests from a listed origin get `access-control-allow-origin`, `access-control-allow-headers: authorization, content-type, idempotency-key`, `access-control-allow-methods: GET, POST, OPTIONS` and `access-control-max-age: 600`. With `'*'`, any origin is allowed. Without `cors`, no CORS headers are sent (same origin only).
