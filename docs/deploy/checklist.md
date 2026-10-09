# Production checklist

Go through this list before real money moves.

## Secrets

- [ ] `secret` is at least 32 random characters (`openssl rand -hex 32`), unique per environment, and stored as a platform secret.
- [ ] `webhooks.secret` is a different random value, shared only with your backend.
- [ ] `tasksToken` (if you use `POST /tasks/sweep` or `GET /health?deep=1`) is another random value. `CRON_SECRET` on Vercel too.
- [ ] `admin.token` (if you use the [admin tools](../guide/admin.md)) is another random value of at least 32 characters, kept on the server only.
- [ ] You got each provider key from the correct environment (sandbox or live). See [Get provider keys](../guide/provider-keys.md).
- [ ] Provider keys are server-side only. No adapter or server import reaches your client bundle.
- [ ] You use live provider keys in production and sandbox keys elsewhere. Set `livemode: true` in production, so events carry `livemode` and adapters such as Coinbase leave sandbox mode. Set each adapter's `env` to `production`: with `livemode: true`, the server does not start when an adapter is in `sandbox`.
- [ ] You know how to rotate each secret. Rotating `secret` breaks start URLs made in the last 10 minutes and every open pay link; rotating `webhooks.secret` needs your backend updated at the same time.

## Sessions

- [ ] Sessions are created only by your backend (`sessions.create()`), or through an `authorize` hook that authenticates the caller. The browser never chooses `userId` or `destination`.
- [ ] Destination addresses come from your database, per user.
- [ ] You pass `country` (and `region` in the US) so region rules apply. Providers still run their own checks.
- [ ] `ttlMinutes` fits your flow (default 30).
- [ ] `amountBounds` is set where you need limits. The server enforces it when its currency matches what the user pays (a fiat code, or a token symbol such as `USDC`).

## Store

- [ ] You use a shared store with an atomic version check (`durableObjectStore` on Cloudflare, `redisStore`, or your own). Not the memory store. Not Workers KV for real traffic. See [Session stores](./stores.md).
- [ ] Sessions are kept for days (the built-in stores keep them 7 days), so late provider webhooks still find them.
- [ ] After an upgrade to session schema 3 (the adapter contract v2), you do not roll back to an older server while sessions are open. The new server migrates each record when it reads it, but an older server does not understand a schema 3 record. See [Record schema](./stores.md#record-schema).
- [ ] Third-party adapters use the adapter API version 2. The server refuses an adapter for version 1 at startup. See [Upgrade from version 1](../adapters/writing-an-adapter.md#upgrade-from-version-1).

## CORS and hosting

- [ ] `baseUrl` is the exact public URL where the handler is mounted, over HTTPS.
- [ ] If the browser calls another origin, `cors.origins` lists your app origins only. Avoid `'*'` in production.
- [ ] Your proxy sets a trusted client IP header (`cf-connecting-ip`, `x-real-ip` or `x-forwarded-for`).
- [ ] Request timeouts are above the 9 second quote timeout.
- [ ] If you build your own client, it sends a request again after `409 CONFLICT` (`retryable: true`). The server returns it when two requests change a session at once.
- [ ] Uptime checks use `GET /health` (quick, no provider calls). `GET /health?deep=1` calls provider APIs and needs the tasks token.

## Provider webhooks

- [ ] Each provider with webhooks points to `{baseUrl}/webhooks/{adapterId}`, and its signing secret is configured on the adapter (`webhookToken` for Xendit, `webhookSecret` for Coinbase, Stripe, Meld, Onramper and Peer, `webhookKey` for MoonPay, `webhookPublicKey` for Bridge, `binancePublicKey` for Binance). Swapped sets its callback URL per order. See [Get provider keys](../guide/provider-keys.md).
- [ ] You tested one webhook per provider in sandbox and saw the session move.
- [ ] Transak: the adapter verifies webhooks with its cached access token. Make sure at least one quote or start ran on the instance (or the token is in the shared store) before webhooks arrive.

## Background sweep

- [ ] `openramp.sweep()` runs every minute or so: a [Cloudflare Cron Trigger](./cloudflare-workers.md#cron-trigger), a [Vercel Cron Job](./nextjs.md#background-sweep), or any scheduler calling `POST {baseUrl}/tasks/sweep` with `tasksToken`. Without it, failed webhooks are never retried, and sessions whose users left are not refreshed or expired.
- [ ] The cron route refuses requests without the secret, and the secret is set in every environment that runs it.
- [ ] You watch the logs for `webhook moved to dead letter after retries` (after `webhooks.retryHours`, default 24 hours) and `sweep: session check failed`. To send dead letters again, call `openramp.webhooks.replay(sessionId)` or use "Replay webhooks" in the [ops dashboard](../guide/admin.md#the-dashboard).
- [ ] Your backend handles `session.late_payment`: a payment the user left with `restart` succeeded after another payment (`earlier_attempt`), or a payment arrived after the session expired (`after_expiry`, followed by `session.succeeded`). Do not treat `session.expired` as final for crediting.
- [ ] Your backend handles `session.reversed`: it takes back or freezes the credit of a payment that the provider refunded or charged back after it completed.
- [ ] Each run has enough time: it retries up to `limit` (default 50) webhooks and checks up to `limit` open sessions, with provider calls for each.

## Admin and monitoring

- [ ] If you turn on the admin routes, `{baseUrl}/admin` is behind your own auth (SSO, an auth proxy) or a VPN. The token is not the only lock.
- [ ] Only operators who need it know the admin token. You rotate it when one of them leaves.
- [ ] Each `admin.resolve` has a clear note (who, why, a ticket). Your backend handles the webhook from a resolve like any other, and credits once per session id.
- [ ] `telemetry.onMetric` sends metrics to your monitoring. You alert on `sweep.lag_ms`, `outbox.depth`, `webhook.dead_letter` and `webhook.verify_failed`.
- [ ] You know the [limits of the time index](../guide/admin.md#the-time-index-and-its-limits): it lists the last `admin.indexDays` days only. For reports, use your own database.

## Your backend

- [ ] Webhooks to your backend are verified with `openramp.webhooks.verify()`, `verifyWebhook()` or a Standard Webhooks library, using the raw body. The secret is a `whsec_` secret from your secret store.
- [ ] Your handler is idempotent: it drops an event id it already handled (webhooks are at-least-once), and credits once per session id (a unique constraint), only on `session.succeeded`, after checking the session. See [Webhooks to your backend](../guide/webhooks.md).
- [ ] You credit the full `session.result.output` only when `outputConfirmed` is `true` and `result.delivery.status` is `ok`. Otherwise you check the amount on chain (the `destination` transaction in `result.transactions`), at the provider, or on your order.
- [ ] You store transaction hashes with a unique constraint, so one transaction cannot complete two sessions (same-chain Relay moves check the receipt, not who sent it).

## Geo and methods

- [ ] `policy.regions` blocks the countries you must not serve.
- [ ] `policy.disabledMethods` or per-session `allowedMethods` hide methods you do not want.
- [ ] You checked the "Not available" group for your main countries.

## Withdrawals

- [ ] `screenAddress` calls your sanctions or blocklist check. It fails closed: an error refuses the address.
- [ ] `allowedDestinations` lists only the chains and currencies you support.
- [ ] With `custody: 'app'`: `treasury.send()` checks and debits the user's balance once per `idempotencyKey`, checks the recipient and amount of each transaction, and throws `TreasuryRefusedError` to refuse (any other error makes the failure final). The server does not know the user's balance.
- [ ] With `custody: 'app'` and Relay: `treasury.address` is set.
- [ ] For withdrawals, you handle `session.failed`: check `result.transactions` and the provider before you return funds to the user. `session.payment_failed` is not final: the user can try again.
- [ ] For withdrawals, you handle `session.reversed`: the payout did not reach the user. Check the provider, then return the funds to the user.

## Adapters

- [ ] You read the TO VERIFY notes on each [adapter page](../adapters/) you use, and tested those paths in sandbox.
- [ ] Relay has an `apiKey`. Relay requires an API key for quotes (`POST /quote/v2`) under its announced policy from 2 Oct 2026. Some requests without a key may still work today, but Relay can refuse them at any time. Always set `RELAY_API_KEY`. The `/requests/v2` status fallback retires on 2026-11-24.
- [ ] Stripe: pass `providerRenderers: { stripe: stripeOnrampRenderer() }` to the modal, or set `surface: 'redirect'` on the adapter.
- [ ] Coinbase users know they need a Coinbase account.

## UI

- [ ] You tested the modal on desktop, Android and iPhone (the repo's Playwright projects cover all three).
- [ ] Popups work: hosted checkouts open from a click on "Continue to ...".
- [ ] The theme meets your contrast needs in light and dark mode.

## Legal

OpenRampKit is software, not a payment service. The providers you configure are the regulated parties: they onboard and verify users, take payments, and deliver funds under their own licenses and terms. You are responsible for your contracts with them, for the countries you serve, and for any rules that apply to your own business (for example consumer protection, tax, and sanctions screening). Check with each provider and with your legal counsel before you go live.
