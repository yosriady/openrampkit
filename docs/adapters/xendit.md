# Xendit

`@openrampkit/adapter-xendit` takes fiat pay-ins into your own [Xendit](https://docs.xendit.co) account with the Payments API v3. It has QR rails (QRIS, QR Ph, PromptPay, PayNow QR) and e-wallets. There is no crypto: use it with a merchant destination. See the [merchant guide](../guide/merchant-destination.md).

```ts
import { xendit } from '@openrampkit/adapter-xendit'

xendit({
  secretKey: process.env.XENDIT_SECRET_KEY!,
  webhookToken: process.env.XENDIT_WEBHOOK_TOKEN!,
})
```

To get the keys, see [Get provider keys](../guide/provider-keys.md#xendit).

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
| `sg-paynow` | `SGQR` | SGD | 0.01 | 200,000 | `QR` |

Each leg allows only its country. Limits come from Xendit's channel pages.

PayNow QR uses the channel code `SGQR`, not `PAYNOW`. Source: the Xendit [PayNow QR channel page](https://docs.xendit.co/docs/paynow-qr) (read 2026-10-09). The leg id stays `sg-paynow`. With `PAYNOW`, Xendit test mode returns `400 API_VALIDATION_ERROR` "API endpoint and method is not supported for 'PAYNOW' channel code with country 'SG'".

## Quotes and start

- Quote: local. The amount is rounded to the currency's minor units and checked against the channel limits (`AMOUNT_TOO_LOW`, `AMOUNT_TOO_HIGH`). Fees come from the `fees` option. Quotes expire after 10 minutes.
- Start: `POST /v3/payment_requests` with `type: 'PAY'`, `capture_method: 'AUTOMATIC'`, the channel code, return URLs, and `metadata: { openramp_session, user_id }`. Header `api-version: 2024-11-11`. Idempotency key: `{sessionId}:xendit:{legId}:{nonce}`, with a new nonce per quote.
- Surface from the payment request's actions: `QR_STRING` gives a `QR`, `WEB_URL` gives a `REDIRECT`, `DEEPLINK_URL` gives a `DEEPLINK`.
- Status: `GET /v3/payment_requests/{id}`.

| Xendit status | Leg |
|---|---|
| `ACCEPTING_PAYMENTS`, `REQUIRES_ACTION` | `awaiting_user` (`PAYMENT`) |
| `AUTHORIZED` | `processing` |
| `SUCCEEDED` | `succeeded` |
| `FAILED`, `CANCELED` | `failed` with `PAYMENT_FAILED` |
| `EXPIRED` | `expired` |

Errors:

| Xendit answer | Error | Retryable |
|---|---|---|
| `429` | `RATE_LIMITED` | yes |
| `403 INVALID_MERCHANT_SETTINGS` ("payment channel has not been activated") | `PROVIDER_UNAVAILABLE`, recovery `choose_other` | no |
| `400 API_VALIDATION_ERROR` that names the channel ("... not supported for 'X' channel code") | `PROVIDER_UNAVAILABLE`, recovery `choose_other` | no |
| Other 4xx | `PROVIDER_DECLINED` with Xendit's message | no |
| 5xx, network errors | `PROVIDER_UNAVAILABLE` | yes |

The two setup errors show the user "This payment method is not set up for this app yet. Try another method." The adapter also writes an error log for the operator. The log names the method, the channel code and the country, and tells you what to do:

- `INVALID_MERCHANT_SETTINGS`: the channel is not active on your Xendit account. Activate the payment channel in the Xendit Dashboard. Do this in test mode for `xnd_development_` keys and again in live mode. A test mode check on 2026-10-09 gave this error for QRIS and QR Ph.
- `API_VALIDATION_ERROR` for a channel: the channel code or the request body does not agree with the Xendit API for that channel. Compare them with the [create payment request reference](https://docs.xendit.co/apidocs/create-payment-request) and the channel page.

## Webhooks

In the Xendit dashboard, set the payment webhook URL to `{baseUrl}/webhooks/xendit`.

- Verification: the `x-callback-token` header must equal `webhookToken`. The token is fixed, and the body has no signature or timestamp. Keep the token secret.
- Replay protection: the adapter gives the SHA-256 of the raw body as the replay key (`webhook.replayKey`). The server keeps each key for 7 days in the adapter's shared store (`claimWebhook`, built on `claimOnce`). A repeat of the same body in that time gets `200` with `{ "received": true, "duplicate": true }` and changes nothing. When the server cannot apply the event yet (it answers `503`), it gives the key back, so the provider's retry still applies. The key is also the event id (`eventId`), so a session drops the same event twice.
- `payment.capture` (or `data.status === 'SUCCEEDED'`) gives `succeeded`. The event has no output amount, because Xendit reports the gross amount and the quote output is net of fees. `payment.failure` (or `FAILED`) gives `failed`. Other events are ignored.

## Verified vs TO VERIFY

- **Verified (docs)**: PayNow QR uses channel code `SGQR` with `POST /v3/payment_requests`, min 0.01 SGD, max 200,000 SGD ([PayNow QR page](https://docs.xendit.co/docs/paynow-qr), read 2026-10-09).
- **TO VERIFY**: a live test mode payment request with `SGQR`. The account used on 2026-10-09 did not test it after the change.
- **TO VERIFY**: PromptPay. The PromptPay channel page gives `PROMPTPAY`, but an example in the create payment request reference uses `QRPROMPTPAY`. The adapter sends `PROMPTPAY`.
- **TO VERIFY**: DuitNow QR (Malaysia) is not in the list; its channel code must be checked with Xendit.
- **TO VERIFY**: VietQR is not in the list; it was not in Xendit's public channel list as of 2026-09.

## Notes

- The idempotency key has a nonce per quote. A retried start for the same quote reuses the first payment request. A restart with a new quote creates a new payment request.
- The webhook parser logs a warning and returns no events for a body that is not JSON, like the other adapters.
