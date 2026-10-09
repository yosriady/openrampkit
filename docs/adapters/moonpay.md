# MoonPay

`@openrampkit/adapter-moonpay` is a fiat onramp through the [MoonPay](https://dev.moonpay.com) buy widget. It buys USDC with cards, Apple Pay, Google Pay, bank transfers, PIX, PayPal, Venmo, Revolut Pay and Interac.

::: info New adapter
This adapter is new. Some provider details are marked TO VERIFY in the source (listed below).
:::

```ts
import { moonpay } from '@openrampkit/adapter-moonpay'

moonpay({
  publishableKey: process.env.MOONPAY_PUBLISHABLE_KEY!, // pk_live_... or pk_test_...
  secretKey: process.env.MOONPAY_SECRET_KEY!,           // sk_...
  webhookKey: process.env.MOONPAY_WEBHOOK_KEY,
  env: 'production',
})
```

To get the keys, see [Get provider keys](../guide/provider-keys.md#moonpay).

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `publishableKey` | `string` | required | Publishable key |
| `secretKey` | `string` | required | Secret key. Signs widget URLs. |
| `env` | `'sandbox' \| 'production'` | required | Sandbox uses `https://buy-sandbox.moonpay.com` |
| `webhookKey` | `string` | none | Webhook API key from the dashboard. Without it, webhooks are rejected. |
| `surface` | `'redirect' \| 'iframe'` | `'redirect'` | How the widget opens |
| `methods` | `string[]` | all | Leg ids to offer |
| `deliverAssets` | `MoonPayDeliverAsset[]` | USDC on Base, Ethereum, Arbitrum, Optimism, Polygon | Assets MoonPay may deliver, most preferred first. A destination token that is not in the list gets no quote (`NO_QUOTES`). |
| `baseCurrencyDefault` | `string` | `'USD'` | Fiat currency when the quote has none |
| `extraFeePercentage` | `number` | none | Your fee in percent (set it up with MoonPay first) |
| `theme` | `'dark' \| 'light'` | none | Widget theme |
| `apiUrl`, `widgetUrl` | `string` | MoonPay defaults | Override the hosts |

## Legs

| Leg | Method | MoonPay `paymentMethod` | Fiat | Countries |
|---|---|---|---|---|
| `card` | `card` | `credit_debit_card` | any | all allowed |
| `apple_pay` | `apple_pay` | `apple_pay` | any | all allowed |
| `google_pay` | `google_pay` | `google_pay` | any | all allowed |
| `ach` | `ach` | `ach_bank_transfer` | USD | US |
| `sepa` | `sepa` | `sepa_bank_transfer` | EUR | EEA and CH |
| `gbp_bank` | `faster_payments` | `gbp_bank_transfer` | GBP | GB |
| `gbp_open_banking` | `open_banking` | `gbp_open_banking_payment` | GBP | GB |
| `pix` | `pix` | `pix_instant_payment` | BRL | BR |
| `paypal` | `paypal` | `paypal` | any | all allowed |
| `venmo` | `venmo` | `venmo` | USD | US |
| `revolut_pay` | `revolut_pay` | `revolut_pay` | any | all allowed |
| `interac` | `interac` | `interac` | CAD | CA |

- `gbp_bank_transfer` is UK Faster Payments. `gbp_open_banking_payment` is UK open banking. Source: [widget parameters](https://dev.moonpay.com/widget/on-ramp/customization/parameters.md) and the [buy quote enum](https://dev.moonpay.com/api-reference/widget/getbuyquote.md).
- SEPA Instant has no separate MoonPay id. It is part of `sepa_bank_transfer` ([supported payment methods](https://support.moonpay.com/en/articles/380823-moonpay-s-supported-payment-methods)).
- Regions: a static deny list of countries where MoonPay does not allow buying (from the live API on 2026-09-29), plus `US-VI`. The live catalog (`GET /v3/countries`, cached for a day) replaces it with the current allowed countries and denied US states.
- Some assets have extra limits: for example USDC on Base is not sold in New York or Canada. The quote then fails with `REGION_UNSUPPORTED`.

## Quotes and start

- Quote: `GET /v3/currencies/{code}/buy_quote` with `areFeesIncluded=true`, so the user pays exactly the amount they typed. Fees: MoonPay fee, network fee, and your extra fee.
- Start: a signed widget URL (base64 HMAC-SHA256 of the query string with the leading `?`, appended as `&signature=`). It locks the amount, sets the wallet address, the method, `externalTransactionId` (the leg ref, `ork_{random}`), `externalCustomerId` (the user id), and `redirectURL`.
- Status: `GET /v1/transactions/ext/{externalTransactionId}`. A 404 means the user has not paid yet.

| MoonPay status | Leg |
|---|---|
| `completed` | `succeeded` with `cryptoTransactionId` |
| `pending` | `processing` |
| `waitingPayment`, `waitingAuthorization` | `awaiting_user` |
| `failed` | `failed` |

## Webhooks

Set the webhook URL in the MoonPay dashboard to `{baseUrl}/webhooks/moonpay` and pass the webhook API key as `webhookKey`.

- Verification: header `Moonpay-Signature-V2: t=<unix>,s=<hex>`, HMAC-SHA256 of `{t}.{body}`, 5 minute tolerance.
- Events whose `type` starts with `transaction_` are parsed with the same status mapping.

## Sandbox limits

MoonPay test mode has USDC only as `usdc` (USDC on Ethereum). `usdc_base`, `usdc_arbitrum`, `usdc_optimism` and `usdc_polygon` are not in test mode. To test in test mode, quote USDC on Ethereum. A test mode quote for USDC on another chain fails. Base is first in the default `deliverAssets`, so set the destination to USDC on Ethereum for test mode. Checked on 9 Oct 2026. See [Get provider keys](../guide/provider-keys.md#sandbox-and-production).

## Verified vs TO VERIFY

- **TO VERIFY**: the recommended iframe `allow` list.
- **TO VERIFY**: Venmo through MoonPay is US-only.
- **TO VERIFY**: the webhook signature is hex (inferred from the example in the docs).
