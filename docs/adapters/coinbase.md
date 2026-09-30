# Coinbase

`@openrampkit/adapter-coinbase` sends users to [Coinbase Onramp](https://docs.cdp.coinbase.com/onramp) to buy USDC with a card, Apple Pay or Google Pay.

```ts
import { coinbase } from '@openrampkit/adapter-coinbase'

coinbase({
  apiKeyId: process.env.CDP_API_KEY_ID!,
  apiKeySecret: process.env.CDP_API_KEY_SECRET!,
  webhookSecret: process.env.CDP_WEBHOOK_SECRET,
})
```

::: warning Coinbase account required
Coinbase ended guest checkout (card or Apple Pay without a Coinbase account) in the hosted widget on 2026-06-30. The hosted flow now needs a Coinbase account. Guest Apple Pay and Google Pay moved to the Headless Onramp API, which this adapter does not implement yet.
:::

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKeyId` | `string` | required | CDP Secret API key id (the key's `name` or `id`) |
| `apiKeySecret` | `string` | required | CDP Secret API key secret: base64 Ed25519 (the CDP default) or an EC PEM (SEC1 or PKCS#8) |
| `appId` | `string` | none | CDP project id. Not used by the session API. |
| `webhookSecret` | `string` | none | Secret of the CDP webhook subscription (`onramp.transaction.*`). Without it, webhooks are rejected. |
| `cdpApiUrl` | `string` | `https://api.cdp.coinbase.com` | CDP API |
| `onrampApiUrl` | `string` | `https://api.developer.coinbase.com` | Onramp API (config, status) |
| `defaultCountry` | `string` | `'US'` | Country when the session has none |
| `defaultSubdivision` | `string` | none | US state for quotes when the session has no region (Coinbase needs `subdivision` for US quotes) |
| `sandbox` | `boolean` | `!session.livemode` | Prefix `partnerUserRef` with `sandbox-` |

The adapter signs a CDP JWT for each call with WebCrypto (EdDSA or ES256). The helpers `cdpJwt`, `importCdpKey` and `sec1ToPkcs8` are exported.

## Legs

| Leg | Method | Coinbase `paymentMethod` | Fiat | Delivers |
|---|---|---|---|---|
| `card` | `card` | `CARD` | USD, EUR, GBP, CAD, AUD, SGD, CHF | USDC on Base, Ethereum, Arbitrum, Optimism, Polygon, Solana |
| `apple_pay` | `apple_pay` | `APPLE_PAY` | same | same |
| `google_pay` | `google_pay` | `CARD` | same | same |

- Regions: every country except `JP` ("available in all countries in which Coinbase operates except Japan").
- Surface: `REDIRECT` to `pay.coinbase.com`.
- Live catalog: `GET /onramp/v1/buy/config`, cached for a day, sets the countries per payment method. If no country lists any method (an unexpected format), the static legs stay.

## Quotes and start

- Quote: `POST /platform/v2/onramp/sessions` with the payment amount, currency and method, the country, the US subdivision (from `session.region` such as `US-CA`, else `defaultSubdivision`), the destination network and address, and `partnerUserRef`. It returns a quote and a single-use one-click URL.
- Start: reuses the quote's URL when it is less than 4 minutes old (session tokens last 5 minutes). Otherwise it makes a new session with the same method and location.
- Reference: `partnerUserRef`, `ork-{random}` (with `sandbox-` in front in sandbox mode).
- Status: `GET /onramp/v1/buy/user/{partnerUserRef}/transactions?pageSize=1`.

## Webhooks

Create a CDP webhook subscription for `onramp.transaction.*` events with the URL `{baseUrl}/webhooks/coinbase`. Pass its `metadata.secret` as `webhookSecret`.

- Verification: header `X-Hook0-Signature` with `t=...` and `v0=...`. `v0` is the hex HMAC-SHA256 of `{t}.{body}`. Timestamps older than 5 minutes are rejected.
- `ONRAMP_TRANSACTION_STATUS_SUCCESS`, `ONRAMP_ORDER_STATUS_COMPLETED` or `onramp.transaction.success` give `succeeded` (with the tx hash and amount). Statuses ending in `_FAILED` or `onramp.transaction.failed` give `failed`. Others give `processing`.

## Verified vs TO VERIFY

- **TO VERIFY**: Coinbase network names for Arbitrum, Optimism and Polygon (check with the Buy Options API).
- **TO VERIFY**: the fiat currency list per country.
- **TO VERIFY**: `google_pay` has no own value in the session API; it is sent as `CARD`.
- **TO VERIFY**: the Buy Config response shape (`{ data: { countries } }` in the guide, `{ countries }` in the API spec). Both are accepted.
- **TO VERIFY**: the status query parameter casing (`pageSize` in the API spec, `page_size` in the guide).
