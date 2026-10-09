# Kotani Pay

`@openrampkit/adapter-kotani` connects [Kotani Pay](https://documentation.kotanipay.com/v3/overview) (API v3). It gives local African payment rails:

- **Deposit:** the user pays with M-Pesa or mobile money. Kotani Pay sends USDC or USDT to the destination address. In South Africa (and Nigeria, TO VERIFY), the user pays on a Kotani Pay bank page.
- **Withdraw:** the user sends USDC or USDT to a Kotani Pay escrow address. Kotani Pay pays the user's mobile money wallet.

```ts
import { kotani } from '@openrampkit/adapter-kotani'

kotani({
  apiKey: process.env.KOTANI_API_KEY!,
  webhookSecret: process.env.KOTANI_WEBHOOK_SECRET!,
  sandbox: true,
})
```

## Why Kotani Pay

We compared Kotani Pay and Yellow Card. Both cover Kenya, Ghana, Nigeria and more African markets. We chose Kotani Pay for these reasons:

- **Self-serve sandbox.** You register at [integrator.kotanipay.com](https://integrator.kotanipay.com/register) and make an API key in the dashboard. You do not talk to sales first.
- **Public API docs.** The full reference, an OpenAPI file and an `llms.txt` index are public.
- **Yellow Card is not self-serve.** Yellow Card gives sandbox keys only after an intro call, a pre-integration form, KYB, an AML review and a signed agreement ([Onboard with us](https://docs.yellowcard.engineering/docs/getting-started-api)). The project skips providers that are not self-serve.

Production access is not self-serve for Kotani Pay either. You ask the Kotani Pay team for a production account. Then you make a production key.

## Access

1. Register a sandbox account at [integrator.kotanipay.com](https://integrator.kotanipay.com/register).
2. In **API Keys**, click **Generate New Key**. Use an integrator-level key (it has all permissions). If you want request signing, click **Generate Secure Key**. It gives a key and a secret.
3. In **Settings**, set the webhook URL to `{baseUrl}/webhooks/kotani` and copy the signing secret.
4. Kotani Pay enables countries and services per integrator. Ask Kotani Pay to enable the countries that you need.
5. For withdrawals, fund your **payout balance** in each payout currency. Kotani Pay pays users from this balance.
6. For production, ask Kotani Pay for a production account. Make a new key in the **Production** environment. Sandbox keys do not work in production.

To get the keys, see [Get provider keys](../guide/provider-keys.md#kotani).

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | required | API key (`Authorization: Bearer`) |
| `webhookSecret` | `string` | none | Webhook signing secret from **Settings**. Without it, the adapter rejects every callback and uses status polling only. |
| `apiSecret` | `string` | none | Secret of a secure key. Set it only when request signing (secure mode) is on for your account. |
| `sandbox` | `boolean` | `false` | Use `https://sandbox-api.kotanipay.io` |
| `apiUrl` | `string` | `https://api.kotanipay.io` | API base URL. Overrides `sandbox`. |
| `countries` | `string[]` | all corridors | Offer only these countries |
| `methods` | `string[]` | all | Offer only these methods (`mpesa`, `mobile_money`, `bank_transfer`) |
| `assets` | `KotaniAsset[]` | `KOTANI_ASSETS` | Delivery and sell assets, with their Kotani chain and token codes |
| `offramp` | `boolean` | `true` | Add withdraw legs (mobile money payouts) |
| `feeBearer` | `'customer' \| 'integrator'` | `'customer'` | Who pays the Kotani Pay fee on a deposit. It must match the billing setting of your Kotani Pay wallet. |
| `quoteTtlSec` | `number` | `120` | Quote lifetime |

## Legs

Deposit legs have the id `{country}-{method}`, for example `ke-mpesa`. Withdraw legs have the id `sell-{country}-{method}`. Each leg allows only its country.

| Country | Currency | Deposit leg | Withdraw leg | Rail | Networks (default) |
|---|---|---|---|---|---|
| Kenya | KES | `ke-mpesa` | `sell-ke-mpesa` | M-Pesa STK push | `MPESA` |
| Kenya | KES | `ke-mobile-money` | `sell-ke-mobile-money` | Mobile money | `AIRTEL` |
| Ghana | GHS | `gh-mobile-money` | `sell-gh-mobile-money` | Mobile money | `MTN`, `VODAFONE`, `AIRTEL` |
| Uganda | UGX | `ug-mobile-money` | `sell-ug-mobile-money` | Mobile money | `MTN`, `AIRTEL` |
| Tanzania | TZS | `tz-mobile-money` | `sell-tz-mobile-money` | Mobile money | `VODACOM`, `AIRTEL`, `YAS`, `HALOPESA` |
| Zambia | ZMW | `zm-mobile-money` | `sell-zm-mobile-money` | Mobile money | `MTN`, `AIRTEL`, `ZAMTEL` |
| Rwanda | RWF | `rw-mobile-money` | `sell-rw-mobile-money` | Mobile money | `MTN`, `AIRTEL` |
| Cameroon | XAF | `cm-mobile-money` | `sell-cm-mobile-money` | Mobile money | `MTN`, `ORANGE` |
| Côte d'Ivoire | XOF | `ci-mobile-money` | `sell-ci-mobile-money` | Mobile money | `MTN`, `ORANGE`, `MOOV`, `WAVE` |
| Senegal | XOF | `sn-mobile-money` | `sell-sn-mobile-money` | Mobile money | `ORANGE`, `FREE`, `EXPRESSO`, `WAVE` |
| DR Congo | CDF | `cd-mobile-money` | `sell-cd-mobile-money` | Mobile money | `AIRTEL`, `ORANGE`, `VODACOM` |
| South Africa | ZAR | `za-bank-transfer` | none | Bank checkout (`PAYBYBANK`) | none |
| Nigeria | NGN | `ng-bank-transfer` | none | Bank checkout (TO VERIFY) | none |

The legs use the existing method codes `mpesa`, `mobile_money` and `bank_transfer`. This adapter adds no new codes.

Limits: `ke-mpesa` has a maximum of 250,000 KES (the Safaricom limit for one payment). Kotani Pay limits per integrator are not public (TO VERIFY). When an amount is out of range, the quote gives Kotani's own error message.

### Assets

| Chain | USDC | USDT | Kotani chain code |
|---|---|---|---|
| Base | Yes | No | `BASE` |
| Polygon | Yes | Yes | `POLYGON` |
| Ethereum | Yes | Yes | `ETHEREUM` |
| Solana | Yes | Yes | `SOLANA` |

Kotani Pay also lists `CELO`, `STELLAR`, `TRON`, `ARBITRUM`, `OPTIMISM`, `BINANCE` and more chains. Add them with the `assets` option after you test them. For other destination chains, the planner adds a bridge leg (for example Relay) after the Kotani Pay leg.

### Live catalog

`catalog()` calls `GET /api/v3/customer/support/countries?serviceType=DEPOSIT` (or `WITHDRAW` for withdrawals). It keeps only the countries that are active and enabled for your account. It caches the result for one hour. When Kotani Pay returns `availableNetworks` for a country, the network list in the form comes from it. If the call fails, the server uses the static legs.

## Deposit flow

1. **Quote:** `POST /api/v3/rate/onramp` with `{ from: currency, to: token, fiatAmount }`. Kotani Pay adds its fee on top of `fiatAmount` (`fiatAmountToSend = fiatAmount + fiatFee`). With `feeBearer: 'customer'`, the adapter asks a second time with `amount - fee`, so the user pays the amount that they typed. The quote shows the fee. For an exact output, the adapter sends `source: 'crypto'`.
2. **Start:** the adapter shows a `FORM`. For mobile money: the account name, the phone number, and the network (only when there is more than one). For bank checkout: the full name and the phone number.
3. **`submit_details`:** the adapter changes a local phone number (`07...`) to international format (`+2547...`). Then it calls `POST /api/v3/onramp` with `mobileMoney` (or `bankCheckout`), `fiatAmount`, `currency`, `chain`, `token`, `receiverAddress`, `referenceId` and `callbackUrl` (`{baseUrl}/webhooks/kotani`).
   - Mobile money: the user gets an STK push or a USSD prompt on the phone. The step is `PAYMENT` with `sub: 'CONFIRM_ON_YOUR_PHONE'` and a status poll.
   - Bank checkout: the step is a `REDIRECT` to the `redirectUrl` from Kotani Pay.
4. **Status:** `GET /api/v3/onramp/{referenceId}`. Kotani Pay has two statuses: `depositStatus` (the fiat payment) and `onchainStatus` (the crypto delivery).

| `depositStatus` | `onchainStatus` | Leg |
|---|---|---|
| `PENDING`, `INITIATED`, `IN_PROGRESS` | any | `awaiting_user` (`PAYMENT`) |
| `SUCCESSFUL` | `PENDING`, `IN_PROGRESS` | `processing` |
| any | `SUCCESSFUL` | `succeeded`, with the tx hash and the crypto amount |
| `SUCCESSFUL` | `FAILED` | `failed` with `DELIVERY_FAILED` |
| `FAILED`, `DECLINED`, `CANCELLED` | any | `failed` with `PAYMENT_FAILED` |
| `EXPIRED` | any | `expired` |
| `REQUIRE_REVIEW`, `ERROR_OCCURRED` | any | `processing` (Kotani Pay support must act) |

If the crypto delivery fails after the user paid, Kotani Pay puts the fiat in **your** fiat wallet, not back to the user. You must refund the user. The error tells the user to contact support.

## Withdraw flow

1. **Quote:** `POST /api/v3/rate/offramp` with `{ from: token, to: currency, cryptoAmount }`. The output is `transactionAmount` (what the recipient gets). For an exact output, the adapter sends `source: 'fiat'`.
2. **Start:** a `FORM` for the payout account: the account name, the phone number and the network.
3. **`submit_details`:** `POST /api/v3/offramp` with `mobileMoneyReceiver`, `cryptoAmount`, `currency`, `chain`, `token`, `referenceId` and `callbackUrl`. When the sender address is known, the adapter also sends `senderAddress` and `refund_config.address`. The step is a `WALLET_TX`: a token transfer of the quoted amount to the `escrowAddress` (an ERC-20 transfer on EVM, a token transfer on Solana).
4. **`submit_tx`:** the client sends the tx hash. The step is `PROCESSING`.
5. **Status:** `GET /api/v3/offramp/{referenceId}`.

| `status` | Leg |
|---|---|
| `PENDING` before the user sends | `awaiting_user` (`WALLET_TX`) |
| `CRYPTO_RECEIVED`, `IN_PROGRESS`, `PENDING` after the user sends | `processing` |
| `SUCCESSFUL` | `succeeded`, with `fiatTransactionAmount` |
| `FAILED` after the crypto arrived, `REFUND_PENDING` | `processing` (Kotani Pay refunds the crypto after about 5 minutes) |
| `REFUNDED` | `refunded` |
| `REFUND_FAILED` | `failed` with `DELIVERY_FAILED` |
| `FAILED` before the crypto arrived, `CANCELLED` | `failed` |
| `EXPIRED` | `expired` |

## Webhooks

Set the webhook URL to `{baseUrl}/webhooks/kotani` in **Settings**, and set `webhookSecret`. The adapter also sends this URL as `callbackUrl` on each order.

- **Verification:** Kotani Pay sends `X-Kotani-Signature: sha256=<hex>`. The value is the HMAC-SHA256, with the signing secret, of `JSON.stringify` of the body without its `signature` field. The adapter parses the body, removes `signature`, serializes the rest, and compares in constant time.
- **Unsigned callbacks:** without a webhook secret, Kotani Pay posts the transaction fields with no signature. The adapter rejects them (401). Kotani Pay retries for 24 hours. To stop the retries, set `disable_webhooks: true` with [Update Webhook Configuration](https://documentation.kotanipay.com/v3/api-reference/integrator/update-webhook) and use polling.
- **Events:**

| Event | Result |
|---|---|
| `transaction.onramp.status.updated` | The deposit status table above |
| `transaction.offramp.status.updated` | The withdraw status table above |
| `refund.completed` | `refunded`, with the refund tx hash |
| `refund.failed` | `failed` with `DELIVERY_FAILED` |
| other events | ignored |

## Request signing

Some accounts have secure mode on. Then every request needs three more headers. Set `apiSecret` and the adapter adds them:

- `x-timestamp`: Unix time in seconds.
- `x-nonce`: a new UUID v4 for each request.
- `x-signature`: HMAC-SHA256 (hex) of `{timestamp}.{nonce}.{body}` for a POST (compact JSON), or `{timestamp}.{nonce}.{last path segment}` for a GET.

## Errors

- Quotes: HTTP 429 is `RATE_LIMITED`. HTTP 400, 404, 409 and 422 are `NO_QUOTES` with Kotani's message. A `200` response with `success: false` is the same as a 400. Other errors are `PROVIDER_UNAVAILABLE`.
- Orders (`submit_details`): HTTP 400, 409 and 422 are `PROVIDER_DECLINED` with Kotani's message (for example a wrong phone number). Other errors are as for quotes.

## Test in the sandbox

The sandbox has reserved phone numbers. Kotani Pay matches only the last nine digits, so add the country code of your corridor (for example `+254700000010`).

| Number ends with | Result |
|---|---|
| `700000001` | Success after about 5 seconds |
| `700000010` | Failed: insufficient funds |
| `700000013` | Failed: the customer cancelled |
| `700000020` | Never settles |
| `700000021` | Success after about 60 seconds |

Other numbers succeed. Bank and card checkouts use the bank's own sandbox. See [Sandbox Scenarios](https://documentation.kotanipay.com/v3/testing/sandbox-scenarios).

## Confirmed vs TO VERIFY

Confirmed from the Kotani Pay docs and OpenAPI file (2026-10-05):

- Base URLs, `Authorization: Bearer` auth, the self-serve sandbox, and the response envelope (`success`, `message`, `data`).
- Endpoints and request fields: `POST /api/v3/rate/onramp`, `POST /api/v3/rate/offramp`, `POST /api/v3/onramp`, `GET /api/v3/onramp/{referenceId}`, `POST /api/v3/offramp`, `GET /api/v3/offramp/{referenceId}`, `GET /api/v3/customer/support/countries`, `GET /health`.
- The status values, the webhook events and their payloads, the webhook signature method, and request signing.
- The chain and token enums, the mobile money currency enum and the network enum.

TO VERIFY with a live sandbox account:

- **TO VERIFY**: the webhook signature on real callbacks. The adapter follows the documented method (re-serialize the parsed body). Check one live callback.
- **TO VERIFY**: that signed callbacks go to the `callbackUrl` of the order, not only to the URL in **Settings**. Set both to `{baseUrl}/webhooks/kotani`.
- **TO VERIFY**: the networks per country. `catalog()` replaces the static list with the live list when Kotani Pay returns it.
- **TO VERIFY**: Nigeria. NGN is in the Kotani Pay currency list, but the docs show bank checkout only for South Africa. Test `ng-bank-transfer` before you offer it, or remove it with `countries`.
- **TO VERIFY**: the fee on a deposit. The rate response gives `fee`, and the order gives `fiatFee`. The adapter assumes that they are equal, and that the user pays the fee on top when the customer pays it.
- **TO VERIFY**: whether Kotani Pay needs a customer record (`Create Mobile Money Customer`) or KYC before an onramp. The onramp request takes the phone number directly, so the adapter does not create one.
- **TO VERIFY**: limits per corridor, and the chain and token list per country.
- **TO VERIFY**: which USDC contract Kotani Pay sends on Polygon. The adapter assumes native USDC, not USDC.e.
- **TO VERIFY**: the rate lock. The adapter does not send `rateId`, because the rate id lifetime is not documented. Kotani Pay sets the rate when the order is created, so the delivered amount can differ a little from the quote.
- **TO VERIFY**: the sandbox host. Most pages use `sandbox-api.kotanipay.io`. The sandbox page uses `sandbox-api.kotanipay.com`. Both answer `/health`.
