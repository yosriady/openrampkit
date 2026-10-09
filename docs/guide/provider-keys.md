# Get provider keys

This page tells you how to get the keys and settings that each adapter needs. For each provider, it gives:

- the access type,
- where to sign up, and the path to the keys in the dashboard,
- which values to copy, the adapter option for each value, and a suggested environment variable,
- how to change from sandbox to production,
- the webhook setup,
- the gotchas.

The facts on this page come from setting up the accounts on 9 Oct 2026. Dashboards change. When this page says "check in the dashboard", we did not confirm that detail.

You do not need any key to start. The [mock adapter](../adapters/mock.md) moves no money and needs no account. Add real providers one at a time.

## Summary

The times are estimates for the first sandbox key. Production access can take longer.

| Adapter | Access type | Keys needed | Time to get started |
|---|---|---|---|
| [Relay](#relay) | Self-serve | API key | About 5 minutes |
| [LI.FI](#lifi) | Self-serve | API key, integrator string | About 5 minutes |
| [MoonPay](#moonpay) | Self-serve sandbox; review (KYB) for live | Publishable key, secret key, webhook key | About 10 minutes |
| [Transak](#transak) | Self-serve sandbox; business profile for live | API key, API secret, referrer domain | About 10 minutes |
| [Xendit](#xendit) | Self-serve test mode | Secret key, webhook verification token | About 10 minutes |
| [Onramper](#onramper) | Self-serve sandbox after an onboarding form; paid plan and KYB for live | API key, Ed25519 signing key, webhook secret | About 15 minutes |
| [Coinbase](#coinbase) | Self-serve limited test access; application for full access | CDP Secret API key (id and secret), webhook secret | About 15 minutes |
| [Kotani Pay](#kotani) | Self-serve sandbox; production on request | API key, webhook signing secret | About 10 minutes |
| [Stripe](#stripe) | Application and review | Secret key, publishable key, webhook signing secret | Days (Stripe reviews the application) |
| [Swapped](#swapped) | Application (business onboarding) | Public key, secret key | Days |
| [Meld](#meld) | Sales (contact form) | API key, webhook secret | Days to weeks |
| [Bridge](#bridge) | Sales | API key, webhook public key | Days to weeks |
| [Binance](#binance) | Partner approval; no sandbox | API URL, client id, access token, RSA key pair, Binance public key | Weeks |
| [Peer](#peer) | Not recommended for production | API key, webhook secret | Not recommended |
| [Reown (WalletConnect)](#reown) | Self-serve | Project id (public) | About 5 minutes |

## Before you start

### The webhook URL

The server receives provider webhooks at one route per adapter:

```
POST {baseUrl}/webhooks/{adapterId}
```

`baseUrl` is the `baseUrl` that you give to `createOpenRamp`. `adapterId` is the id of the adapter, for example `moonpay`. Example: `https://app.example.com/api/openramp/webhooks/moonpay`. The adapter verifies each webhook with the secret or public key that you copy from the provider.

A provider cannot send a webhook to `localhost`. To test webhooks on your computer, use a tunnel to a public HTTPS URL. Set `baseUrl` to that URL.

### Sandbox and production

Each adapter has its own sandbox switch: an option (`env`, `sandbox` or `apiUrl`), or the key prefix. The sections below give the switch for each adapter. Also set `livemode: true` on `createOpenRamp` in production. Events then carry `livemode`, and adapters such as Coinbase leave sandbox mode.

## Keep keys safe

- Keep secret keys on the server only. Never put a secret key in a `NEXT_PUBLIC_` variable or in your client bundle.
- Put keys in an env file that git ignores. The repo ignores `.env`, `.env.local` and `.dev.vars`. In production, use your platform's secrets (for example `wrangler secret put` or the Vercel environment variables).
- Never paste keys into a chat, an issue, a pull request or a log.
- If a key was exposed, rotate it in the provider dashboard at once. Then update your env file and your platform secrets.
- Use a different key for each environment (local, staging, production). Then you can rotate one key and the other environments continue to work.
- The examples on this page show no real key values. The prefixes (for example `pk_test_`) only help you find the correct key.

## Relay {#relay}

**Access type:** self-serve.

**Sign up:** [dashboard.relay.link](https://dashboard.relay.link).

**Get the key:**

1. Create an organization.
2. Open **API keys**. Click **Create an API Key**.
3. Give the key a name, for example `staging`. Copy the key.

| Value | Adapter option | Env var |
|---|---|---|
| API key | `apiKey` | `RELAY_API_KEY` |

```ts
relay({ apiKey: process.env.RELAY_API_KEY })
```

The adapter sends the key in the `x-api-key` header.

**Sandbox and production:** the default API is `https://api.relay.link` (mainnets). For testnets, set `baseUrl: 'https://api.testnets.relay.link'`. Make one key for each environment. Check in the dashboard if a testnet key is different from a mainnet key.

**Webhooks:** the Relay adapter has no webhook handler. Status comes from polling. You can configure webhooks per key in the Relay dashboard, but the adapter does not use them.

**Gotchas:**

- Relay requires an API key for quotes (`POST /quote/v2`) under its announced policy from 2 Oct 2026. Some requests without a key may still work today, but Relay can refuse them at any time. Always set `RELAY_API_KEY`. A refused quote gets `401 UNAUTHORIZED_QUOTE`. A quote that sets `referrer` without a key is refused now.
- Without a key, status checks use `/requests/v2`. Relay retires it on 24 Nov 2026.

## LI.FI {#lifi}

**Access type:** self-serve.

**Sign up:** [portal.li.fi](https://portal.li.fi).

**Get the key:**

1. Open **Integrations**. Click **New integration**.
2. Give it a name.
3. Set the **integration string**. It is lowercase and you cannot change it later. This is the adapter's `integrator`.
4. Optional: add fee wallets. Skip this step if you charge no fee.
5. Click **Create API key**. Copy the key at once. LI.FI shows it one time only.

| Value | Adapter option | Env var |
|---|---|---|
| API key | `apiKey` | `LIFI_API_KEY` |
| Integration string | `integrator` | `LIFI_INTEGRATOR` |

```ts
lifi({ apiKey: process.env.LIFI_API_KEY, integrator: process.env.LIFI_INTEGRATOR })
```

The adapter sends the key in the `x-lifi-api-key` header.

**Sandbox and production:** the adapter has no sandbox switch. The API is `https://li.quest/v1` (`baseUrl`). Quotes move no money. A wallet transaction moves real funds, so test with small amounts.

**Webhooks:** the LI.FI adapter has no webhook handler. Status comes from polling.

**Gotchas:**

- With a key, the quote limit is about 12,000 requests in 2 hours. Without a key, it is 75 requests in 2 hours. The server quotes on each amount change, so you reach the keyless limit fast.
- A fee (`feeBps`) needs `integrator` and a fee wallet for that integration. Without a fee wallet, LI.FI refuses the quote (error code `1011`).
- If you lose the key, make a new one. You cannot see it again.

## MoonPay {#moonpay}

**Access type:** self-serve sandbox (Test mode). Live access needs a review (KYB).

**Sign up:** [dashboard.moonpay.com](https://dashboard.moonpay.com). A new account starts in Test mode.

**Get the keys:** open **Developers**, then **API Keys**. The page shows four keys:

| Value | Prefix in Test mode | Adapter option | Env var |
|---|---|---|---|
| Publishable Key | `pk_test_` | `publishableKey` | `MOONPAY_PUBLISHABLE_KEY` |
| Secret Key | `sk_test_` | `secretKey` | `MOONPAY_SECRET_KEY` |
| Webhook Key | `wk_test_` | `webhookKey` | `MOONPAY_WEBHOOK_KEY` |
| Public Key | | not used | |

```ts
moonpay({
  publishableKey: process.env.MOONPAY_PUBLISHABLE_KEY!,
  secretKey: process.env.MOONPAY_SECRET_KEY!,
  webhookKey: process.env.MOONPAY_WEBHOOK_KEY,
  env: 'sandbox',
})
```

**Sandbox and production:** set `env: 'sandbox'` with the `_test_` keys. Set `env: 'production'` with the live keys. `env` is required. To go live, click **Start review** in the dashboard and complete KYB.

**Webhooks:** register `{baseUrl}/webhooks/moonpay` in the dashboard (check in the dashboard for the exact page). Copy the Webhook Key to `webhookKey`. Without `webhookKey`, the adapter rejects every webhook.

**Gotchas:**

- The "refresh" icon next to each key rotates that key. The old key stops at once. Do not click it unless you want a new key.
- Test mode does not support every currency. For example, `usdc_base` returned "Currency not supported in test mode". Use `deliverAssets` to pick an asset that Test mode supports.
- `env` must agree with the keys. A live key with `env: 'sandbox'` (or the reverse) does not work.

## Transak {#transak}

**Access type:** self-serve sandbox (Staging). Live access needs a business profile.

**Sign up:** [dashboard.transak.com](https://dashboard.transak.com).

**Get the keys:**

1. At the top of the dashboard, change the environment selector from **Production** to **Staging**.
2. Open **Developers**. Copy the **API Key**.
3. Click **Generate** to make the **API Secret**. Copy it.
4. Register your web domain as the referrer domain (check in the dashboard for the exact page).

| Value | Adapter option | Env var |
|---|---|---|
| API Key | `apiKey` | `TRANSAK_API_KEY` |
| API Secret | `apiSecret` | `TRANSAK_API_SECRET` |
| Your domain, for example `app.example.com` | `referrerDomain` | `TRANSAK_REFERRER_DOMAIN` |

```ts
transak({
  apiKey: process.env.TRANSAK_API_KEY!,
  apiSecret: process.env.TRANSAK_API_SECRET!,
  referrerDomain: process.env.TRANSAK_REFERRER_DOMAIN!,
  env: 'staging',
})
```

The adapter uses the secret to get an access token: `POST https://api-stg.transak.com/partners/api/v2/refresh-token` with the header `api-secret` and the body `{ apiKey }`. It does this for you.

**Sandbox and production:** set `env: 'staging'` with Staging keys. The default is `'production'`. To go live, click **Complete your business profile** in the dashboard. Then copy the Production keys.

**Webhooks:** register `{baseUrl}/webhooks/transak` in the Transak dashboard (check in the dashboard for the exact page). There is no separate webhook secret: Transak signs webhooks with the access token, and the adapter keeps that token.

**Gotchas:**

- If you forget `env: 'staging'`, the adapter sends Staging keys to the production API, and every call fails.
- Partners must make widget URLs on the server (Secure Widget URL). The adapter does this in `start()`.
- A new access token cancels the old token. Do not share one API key between two deployments (for example your computer and staging). Each deployment refreshes the token and stops the other one.
- The adapter verifies a webhook with the cached access token. Before webhooks arrive, run at least one quote or start on the instance, or use a shared store.

## Xendit {#xendit}

**Access type:** self-serve test mode.

**Sign up:** [dashboard.xendit.co](https://dashboard.xendit.co). Use **Test mode**.

**Get the keys:**

1. Open **Settings**, then **Developers**, then **API keys**.
2. Click **Generate secret key**. In Test mode, the key starts with `xnd_development_`.
3. Set the permissions. The adapter calls the Payments API v3 (`POST /v3/payment_requests` and `GET /v3/payment_requests/{id}`). Give the key write permission for the money-in (payment request) products. Check in the dashboard for the exact permission names.
4. Open **Settings**, then **Webhooks**. Copy the **Webhook verification token**.
5. Activate each payment channel that you offer (for example QRIS, QR Ph, PayNow QR, DANA). Do this in **Test mode** first, and again in live mode. Check in the dashboard for the exact page name. A channel that is not active fails with `403 INVALID_MERCHANT_SETTINGS`.

| Value | Adapter option | Env var |
|---|---|---|
| Secret key | `secretKey` | `XENDIT_SECRET_KEY` |
| Webhook verification token | `webhookToken` | `XENDIT_WEBHOOK_TOKEN` |

```ts
xendit({ secretKey: process.env.XENDIT_SECRET_KEY!, webhookToken: process.env.XENDIT_WEBHOOK_TOKEN! })
```

**Sandbox and production:** the key prefix sets the mode. `xnd_development_` keys use test mode. `xnd_production_` keys move real money. The API URL is the same (`apiUrl`, default `https://api.xendit.co`). Copy the webhook token of the same mode as the key (check in the dashboard).

**Webhooks:** in **Settings**, then **Webhooks**, set the payment webhook URL to `{baseUrl}/webhooks/xendit`. The adapter compares the `x-callback-token` header with `webhookToken`.

**Gotchas:**

- A key with no read permission on balance gets `403` on `GET /balance`. The adapter does not call `/balance`, so this is not a problem.
- The webhook token has no signature or timestamp. Keep it as secret as the API key.
- Xendit has no crypto. Use the adapter with a [merchant destination](./merchant-destination.md).
- Activate each payment channel before you use it. Do this in test mode and again in live mode. A channel that is not active gets `403 INVALID_MERCHANT_SETTINGS` "payment channel has not been activated". On 2026-10-09, a new test mode account got this error for QRIS and QR Ph, while DANA worked. The adapter shows the user "This payment method is not set up for this app yet" and writes an error log that names the channel. See [Xendit errors](../adapters/xendit.md#quotes-and-start).
- PayNow QR uses the channel code `SGQR`. The old code `PAYNOW` gets `400 API_VALIDATION_ERROR` "API endpoint and method is not supported for 'PAYNOW' channel code with country 'SG'".

## Onramper {#onramper}

**Access type:** self-serve sandbox after an onboarding form. Live access needs a paid subscription and KYB.

**Sign up:** [dashboard.onramper.com/users/sign_up](https://dashboard.onramper.com/users/sign_up). Then complete the onboarding form: entity, project, industry, country, expected volume and go-live date.

**Get the keys:**

1. After the form, the dashboard shows a **Staging API Key** (`pk_test_...`). Copy it.
2. Find the signing key and the webhook secret in the dashboard settings. Check in the dashboard for the exact page.

The adapter option `secretKey` is an Ed25519 private key for "Signature V2". It accepts a PKCS#8 PEM, base64 PKCS#8 DER, or a 32-byte seed (base64 or hex). If you make the key pair yourself, give Onramper the public key:

```sh
openssl genpkey -algorithm ed25519 -out onramper-private.pem   # secretKey
openssl pkey -in onramper-private.pem -pubout -out onramper-public.pem   # give to Onramper
```

Check in the dashboard if Onramper makes the key for you, or if you upload your public key.

| Value | Adapter option | Env var |
|---|---|---|
| API key (`pk_test_...` or `pk_prod_...`) | `apiKey` | `ONRAMPER_API_KEY` |
| Ed25519 private key | `secretKey` | `ONRAMPER_SIGNING_KEY` |
| Webhook secret | `webhookSecret` | `ONRAMPER_WEBHOOK_SECRET` |

```ts
onramper({
  apiKey: process.env.ONRAMPER_API_KEY!,
  secretKey: process.env.ONRAMPER_SIGNING_KEY!,
  webhookSecret: process.env.ONRAMPER_WEBHOOK_SECRET,
  env: 'sandbox',
})
```

**Sandbox and production:** set `env: 'sandbox'` with the `pk_test_` key (API `https://api-stg.onramper.com`). Set `env: 'production'` with the `pk_prod_` key. `env` is required.

**Webhooks:** send `{baseUrl}/webhooks/onramper` to Onramper (in the dashboard or through your Onramper contact; check in the dashboard). Copy the webhook secret to `webhookSecret`.

**Gotchas:**

- Without `webhookSecret`, the adapter cannot learn the transaction id, and status stays "still paying".
- The checkout is bound to the user's IP. Without a client IP header, start fails.
- Register the public key before the first start. Without it, start gets `401` `{"errorId":4011,"message":"No V2 signing key is registered for this API key..."}`. The [Onramper key setup page](https://docs.onramper.com/docs/get-set-up-keys-onboarding) says to send the public key (PEM) to your Onramper account manager or support. Use one key pair for staging and another for production. The adapter logs this as a setup error and does not retry.
- Onramper also wants the server egress IPs and your domains on its allowlist. A server call from another IP gets `403`.
- The adapter does not accept a PEM with `\n` escapes. A PEM with real new lines works. For a one-line env var, use the base64 DER form: `openssl pkey -in onramper-private.pem -outform DER | base64`.

## Coinbase {#coinbase}

**Access type:** self-serve limited test access. Full access needs an application.

**Sign up:** sign in at [portal.cdp.coinbase.com](https://portal.cdp.coinbase.com). Pick a project.

**Get the keys:**

1. Open **Payments**, then **Onramp & Offramp**.
2. In **Configuration**, set the **Application display name**. Add your domain to the **Domain allowlist**. The `redirectUrl` must be on this list.
3. Open **API keys**. Create a **Secret API key**. Copy the key id and the secret at once. The portal shows the secret one time only.
4. Create the Onramp webhook subscription and copy its secret (check in the portal for the exact page).
5. For full access, click **Apply for access**.

| Value | Adapter option | Env var |
|---|---|---|
| Secret API key id (the key `name` or `id`) | `apiKeyId` | `CDP_API_KEY_ID` |
| Secret API key secret (base64 Ed25519 or EC PEM) | `apiKeySecret` | `CDP_API_KEY_SECRET` |
| Onramp webhook secret | `webhookSecret` | `CDP_WEBHOOK_SECRET` |
| Project id (optional, not used by the session API) | `appId` | `CDP_PROJECT_ID` |

```ts
coinbase({
  apiKeyId: process.env.CDP_API_KEY_ID!,
  apiKeySecret: process.env.CDP_API_KEY_SECRET!,
  webhookSecret: process.env.CDP_WEBHOOK_SECRET,
})
```

**Sandbox and production:** the `sandbox` option sets sandbox mode. Its default is `!livemode`: with `livemode: true` on `createOpenRamp`, the adapter leaves sandbox mode. A new project has limited test access: 25 test transactions, at most 5 USD each.

**Webhooks:** subscribe to `onramp.transaction.created`, `onramp.transaction.updated`, `onramp.transaction.success` and `onramp.transaction.failed` with the URL `{baseUrl}/webhooks/coinbase`. Copy the subscription secret to `webhookSecret`. Without it, the adapter rejects every webhook.

**Gotchas:**

- Guest Apple Pay (`guestCheckout`, the headless flow) needs extra approval from Coinbase. Its `domain` must be on the domain allowlist.
- The hosted legs need a Coinbase account for each user.
- Copy the secret when you create the key. If you lose it, make a new key.

## Kotani Pay {#kotani}

**Access type:** self-serve sandbox. Production on request.

**Sign up:** [integrator.kotanipay.com](https://integrator.kotanipay.com/register).

**Get the keys:**

1. Open **API Keys**. Click **Generate New Key**. Use an integrator-level key (it has all permissions). Copy the API key.
2. Optional: for request signing, click **Generate Secure Key**. It gives a key and a secret.
3. Open **Settings**. Set the webhook URL. Copy the webhook signing secret.
4. Ask Kotani Pay to turn on the countries that you need.

| Value | Adapter option | Env var |
|---|---|---|
| API key | `apiKey` | `KOTANI_API_KEY` |
| Webhook signing secret | `webhookSecret` | `KOTANI_WEBHOOK_SECRET` |
| Secure key secret (only with request signing) | `apiSecret` | `KOTANI_API_SECRET` |

```ts
kotani({
  apiKey: process.env.KOTANI_API_KEY!,
  webhookSecret: process.env.KOTANI_WEBHOOK_SECRET,
  sandbox: true,
})
```

**Sandbox and production:** set `sandbox: true` for `https://sandbox-api.kotanipay.io`. The default is production. For production, ask Kotani Pay for a production account, then make a new key in the **Production** environment. Sandbox keys do not work in production.

**Webhooks:** in **Settings**, set the webhook URL to `{baseUrl}/webhooks/kotani`. Without `webhookSecret`, the adapter rejects every callback and uses polling only.

**Gotchas:**

- For withdrawals, fund your payout balance in each payout currency.
- `feeBearer` must agree with the billing setting of your Kotani Pay wallet.

## Stripe {#stripe}

**Access type:** application and review.

**Sign up:** in the [Stripe dashboard](https://dashboard.stripe.com), open **Crypto onramp**, then **Get started**.

**Apply:**

1. Update the domains where the onramp runs.
2. Click **Submit your Stripe application**. Give your business details, a business description, the answer to the Terms of Service question (yes or no), and whether you fill in the wallet address for the user.
3. Wait for approval. Check in the dashboard if the onramp works in test mode before approval.

**Get the keys:** the adapter uses the API keys of your Stripe account. Open **Developers**, then **API keys** (check in the dashboard). A restricted key with onramp access also works.

| Value | Adapter option | Env var |
|---|---|---|
| Secret key (`sk_test_...` in test mode) | `secretKey` | `STRIPE_SECRET_KEY` |
| Publishable key (`pk_test_...` in test mode) | `publishableKey` | `STRIPE_PUBLISHABLE_KEY` |
| Webhook signing secret (`whsec_...`) | `webhookSecret` | `STRIPE_WEBHOOK_SECRET` |

```ts
stripe({
  secretKey: process.env.STRIPE_SECRET_KEY!,
  publishableKey: process.env.STRIPE_PUBLISHABLE_KEY!,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
})
```

**Sandbox and production:** the key prefix sets the mode. `sk_test_` and `pk_test_` keys use test mode. Live keys start with `sk_live_` and `pk_live_`. There is no `env` option.

**Webhooks:** open **Developers**, then **Webhooks**. Add an endpoint with the URL `{baseUrl}/webhooks/stripe` and the event `crypto.onramp_session.updated`. Copy its signing secret to `webhookSecret`. Test mode and live mode have different endpoints and secrets.

**Gotchas:**

- The publishable key goes to the browser for the embedded onramp. That is safe. The secret key must stay on the server.
- Set `providerRenderers: { stripe: stripeOnrampRenderer() }` on the modal, or `surface: 'redirect'` on the adapter. See [Stripe](../adapters/stripe.md).

## Swapped {#swapped}

**Access type:** application (business onboarding). We saw no self-serve sandbox.

**Sign up:** apply through Swapped business onboarding (see [docs.swapped.com](https://docs.swapped.com)). Swapped gives you the keys after onboarding. Check in the dashboard for the path.

| Value | Adapter option | Env var |
|---|---|---|
| Public key (`pk_...`) | `publicKey` | `SWAPPED_PUBLIC_KEY` |
| Secret key (`sk_...`) | `secretKey` | `SWAPPED_SECRET_KEY` |

```ts
swapped({
  publicKey: process.env.SWAPPED_PUBLIC_KEY!,
  secretKey: process.env.SWAPPED_SECRET_KEY!,
  env: 'sandbox',
})
```

**Sandbox and production:** set `env: 'sandbox'` for `https://sandbox.swapped.com`. The default is `'production'`. The sandbox has BTC and ETH testnets and test cards only.

**Webhooks:** you do not register a URL. The adapter puts `{baseUrl}/webhooks/swapped` in each widget URL as `responseUrl`. The adapter verifies notifications with `secretKey`.

**Gotchas:**

- An empty `secretKey` makes the adapter refuse every notification.

## Meld {#meld}

**Access type:** sales. We saw no self-serve sandbox: the sign-up sent us to a "Sandbox access" contact form.

**Sign up:** fill in the contact form on [meld.io](https://www.meld.io). Meld gives you a dashboard after the call. Check in the dashboard for the path to the API key.

| Value | Adapter option | Env var |
|---|---|---|
| API key | `apiKey` | `MELD_API_KEY` |
| Webhook profile secret | `webhookSecret` | `MELD_WEBHOOK_SECRET` |

```ts
meld({
  apiKey: process.env.MELD_API_KEY!,
  env: 'sandbox',
  webhookSecret: process.env.MELD_WEBHOOK_SECRET,
})
```

**Sandbox and production:** set `env: 'sandbox'` for `https://api-sb.meld.io`, or `env: 'production'`. `env` is required.

**Webhooks:** create a webhook profile with the URL `{baseUrl}/webhooks/meld`. Copy its secret to `webhookSecret`.

**Gotchas:**

- The signature covers the webhook URL. If a proxy rewrites the URL, set `webhookUrl` to the URL in the Meld profile.

## Bridge {#bridge}

**Access type:** sales. Production needs KYB of your company.

**Sign up:** contact Bridge sales. For a sandbox key, write to support@bridge.xyz. Then make a sandbox key in the dashboard with the **Sandbox** toggle on. Only dashboard admins can make keys.

| Value | Adapter option | Env var |
|---|---|---|
| API key (`sk-test-...` in the sandbox) | `apiKey` | `BRIDGE_API_KEY` |
| Webhook endpoint public key (PEM) | `webhookPublicKey` | `BRIDGE_WEBHOOK_PUBLIC_KEY` |

```ts
bridge({
  apiKey: process.env.BRIDGE_API_KEY!,
  webhookPublicKey: process.env.BRIDGE_WEBHOOK_PUBLIC_KEY!,
  env: 'sandbox',
})
```

**Sandbox and production:** set `env: 'sandbox'` for `https://api.sandbox.bridge.xyz`. The default is `'production'`. In the sandbox, KYC links do not work, no money moves, and Bridge sends no payment webhooks.

**Webhooks:** Bridge signs webhooks with an RSA key, one key for each endpoint.

1. Create the endpoint with `POST /v0/webhooks` and the URL `{baseUrl}/webhooks/bridge`.
2. Copy the `public_key` from the answer to `webhookPublicKey`.
3. Turn the endpoint on with `PUT /v0/webhooks/{id}` and `status: 'active'`. A new endpoint is disabled.

See [Bridge webhooks](../adapters/bridge.md#webhooks).

**Gotchas:**

- A new webhook endpoint has a new public key. Update `webhookPublicKey` when you make a new endpoint.

## Binance {#binance}

**Access type:** partner approval. There is no sandbox.

**Sign up:** contact the Binance Pay Onchain team. See [Binance access requirements](../adapters/binance.md#access-requirements).

**You send to Binance:**

- your RSA public key (make the key pair with OpenSSL; see the adapter page),
- the IP addresses of your server,
- your webhook URL: `{baseUrl}/webhooks/binance`,
- the domains of your redirect URLs,
- a logo (80 x 80 pixel PNG).

**Binance gives you:**

| Value | Adapter option | Env var |
|---|---|---|
| API base URL | `apiUrl` | `BINANCE_API_URL` |
| Client id | `clientId` | `BINANCE_CLIENT_ID` |
| Access token | `accessToken` | `BINANCE_ACCESS_TOKEN` |
| Webhook public key | `binancePublicKey` | `BINANCE_WEBHOOK_PUBLIC_KEY` |
| Partner code | `webhookPartnerCode` (optional) | `BINANCE_PARTNER_CODE` |
| Your RSA private key (you keep it) | `privateKey` | `BINANCE_PRIVATE_KEY` |

```ts
binance({
  apiUrl: process.env.BINANCE_API_URL!,
  clientId: process.env.BINANCE_CLIENT_ID!,
  accessToken: process.env.BINANCE_ACCESS_TOKEN!,
  privateKey: process.env.BINANCE_PRIVATE_KEY!,
  binancePublicKey: process.env.BINANCE_WEBHOOK_PUBLIC_KEY!,
})
```

**Sandbox and production:** there is no sandbox. Each call goes to the live API.

**Webhooks:** you give Binance the webhook URL during onboarding. The adapter verifies webhooks with `binancePublicKey`.

**Gotchas:**

- Binance allows calls only from the server IPs that you sent. A platform with changing IPs needs a fixed outbound IP.
- The adapter was not tested against the live API. Read the TO VERIFY notes on the [Binance](../adapters/binance.md) page.

## Peer {#peer}

**Access type:** not recommended for production. Peer is a peer-to-peer marketplace. It has legal risk, and paying strangers for crypto may breach the payment apps' terms. The adapter is off by default: the factory throws unless you pass `enabled: true`.

**Sign up:** see [docs.pay.peer.xyz](https://docs.pay.peer.xyz). The merchant API key is in **Settings**, then **Developer** (check in the dashboard). Sandbox and live keys are separate.

| Value | Adapter option | Env var |
|---|---|---|
| Merchant API key | `apiKey` | `PEER_API_KEY` |
| Webhook signing secret | `webhookSecret` | `PEER_WEBHOOK_SECRET` |

```ts
peer({
  enabled: true,
  apiKey: process.env.PEER_API_KEY!,
  webhookSecret: process.env.PEER_WEBHOOK_SECRET!,
  env: 'sandbox',
})
```

**Sandbox and production:** set `env: 'sandbox'` with the sandbox key, or `env: 'live'` with the live key. `env` is required.

**Webhooks:** register `{baseUrl}/webhooks/peer` with `POST /api/v1/webhooks`. Copy `responseObject.secret` from the answer to `webhookSecret`. Peer reports settlement only by webhook.

**Gotchas:** read the warning on the [Peer](../adapters/peer.md) page before you turn it on.

## Reown (WalletConnect) {#reown}

The wallet button in the Next.js example uses Reown (WalletConnect) for mobile wallets. Without a project id, only browser wallets work.

**Access type:** self-serve.

**Sign up:** [dashboard.reown.com](https://dashboard.reown.com). Create a project. Copy the **Project ID**.

| Value | Where it goes | Env var |
|---|---|---|
| Project ID | `examples/next-demo/lib/wagmi.ts` | `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` |

```sh
# examples/next-demo/.env.local
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=your-project-id
```

**Gotchas:**

- The project id is public by design. The browser needs it, so it is safe in a `NEXT_PUBLIC_` variable. It is the only value on this page that is not a secret.
- Check in the dashboard if you must add your domains to an allowlist for production.

## Next steps

- Read the [adapter page](../adapters/) of each provider that you use, and its TO VERIFY notes.
- Test one webhook for each provider in the sandbox. See [Webhooks to your backend](./webhooks.md).
- Go through the [production checklist](../deploy/checklist.md) before real money moves.
