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
| `POST` | `/sessions/:id/target` | Bearer | Withdraw: set the target the user picked, and plan |
| `POST` | `/sessions/:id/quotes` | Bearer | Quote a method |
| `POST` | `/sessions/:id/select` | Bearer, `Idempotency-Key` | Confirm a quote and start the first leg |
| `POST` | `/sessions/:id/transitions/:name` | Bearer, `Idempotency-Key` | Fire a transition |
| `POST` | `/sessions/:id/pay-link` | Bearer client secret | Make a signed pay link |
| `GET` | `/start/:token` | Signed token | Popup-safe redirect to a provider |
| `GET` | `/pay/:credential` | Signed credential | Hosted pay page for one session |
| `GET` | `/return` | none | "You can close this tab" page |
| `POST` | `/webhooks/:adapterId` | Adapter verifies | Provider webhooks |
| any | `/adapters/:adapterId/*` | Adapter decides | Adapter routes |
| `GET` | `/health` | none (`?deep=1`: tasks token) | Quick check; deep check of each adapter |
| `POST` | `/tasks/sweep` | Bearer `tasksToken` | Run the background sweep |
| `OPTIONS` | any | none | CORS preflight: `204` |

## Authentication

Session routes need the client secret:

```
Authorization: Bearer ors_6a1f0c2b9d8e7f6a5b4c3d2e.4b1f...
```

The session id before the dot must equal `:id`. A missing or wrong secret gets `401 UNAUTHORIZED`. A [pay link](#get-pay-credential) credential (`ors_....pay_{exp}_{sig}`) also works, until it expires. When an open session is past its expiry, loading it moves it to `EXPIRED` first.

Session routes record the caller's IP (`cf-connecting-ip`, `x-real-ip` or the first `x-forwarded-for`) for adapters.

## Errors

Every error is JSON:

```json
{ "error": { "code": "QUOTE_EXPIRED", "message": "The quote expired. Get a new quote to continue.", "retryable": true } }
```

| Status | When |
|---|---|
| `400` | Body is not JSON (`BAD_REQUEST`), a field that is not valid (amount, address, source, target, `Idempotency-Key`), or an adapter refused the input |
| `401` | Bad client secret, bad start URL signature, bad webhook signature, bad tasks token, or `authorize` returned `null` |
| `403` | Withdraw target refused: `TARGET_NOT_ALLOWED` or `ADDRESS_REJECTED` |
| `404` | Unknown route or adapter (`NOT_FOUND`) |
| `409` | A payment is already in progress; a transition is not allowed now; nothing to continue; a withdrawal that can no longer change; or a concurrent change (`CONFLICT`) |
| `410` | Quote expired (`QUOTE_EXPIRED`), session past its deadline (`SESSION_EXPIRED`), or start URL expired (plain text) |
| `413` | The body is too large (`BAD_REQUEST`): more than 64 KiB for the browser routes, more than 1 MiB for provider webhooks |
| `422` | No pathway for the method (`NO_QUOTES`), an amount outside `amountBounds` (`AMOUNT_TOO_LOW`, `AMOUNT_TOO_HIGH`), or an adapter error |
| `429` | Provider rate limit, or the per-session limit (`RATE_LIMITED`) |
| `500` | Unexpected error (`INTERNAL`); the details are logged, not returned |
| `502`, `503`, `504` | Provider unavailable or timed out (`PROVIDER_UNAVAILABLE`). `503` also when `screenAddress` throws. |

### CONFLICT

Every save checks the session version. When two requests change the same session at the same time (for example a provider webhook and a browser action), one of them gets `409` with the code `CONFLICT`, the message "The session changed at the same time. Try again." and `retryable: true`. Send the request again. Provider webhooks retry a conflict on the server up to 3 times.

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
  destination?: Destination       // withdraw: absent until the user picks a target
  source?: WithdrawSource         // withdraw only
  allowedTargets?: AllowedTargets // withdraw only, when the app set them
  status: 'open' | 'processing' | 'completed' | 'failed' | 'expired' | 'refunded'
  country?: string
  currency?: string             // set after the first plan
  locale?: string               // only when the app set one
  amountBounds?: { min?: string; max?: string; currency: string }
  step: Step
  result?: SessionResult        // once a payment started
  expiresAt: string
  livemode: boolean
}
```

See [`SessionResult`](./core.md#sessionresult).

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

## POST /sessions/:id/target

Withdraw sessions only. It sets where the funds go, then plans like `/plan`.

Body, "To wallet":

```json
{ "type": "crypto", "chain": "eip155:42161", "token": "0xaf88d065e77c8cc2239327c5edb3a432268e5831", "address": "0x2222...", "symbol": "USDC", "decimals": 6 }
```

Body, "To cash":

```json
{ "type": "fiat", "currency": "PHP" }
```

Both can also carry the `/plan` fields `walletConnected`, `walletAddress` and `surfaces`.

The server:

1. checks the format: a CAIP-2 `chain`, a token address or `native`, and an address that is valid for the chain; or an ISO 4217 `currency` (uppercased),
2. checks the session's `allowedTargets`,
3. calls `screenAddress(address, chain)` for a crypto target,
4. stores the target as the session `destination`, clears the stored quotes, and plans.

Response `200`: a `PlanResult`.

| Status | When |
|---|---|
| `400` | The body is not valid (for example "Enter a valid address for this network.") |
| `403` | `TARGET_NOT_ALLOWED` (not in `allowedTargets`) or `ADDRESS_REJECTED` (`screenAddress` returned something other than `true`) |
| `409` | Not a withdraw session; a payment is in progress; the withdrawal is complete or expired |
| `503` | `screenAddress` threw (`PROVIDER_UNAVAILABLE`, "We could not check this address. Try again.") |

On a withdraw session, `/plan` and `/quotes` answer `409` ("Choose where to send the funds first.") until a target is set.

## POST /sessions/:id/quotes

Body:

```json
{ "method": "vietqr", "amount": "500000", "amountSide": "source", "source": { "chain": "eip155:42161", "token": "0xaf88..." } }
```

| Field | Required | Description |
|---|---|---|
| `method` | yes | A method from the plan |
| `amount` | yes | Decimal string, for example `"25.50"` (digits, then an optional dot and digits). `"0"` is allowed for `transfer`. |
| `amountSide` | no | `'source'` (default) or `'destination'` (one-leg pathways only) |
| `source` | no | For `wallet` and `transfer`: the token the user pays with (`{ chain, token }`, a CAIP-2 chain and a token address or `native`) |

The server plans first if needed. It quotes up to 5 available pathways for the method in parallel.

For a withdraw session, the source is the session's `source`, and `body.source` is ignored.

Response `200`: `{ "quotes": Quote[], "errors": OrkError[] }`, ranked (see [Quoting](../concepts/pathways.md#quoting)). A quote outside the session's `amountBounds` is dropped, and `errors` gets `AMOUNT_TOO_LOW` or `AMOUNT_TOO_HIGH`. Errors: `400` without `method` or `amount`, or when a field is not valid; `409` while a payment is in progress; `422 NO_QUOTES` when the method has no available pathway.

## POST /sessions/:id/select

Headers: `Idempotency-Key: <random>` (recommended).

Body: `{ "quoteId": "q_...", "walletAddress": "0x..." }` (`walletAddress` optional).

The server checks `amountBounds` again, starts the first leg and returns the `PublicSession` with the new step. A `REDIRECT` surface URL is replaced by a start URL. A surface URL that is not safe fails the leg (see [Surface URLs](../guide/security.md#surface-urls)). Errors: `410 QUOTE_EXPIRED` when the quote is unknown or expired; `409` while a payment is in progress; `422 AMOUNT_TOO_LOW` or `AMOUNT_TOO_HIGH` outside the bounds. If the first leg fails to start, the active pathway is rolled back.

## POST /sessions/:id/transitions/:name

Headers: `Idempotency-Key: <random>` (recommended).

Body: `{ "inputs": { "txHash": "0x..." } }` (`inputs` optional).

- `restart`: back to `SELECT_METHOD`. Allowed with no active payment, during `PAYMENT`, or after a terminal state other than `COMPLETED`. Otherwise `409`.
- Any other name must be a SUBMIT or SURFACE_RESULT transition of the current step, and the adapter must implement `transition()`. Otherwise `409`.

Response `200`: the `PublicSession`.

### Idempotency

When `Idempotency-Key` is present, the server stores the response under `(session, route, key)` for 24 hours. The route is `select` or `transitions/{name}`. A repeat on the same route returns the stored status and body with `idempotent-replay: true`. The same key on another route does not replay. The key must have 1 to 255 printable ASCII characters (else `400`).

### Session deadline

After `expiresAt`, `/plan`, `/target`, `/quotes`, `/select` and the `restart` transition answer `410 SESSION_EXPIRED`. A payment that started before the deadline can still finish: `/step` and the other transitions still work. The exception is a leg that still waits for the user (`awaiting_user`): the [background sweep](./server.md#background-sweep) expires it after the deadline.

### Limits

- A JSON body can have at most 64 KiB, and a provider webhook body at most 1 MiB. A larger body gets `413`.
- `walletAddress` (in `/plan`, `/target` and `/select`) must be 8 to 128 printable characters.
- `/plan`, `/target`, `/quotes`, `/select` and `/transitions/*` call provider APIs. Together they count against `limits.providerCallsPerMinute` per session (default 60). Over the limit: `429 RATE_LIMITED`.

## GET /start/:sessionId.:token.:sig

Checks the HMAC signature (`401` when wrong), then the token's expiry (10 minutes; `410` text when expired), then answers `302` to the provider URL with `cache-control: no-store` and `referrer-policy: no-referrer` (or `strict-origin` when the surface set `keepReferrer`).

## POST /sessions/:id/pay-link

Makes a signed link to the [pay page](#get-pay-credential). Only the client secret can call it: a pay link credential gets `403`.

- Body (optional): `{ "ttlMinutes": 15 }`. The default and the maximum is the session expiry plus 30 minutes.
- Response `201`: `{ "url": "https://.../pay/ors_....pay_tm5nzp_c7c8...", "expiresAt": "..." }`
- `404` when `payPage` is `false`.

The backend API `openramp.sessions.payLink(id, { ttlMinutes? })` returns the same object without a client secret.

## GET /pay/:credential

A small HTML page that mounts `<openramp-modal>` for the session in embedded mode (`openDeposit` or `openWithdraw`). A person opens it on a phone and pays. See [Agents (MCP)](../guide/agents.md#the-pay-link).

The credential is `{sessionId}.pay_{exp}_{sig}`: `exp` is the expiry (Unix seconds, base 36) and `sig` is an HMAC-SHA256 of the session id and `exp` with `secret`. The page passes the credential to the modal as the client secret.

| Status | When |
|---|---|
| `200` | HTML with `cache-control: no-store`, `referrer-policy: no-referrer`, and a content security policy with a script nonce and `frame-ancestors 'none'` |
| `401` | The signature is wrong (plain text) |
| `404` | The session does not exist, or `payPage` is `false` |
| `410` | The link expired (plain text) |

The page imports `payPage.scriptUrl` (default `https://esm.sh/@openrampkit/web@0`).

## GET /return

A small HTML page: "You can close this tab and go back to the app." It tries `window.close()` after 800 ms.

## POST /webhooks/:adapterId

For provider callbacks. The server reads the raw body, calls the adapter's `webhook.verify()` (`401` when false) and `webhook.parse()`, applies each event to the session that owns its `ref`, and answers `{ "received": true }`. `404` when the adapter has no webhook handler. Events for unknown refs are logged and ignored.

## /adapters/:adapterId/*

Passed to the adapter's `routes(req, subpath, ctx)`. `404` when the adapter has no route for it.

## GET /health

By default, a quick check with no provider calls and no auth. Use it for uptime checks:

```json
{ "ok": true, "adapters": ["relay", "swapped"] }
```

`GET /health?deep=1` also calls each adapter's `health()` (adapters without it count as ok). These call provider APIs, so the deep check needs `Authorization: Bearer {tasksToken}`. Without the token, or when `tasksToken` is not set, it answers `401`.

```json
{ "ok": false, "adapters": [{ "id": "relay", "ok": true }, { "id": "swapped", "ok": false, "detail": "HTTP 401 from ..." }] }
```

Status `200` when all are ok, else `503`.

## POST /tasks/sweep

Runs [`openramp.sweep()`](./server.md#background-sweep): it retries failed webhooks, refreshes open payments and expires idle sessions.

- Header: `Authorization: Bearer {tasksToken}`. A wrong or missing token gets `401`.
- Without `tasksToken` in the config, the route answers `404`.
- Query: `?limit=50` (optional) caps the work per run.

Response `200`: a `SweepResult`.

```json
{ "webhooks": { "retried": 1, "delivered": 1, "dropped": 0, "pending": 0 }, "sessions": { "checked": 3, "changed": 1, "expired": 1, "open": 1 } }
```

## CORS

With `cors: { origins: [...] }`, requests from a listed origin get `access-control-allow-origin`, `access-control-allow-headers: authorization, content-type, idempotency-key`, `access-control-allow-methods: GET, POST, OPTIONS` and `access-control-max-age: 600`. With `'*'`, any origin is allowed. Without `cors`, no CORS headers are sent (same origin only).
