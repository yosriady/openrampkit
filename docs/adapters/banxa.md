# Banxa

`@openrampkit/adapter-banxa` is a direct fiat onramp through [Banxa](https://docs.banxa.com/products/hosted-checkout) Hosted Checkout (API integration). It buys USDC with cards, Apple Pay, Google Pay, bank transfers (SEPA, Faster Payments, PayID, NPP, iDEAL, Interac, SPEI, Khipu, South African bank transfer), Klarna, PayPal, VietQR and UPI.

::: info New adapter, not yet verified
This adapter is new. It is built from the Banxa docs, and no sandbox order has run through it yet. Some provider details are marked TO VERIFY in the source (listed below).
:::

```ts
import { banxa } from '@openrampkit/adapter-banxa'

banxa({
  partnerRef: process.env.BANXA_PARTNER_REF!,   // the first segment of every Banxa API path
  apiKey: process.env.BANXA_API_KEY!,           // v2 API key (x-api-key)
  hmacKey: process.env.BANXA_HMAC_KEY,          // HMAC key pair: Banxa signs webhooks with it
  hmacSecret: process.env.BANXA_HMAC_SECRET,
  env: 'production',
})
```

To get the keys, see [Get provider keys](../guide/provider-keys.md#banxa).

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `partnerRef` | `string` | required | Partner reference from Banxa onboarding. Every API path starts with it: `https://api.banxa.com/{partnerRef}/v2/...` |
| `apiKey` | `string` | required | The v2 API key, sent as `x-api-key` on every call. Server-side only. |
| `env` | `'sandbox' \| 'production'` | required | Sandbox uses `https://api.banxa-sandbox.com`, production `https://api.banxa.com`. The server checks `env` against `livemode`. |
| `hmacSecret` | `string` | none | Secret of the HMAC key pair. Banxa signs webhooks with it. Without it, webhooks are rejected and the adapter relies on status checks. |
| `hmacKey` | `string` | none | API key of the same HMAC pair. When set, a webhook must name this key. |
| `webhookPath` | `string` | the request path | The path of the webhook URL that Banxa calls (Banxa signs it). Set it when a proxy rewrites the path. |
| `surface` | `'redirect' \| 'iframe'` | `'redirect'` | How the checkout opens |
| `methods` | `string[]` | all | Leg ids to offer |
| `deliverAssets` | `BanxaDeliverAsset[]` | USDC on Base, Ethereum, Arbitrum, Optimism, Polygon | Assets Banxa may deliver, most preferred first. A destination token that is not in the list gets no quote (`NO_QUOTES`). |
| `subPartnerId` | `string` | none | Banxa `subPartnerId` on each order (a channel or site in your account) |
| `discountCode` | `string` | none | Banxa `discountCode` on each quote and order (sets your commission) |
| `baseCurrencyDefault` | `string` | `'USD'` | Fiat currency when the quote has none |
| `apiUrl` | `string` | Banxa default | Override the host |

Banxa has two credential types. The v2 API key (`apiKey`) calls every `/v2` endpoint. The HMAC key pair (`hmacKey`, `hmacSecret`) verifies webhooks. The adapter does not sign API calls with HMAC: Banxa uses HMAC signing only for KYC sharing (`POST /v2/identities/token/share`), which this adapter does not call.

## Legs

One `fiat_onramp` leg per payment method, from fiat in the user's account to crypto at an address. Every leg has `requires: ['provider_kyc']`: Banxa does KYC in its checkout.

| Leg | Method | Banxa `paymentMethodId` | Fiat | Countries |
|---|---|---|---|---|
| `card` | `card` | `debit-credit-card` | 28 currencies (AUD, CAD, EUR, GBP, USD and more) | all Banxa countries |
| `apple_pay` | `apple_pay` | `apple-pay` | same as card | all Banxa countries |
| `google_pay` | `google_pay` | `google-pay` | same as card | all Banxa countries |
| `sepa` | `sepa` | `sepa-bank-transfer` | EUR | EEA and CH |
| `gbp_bank` | `faster_payments` | `gbp-bank-transfer` | GBP | GB |
| `payid` | `payid` | `payid-bank-transfer` | AUD | AU |
| `npp` | `bank_transfer` | `npp-bank-transfer` | AUD | AU |
| `ideal` | `ideal` | `ideal-bank-transfer` | EUR | NL |
| `klarna` | `klarna` | `klarna-paynow` | EUR, SEK | AT, BE, FI, DE, NL, ES, SE |
| `paypal` | `paypal` | `paypal` | EUR | EEA |
| `interac` | `interac` | `interac-bank-transfer` | CAD | CA |
| `spei` | `spei` | `spei` | MXN | MX |
| `khipu` | `khipu` | `khipu` | CLP | CL |
| `zar_bank` | `bank_transfer` | `zar-bank-transfer` | ZAR | ZA |
| `vietqr` | `vietqr` | `viet-qr` | VND | VN |
| `upi` | `upi` | `upi` | INR | IN |

- Source: [Supported payment methods](https://docs.banxa.com/products/hosted-checkout/docs/reference/supported-payment-methods) (16 Oct 2026).
- ACH is not a leg: the Banxa docs say ACH is for sell orders only.
- Stablecoins are not sold in Canada, so with the default `deliverAssets` the `interac` leg gets `REGION_UNSUPPORTED`. Add a non-stablecoin asset to `deliverAssets` to use it.
- Regions: a static deny list of the countries Banxa does not serve ([geographic restrictions](https://docs.banxa.com/products/hosted-checkout/docs/reference/geographic-and-asset-restrictions)).

### Live catalog

`catalog()` reads `GET /v2/countries` and `GET /v2/payment-methods/buy`, cached for a day. Each method gets the fiats that Banxa lists for it, and the countries that Banxa serves. A method that Banxa does not list is dropped. A Banxa method that this adapter does not know becomes a leg with the id `bx_` plus the Banxa id (for example `bx_open_banking`), and its method id is the Banxa id in lowercase with `_`. If the catalog fails, the server uses the static legs.

## Quotes and start

- Quote: `GET /{partnerRef}/v2/quotes/buy` with `fiat`, `crypto`, `blockchain`, `paymentMethodId` and `fiatAmount` (or `cryptoAmount` for an exact output). It also sends `externalCustomerId` (the user id), `ipAddress` (when the server knows it) and `discountCode`.
- Blockchain codes: the adapter reads `GET /v2/crypto/buy` (cached for a day) and picks the Banxa blockchain code by the chain id (`network`) and token address. When that list fails, it uses the code in `deliverAssets`.
- Region rules per asset: `unsupportedCountries` from the crypto list (country, or US state), plus no stablecoins in Canada. A restricted asset gets `REGION_UNSUPPORTED` before the quote call.
- Limits: the per-method `minimum` and `maximum` from `GET /v2/fiats/buy` (cached for a day) give `AMOUNT_TOO_LOW` and `AMOUNT_TOO_HIGH` before the quote call.
- Fees, in the fiat currency, all `included: true`: the Banxa processing fee (`provider`), the network fee (`network`), the partner fee (`app`, when Banxa sends it), and the Banxa spread in the rate (`provider`, `amount: null`, because Banxa does not state it).
- The guarantee is `estimate`: Banxa quotes are display only, with no quote id, and the final price is set at checkout. The quote expires after 1 minute (Banxa gives no validity window and calls quotes short-lived).
- Start: `POST /{partnerRef}/v2/buy` with the amount, the payment method, the wallet address (`deliverTo` or the session destination), the blockchain, `redirectUrl` (the server's return URL), `externalCustomerId` (the user id, stable per user, so returning users skip repeat KYC), `externalOrderId` (the leg ref, `ork_{random}`), and `email` when known. Optional fields are left out, never `null` (Banxa answers `4002` to `null`).
- The answer has `checkoutUrl` and the Banxa order `id`. The leg returns a `REDIRECT` surface (a popup) to `checkoutUrl`, or an `IFRAME` with `surface: 'iframe'`. The checkout URL must load within 1 minute of the order; the UI opens it at once.
- `providerRef`: the Banxa order id (the long hash, which Banxa says to reconcile on).

### Iframe

With `surface: 'iframe'` the frame gets `allow="payment; camera; microphone; encrypted-media"` ([iframe docs](https://docs.banxa.com/products/hosted-checkout/docs/checkout-experience/iframe/iframe-web)). Banxa leaves the frame for a full redirect in three cases: the first KYC, Apple Pay, and browsers that block third-party cookies (Safari by default). Add `https://checkout.banxa.com` and `https://checkout.banxa-sandbox.com` to your CSP `frame-src`. The default `redirect` surface has none of these limits.

## Status

`status()` reads `GET /{partnerRef}/v2/orders/{orderId}` with the Banxa order id, which `start()` keeps in the session store. A 404 means the order is not there yet (the user is still in the checkout).

| Banxa status | Leg | Detail code |
|---|---|---|
| `pendingPayment` | `requires_action` (the user does KYC and pays in the checkout) | |
| `waitingPayment` | `processing` | `processing` |
| `paymentReceived` | `processing` | `settling` |
| `inProgress` | `processing` | `processing` |
| `extraVerification` | `processing` | `delayed` |
| `cryptoTransferred` | `processing` | `confirming` |
| `complete` | `succeeded`, with `transactionHash` as the `destination` transaction and `cryptoAmount` as the output | |
| `declined` | `failed`, `PAYMENT_FAILED` (recovery `retry_payment`) | |
| `cancelled` | `failed`, `PROVIDER_DECLINED` (recovery `contact_support`) | |
| `expired` | `expired` | |
| `refunded` | `refunded` | |
| other | no event: the adapter logs the unknown status once (`statusMap`), and the leg keeps its current step | |

- Only `complete` is a success. Banxa warns that `paymentReceived` can still end in `cancelled` after a risk review.
- Banxa says `expired` is not always final: a late payment can resume the order. The leg ends as `expired`; a later `complete` takes the server's late payment path.
- The raw Banxa status goes to `detail.providerStatus`.

## Webhooks

Set the webhook URL for each environment in the Banxa Partner Dashboard to `{baseUrl}/webhooks/banxa`, and pass the HMAC key pair as `hmacKey` and `hmacSecret`. Use **Send test** in the dashboard to check it.

- Verification: header `Authorization: Bearer {hmacKey}:{signature}:{nonce}`. The signature is the hex HMAC-SHA256, with the HMAC secret, of `POST\n{webhook path}\n{nonce}\n{raw body}`. The path is the path of your own webhook URL (for example `/api/openramp/webhooks/banxa`), not a Banxa path. The nonce is used exactly as received. The compare is constant time.
- No time window: Banxa says to treat the nonce as opaque, and it retries one delivery with the same payload for up to 2 hours. Replays are dropped by the replay key instead (below), and events only move a leg forward.
- Replay key and event id: `order_id`, `status` and `status_date` (Banxa suggests `order_id` and `status` for dedupe; `status_date` keeps a later return to the same status). Other bodies use the SHA-256 of the body.
- Events: order webhooks with `order_type: BUY` and our `external_id` (the leg ref), with the status table above. KYC, extra verification and account blocked webhooks carry no `external_id`, so they give no event; the order webhook and `status()` still report the order.
- A proxy that rewrites the path breaks the signature. Set `webhookPath` to the path that Banxa calls.

Without `hmacSecret`, the adapter rejects every webhook, and the server learns the result from `status()` (the browser poll and the background sweep). Banxa limits sandbox to 120 requests per minute, so set up webhooks in production.

## Errors

| Banxa answer | OpenRampKit error |
|---|---|
| `401` (wrong key or wrong environment) | `PROVIDER_UNAVAILABLE`, not retryable, with an operator log |
| `429` | `RATE_LIMITED` |
| `400` or `422` with code `5034` (coin restricted in the region) | `REGION_UNSUPPORTED` |
| `400` or `422` with a minimum or maximum message | `AMOUNT_TOO_LOW` or `AMOUNT_TOO_HIGH` |
| `400` or `422` with a KYC refusal message | `KYC_REJECTED` |
| other `400` or `422` | `NO_QUOTES` with the Banxa message |
| `5xx`, network error, timeout | `PROVIDER_UNAVAILABLE` (retryable) |

## Sandbox limits

- Sandbox orders do not always settle by themselves; Banxa may need to move a test order to `complete` by hand. No crypto moves on chain in sandbox.
- Sandbox prices are not refreshed at production frequency.
- Use mainnet address formats: sandbox rejects testnet addresses.
- Test card `4111 1111 1111 1111`, any future expiry, any CVV; the name on the card must match the billing name. Email code `7203`. See [sandbox test data](https://docs.banxa.com/products/hosted-checkout/docs/testing/sandbox-test-data).

## Verified vs TO VERIFY

Verified from the Banxa docs (16 Oct 2026), not yet against a live sandbox:

- Base URLs, the `{partnerRef}` path, `x-api-key` auth, and the endpoints and fields of quote, create order, order lookup, countries, payment methods, crypto and fiats.
- The order statuses and their meaning, and the webhook payload, signature, retries and dedupe advice.
- The payment method ids, fiats and countries, the deny list, the iframe permissions, and error code `5034`.

TO VERIFY (marked in the source):

- The Banxa blockchain codes for Base (`BASE`) and Arbitrum (`ARB`). The adapter prefers the live code from `GET /v2/crypto/buy` by chain id, so this matters only when that list fails.
- UPI as a buy method (in the order and quote id lists, not in the supported methods table).
- That `fiatAmount` in a quote already includes the processing and network fees (the docs suggest it).
- The shape of a Banxa error body (`code` and `message`), and the messages for amount limits and KYC refusals.
- Whether Banxa rejects a repeated `externalOrderId` (the adapter makes a new one for each start).
- Whether the signed webhook path includes a query string.

Before the TO VERIFY marks go: one sandbox order to `complete`, with webhooks and status checks, recorded as test fixtures.
