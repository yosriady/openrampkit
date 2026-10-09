# Stripe

`@openrampkit/adapter-stripe` uses the [Stripe Crypto Onramp](https://docs.stripe.com/crypto/onramp) to buy USDC in the US and the EU.

::: info New adapter
This adapter is new. Stripe must approve your account for the onramp. Some details are marked TO VERIFY in the source (listed below).
:::

```ts
import { stripe } from '@openrampkit/adapter-stripe'

stripe({
  secretKey: process.env.STRIPE_SECRET_KEY!,
  publishableKey: process.env.STRIPE_PUBLISHABLE_KEY!,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
})
```

::: warning Pick the surface
By default the adapter returns a `PROVIDER_SDK` surface for Stripe's embedded onramp. The surface `params` carry `clientSecret`, `publishableKey`, `sessionId` and `redirectUrl` (when Stripe gives one). You have two choices:

- Keep the default and pass `providerRenderers: { stripe: stripeOnrampRenderer() }` to `openDeposit()` or `OpenRampProvider`. The modal mounts the Stripe element. See [PROVIDER_SDK](../concepts/surfaces.md#provider-sdk).
- Set `surface: 'redirect'`. The modal opens the Stripe-hosted onramp in a new tab.

Without a renderer and with the default surface, the planner shows Stripe's methods as "Not available" (`CLIENT_UPGRADE_REQUIRED`).
:::

To get the keys, see [Get provider keys](../guide/provider-keys.md#stripe).

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `secretKey` | `string` | required | Secret key (or a restricted key with onramp access) |
| `publishableKey` | `string` | required | Passed to the client for the embedded onramp |
| `webhookSecret` | `string` | required | Endpoint secret (`whsec_...`) for `crypto.onramp_session.updated` |
| `surface` | `'sdk' \| 'redirect'` | `'sdk'` | `PROVIDER_SDK` or a `REDIRECT` to the Stripe-hosted onramp |
| `methods` | `string[]` | all | Leg ids: `card`, `apple_pay`, `google_pay`, `ach` |
| `apiUrl` | `string` | `https://api.stripe.com` | API base URL |
| `env` | `'sandbox' \| 'production'` | from the key prefix | `sk_test_` or `rk_test_` is `sandbox`; `sk_live_` or `rk_live_` is `production`. A value that does not agree with the key throws. The server checks `env` against `livemode`. |

## Legs

| Leg | Fiat | Countries |
|---|---|---|
| `card` | USD, EUR | US and EU |
| `apple_pay` | USD, EUR | US and EU |
| `google_pay` | USD, EUR | US and EU |
| `ach` | USD | US |

- Every leg denies `US-HI`.
- Delivers USDC on Base, Ethereum, Polygon, Solana and Avalanche. Another token or chain gets no quote (`NO_QUOTES`). Some networks are not sold everywhere: USDC on Base, Polygon, Solana and Avalanche is not sold in the EU, and USDC on Polygon and Avalanche is not sold in New York. The quote then fails with `REGION_UNSUPPORTED`.
- The Stripe onramp UI picks the payment method itself. The legs only tell the planner what to show.

## Quotes and start

- Quote: `GET /v1/crypto/onramp_quotes` (falls back to `/v1/crypto/onramp/quotes` on 404). The fees are `transaction_fee_monetary` and `network_fee_monetary`. `source_total_amount` is what the user pays. Quotes expire after 5 minutes.
- Start: `POST /v1/crypto/onramp_sessions` (form-encoded) with the wallet address locked, USDC, the network, the source amount, `customer_ip_address` (from `ctx.session.ip`), and metadata. A `rejected` session fails the leg with `PROVIDER_DECLINED`.
- Reference: the onramp session id.
- Status: `GET /v1/crypto/onramp_sessions/{id}`.

| Stripe status | Leg |
|---|---|
| `fulfillment_complete` | `succeeded` with `transaction_id` |
| `fulfillment_processing` | `processing` |
| `initialized`, `requires_payment` | `awaiting_user` |
| `rejected` | `failed` with `PROVIDER_DECLINED` |

## Webhooks

Add a webhook endpoint in the Stripe dashboard for `crypto.onramp_session.updated` with the URL `{baseUrl}/webhooks/stripe`, and pass its secret as `webhookSecret`. When `webhookSecret` is empty or not set, the adapter refuses every webhook (`401`).

- Verification: `Stripe-Signature: t=...,v1=...`, hex HMAC-SHA256 of `{t}.{body}`, 5 minute tolerance. Any matching `v1` passes.

## Verified vs TO VERIFY

- **TO VERIFY**: the request key for a Base wallet address (`wallet_addresses[base_network]` is assumed).
- **TO VERIFY**: the method list (card, Apple Pay, Google Pay, ACH) comes from Stripe marketing pages, not the API docs.
- **TO VERIFY**: the quotes path (the API reference and the embedded guide name different paths).
