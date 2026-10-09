# Peer

`@openrampkit/adapter-peer` buys USDC on Base through the hosted [Peer Pay](https://docs.pay.peer.xyz) checkout, with US payment apps (Venmo, Cash App, Zelle, Chime, PayPal) and Wise or Revolut (USD, EUR, GBP).

::: danger Opt-in: read this first
Peer is a peer-to-peer marketplace. A seller escrows USDC on Base, the buyer pays that seller in a payment app, and an attestation of the payment releases the USDC. There is no licensed provider or KYC step between buyer and seller. Liquidity is thin and moves by the minute. Venmo and PayPal payments can be charged back after settlement (paid from the merchant's stake). Paying strangers for crypto may breach the payment apps' terms.

The factory throws unless you pass `enabled: true`. Check your compliance position first.
:::

::: info New adapter
This adapter is new and still in progress.
:::

```ts
import { peer } from '@openrampkit/adapter-peer'

peer({
  enabled: true,
  apiKey: process.env.PEER_API_KEY!,
  webhookSecret: process.env.PEER_WEBHOOK_SECRET!,
  env: 'production',
})
```

To get the keys, see [Get provider keys](../guide/provider-keys.md#peer).

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `enabled` | `true` | required | The opt-in flag |
| `apiKey` | `string` | required | Merchant API key. Sandbox and live keys are separate. |
| `webhookSecret` | `string` | required | Peer reports settlement only by webhook |
| `env` | `'sandbox' \| 'production'` | required | Which key you pass. `'live'` is a deprecated alias of `'production'`. The server checks `env` against `livemode`. |
| `rails` | `string[]` | all | `venmo`, `cashapp`, `zelle`, `chime`, `paypal`, `revolut`, `wise` |
| `feePayer` | `'MERCHANT' \| 'PAYEE' \| 'SPLIT'` | merchant setting | Who pays the fee |
| `buyerFeeShareBps` | `number` | none | With `SPLIT`: the buyer's share, 0 to 10000 in steps of 1000 |
| `feeBps` | `number` | `295` | Plan fee for estimates (Base plan 2.95%, Pro 4.95%) |
| `surface` | `'redirect' \| 'iframe'` | `'redirect'` | Popup or embedded checkout |
| `liquidityCheck` | `boolean` | `true` | Hide rails with no sellers in the orderbook |
| `apiUrl`, `checkoutUrl`, `orderbookUrl` | `string` | Peer defaults | Hosts |

## Legs

| Leg (rail) | Method | Fiat | Countries |
|---|---|---|---|
| `venmo` | `venmo` | USD | US |
| `cashapp` | `cash_app` | USD | US |
| `zelle` | `zelle` | USD | US |
| `chime` | `chime` | USD | US |
| `paypal` | `paypal` | USD | US |
| `revolut` | `revolut` | USD, EUR, GBP | US, GB, EEA |
| `wise` | `wise` | USD, EUR, GBP | all |

All legs deliver USDC on Base. The platform minimum is 10 USDC per order.

## Quotes and start

- Quote: checks availability for the rail (`POST /api/v1/merchants/me/quotes/availability`); no availability gives `NO_QUOTES`. The USDC estimate comes from the public orderbook (or 1:1 for USD), minus the plan fee.
- Start: `POST /api/v1/orders` with the rail, the destination address on Base and an idempotency key. The checkout URL is `https://pay.peer.xyz/?order=...&token=...`.
- Surface: `REDIRECT` by default. With `surface: 'iframe'`, an `IFRAME` that declares the `checkout.success`, `checkout.failed` and `checkout.closed` messages.
- Status: `GET /api/v1/orders/{orderId}`.

## Webhooks

Register `{baseUrl}/webhooks/peer` with Peer (`POST /api/v1/webhooks`) and pass the returned secret as `webhookSecret`.

- Verification: `X-Webhook-Signature` is the hex HMAC-SHA256 of `{X-Webhook-Timestamp}.{body}`, 5 minute tolerance.
- `ORDER_FULFILLED` completes the leg with the settled USDC amount and the fulfil transaction. `ORDER_CANCELLED` fails it. Expired or failed payment attempts keep the leg waiting, because a late settlement can still fulfil the order.

## Verified vs TO VERIFY

- **TO VERIFY**: PayPal liquidity outside USD.
- **TO VERIFY**: with `feePayer: 'SPLIT'`, the estimate is computed like `MERCHANT`.
