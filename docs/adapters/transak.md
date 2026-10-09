# Transak

`@openrampkit/adapter-transak` is a fiat onramp through the [Transak](https://docs.transak.com) widget. It buys USDC with cards, Apple Pay, Google Pay, bank transfers, UPI and other local methods.

```ts
import { transak } from '@openrampkit/adapter-transak'

transak({
  apiKey: process.env.TRANSAK_API_KEY!,
  apiSecret: process.env.TRANSAK_API_SECRET!,
  referrerDomain: 'app.example.com',
  env: 'production',
})
```

To get the keys, see [Get provider keys](../guide/provider-keys.md#transak).

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | required | Partner API key |
| `apiSecret` | `string` | required | Partner API secret |
| `referrerDomain` | `string` | required | Your web domain (or mobile package name), registered with Transak |
| `env` | `'staging' \| 'production'` | `'production'` | Staging uses the `-stg` hosts |
| `surface` | `'IFRAME' \| 'REDIRECT'` | `'IFRAME'` | How the widget opens (see the warning below) |
| `defaultCountry` | `string` | none | Country for quotes when the session has none |

## Legs

| Leg | Method | Fiat | Notes |
|---|---|---|---|
| `card` | `card` | any | `credit_debit_card` |
| `apple_pay` | `apple_pay` | any | |
| `google_pay` | `google_pay` | any | |
| `bank_transfer` | `bank_transfer` | EUR, USD | `sepa_bank_transfer` or `pm_wire` by currency; ETA 10 minutes to 3 days |
| `upi` | `upi` | INR | India only |
| `faster_payments` | `faster_payments` | GBP | `gbp_bank_transfer` (UK Faster Payments). GB only |
| `open_banking` | `open_banking` | GBP, EUR | `pm_open_banking` ("Easy Bank Transfer"). GB, IE, FR, DE, IT, ES, NL, EE, LV, LT, PT, BE, PL, DK |
| `pse` | `pse` | COP | `pm_pse`. Colombia only |

- The catalog also maps `pm_astropay` to `astropay`.
- Sources: the live list [`GET /api/v2/currencies/fiat-currencies`](https://api.transak.com/api/v2/currencies/fiat-currencies), the [Get Fiat Currencies example](https://docs.transak.com/api/public/get-fiat-currencies) and the [Transak fee table](https://transak.notion.site/On-Ramp-Payment-Methods-Fees-Other-Details-b0761634feed4b338a69f4f186d906a5).
- Delivers USDC on Base, Ethereum, Arbitrum, Optimism, Polygon and Solana.
- Live catalog: `GET /fiat/public/v1/currencies/fiat-currencies`, cached for one hour. For the session currency, it builds one leg per active payment option, with the supporting countries and the min and max amounts. Common methods keep the static leg ids.
- Surface: `IFRAME` (625 px high) by default.

## Quotes and start

- Access token: `POST /partners/api/v2/refresh-token`. It is valid for 7 days, and a new call invalidates the old token, so the adapter caches it (in memory and in the store) and refreshes one at a time.
- Quote: `GET /api/v1/pricing/public/quotes` with the fiat currency and amount, USDC, the network, the payment method and the country. Fees come from `feeBreakdown`. Quotes expire after 10 minutes.
- Start: `POST {gateway}/api/v2/auth/session` with `widgetParams` (wallet address locked, amount, payment method, `partnerOrderId`, `partnerCustomerId`, `redirectURL`, email and country when known). The widget URL is single-use and valid for 5 minutes, so it is made in `start()`.
- Reference: `partnerOrderId`, `ork_{random}`.
- There is no `status()`. Progress comes from webhooks only.

::: warning REDIRECT and the Referer header
Transak checks the browser's `Referer` against `referrerDomain`. The server's popup-safe start redirect sends `referrer-policy: no-referrer` unless the surface sets `keepReferrer: true`. This adapter sets `keepReferrer: true` on its `REDIRECT` surface, so the start redirect uses `referrer-policy: strict-origin` and sends the origin of your OpenRampKit server. That origin must match `referrerDomain`. The default `IFRAME` surface does not use the start redirect.
:::

## Webhooks

Set the webhook URL in the Transak partner dashboard to `{baseUrl}/webhooks/transak`.

- The body is `{ data: <JWT> }`, signed HS256 with the partner access token. The adapter verifies it with the cached token (in memory or in the store). If no token is cached yet (for example a fresh instance that has not quoted), verification fails and the adapter logs a warning.
- Status mapping (`webhookData.status`):

| Status | Leg |
|---|---|
| `COMPLETED` | `succeeded` with `transactionHash` |
| `FAILED`, `CANCELLED` | `failed` |
| `EXPIRED` | `expired` |
| `REFUNDED` | `refunded` |
| `PAYMENT_DONE_MARKED_BY_USER`, `PROCESSING`, `PENDING_DELIVERY_FROM_TRANSAK`, `ON_HOLD_PENDING_DELIVERY_FROM_TRANSAK` | `processing` |
| `AWAITING_PAYMENT_FROM_USER` | no change |

## Sandbox limits

Transak staging has 26 fiat currencies. INR is not one of them, so you cannot test UPI on staging. Checked on 9 Oct 2026. See [Get provider keys](../guide/provider-keys.md#sandbox-and-production).

## Verified vs TO VERIFY

- **TO VERIFY**: Transak network names for Arbitrum and Optimism (check with `GET /cryptocoins`).
- **TO VERIFY**: the UPI payment method id (`inr_upi`; partner-specific).
- **TO VERIFY**: `pm_pse` and `pm_astropay`. They are in the docs example, but not in the live list without a partner key. Your partner account may not have them.
- **TO VERIFY**: the bank transfer method for currencies other than EUR, GBP and USD (falls back to `sepa_bank_transfer`).
- The widget session call sends the end-user IP header `x-user-ip` when `ctx.session.ip` is known (the IP of the latest browser request).
