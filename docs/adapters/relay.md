# Relay

`@openrampkit/adapter-relay` moves crypto with [Relay](https://docs.relay.link): pay from a connected wallet, send to a deposit address, and the bridge hop after a fiat onramp.

```ts
import { relay } from '@openrampkit/adapter-relay'

relay({
  apiKey: process.env.RELAY_API_KEY,
  appFee: { bps: 25, recipient: '0xYourFeeAddress' },
  referrer: 'your-app',
})
```

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | none | Sent as `x-api-key`. Needed for `GET /requests/v3` (status of deposit-address legs) and higher rate limits. |
| `baseUrl` | `string` | `https://api.relay.link` | Use `https://api.testnets.relay.link` for testnets |
| `appFee` | `{ bps: number; recipient: string }` | none | Your fee in basis points. It accrues as a claimable balance at Relay. |
| `referrer` | `string` | none | Relay `referrer`, for attribution |
| `refundTo` | `'origin' \| string` | `'origin'` | Where Relay refunds failed deposit-address requests. `'origin'` turns on automatic refund to the original sender. |

::: warning No API key
Without `apiKey`, status checks for `transfer` and `bridge` use the deprecated `GET /requests/v2`. Relay retires it on 2026-11-24. The adapter logs a warning once. Set an API key.
:::

## Legs

| Leg | Method | From | To | Surface | Notes |
|---|---|---|---|---|---|
| `wallet` | `wallet` | Any crypto in the user's wallet | Any crypto at an address | `WALLET_TX` | Requires a connected wallet. EVM source chains only. |
| `transfer` | `transfer` | Any crypto in the user's wallet | Any crypto at an address | `DEPOSIT_ADDRESS` | Any amount. The user sends from any wallet or exchange. |
| `bridge` | (hop) | USDC on Base, Arbitrum, Optimism, Polygon or Ethereum, at an address | Any crypto at an address | none shown | The second leg of a two-leg pathway |

All legs allow every region.

### wallet

- The quote calls Relay `POST /quote/v2` with the user's source token and the destination. `EXACT_INPUT` by default; `EXACT_OUTPUT` when the amount is on the destination side.
- Same chain and same token: no Relay. The adapter builds a plain transfer (native value or ERC-20 `transfer`), with no fees.
- On start, the adapter reuses the quote's transaction steps when they are less than 20 seconds old and built for the same user. Otherwise it quotes again with the user's address.
- Only `transaction` steps are supported. A route that needs a `signature` step fails with `PROVIDER_DECLINED` and suggests another token or "Transfer crypto".
- After the wallet sends, the client fires `submit_tx` with `{ txHash }`. The adapter then checks `GET /intents/status/v3?requestId=...`.

::: danger Same-chain transfers trust the browser
For a direct same-chain, same-token transfer, the adapter marks the leg as succeeded as soon as the browser reports a transaction hash. It does not check the chain. Verify such deposits on chain before you credit them. See [Webhooks to your backend](../guide/webhooks.md#credit-exactly-once).
:::

### transfer

- The quote asks Relay for an **open deposit address** (`useDepositAddress: true`) for the source token and the destination. Deposit addresses are cached per recipient and route for 24 hours, so a user sees the same address again.
- When the user did not enter an amount, the quote uses a nominal amount (10 units of a 6 to 8 decimal token, else 0.005) to show the rate.
- Status looks for Relay requests to the deposit address that were created after the leg started (with one minute of slack), newest first.
- Same chain and same token: the address is the destination itself. The adapter cannot see deposits without a chain watcher, so the leg stays in `PAYMENT` until something else settles it.

![Transfer crypto](../screenshots/21-transfer-address.png)

### bridge

- Before the first leg is quoted, the server calls `prepareDeposit()`. The adapter returns an open deposit address from the hop asset to the destination. The first leg (for example Swapped) delivers there.
- The bridge leg starts as `PROCESSING` with sub-state `waiting_for_deposit`, and completes when Relay reports the request as `success`.

## Status mapping

| Relay status | Leg |
|---|---|
| `success` | `succeeded` (`COMPLETED`) |
| `failure` | `failed` with `DELIVERY_FAILED` |
| `refund` | `refunded` (`REFUNDED`) |
| other | `processing` (the Relay status is the `sub` state) |

## Webhooks

The Relay adapter has no webhook handler. Status comes from polling: the browser's step poll and `openramp.sessions.refresh()`.

## Verified vs TO VERIFY

The source has no TO VERIFY markers for Relay. The Relay API paths used are `/quote/v2`, `/currencies/v2`, `/intents/status/v3`, `/requests/v3` (with a key) or `/requests/v2`, and `/chains` (health).
