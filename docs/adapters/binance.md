# Binance

`@openrampkit/adapter-binance` lets a user deposit from their Binance account. The user pays from the balance in their Binance account. Then Binance sends the crypto on chain to the destination address: the user's own wallet or the app's wallet.

The adapter uses the on-ramp APIs of [Binance Pay Onchain](https://developers.binance.com/en/docs/products/connect-2.0/introduction). The earlier name of this product is Binance Connect.

```ts
import { binance } from '@openrampkit/adapter-binance'

binance({
  apiUrl: process.env.BINANCE_API_URL!, // Binance gives you this URL
  clientId: process.env.BINANCE_CLIENT_ID!,
  accessToken: process.env.BINANCE_ACCESS_TOKEN!,
  privateKey: process.env.BINANCE_PRIVATE_KEY!, // your RSA private key (PKCS#8)
  binancePublicKey: process.env.BINANCE_WEBHOOK_PUBLIC_KEY!,
})
```

::: warning Partner approval required
You cannot get keys for this product yourself. Binance must approve you as a partner first. There is no sandbox. The adapter was not tested against the live API. Read [What is not verified](#what-is-not-verified) before you go live.
:::

## Which Binance product, and why

Binance has three products that can move funds from a Binance user. We compared them for one job: the user funds a self-custody wallet or an app wallet from Binance.

| Product | What it does | Funds go to | Access | Fit |
|---|---|---|---|---|
| **Binance Pay Onchain on-ramp** (earlier: Binance Connect) | The user buys crypto on a Binance page. Payment methods include the Binance balance (`BUY_WALLET`), a crypto balance converted with `SPOT`, card and P2P. Binance then withdraws the crypto to an address that you give. | Any on-chain address | Partner approval. Binance gives the base URL, client id and access token. No sandbox. | **Chosen.** It is the only product that sends the user's Binance funds to an on-chain address with an order id, a status API and signed webhooks. |
| Binance Pay (merchant, C2B) | The user pays a merchant order from their Binance Pay balance. | The merchant's Binance account | Merchant account with KYB. The merchant applies on the Binance Merchant portal. | Not chosen. The funds stay inside Binance, in your merchant account. To fund the user's wallet, you must withdraw and send the funds yourself. Thus, you hold the user's funds. |
| Withdraw to an address (app deep link) | The user opens the Binance app and withdraws to an address. | Any on-chain address | None | Not an adapter. We found no documented deep link that fills the address, network and amount. Use the `exchange_transfer` method (a deposit address with exchange wording) for this flow. It works with no Binance account. |

So, the adapter uses Binance Pay Onchain. If you do not have partner approval, use `exchange_transfer` with [Relay](./relay.md) or another adapter that gives a deposit address.

## Access requirements

From the [developer account](https://developers.binance.com/en/docs/products/connect-2.0/basics/6.apply-developer-account) and [credentials](https://developers.binance.com/en/docs/products/connect-2.0/account-and-credentials) pages (read 2026-10-05):

1. Contact the Binance Pay Onchain team. Confirm the product scope (the on-ramp APIs) with them. Some features are off by default or need approval. Availability depends on your partner type, region, commercial setup and compliance review.
2. Make an RSA key pair. Keep the private key. Send these items to Binance:
   - your RSA public key,
   - the IP addresses of your server, for the allow list,
   - your webhook URL: `{baseUrl}/webhooks/binance`,
   - the domains of your return URL (`redirectUrl` and `failRedirectUrl`),
   - a deep link scheme, if you use one,
   - a logo (80 x 80 pixel PNG).
3. Binance sends you the client id, the access token, the API base URL, and its webhook public key with a partner code.

The docs do not describe a KYB process or a form. Expect a compliance review of your company (TO VERIFY with Binance).

Make the key pair with OpenSSL:

```sh
openssl genrsa -out binance.pem 2048
openssl pkcs8 -topk8 -nocrypt -in binance.pem -out binance-private.pem   # privateKey
openssl rsa -in binance.pem -pubout -out binance-public.pem               # send to Binance
```

The Binance docs show 1024-bit keys. The adapter accepts 1024-bit and 2048-bit keys. Ask Binance which size they accept.

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `apiUrl` | `string` | required | API base URL. Binance gives it to partners. It is not public. |
| `clientId` | `string` | required | `X-Tesla-ClientId` |
| `accessToken` | `string` | required | `X-Tesla-SignAccessToken` |
| `privateKey` | `string` | required | Your RSA private key: PKCS#8 PEM (`BEGIN PRIVATE KEY`) or base64 DER. Escaped newlines (`\n`) are accepted. |
| `binancePublicKey` | `string` | required | Binance's webhook public key: SPKI PEM (`BEGIN PUBLIC KEY`) or base64 DER. Without it, every webhook is rejected. |
| `webhookPartnerCode` | `string` | none | When set, a webhook must have this value in `X-BN-Connect-For`. TO VERIFY: the client id or the partner code. |
| `payMethodCode` | `string \| null` | `'BUY_WALLET'` | Binance payment method. `BUY_WALLET` is the fiat balance in the Binance account. `null` lets the user choose on the Binance page (card and P2P too). |
| `method` | `string` | `'exchange'` | Method id of the leg |
| `deliverAssets` | `BinanceDeliverAsset[]` | USDC on Base, Arbitrum, Ethereum, Optimism, BNB Chain, Solana | Assets Binance may send, most preferred first |
| `regions` | `RegionPolicy` | `BINANCE_REGIONS` | Where the leg is offered |
| `timeoutMs` | `number` | `8000` | Request timeout |

`BinanceDeliverAsset` is `{ chain, token, cryptoCurrency, network, symbol?, decimals? }`. `cryptoCurrency` is the Binance coin (`USDC`). `network` is the Binance network code (`BASE`, `ARBITRUM`, `ETH`, `OPTIMISM`, `BSC`, `SOL`).

The helpers `importRsaPrivateKey`, `importRsaPublicKey`, `rsaSign` and `rsaVerify` are exported.

## Legs

| Leg | Kind | Method | From | To | Surface |
|---|---|---|---|---|---|
| `account` | `fiat_onramp` | `exchange` ("Connect exchange") | Fiat in the user's Binance account | The `deliverAssets`, at an address | `REDIRECT` |

- **Method**: `exchange` is in the "Use Crypto" tab of the modal. The planner never makes it the recommended cash method.
- **Delivers to**: USDC on Base first by default. For other destinations, the planner adds a bridge hop.
- **Requires**: a Binance account and Binance KYC (`provider_account`, `provider_kyc`).
- **Limits**: the leg has no static limits. Binance checks the amount on its page.

## Regions

`BINANCE_REGIONS` allows every country except:

| Code | Reason |
|---|---|
| `US` | Binance.com does not serve US residents. Binance.US is a different company. |
| `CA` | Binance left Canada in 2023. |
| `NL` | Binance left the Netherlands in 2023. |
| `SG`, `MY` | On the "List of Prohibited Countries" in the Binance Terms of Use. |
| `CU`, `IR`, `KP`, `SY` | Sanctions. Named in the Binance Terms of Use. |
| `UA-43`, `UA-40`, `UA-14`, `UA-09` | Crimea, Sevastopol, Donetsk and Luhansk. |

TO VERIFY: the on-ramp coverage for your partner setup. Binance sets it during approval. Set `regions` to match what Binance confirms.

## How it works

1. **Quote**: `POST /papi/v1/ramp/connect/buy/estimated-quote` with `fiatCurrency`, `cryptoCurrency`, `requestedAmount`, `amountType` (1 for a fiat amount, 2 for a crypto amount), `network` and `payMethodCode`. The quote shows `totalAmount` as the output (or the input for a crypto amount), `feeAmount` as the Binance fee and `networkFee` as the network fee. The quote is an estimate (`data.estimate: true`) and expires after 5 minutes. Binance shows the final price on its page.
2. **Start**: `POST /papi/v1/ramp/connect/buy/pre-order` with our `externalOrderId` (the leg ref: `ork` and 24 hex characters), the address, the network, the amount, `redirectUrl`, `failRedirectUrl` (both the session return URL) and `clientIp`. Binance answers with a `link`. The modal opens it (`REDIRECT`, popup). The adapter refuses a link that is not `https:`.
3. **Status**: `POST /papi/v1/ramp/connect/order` with `externalOrderId`. The server calls it when the browser polls and from the sweep.
4. **Webhook**: Binance posts `connect_order_event` to `{baseUrl}/webhooks/binance`.

Every request is signed. The adapter sends:

| Header | Value |
|---|---|
| `X-Tesla-ClientId` | `clientId` |
| `X-Tesla-SignAccessToken` | `accessToken` |
| `X-Tesla-Timestamp` | Time in milliseconds |
| `X-Tesla-Signature` | base64 of SHA256withRSA over the JSON body followed by the timestamp, with your private key |

A response with `success: false`, or a `code` other than `000000`, becomes `NO_QUOTES` with the Binance message. HTTP 429 becomes `RATE_LIMITED`. Timeouts and HTTP 5xx become `PROVIDER_UNAVAILABLE`.

## Webhook verification

The webhook has three headers:

| Header | Use |
|---|---|
| `X-BN-Connect-Signature` | base64 of SHA256withRSA over the raw body followed by the timestamp, signed by Binance |
| `X-BN-Connect-Timestamp` | The timestamp in the signed text |
| `X-BN-Connect-For` | Your client id or partner code. Checked when `webhookPartnerCode` is set. |

The adapter verifies the signature with `binancePublicKey`. A missing header, a changed body, a changed timestamp or a signature from another key gives 401. Events are idempotent: the same body gives the same events.

## Status mapping

| Binance status | Leg status |
|---|---|
| 0 `INIT` | No change (the user has not paid) |
| 1, 2, 3, 4, 6, 10, 11, 15 (buying, converting, withdrawing) | `processing` |
| 20 `COMPLETED` | `succeeded`, with `withdrawTxHash` and `cryptoAmount` |
| 93 `SWAP_ABANDONED`, 96 `WITHDRAW_ABANDONED` | `failed`, `PAYMENT_FAILED`. The crypto stays in the Binance account. |
| 98 `WITHDRAW_FAILED` | `failed`, `DELIVERY_FAILED`. The crypto stays in the Binance account. |
| 94, 95, 97, 99 | `failed`, `PAYMENT_FAILED` |

## What is not verified

We wrote the adapter from the public docs (read 2026-10-05). We did not test it against the live API, because there is no sandbox and no partner account. These items are marked TO VERIFY in the code:

- The API base URL. Binance gives it during onboarding.
- The webhook signature text. The docs write "requestBody + X-Connect-Timestamp", but the header is `X-BN-Connect-Timestamp`. The adapter uses the `X-BN-Connect-Timestamp` value.
- The value of `X-BN-Connect-For`: the client id or the webhook partner code.
- The webhook answer. Binance asks for `{"returnCode":"SUCCESS"}`. The OpenRampKit server answers `{"received":true}` with HTTP 200. Binance can send the event again. That is safe, and the status polling also finds the result.
- The unit of `networkFee` (we show it in the delivered coin), and if `totalAmount` is before or after the fees.
- The quote lifetime and the maximum length of `externalOrderId`.
- Network codes other than those in the docs examples (`ETH`, `BSC`, `ARBITRUM`, `SOL`, `OPTIMISM`, `BASE`). Call `POST /papi/v1/ramp/connect/crypto-network` to check them.
- The fiat currencies and limits for your setup (`POST /papi/v1/ramp/connect/buy/trading-pairs`).
- A user who holds USDC in Binance and only wants to send it. The docs list order type 3 ("send") but do not describe how to start it. With `BUY_WALLET`, the user pays from a fiat balance. With `payMethodCode: null`, the user chooses on the Binance page.
- Fine mapping of Binance error codes. Today every refused request becomes `NO_QUOTES` with the Binance message.

## Sources

- Binance Pay Onchain overview: https://developers.binance.com/en/docs/products/connect-2.0/introduction
- Product scope: https://developers.binance.com/en/docs/products/connect-2.0/product-scope
- Request headers: https://developers.binance.com/en/docs/products/connect-2.0/basics/1.common-request-headers
- Request signing: https://developers.binance.com/en/docs/products/connect-2.0/basics/3.request-signing
- Base URLs (no sandbox): https://developers.binance.com/en/docs/products/connect-2.0/basics/4.base-urls
- Order status: https://developers.binance.com/en/docs/products/connect-2.0/basics/7.order-status
- Estimated quote: https://developers.binance.com/en/docs/products/connect-2.0/on-ramp-buy-apis/4.get-estimated-quote
- Create order link: https://developers.binance.com/en/docs/products/connect-2.0/on-ramp-buy-apis/5.pre-order
- Query order: https://developers.binance.com/en/docs/products/connect-2.0/on-ramp-buy-apis/6.query-order-details
- Payment methods (`BUY_WALLET`): https://developers.binance.com/en/docs/products/connect-2.0/on-ramp-buy-apis/7.get-payment-method-list-v2
- Webhook: https://developers.binance.com/docs/binance_connect/webhook/webhook
- Binance Pay merchant API (not chosen): https://developers.binance.com/docs/binance-pay/api-order-create-v2
