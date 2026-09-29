# Xendit

`@openrampkit/adapter-xendit` takes fiat pay-ins into your own [Xendit](https://docs.xendit.co) account with the Payments API v3. It has QR rails (QRIS, QR Ph, PromptPay, PayNow) and e-wallets. There is no crypto: use it with a merchant destination. See the [merchant guide](../guide/merchant-destination.md).

```ts
import { xendit } from '@openrampkit/adapter-xendit'

xendit({
  secretKey: process.env.XENDIT_SECRET_KEY!,
  webhookToken: process.env.XENDIT_WEBHOOK_TOKEN!,
})
```

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `secretKey` | `string` | required | Secret API key (`xnd_development_...` or `xnd_production_...`) |
| `webhookToken` | `string` | required | Webhook verification token from Dashboard > Settings > Webhooks |
| `forUserId` | `string` | none | Sub-account id for xenPlatform (sent as `for-user-id`) |
| `apiUrl` | `string` | `https://api.xendit.co` | API base URL |
| `fees` | `Record<method, { bps?: number; fixed?: string }>` | none | Fee model for quotes (Xendit does not return fees) |
| `expiryMinutes` | `number` | `15` | Countdown shown on QR codes |
| `methods` | `string[]` | all | Offer only these methods |

## Legs

One leg per country and channel. The leg id is `{country}-{method}`, for example `id-qris`. Each leg takes one currency from `user_account` and delivers the same currency to `merchant_account`.

| Leg | Channel code | Currency | Min | Max | Surface |
|---|---|---|---|---|---|
| `id-qris` | `QRIS` | IDR | 1 | 10,000,000 | `QR` |
| `id-dana` | `DANA` | IDR | 1 | 10,000,000 | `REDIRECT`, `DEEPLINK` |
| `id-ovo` | `OVO` | IDR | 100 | 10,000,000 | `REDIRECT`, `DEEPLINK` |
| `id-shopeepay` | `SHOPEEPAY` | IDR | 1 | 10,000,000 | `REDIRECT`, `DEEPLINK` |
| `ph-qrph` | `QRPH` | PHP | 1 | 50,000 | `QR` |
| `ph-gcash` | `GCASH` | PHP | 1 | 100,000 | `REDIRECT`, `DEEPLINK` |
| `ph-maya` | `PAYMAYA` | PHP | 1 | 100,000 | `REDIRECT`, `DEEPLINK` |
| `ph-grabpay` | `GRABPAY` | PHP | 1 | 100,000 | `REDIRECT`, `DEEPLINK` |
| `th-promptpay` | `PROMPTPAY` | THB | 1 | 700,000 | `QR` |
| `th-truemoney` | `TRUEMONEY` | THB | 1 | 100,000 | `REDIRECT`, `DEEPLINK` |
| `my-touchngo` | `TOUCHNGO` | MYR | 1 | 10,000 | `REDIRECT`, `DEEPLINK` |
| `my-grabpay` | `GRABPAY` | MYR | 1 | 10,000 | `REDIRECT`, `DEEPLINK` |
| `vn-momo` | `MOMO` | VND | 1,000 | 50,000,000 | `REDIRECT`, `DEEPLINK` |
| `vn-zalopay` | `ZALOPAY` | VND | 1,000 | 50,000,000 | `REDIRECT`, `DEEPLINK` |
| `sg-paynow` | `PAYNOW` | SGD | 1 | 200,000 | `QR` |

Each leg allows only its country. Limits come from Xendit's channel pages.

## Quotes and start

- Quote: local. The amount is rounded to the currency's minor units and checked against the channel limits (`AMOUNT_TOO_LOW`, `AMOUNT_TOO_HIGH`). Fees come from the `fees` option. Quotes expire after 10 minutes.
- Start: `POST /v3/payment_requests` with `type: 'PAY'`, `capture_method: 'AUTOMATIC'`, the channel code, return URLs, and `metadata: { openramp_session, user_id }`. Header `api-version: 2024-11-11`. Idempotency key: `{sessionId}:xendit:{legId}:start`.
- Surface from the payment request's actions: `QR_STRING` gives a `QR`, `WEB_URL` gives a `REDIRECT`, `DEEPLINK_URL` gives a `DEEPLINK`.
- Status: `GET /v3/payment_requests/{id}`.

| Xendit status | Leg |
|---|---|
| `ACCEPTING_PAYMENTS`, `REQUIRES_ACTION` | `awaiting_user` (`PAYMENT`) |
| `AUTHORIZED` | `processing` |
| `SUCCEEDED` | `succeeded` |
| `FAILED`, `CANCELED` | `failed` with `PAYMENT_FAILED` |
| `EXPIRED` | `expired` |

Errors: HTTP 429 is `RATE_LIMITED`. Other 4xx is `PROVIDER_DECLINED` with Xendit's message. 5xx and network errors are `PROVIDER_UNAVAILABLE`.

## Webhooks

In the Xendit dashboard, set the payment webhook URL to `{baseUrl}/webhooks/xendit`.

- Verification: the `x-callback-token` header must equal `webhookToken`.
- `payment.capture` (or `data.status === 'SUCCEEDED'`) gives `succeeded` with the amount. `payment.failure` (or `FAILED`) gives `failed`. Other events are ignored.

## Verified vs TO VERIFY

- **TO VERIFY**: the PayNow QR channel code (`PAYNOW`).
- **TO VERIFY**: DuitNow QR (Malaysia) is not in the list; its channel code must be checked with Xendit.
- **TO VERIFY**: VietQR is not in the list; it was not in Xendit's public channel list as of 2026-09.

## Notes

- The idempotency key is the same for every start of the same leg in one session. If the user restarts and chooses the same method again with another amount, Xendit may return the first payment request or refuse the new one. Create a new session for a new attempt.
- The webhook parser throws on a body that is not JSON (the server then answers 400). Other adapters return no events instead.
