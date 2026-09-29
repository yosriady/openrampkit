# Swapped

`@openrampkit/adapter-swapped` is a fiat onramp and offramp through the [Swapped](https://docs.swapped.com) widget, shown in an iframe. Deposits cover cards, Apple Pay, Google Pay, SEPA, and many local methods in Southeast Asia and beyond. Withdrawals pay out to a bank transfer, Skrill, PIX or Interac.

```ts
import { swapped } from '@openrampkit/adapter-swapped'

swapped({
  publicKey: process.env.SWAPPED_PUBLIC_KEY!, // pk_...
  secretKey: process.env.SWAPPED_SECRET_KEY!, // sk_...
  env: 'production',
})
```

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `publicKey` | `string` | required | Public key (`pk_...`). Used as `apiKey` in the widget URL and the merchant APIs. |
| `secretKey` | `string` | required | Secret key (`sk_...`). Signs widget URLs and verifies order notifications. |
| `env` | `'sandbox' \| 'production'` | `'production'` | Sandbox uses `https://sandbox.swapped.com` (BTC and ETH testnets and test cards only) |
| `widgetUrl` | `string` | `https://widget.swapped.com` or the sandbox URL | Widget base URL |
| `apiUrl` | `string` | same as `widgetUrl` | Merchant API base URL |
| `markup` | `number` | none | Your markup in percent, 0 to 5 (0.5 means 0.5%) |
| `deliverAssets` | `SwappedDeliverAsset[]` | USDC on Base, Arbitrum, Polygon, Ethereum | Assets Swapped may deliver, most preferred first |
| `defaultCountry` | `string` | `'US'` | Country for pricing when the session has none |
| `statusPolling` | `boolean` | `false` | Also poll `get_transactions` for order status. **TO VERIFY** (see below). |

`SwappedDeliverAsset` is `{ chain, token, currencyCode, symbol?, decimals? }`, where `currencyCode` is Swapped's code such as `USDC_BASE`.

## Legs

The adapter has one leg per Swapped `payment_group`. The leg id is the group name (`creditcard`, `apple-pay`, `vietqr`, ...). The method id is mapped to the OpenRampKit vocabulary:

| Swapped group | Method |
|---|---|
| `creditcard` | `card` |
| `apple-pay`, `applepay` | `apple_pay` |
| `google-pay`, `googlepay` | `google_pay` |
| `bank-transfer`, `banktransfer` | `bank_transfer` |
| `zalo`, `zalopay` | `zalopay` |
| `sepa`, `vietqr`, `momo`, `gcash`, `maya`, `gopay`, `dana`, `ovo`, `grabpay`, `promptpay`, `touchngo`, `pix`, `upi` | same name |

Other groups keep their own name as the method id.

- **Static legs**: `creditcard`, `apple-pay`, `google-pay`, used when the catalog is not available.
- **Live catalog**: `GET /api/v1/merchant/get_payment_methods`, cached for one hour. For the user's country and currency, it builds one leg per group, with the countries where it exists and the min and max amounts (in EUR).
- **Delivers to**: the `deliverAssets` (USDC on Base first by default). For other destinations, the planner adds a Relay bridge hop.
- **Regions**: every country except `US-TX` ("users from Texas won't be able to use stablecoins").
- **Surface**: `IFRAME` (560 px high). It declares `messages: { completed: ['SWAPPED_ORDER_DATA'] }`, so when the widget posts that message the modal checks the status at once (see [Surfaces](../concepts/surfaces.md#iframe)).

## Sell legs (withdraw to cash)

For [withdraw sessions](../guide/withdraw.md), the adapter declares `crypto_offramp` legs. Their ids have the prefix `sell-`.

| Leg | Method | Payout currencies | Countries |
|---|---|---|---|
| `sell-bank-transfer` | `bank_transfer` | EUR, DKK, GBP | all |
| `sell-skrill` | `skrill` | EUR, DKK, GBP | all |
| `sell-pix` | `pix` | BRL | BR |
| `sell-interac-extra` | `interac` | CAD | CA |

- **Static legs**: the table above, from the Swapped docs (2026-09). The server uses them when the live catalog is not available.
- **Live catalog**: for a withdraw session, `catalog()` calls `GET /api/v1/merchant/sell/get_payout_methods` (cached for one hour). It returns one sell leg per payout method that is enabled and pays out in the target currency, for the user's country and for all countries. Its min and max amounts become the leg limits (in EUR).
- **From**: the `deliverAssets` (USDC on Base, Arbitrum, Polygon, Ethereum by default), in the user's wallet or at the app's address. So the session `source` must be one of them.
- **To**: fiat in the user's own account.
- **Regions**: the payout method's countries, minus `US-TX`.
- **Surfaces**: `IFRAME` (the Swapped sell widget), then `WALLET_TX` (the crypto transfer to Swapped).

### Sell quotes are estimates

Swapped prices a sell by the fiat amount only. The user enters a crypto amount, so the adapter makes two calls to `POST /api/v1/merchant/sell/pricing`:

1. It prices 100 units of the payout currency, to get the fiat value of one crypto unit.
2. It prices the fiat amount that the crypto amount buys (rounded down to cents).

The quote output is the fiat amount after fees. The fees are the Swapped fee and your markup (as an app fee), in the payout currency. The quote expires after 10 minutes. The widget sets the final amount, so the quote is an estimate (`data.estimate: true`). Swapped does not report the payout amount, so `result.outputConfirmed` stays `false`.

### Sell flow

1. **Start**: a signed widget URL on `/sell`, with `userSendsFunds=false`, the payout method, the crypto code and amount, the payout currency, `externalCustomerId`, the email and country when known, and `responseUrl` (the webhook URL). The user enters the payout details, and passes any checks that Swapped needs, in the widget.
2. **`payment_pending` webhook**: Swapped is ready for the crypto. The notification has the deposit address (`order_crypto_address`) and the amount. The adapter turns it into a `WALLET_TX` step: an ERC-20 `transfer` of that amount to that address. The user's wallet signs it, or the server's [treasury hook](../guide/withdraw.md#custody-app) sends it (`custody: 'app'`).
3. **`submit_tx`**: the client (or the server, for the treasury) reports the hash. The leg is `PROCESSING` (sub-state `CONFIRMING`).
4. **Payout**: `payout_pending` keeps it `processing`. `order_completed` is `succeeded`. `order_cancelled` fails the leg with `PAYMENT_FAILED` ("The payout was cancelled.", `recovery: 'contact_support'`).

The deposit address and the amount of the `WALLET_TX` come from the verified Swapped webhook, not from the quote. With `custody: 'app'`, check them in your treasury hook.

## Quotes and start

- Quote: `POST /api/v1/merchant/pricing` with the public key, the payment group, the fiat amount (or crypto amount), the target currency code and the region. Fees: Swapped fee, network fee, and your markup as an app fee. Quotes expire after 10 minutes; the widget shows the final price.
- Start: a signed widget URL. The signature is the base64 HMAC-SHA256 of the query string (with the leading `?`) using the secret key, appended last as `&signature=`. The URL locks the amount (`lockBaseCurrency=true`), sets the wallet address, the method, the email and country when known, `redirectUrl` (the return page) and `responseUrl` (the webhook URL).
- Reference: `externalCustomerId` is set to `{userId}.{random}`. Swapped echoes only this field in callbacks, so it routes the webhook to the leg. The user id stays visible as the prefix in the Swapped dashboard.

## Webhooks

Swapped sends order notifications (buy and sell) to the `responseUrl` that the adapter puts in the widget URL: `{baseUrl}/webhooks/swapped`. You do not need to configure it in a dashboard.

- Verification: the `signature` header must equal the base64 HMAC-SHA256 of the raw body with the secret key.
- Status mapping for buy orders (sell orders: see [Sell flow](#sell-flow)):

| `order_status` | Leg |
|---|---|
| `order_broadcasted` | `succeeded`, with the transaction id as `txHash` |
| `order_completed` | `processing` (paid and bought, not yet sent on chain) |
| `order_cancelled` | `failed` with `PAYMENT_FAILED` |
| `payment_pending` | no change |

## Verified vs TO VERIFY

- The live payment-methods API returns `{ data: { [country]: Method[] } }`. The docs show a flat list. The adapter accepts both.
- **TO VERIFY**: `statusPolling`. The `get_transactions` signature is assumed to be the base64 HMAC-SHA256 of the JSON body without `signature`. It was not tested against the live API.
