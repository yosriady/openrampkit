# Coinbase

`@openrampkit/adapter-coinbase` connects to [Coinbase Onramp](https://docs.cdp.coinbase.com/onramp). The user buys USDC with a card, Apple Pay, Google Pay, ACH or the balance of a Coinbase account. In the US, the user can also pay with Apple Pay as a guest, without a Coinbase account.

```ts
import { coinbase } from '@openrampkit/adapter-coinbase'

coinbase({
  apiKeyId: process.env.CDP_API_KEY_ID!,
  apiKeySecret: process.env.CDP_API_KEY_SECRET!,
  webhookSecret: process.env.CDP_WEBHOOK_SECRET,
  // Optional: guest Apple Pay in the US (Headless Onramp API)
  guestCheckout: { domain: 'app.example.com' },
})
```

::: warning Hosted flow needs a Coinbase account
Coinbase ended guest checkout in the hosted widget on 2026-06-30. The hosted legs (`card`, `apple_pay`, `google_pay`, `ach`, `coinbase_account`) need a Coinbase account. For guest Apple Pay, set `guestCheckout`. It uses the [Headless Onramp API](https://docs.cdp.coinbase.com/onramp/headless-onramp/overview).
:::

To get the keys, see [Get provider keys](../guide/provider-keys.md#coinbase).

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKeyId` | `string` | required | CDP Secret API key id (the key's `name` or `id`) |
| `apiKeySecret` | `string` | required | CDP Secret API key secret: base64 Ed25519 (the CDP default) or an EC PEM (SEC1 or PKCS#8) |
| `appId` | `string` | none | CDP project id. Not used by the session API. |
| `webhookSecret` | `string` | none | Secret of the CDP webhook subscription (`onramp.transaction.*`). Without it, webhooks are rejected. |
| `cdpApiUrl` | `string` | `https://api.cdp.coinbase.com` | CDP API (sessions, orders) |
| `onrampApiUrl` | `string` | `https://api.developer.coinbase.com` | Onramp API (config, status) |
| `defaultCountry` | `string` | `'US'` | Country when the session has none |
| `defaultSubdivision` | `string` | none | US state for quotes when the session has no region (Coinbase needs `subdivision` for US quotes) |
| `env` | `'sandbox' \| 'production'` | none: each session's `livemode` decides | `'sandbox'` prefixes `partnerUserRef` with `sandbox-`. The server checks it against `livemode`. |
| `sandbox` | `boolean` | none | Deprecated. `true` is `env: 'sandbox'`, `false` is `env: 'production'`. |
| `accountBalance` | `'FIAT_WALLET' \| 'CRYPTO_WALLET'` | `'FIAT_WALLET'` | The balance that the `coinbase_account` leg selects first. The user can pick another balance on the Coinbase page. |
| `guestCheckout` | `{ domain, verifiedContact? }` | none | Turns on the `guest_apple_pay` leg. See [Guest Apple Pay](#guest-apple-pay). |

The adapter signs a CDP JWT for each call with WebCrypto (EdDSA or ES256). The helpers `cdpJwt`, `importCdpKey` and `sec1ToPkcs8` are exported.

## Legs

| Leg | Method | Coinbase `paymentMethod` | Fiat | Regions | Surface |
|---|---|---|---|---|---|
| `card` | `card` | `CARD` | USD, EUR, GBP, CAD, AUD, SGD, CHF | All except JP | `REDIRECT` |
| `apple_pay` | `apple_pay` | `APPLE_PAY` | same | All except JP | `REDIRECT` |
| `google_pay` | `google_pay` | `CARD` | same | All except JP | `REDIRECT` |
| `ach` | `ach` | `ACH` (`ACH_BANK_ACCOUNT` in Buy Config) | USD | US | `REDIRECT` |
| `coinbase_account` | `coinbase_account` | `FIAT_WALLET` or `CRYPTO_WALLET` (`CRYPTO_ACCOUNT` in Buy Config) | same as `card` | All except JP | `REDIRECT` |
| `guest_apple_pay` | `apple_pay` | `GUEST_CHECKOUT_APPLE_PAY` | USD | US | `IFRAME` |

All legs deliver USDC on Base, Ethereum, Arbitrum, Optimism, Polygon or Solana.

- The `paymentMethod` values of the hosted legs come from the [session API](https://docs.cdp.coinbase.com/api-reference/v2/rest-api/onramp/create-an-onramp-session) (`CARD`, `ACH`, `APPLE_PAY`, `PAYPAL`, `FIAT_WALLET`, `CRYPTO_WALLET`). The enum has no Google Pay value, so `google_pay` is sent as `CARD`. PayPal is sell only ([payment methods](https://docs.cdp.coinbase.com/onramp/additional-resources/payment-methods)), so there is no PayPal leg.
- Regions: every country except `JP` ("available in all countries in which Coinbase operates except Japan").
- Live catalog: `GET /onramp/v1/buy/config`, cached for a day, sets the countries per payment method. If no country lists any method (an unexpected format), the static legs stay. The `guest_apple_pay` leg keeps its US region.

## Coinbase account balance

The `coinbase_account` method has the kind `exchange`, so the modal shows it with the crypto and exchange methods. The user signs in to Coinbase and pays from a USD (or other fiat) balance or from a crypto balance. Coinbase charges no Coinbase fee to send an existing crypto balance ([Onramp FAQ](https://docs.cdp.coinbase.com/onramp/additional-resources/faq)). The quote shows the fees that Coinbase returns.

## Guest Apple Pay

The `guest_apple_pay` leg uses the [Create Onramp Order API](https://docs.cdp.coinbase.com/api-reference/v2/rest-api/onramp/create-an-onramp-order). The user pays with Apple Pay in a Coinbase frame inside the modal. The user does not need a Coinbase account.

Limits from the Coinbase docs:

- US users only, with a real US cell phone number (not VoIP).
- Up to 2,500 USD each week. The minimum is about 5 USD. The leg shows `limits: { min: '5', max: '2500' }`.
- Debit cards only. Coinbase does not take credit cards in the US, and declines prepaid cards.
- Today, at most 15 guest transactions for each user in total, and 10 successful transactions each day.
- On the web, only Apple Pay. Google Pay works only in an Android WebView, so there is no guest Google Pay leg. Safari shows the Apple Pay sheet. Other browsers show a QR code that the user scans with an iPhone.

Setup:

1. Apply for Onramp access in the CDP portal. Coinbase gives Headless Onramp access when it approves the app.
2. Add the domain of the page that shows the modal to the Onramp domain allowlist (**Payments**, then **Onramp & Offramp**, in the CDP portal). Verify the domain with the file that Coinbase gives you. The domain must not be registered with another Apple Merchant ID.
3. Set `guestCheckout: { domain: 'app.example.com' }`.

Two modes:

- **Embedded order** (default, no `verifiedContact`): Coinbase collects and verifies the phone number and email in the frame, and shows the Coinbase terms. Coinbase must turn on embedded orders for your account. The adapter saves the `userAuthToken` from the order for 60 days, for each user and wallet. The next order of the same user to the same wallet sends it, so the user can skip the OTP step.
- **Standard order**: set `verifiedContact(ctx)` to return the user's `email`, `phoneNumber`, `agreementAcceptedAt` and `phoneNumberVerifiedAt` (or `smsVerificationId` and `emailVerificationId` from the Onramp Verification APIs). Your app must verify the email and phone with OTP first, and tell the user that they accept the Coinbase Guest Checkout Terms, User Agreement and Privacy Policy.

Flow:

- Quote: `POST /platform/v2/onramp/orders` with `isQuote: true`, `paymentMethod: GUEST_CHECKOUT_APPLE_PAY`, `paymentCurrency: USD`, the network, address, `domain`, `clientIp` and `locale`.
- Start: the same call with `isQuote: false`. The order's `paymentLink.url` opens in an `IFRAME` surface with `allow="payment"` and `referrerpolicy="no-referrer"`. In sandbox mode the adapter adds `useApplePaySandbox=true` to the link. Sandbox links work on `http://localhost` without domain setup.
- Frame events: the modal reads the Coinbase `postMessage` events (`eventName`). `onramp_api.commit_success` and `onramp_api.polling_success` make the modal check the status at once. `onramp_api.commit_error`, `onramp_api.polling_error` and `onramp_api.session_error` also do. `onramp_api.cancel` shows the "closed" notice. The server status is always the source of truth.
- Status: `GET /platform/v2/onramp/orders/{orderId}`. `ONRAMP_ORDER_STATUS_PENDING_*` gives `requires_action`, `PROCESSING` gives `processing`, `COMPLETED` gives `succeeded` and `FAILED` gives `failed`.
- Errors: `guest_transaction_limit` gives `AMOUNT_TOO_HIGH`. `guest_region_forbidden` gives `REGION_UNSUPPORTED`. `guest_permission_denied` and `guest_transaction_count` give `PROVIDER_DECLINED`.

If the user leaves the frame before paying, Coinbase sends no webhook and the order stays open. The session expires as usual.

## Quotes and start (hosted legs)

- Delivers USDC on Base, Ethereum, Arbitrum, Optimism, Polygon and Solana. Another token or chain gets no quote (`NO_QUOTES`). The adapter does not quote USDC on Base in its place.
- Quote: `POST /platform/v2/onramp/sessions` with the payment amount, currency and method, the country, the US subdivision (from `session.region` such as `US-CA`, else `defaultSubdivision`), the destination network and address, and `partnerUserRef`. It returns a quote and a single-use one-click URL.
- Start: reuses the quote's URL when it is less than 4 minutes old (session tokens last 5 minutes). Otherwise it makes a new session with the same method and location.
- Reference: `partnerUserRef`, `ork-{random}` (with `sandbox-` in front in sandbox mode). Guest orders use the same reference.
- Status: `GET /onramp/v1/buy/user/{partnerUserRef}/transactions?pageSize=1`.

## Webhooks

Create a CDP webhook subscription for `onramp.transaction.created`, `onramp.transaction.updated`, `onramp.transaction.success` and `onramp.transaction.failed` with the URL `{baseUrl}/webhooks/coinbase`. Pass its `metadata.secret` as `webhookSecret`. The same subscription sends hosted transaction events and guest order events.

- Verification: header `X-Hook0-Signature` with `t=...` and `v0=...`. `v0` is the hex HMAC-SHA256 of `{t}.{body}` ([verify signatures](https://docs.cdp.coinbase.com/webhooks/verify-signatures)). Timestamps older than 5 minutes are rejected.
- `ONRAMP_TRANSACTION_STATUS_SUCCESS`, `ONRAMP_ORDER_STATUS_COMPLETED` or `onramp.transaction.success` give `succeeded` (with the tx hash and amount). Statuses ending in `_FAILED` or `onramp.transaction.failed` give `failed`. `ONRAMP_ORDER_STATUS_PENDING_*` gives `requires_action`. Others give `processing`.

## Verified vs TO VERIFY

Verified in the CDP docs (2026-10-05):

- Buy Config response shape: `{ countries: [{ id, payment_methods: [{ id }], subdivisions }] }` (Onramp API spec). The older `{ data: { countries } }` shape is still accepted.
- Status query parameter: `pageSize` (camelCase, Onramp API spec).
- Network names `base`, `ethereum`, `polygon` and `solana`.
- The session API has no Google Pay value.
- Order API fields, statuses, payment link types, error types, post message events and the webhook signature.

Still TO VERIFY:

- **TO VERIFY**: Coinbase network names for Arbitrum and Optimism, and USDC on them (check with the Buy Options API).
- **TO VERIFY**: the fiat currency list per country.
- **TO VERIFY**: that the session API returns a quote for `FIAT_WALLET` and `CRYPTO_WALLET` with a fiat `paymentCurrency`.
- **TO VERIFY**: guest orders in currencies other than USD. The adapter sends USD only.
- **TO VERIFY**: that Coinbase accepts the modal's iframe sandbox. The docs ask for `allow-scripts allow-same-origin`. The modal adds `allow-forms` and popup tokens.
