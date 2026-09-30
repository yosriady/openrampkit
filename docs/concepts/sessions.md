# Sessions and security

A **session** is one deposit or withdrawal attempt by one user. A deposit goes to one destination. A withdrawal sends one source asset (see [Withdrawals](../guide/withdraw.md)). Your backend creates it. The browser works on it with a client secret.

## Why a server

The browser cannot be trusted with:

- **Provider secrets.** Swapped, Coinbase and Transak URLs must be signed with keys that only the server has.
- **The destination.** If the browser chose the address, a script on the page could redirect the funds.
- **The outcome.** A browser can claim a payment succeeded. Only a verified provider webhook or a provider status call can confirm it.

So the server:

1. holds provider secrets and signs provider URLs,
2. fixes the user, the destination and other inputs when the session is created,
3. receives provider webhooks and sends signed webhooks to your backend,
4. asks providers for status when the browser polls, and from the [background sweep](../api/server.md#background-sweep) after the user leaves.

## Creating a session

The [session creation flow](./flows.md#session-creation) shows the full sequence as a diagram.


```ts
const { id, clientSecret, expiresAt } = await openramp.sessions.create({
  userId: user.id,
  destination: { type: 'crypto', chain: 'eip155:8453', token: USDC_BASE, address: user.depositAddress },
  country: 'VN',
  email: user.email,
  allowedMethods: ['vietqr', 'card', 'transfer'],
  metadata: { orderId: 'o_42' },
  ttlMinutes: 30,
})
```

See [`CreateSessionInput`](../api/server.md#createsessioninput) for every field. The server stores these fields. The browser cannot change them.

- `destination` is normalized: crypto token addresses are lowercased, merchant currencies uppercased.
- `country` and `region` are uppercased. They drive the currency, the methods and the region checks.
- `allowedMethods` filters the plan: other methods are not shown and cannot be quoted.
- `amountBounds` is shown to the user as a min and max on the amount screen. The server enforces it on quotes and on select (see [Amount bounds](../api/server.md#amount-bounds)). Provider limits still apply.
- `email` is passed to adapters that can prefill it (Swapped, Transak, MoonPay, Onramper).
- `locale` (BCP 47, such as `vi`) is sent to the modal as `PublicSession.locale`, where it picks the language unless the client sets one. Adapters get it as `ctx.session.locale` (`en` when not set).

## Client secrets

`clientSecret` has the form `{sessionId}.{secret}`, for example `ors_6a1f....9c2e...`. The server stores only the SHA-256 hash of the secret part.

The browser sends it on every call as `Authorization: Bearer {clientSecret}`. The server checks that the id in the token matches the id in the URL, and compares the hash in constant time. A wrong or missing secret gets `401 UNAUTHORIZED`.

A client secret gives access to one session only. It can read the session and move it forward. It cannot change the user, the destination, the metadata or the expiry. Treat it like a short-lived token: send it only to the user who owns the session.

A **pay link credential** works like a client secret. `openramp.sessions.payLink(id)` or `POST /sessions/:id/pay-link` returns a URL `{baseUrl}/pay/{sessionId}.pay_{exp}_{sig}`. The part after the dot is an HMAC over the session id and an expiry, signed with your `secret`. It works until it expires (by default the session expiry plus 30 minutes). An expired credential gets `401` with "This pay link expired.". A pay link credential cannot make another pay link. See [GET /pay/:credential](../api/http.md#get-pay-credential) and the [agent flow](./flows.md#ai-agent-via-mcp).

## Browser-created sessions (optional)

If your backend cannot call `sessions.create()` directly (for example the server is a separate Worker), enable `POST /sessions` with an `authorize` hook. The hook authenticates the request and returns the session input, or `null` to refuse:

```ts
createOpenRamp({
  // ...
  authorize: async (req, body) => {
    if (req.headers.get('x-app-key') !== env.APP_API_KEY) return null
    return body as CreateSessionInput // your backend sent it, so it is trusted
  },
})
```

Without `authorize`, `POST /sessions` returns 404. The route fills `country` and `region` from geo headers, and the hook's result overrides them. Never return a destination that came from an untrusted browser.

## Idempotency

`POST /sessions/:id/select` and `POST /sessions/:id/transitions/:name` accept an `Idempotency-Key` header. The client sends a random key on every call. If the same key comes again within 24 hours for the same session, the server replays the stored response with the header `idempotent-replay: true`. A double click or a network retry does not start a second payment.

Two more guards:

- A new `quotes` or `select` call while a payment is in progress returns `409` ("A payment is already in progress.").
- Every save uses an optimistic version check. When two requests change the same session at once, one gets `409 CONFLICT` (`retryable: true`) and can send the request again.

## Popup-safe start URLs

Hosted checkouts (card, bank, some e-wallets) need a new tab. Browsers block `window.open` unless it runs inside a click handler, and the provider URL is often made on the server after the click.

So the server never sends the provider URL to the browser. When a leg returns a `REDIRECT` surface, the server:

1. stores the provider URL under a random token for 10 minutes,
2. replaces the URL with `{baseUrl}/start/{sessionId}.{token}.{sig}`, where `sig` is an HMAC of the session id and token with your `secret`,
3. on `GET /start/...`, checks the signature and the expiry, then answers `302` to the provider URL with `cache-control: no-store` and `referrer-policy: no-referrer`.

The modal opens this URL from the "Continue to ..." click, so popup blockers allow it. An adapter can set `keepReferrer: true` on the surface when the provider checks the `Referer` header; then the redirect uses `referrer-policy: strict-origin`.

When the provider is done, it sends the user to `returnUrl` (default `{baseUrl}/return`). That page says "You can close this tab and go back to the app." and tries to close itself.

## Expiry

Sessions expire after `ttlMinutes` (default 30). The server moves a session to `EXPIRED` with `SESSION_EXPIRED` and sends `session.expired` in these cases:

- A request finds an **open** session (no payment started) after its expiry.
- The background sweep finds a session after its expiry with no payment started, or with a leg that still waits for the user (`awaiting_user`, for example an unpaid QR code).

A leg that the provider is processing does not expire this way: the provider decides the outcome. A leg can also end as `expired` on its own (the provider says so). Then the step is `EXPIRED`, and the server sends `session.expired` too.

See the [expiry flow](./flows.md#background-sweep-and-session-expiry).

Quotes expire on their own schedule (`expiresAt`). Selecting an expired quote returns `410 QUOTE_EXPIRED`.

Start URLs expire after 10 minutes and return `410` with a plain text message.

## What the session stores

The store keeps a `SessionRecord`: the inputs above, the plan, the last 20 quotes, the active pathway with each leg's quote, provider reference and last step, the start URL tokens, and which webhooks were sent. Adapters also keep small records in the same store, under their own key prefix. See [Session stores](../deploy/stores.md).
