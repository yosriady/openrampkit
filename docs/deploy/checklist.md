# Production checklist

Go through this list before real money moves.

## Secrets

- [ ] `secret` is at least 32 random characters (`openssl rand -hex 32`), unique per environment, and stored as a platform secret.
- [ ] `webhooks.secret` is a different random value, shared only with your backend.
- [ ] Provider keys are server-side only. No adapter or server import reaches your client bundle.
- [ ] You use live provider keys in production and sandbox keys elsewhere. Set `livemode: true` in production, so events carry `livemode` and adapters such as Coinbase leave sandbox mode.
- [ ] You know how to rotate each secret. Rotating `secret` breaks start URLs made in the last 10 minutes; rotating `webhooks.secret` needs your backend updated at the same time.

## Sessions

- [ ] Sessions are created only by your backend (`sessions.create()`), or through an `authorize` hook that authenticates the caller. The browser never chooses `userId` or `destination`.
- [ ] Destination addresses come from your database, per user.
- [ ] You pass `country` (and `region` in the US) so region rules apply. Providers still run their own checks.
- [ ] `ttlMinutes` fits your flow (default 30).

## Store

- [ ] You use a shared store with an atomic version check (Redis, or your own). Not the memory store. Not Workers KV for real traffic. See [Session stores](./stores.md).
- [ ] Sessions are kept for days (the built-in stores keep them 7 days), so late provider webhooks still find them.

## CORS and hosting

- [ ] `baseUrl` is the exact public URL where the handler is mounted, over HTTPS.
- [ ] If the browser calls another origin, `cors.origins` lists your app origins only. Avoid `'*'` in production.
- [ ] Your proxy sets a trusted client IP header (`cf-connecting-ip`, `x-real-ip` or `x-forwarded-for`).
- [ ] Request timeouts are above the 9 second quote timeout.
- [ ] `GET /health` is blocked or rate-limited at the edge. It has no auth and calls provider APIs.

## Provider webhooks

- [ ] Each provider with webhooks points to `{baseUrl}/webhooks/{adapterId}`, and its signing secret is configured on the adapter (`webhookToken` for Xendit, `webhookSecret` for Coinbase and Stripe, `webhookKey` for MoonPay). Swapped sets its callback URL per order.
- [ ] You tested one webhook per provider in sandbox and saw the session move.
- [ ] Transak: the adapter verifies webhooks with its cached access token. Make sure at least one quote or start ran on the instance (or the token is in the shared store) before webhooks arrive.

## Your backend

- [ ] Webhooks to your backend are verified with `openramp.webhooks.verify()` or `verifyWebhook()`, using the raw body.
- [ ] You credit only on `session.completed`, once per session id (a unique constraint), after checking the session. See [Webhooks to your backend](../guide/webhooks.md).
- [ ] You get the amount from your own records, the chain, or the provider. The webhook does not carry it.
- [ ] Same-chain wallet payments through Relay are verified on chain before crediting (the adapter trusts the browser's transaction hash).
- [ ] A background job reconciles sessions that are still processing (`openramp.sessions.refresh(id)`), because the server does not retry webhooks and Relay has no provider webhooks.

## Geo and methods

- [ ] `policy.regions` blocks the countries you must not serve.
- [ ] `policy.disabledMethods` or per-session `allowedMethods` hide methods you do not want.
- [ ] You checked the "Not available" group for your main countries.

## Adapters

- [ ] You read the TO VERIFY notes on each [adapter page](../adapters/) you use, and tested those paths in sandbox.
- [ ] Relay has an `apiKey` (the `/requests/v2` fallback retires on 2026-11-24).
- [ ] Stripe uses `surface: 'redirect'` with the web modal.
- [ ] Coinbase users know they need a Coinbase account.

## UI

- [ ] You tested the modal on desktop, Android and iPhone (the repo's Playwright projects cover all three).
- [ ] Popups work: hosted checkouts open from a click on "Continue to ...".
- [ ] The theme meets your contrast needs in light and dark mode.

## Legal

OpenRampKit is software, not a payment service. The providers you configure are the regulated parties: they onboard and verify users, take payments, and deliver funds under their own licenses and terms. You are responsible for your contracts with them, for the countries you serve, and for any rules that apply to your own business (for example consumer protection, tax, and sanctions screening). Check with each provider and with your legal counsel before you go live.
