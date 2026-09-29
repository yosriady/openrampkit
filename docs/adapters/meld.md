# Meld

`@openrampkit/adapter-meld` gets fiat onramp quotes from many providers through [Meld](https://docs.meld.io), picks the best one, and sends the user to that provider's widget.

::: info New adapter
This adapter is new and still in progress. Some provider details are marked TO VERIFY in the source (listed below).
:::

```ts
import { meld } from '@openrampkit/adapter-meld'

meld({
  apiKey: process.env.MELD_API_KEY!,
  env: 'production',
  webhookSecret: process.env.MELD_WEBHOOK_SECRET,
})
```

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | required | Sent as `Authorization: BASIC <apiKey>` |
| `env` | `'sandbox' \| 'production'` | required | Sandbox is `https://api-sb.meld.io` |
| `serviceProviders` | `string[]` | all on your account | Only quote these providers, e.g. `['TRANSAK', 'BANXA']` |
| `webhookSecret` | `string` | none | Webhook profile secret. Without it, webhooks are rejected. |
| `webhookUrl` | `string` | the request URL | The URL registered in the Meld profile (the signature covers it). Set it when a proxy rewrites URLs. |
| `deliverAssets` | `MeldDeliverAsset[]` | USDC on Base, Ethereum, Polygon, Arbitrum | Assets to buy, most preferred first |
| `defaultCountry` | `string` | `'US'` | Country for quotes when the session has none |
| `version` | `string` | `'2026-02-03'` | `Meld-Version` header |
| `apiUrl` | `string` | by `env` | API base URL |

## Legs

One leg per payment method. Static legs (used when the catalog fails): `card`, `apple_pay`, `google_pay`, `upi` (IN, INR), `pix` (BR, BRL), `binance_pay`, `sepa` (EUR countries), `ach` (US, USD). The live catalog (`GET /service-providers/properties/payment-methods`, cached for an hour per country and currency) builds the legs for the user's country and currency.

- Surface: `REDIRECT` to the chosen provider's widget (`serviceProviderWidgetUrl`, else Meld's hosted `widgetUrl`). The modal shows the provider's name.
- Delivers to `deliverTo.address` (a hop) or the destination address.

## Quotes and start

- Quote: `POST /payments/crypto/quote` returns one quote per provider. The one with the most crypto out is the leg quote. The full list is in `quote.data.providers`. Quotes expire after 5 minutes.
- Start: `POST /crypto/session/widget` (`sessionType: 'BUY'`) with the chosen provider, the wallet, the amount, `redirectUrl`, the user's IP when known, `externalCustomerId` (the user id) and `externalSessionId` (the leg ref, `ork_{random}`).
- Status: `GET /payments/transactions?externalSessionIds={ref}`.

| Meld status | Leg |
|---|---|
| `SETTLED` | `succeeded` |
| `PENDING_CREATED`, `TWO_FA_REQUIRED` | `awaiting_user` |
| `PENDING`, `SETTLING`, `TWO_FA_PROVIDED`, `ERROR`, `ACCEPTED`, `AUTHORIZED`, `PARTIALLY_SETTLED` | `processing` (`ERROR` is temporary at Meld) |
| `FAILED`, `DECLINED`, `CANCELLED`, `AUTHORIZATION_EXPIRED` | `failed` |
| `REFUNDED` | `refunded` |

## Webhooks

Create a Meld webhook profile with the URL `{baseUrl}/webhooks/meld` and pass its secret as `webhookSecret`.

- Verification: `Meld-Signature` is the base64url (with padding) HMAC-SHA256 of `{Meld-Signature-Timestamp}.{webhookUrl}.{body}`.
- Only `TRANSACTION_CRYPTO_*` events are read. On a settled event, the adapter reads the transaction for the amount and the transaction hash.

## Verified vs TO VERIFY

- Verified: the `USDC` (Ethereum) and `USDC_BASE` currency codes.
- **TO VERIFY**: `USDC_POLYGON` and `USDC_ARBITRUM`.
- **TO VERIFY**: the `UPI` and `BINANCE_PAY` payment method codes.
- **TO VERIFY**: Meld documents no timestamp tolerance for webhooks. The adapter rejects timestamps more than 5 minutes off.
