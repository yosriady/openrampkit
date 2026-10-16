# Stripe Link (headless)

`@openrampkit/adapter-stripe-link` uses the Stripe [Embedded Components onramp](https://docs.stripe.com/crypto/onramp/embedded-components) to buy USDC in the US. The user signs in to Link. Then the purchase runs in your own screens. Stripe shows only small parts: the Link sign-in (a code and a consent screen), the Payment Element, the identity document check and 3DS.

The [Stripe](./stripe.md) adapter is different: it shows Stripe's full onramp UI (embedded or hosted).

::: warning Unverified
This adapter is built from Stripe's docs only. It is not tested against a Stripe account yet. The API is in private preview: no call works, also in a sandbox, until Stripe finishes your onboarding. Some details are marked TO VERIFY (listed below).
:::

```ts
import { stripeLink } from '@openrampkit/adapter-stripe-link'

stripeLink({
  secretKey: process.env.STRIPE_SECRET_KEY!,
  publishableKey: process.env.STRIPE_PUBLISHABLE_KEY!,
  oauthClientId: process.env.STRIPE_LINK_OAUTH_CLIENT_ID!,
  webhookSecret: process.env.STRIPE_LINK_WEBHOOK_SECRET!,
  tokenKey: process.env.STRIPE_LINK_TOKEN_KEY, // optional
})
```

To get the keys, see [Get provider keys](../guide/provider-keys.md#stripe-link).

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `secretKey` | `string` | required | Secret key of the onboarded account |
| `publishableKey` | `string` | required | Passed to the client for the Stripe SDK (`@stripe/crypto`) |
| `oauthClientId` | `string` | required | The Link OAuth client id from Stripe onboarding |
| `webhookSecret` | `string` | required | Endpoint secret (`whsec_...`) for `crypto.onramp_session.updated` |
| `tokenKey` | `string` | derived from `secretKey` | Secret (at least 32 characters) for the key that encrypts the Link access token in the session store. Set your own. |
| `requireSessionEmail` | `boolean` | `false` | Only the session's own `email` may sign in to Link. A session with no email cannot start the leg, and the email `FORM` never shows. A session email is always locked, also when this is `false`. |
| `methods` | `string[]` | all | Leg ids: `card`, `apple_pay`, `google_pay`, `ach` |
| `apiUrl` | `string` | `https://api.stripe.com` | API base URL |
| `linkUrl` | `string` | `https://login.link.com` | Link OAuth base URL |
| `stripeVersion` | `string` | `2026-09-30.endive;crypto_onramp_beta=v2` | The `Stripe-Version` header |
| `env` | `'sandbox' \| 'production'` | from the key prefix | `sk_test_` is `sandbox`; `sk_live_` is `production`. A value that does not agree with the key throws. |

## Legs

| Leg | Fiat | Countries | Payment Element |
|---|---|---|---|
| `card` | USD | US, not NY | `payment_method_types: ['card']` |
| `apple_pay` | USD | US, not NY | `['card']` with `wallets.applePay: 'auto'` |
| `google_pay` | USD | US, not NY | `['card']` with `wallets.googlePay: 'auto'` |
| `ach` | USD | US, not NY | `['us_bank_account']` |

- Delivers USDC on Base, Ethereum and Solana. Live mode adds Arbitrum, Polygon and Tempo (USDC.e). Stripe also lists Sui, World Chain and Celo, which the kit does not route yet. Another token or chain gets no quote (`NO_QUOTES`).
- Each leg declares the `PROVIDER_SDK` surface (the email `FORM` is a fallback), and needs `provider_account`, `provider_kyc` and `otp`.

## The flow

Each step is a `PROVIDER_SDK` surface with `provider: 'stripe-link'`. Its `params` hold `publishableKey` and a `step`. The client runs the Stripe SDK call for the step, then calls the transition. The server never sees the KYC data, the card or the bank account.

| Step | Phase | `params` | SDK call on the client | Then call the transition |
|---|---|---|---|---|
| Email (a `FORM`, only when the session has no `email`) | AUTH | | | `submit_email` with `{ email }` |
| `register_link_user` (no Link account for the email) | AUTH | `email`, `country` | `registerLinkUser({ email, phone, country, fullName })` | `link_registered` |
| `authenticate` | AUTH | `linkAuthIntentId` | `authenticate(linkAuthIntentId, cb)` | `link_authenticated` with `{ cryptoCustomerId, clientKey }` (`cryptoCustomerId` from the callback) |
| `submit_kyc_info` | KYC | | `submitKycInfo(kycInfo)` with your own form | `kyc_submitted` with `{ clientKey }` |
| `verify_documents` | KYC | | `verifyDocuments()` | `documents_verified` with `{ clientKey }` |
| `register_wallet_address` | PAYMENT | `walletAddress`, `network` | `registerWalletAddress(walletAddress, network)` | `wallet_registered` with `{ clientKey }` |
| `collect_payment_method` | PAYMENT | `paymentMethodTypes`, `wallets` | `collectPaymentMethod(...)` | `payment_method_collected` with `{ paymentToken, clientKey }` (`cpt_...`) |
| `perform_checkout` | PAYMENT | `onrampSessionId`, `clientSecret` | `performCheckout(onrampSessionId, cb)` | `checkout` with `{ clientKey }` (and `userAgent` for ACH) from inside `cb`; return the new `clientSecret` |

`clientKey` (the `STRIPE_LINK_CLIENT_KEY` export) is a random value of 32 to 128 URL-safe characters (for example 32 random bytes in base64url). The client makes it before `link_authenticated`, keeps it in memory, and sends the same value with every later transition. See [Security](#security).

The server skips a step when Stripe says it is done: KYC that is already verified, or a wallet that is already on file. While a KYC review runs, the leg waits in `processing` with phase `kyc`, and each status check asks Stripe again.

::: warning Client renderer
The kit has no `stripe-link` renderer yet. A renderer must call transitions with inputs and read the next step, which `ProviderRendererContext` does not offer today. Without any provider renderer, the planner shows these methods as "Not available" in the modal (`CLIENT_UPGRADE_REQUIRED`). The planner checks the surface kind, not the provider: when you give a renderer for another provider (for example `stripe`), also set `methods` or leave this adapter out until a `stripe-link` renderer exists. A headless app can drive the flow with `client.transition()`.
:::

## Link tokens

- The OAuth access token stays on the server. It is never in a step, an event or a log.
- The adapter seals it (AES-256-GCM, a key from HKDF-SHA256 of `tokenKey`; the additional data is the session id, the app user id, the leg ref and the checked crypto customer id) and keeps it in the session store for its lifetime minus 60 seconds (at most 1 hour).
- The adapter never keeps the refresh token. When the access token expires, the user signs in to Link again.
- The adapter drops the token when the payment leaves the checkout, when the leg fails, and on cancel.

## Security

The adapter binds the Link identity to the session and to the client that signed in.

- **Sign-in needs the account owner.** The server creates the LinkAuthIntent for the email. Only the owner of that Link account can approve it in the Stripe SDK (a one-time code and a consent screen). The server gets a token only from `POST /v1/link_auth_intent/{id}/tokens`, which Link refuses (403) until the owner approves. The intent id comes from the server's record, never from the client.
- **The email.** An email that the app sets on the session is locked: `submit_email` is refused. Set `requireSessionEmail: true` to allow only the app's email (use this when your app has verified the email). Without an app email, the user types one in the `FORM`. They can change it before the sign-in, but not after it. A person who types another person's email cannot finish the sign-in without that person's one-time code.
- **The crypto customer.** The client sends `cryptoCustomerId` from the SDK callback. Before the server keeps the token or uses the id, it reads `GET /v1/crypto/customers/{id}` with the new token, and Stripe must answer with the same id. Otherwise the token is not stored and a new sign-in starts.
- **The client key.** `link_authenticated` needs a `clientKey`. The server keeps only its SHA-256. Every later transition (KYC, documents, wallet, payment method, checkout) must send the same key. The key is never in a step, so another holder of a session credential (a [pay link](../guide/agents.md#the-pay-link), another device, a leaked client secret) cannot use the Link token. Before the onramp session exists, a missing or wrong key drops the token and starts a new sign-in. After it exists, `checkout` without the key is refused (403), and the leg stays as it is. A page reload loses the key, so the user signs in to Link again.
- **The session and the user.** The leg record holds the session id and the app user id, and every load checks them. The sealed token opens only for the same session, user, leg ref and crypto customer. The token key comes from `tokenKey`, so the token still opens after a server restart, but never for another session or user.
- **The stages.** Each transition runs only from its own stage (409 otherwise). A client cannot skip KYC, the wallet step or the payment method step.
- **The wallet.** The delivery address is the leg's own address, set by the server at start. The wallet step and the onramp session use only that address. A `walletAddress` input is ignored.
- **The payment token.** The client sends `paymentToken` (`cpt_...`) from the Payment Element. Only the client with the key can send it. Stripe ties a payment token to the Link customer. **TO VERIFY**: that Stripe refuses a payment token of another customer.
- **Status polls.** `status()` runs on the server (polls and sweeps) without a client key. It reads the session and the KYC state, and it can create the onramp session after a document review. It never calls checkout, so it never takes a payment.

## Quotes and start

- Quote: `GET /v1/crypto/onramp_quotes` with `ui_mode=headless` and the secret key only (no user token). `source_total_amount` is what the user pays. The fees are `transaction_fee_monetary` (`provider`) and `network_fee_monetary` (`network`), with `included: true`. The guarantee is `estimate`: Stripe sets the final amount when the session is created. Quotes expire after 5 minutes.
- Start: `POST https://login.link.com/v1/link_auth_intent` (JSON: `email`, `oauth_client_id`, `oauth_scopes: 'kyc.status:read,crypto:ramp'`). A 404 asks the client to register the user. A 409 (the user revoked the connection) fails the leg with `PROVIDER_DECLINED`.
- Sign-in done: `POST https://login.link.com/v1/link_auth_intent/{id}/tokens`.
- KYC and wallets: `GET /v1/crypto/customers/{crc}` and `GET /v1/crypto/customers/{crc}/crypto_consumer_wallets`.
- Session: `POST /v1/crypto/onramp_sessions` (form-encoded) with `ui_mode=headless`, `crypto_customer_id`, `payment_token`, the source amount, USDC, the network, `wallet_address`, `customer_ip_address` and metadata (`ork_ref`, `ork_session`, `ork_leg`). A 400 `crypto_onramp_missing_document_verification` asks for identity documents, then the adapter tries again.
- Checkout: `POST /v1/crypto/onramp_sessions/{id}/checkout`.
- Every api.stripe.com call sends `Authorization: Bearer <secret key>`, the `Stripe-Version` header and, for a user call, `Stripe-OAuth-Token`.
- Reference: our own `slk_...` id is the leg `ref`. The onramp session id (`cos_...`) is the `providerRef`.
- Status: `GET /v1/crypto/onramp_sessions/{id}`.

| Stripe status | Leg |
|---|---|
| `fulfillment_complete` | `succeeded`, with `transaction_id` as the `destination` transaction when it is a chain hash |
| `fulfillment_processing` | `processing`, detail code `processing` |
| `initialized`, `requires_payment` | `requires_action` (the checkout step) |
| `rejected` | `failed` with `PROVIDER_DECLINED` |
| other | no event: the leg keeps its current step |

## Webhooks

Add a webhook endpoint in the Stripe dashboard for `crypto.onramp_session.updated` with the URL `{baseUrl}/webhooks/stripe-link`, and pass its secret as `webhookSecret`. When `webhookSecret` is empty, the adapter refuses every webhook.

- Verification: `Stripe-Signature: t=...,v1=...`, hex HMAC-SHA256 of `{t}.{body}`, 5 minute tolerance. Any matching `v1` passes. The adapter checks it with `verifyTimestampedHmac` from `@openrampkit/adapter`.
- The adapter takes only sessions that it made. Its own index of session ids (written when it creates a session) comes first. `metadata.ork_ref` is used only when the index entry has expired (after 7 days). When both exist and do not agree, the event is ignored. Events of the [Stripe](./stripe.md) adapter are ignored.
- Replay key: the Stripe event id.

## Verified vs TO VERIFY

Verified in Stripe's docs (the web integration guide and the API reference, 2026-10-16): the endpoints, headers, parameters and response fields above, the OAuth scopes, the session statuses, the webhook event, the sandbox networks, and the payment method types.

- **TO VERIFY**: the KYC status values. The guide reads a `verifications` entry (`kyc_verified`, `not_started`); the API reference shows `kyc_tiers` with `verification_status`. The adapter reads both.
- **TO VERIFY**: the shape of the consumer wallet list (`data` with `wallet_address` and `network` is assumed).
- **TO VERIFY**: the `mandate_data` keys for ACH checkout (the guide names only the parameter).
- **TO VERIFY**: whether `transaction_id` holds the chain hash (the example shows a `cxt_...` id).
- **TO VERIFY**: whether a session retrieve needs `Stripe-OAuth-Token`.
- **TO VERIFY**: EUR and EU users (the guide says US only, but also shows EU sessions).
- **TO VERIFY**: the ACH delivery time.
