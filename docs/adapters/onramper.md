# Onramper

`@openrampkit/adapter-onramper` gets fiat onramp quotes from many providers through [Onramper](https://docs.onramper.com), picks the best payout, and sends the user to a signed checkout.

::: info New adapter
This adapter is new and still in progress. Some provider details are marked TO VERIFY in the source (listed below).
:::

```ts
import { onramper } from '@openrampkit/adapter-onramper'

onramper({
  apiKey: process.env.ONRAMPER_API_KEY!,          // pk_prod_... or pk_test_...
  secretKey: process.env.ONRAMPER_SIGNING_KEY!,   // Ed25519 private key (PKCS#8 PEM or base64 seed)
  webhookSecret: process.env.ONRAMPER_WEBHOOK_SECRET,
  env: 'production',
})
```

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | required | Sent as `Authorization` (no prefix) |
| `secretKey` | `string` | required | Ed25519 private key for "Signature V2". Give Onramper the public key at onboarding. |
| `env` | `'sandbox' \| 'production'` | required | Sandbox is `https://api-stg.onramper.com` |
| `webhookSecret` | `string` | none | Verifies webhooks, and is sent as `x-onramper-secret` for status reads |
| `onramps` | `string[]` | all | Only these onramps, e.g. `['moonpay', 'banxa']` |
| `deliverAssets` | `OnramperDeliverAsset[]` | USDC on Base, Ethereum, Polygon, Arbitrum | Assets to buy, most preferred first |
| `defaultCountry` | `string` | `'US'` | Country when the session has none |
| `apiUrl` | `string` | by `env` | API base URL |

The signing helpers are exported: `signV2`, `canonicalJson`, `canonicalStringV2`, `ed25519Sign`, `importEd25519Key`, `sha256Hex`.

## Legs

Static legs: `card`, `apple_pay`, `google_pay`, `sepa` (EUR countries), `ach` (US), `pix` (BR), `upi` (IN), and these regional methods:

| Leg and method | Onramper `paymentTypeId` | Countries | Fiat |
|---|---|---|---|
| `sepa_instant` | `sepainstant` | EUR countries | EUR |
| `faster_payments` | `fasterpaybank` | GB | GBP |
| `open_banking` | `fasterpayopen` (GBP), `openbanking` (EUR) | GB and EUR countries | GBP, EUR |
| `ideal` | `ideal` | NL | EUR |
| `bancontact` | `bancontact` | BE | EUR |
| `interac` | `interacetransfer` | CA | CAD |
| `spei` | `spei` | MX | MXN |
| `bancolombia` | `bancolombia` | CO | COP |
| `khipu` | `khipu` | CL | CLP |
| `imps` | `imps` | IN | INR |

The catalog also maps `sofort`, `mpesa`, `alipay`, `iach` (to `ach`), `paypal`, `venmo` and `revolutpay`. All ids are in the live list `GET /supported/payment-types`. The countries come from `GET /supported/payment-types/{fiat}?country=...` (both read on 2026-10-04).

The live catalog (`GET /supported/payment-types/{fiat}`, cached for an hour) builds legs for the user's currency and country, with limits.

- Surface: `REDIRECT` to the checkout. The modal shows the chosen onramp's name.

## Quotes and start

- Quote: `GET /quotes/{fiat}/{crypto}` returns one item per onramp. The best payout is the leg quote; the list is in `quote.data.providers`. Quotes expire after 5 minutes.
- Start: `POST /checkout/v2/intent`, signed with Ed25519 (headers `x-onramper-signature`, `-timestamp`, `-nonce`). The checkout is single-use, expires after 10 minutes, and is bound to the end user's IP (`endUserIpHash`). Without `ctx.session.ip`, start fails with `PROVIDER_UNAVAILABLE`.
- Reference: `partnerContext`, `ork_{random}`.
- Status: `GET /transactions/{transactionId}`. The transaction id is learnt from the first webhook, so until a webhook arrives (or without `webhookSecret`), status reports "still paying".

| Onramper status | Leg |
|---|---|
| `completed` | `succeeded` |
| `paid`, `pending` | `processing` |
| `new` | `awaiting_user` |
| `failed`, `canceled`, `cancelled` | `failed` |

## Webhooks

Ask your Onramper contact to send webhooks to `{baseUrl}/webhooks/onramper`.

- Verification: `X-Onramper-Webhook-Signature` is the hex HMAC-SHA256 of the raw body with `webhookSecret`. The signature has no timestamp.
- Replay protection: the adapter gives the SHA-256 of the raw body as the replay key (`webhook.replayKey`). The server keeps each key for 7 days in the adapter's shared store (`claimWebhook`, built on `claimOnce`). A repeat of the same body in that time gets `200` with `{ "received": true, "duplicate": true }` and changes nothing. When the server cannot apply the event yet (it answers `503`), it gives the key back, so the provider's retry still applies. The key is also the event id (`eventId`), so a session drops the same event twice.
- The adapter finds the leg by `partnerContext`.

## Verified vs TO VERIFY

- **Verified** (live API, 2026-10-04): the `pix` and `upi` payment type ids, and the regional ids in the table above.
- **TO VERIFY**: `mpesa` is in the global list, but no Kenya query returned it on 2026-10-04. It has no static leg.
