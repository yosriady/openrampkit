# Flashnet

`@openrampkit/adapter-flashnet` uses the [Flashnet Orchestra API](https://docs.flashnet.xyz/orchestra/quickstart). It adds three ways to deposit:

- **Cash App** (`cash_app`): the user pays a Lightning invoice from the Cash App USD balance and gets USDC at the destination.
- **Lightning** (`lightning`): the same invoice, paid from any Lightning wallet.
- **Transfer from Bitcoin or Tron** (`transfer`): the user sends BTC on Bitcoin or USDT on Tron to an Orchestra deposit address and gets USDC at the destination.

::: warning Experimental, not yet verified
This adapter is built from the public Orchestra docs and OpenAPI spec (read on 2026-10-16). No order has run through it yet. Orchestra has **no sandbox**: the only test is a small real order in production (the USD minimum is 1.00). Flashnet must approve your account before the API works. Details that the docs do not confirm are marked TO VERIFY below and in the source.
:::

```ts
import { flashnet } from '@openrampkit/adapter-flashnet'

flashnet({
  apiKey: process.env.FLASHNET_API_KEY!,              // server key, fn_...
  webhookSecret: process.env.FLASHNET_WEBHOOK_SECRET, // from POST /v1/webhooks
  refundAddresses: { tron: process.env.FLASHNET_TRON_REFUND }, // needed for Tron deposits
})
```

To get the keys, see [Get provider keys](../guide/provider-keys.md#flashnet).

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | required | A server key (`fn_...`), sent as `Authorization: Bearer`. The adapter refuses a client key (`fnp_...`). Server-side only. |
| `env` | `'production'` | `'production'` | Orchestra has production only. `'sandbox'` throws. |
| `webhookSecret` | `string` | none | The signing secret that `POST /v1/webhooks` returns (once). Without it, webhooks are rejected and the adapter relies on status checks. |
| `legs` | `Array<'cash_app' \| 'lightning' \| 'transfer'>` | all | The legs to offer |
| `invoiceSurface` | `'qr' \| 'deeplink'` | `'qr'` | How the Lightning invoice shows: a QR code that the user scans with the phone, or a button that opens Cash App (or the Lightning wallet). Use `'deeplink'` in a mobile app. |
| `refundAddresses` | `{ tron?: string; bitcoin?: string }` | none | Where a refund goes when the user's own address on the origin chain is not known. Orchestra requires a refund address for Tron deposits, so without `tron` the Tron route gets no quote. A refund to this address goes to you, not to the user. |
| `deliverAssets` | `FlashnetDeliverAsset[]` | USDC on Base, Solana, Ethereum, Arbitrum, Optimism, Polygon | Assets Orchestra may deliver, with the Orchestra chain and asset ids (`fnChain`, `fnAsset`) and the decimals |
| `apiUrl` | `string` | `https://orchestration.flashnet.xyz` | Override the host |

## Legs

| Leg | Kind | Method | From | Regions | Surface |
|---|---|---|---|---|---|
| `cash_app` | `fiat_onramp` | `cash_app` | USD (the Cash App balance) | US, not US-NY | `QR` (or `DEEPLINK`) |
| `lightning` | `fiat_onramp` | `lightning` | USD, paid as BTC over Lightning | All, not US-NY | `QR` (or `DEEPLINK`) |
| `transfer` | `bridge_swap` | `transfer` | BTC on Bitcoin, USDT on Tron | All | `DEPOSIT_ADDRESS` |

Orchestra says the onramp is "not available to residents of New York City". The region policy works by state, so the legs deny all of `US-NY`. TO VERIFY with Flashnet.

Bitcoin (`bip122:000000000019d6689c085ae165831e93`) and Tron (`tron:728126428`) are in the core chain table. The source picker shows them when an adapter (this one) lists a token on them.

## The Cash App and Lightning flow

1. `quote()` reads the USD limits of the route (`GET /v1/orchestration/limits`, `fiatUsd`) and refuses an amount outside them (`AMOUNT_TOO_LOW`, `AMOUNT_TOO_HIGH`). The estimate endpoint takes sats, not USD. So the adapter reads the route rate with a nominal 100,000 sats, then estimates the sats for the USD amount. The quote is an `estimate`: Cash App converts USD to sats at its own rate (a fee with no stated amount).
2. `start()` calls `POST /v1/orchestration/onramp` with `amountFiatUsd` and the session destination as `recipientAddress`. The answer has the BOLT11 invoice in `depositAddress`. The leg `ref` is the Orchestra `quoteId`, and `providerRef` is the `orderId`.
3. The surface is a QR code (or a deep link) to `https://cash.app/launch/lightning/{invoice}` for Cash App, or `lightning:{invoice}` for a Lightning wallet. The adapter builds the link from the invoice. It never opens the link from the answer.
4. Paying the invoice creates the order. The leg follows the order by status checks and webhooks.
5. An invoice that is not paid ends the leg with `QUOTE_EXPIRED` and `recovery: 'requote'`, one minute after it expires. A late payment then takes the server's late payment path.

A `202` answer with `status: 'paused'` means that Flashnet keeps the order for a screening review, with no invoice. Nothing was paid, so the leg fails with `PROVIDER_DECLINED` and the user can choose another method.

## Deposits from Bitcoin and Tron

`quote()` uses `GET /v1/orchestration/estimate` with the amount in the smallest unit (sats, or 6 decimals for USDT). `start()` calls `POST /v1/orchestration/quote` and shows the `depositAddress` (and `depositMemo`, when there is one). Orchestra sees the deposit and makes the order with no confirm call. A deposit after the 2-minute quote gets new pricing, so the quote is an `estimate`.

## Status and webhooks

`status()` calls `GET /v1/orchestration/status?quoteId={ref}`. Before the deposit, it answers `404`, and the leg waits. Webhooks go to `{baseUrl}/webhooks/flashnet`. The adapter checks `X-Flashnet-Signature` (hex HMAC-SHA256 of `{X-Flashnet-Timestamp}.{rawBody}`) in constant time, with a 5-minute window. The replay key and the event id are `(data.id, event, data.updatedAt)`, as the docs advise.

| Orchestra status | Leg status | Detail |
|---|---|---|
| `processing` | `processing` | `processing` |
| `confirming` | `processing` | `confirming` |
| `swapping`, `delivering` | `processing` | `settling` |
| `bridging` | `processing` | `bridging` |
| `refunding` | `processing` | `refunding` |
| `awaiting_approval`, `paused`, `unfulfilled` | `processing` | `delayed` |
| `completed` | `succeeded` (after the checks below) | |
| `refunded` | `refunded` | |
| `failed`, `fallback_delivered`, `order.recovery_required` | `processing` | `delayed`, and an error log for the operator |
| `expired` with no deposit | `expired` (`QUOTE_EXPIRED`) | |

An order exists only after the user paid. So a failed order never shows as failed and never offers "try again": the leg stays `processing`, and the operator sees an error log and handles the order in the Flashnet dashboard. An unknown status keeps the current step.

## Money safety checks

- **Destination.** The recipient is always the session destination (or the next leg's deposit address). A quote for an asset that is not the session destination is refused. An answer that names another recipient, another asset or other decimals is refused before the user sees an invoice or an address.
- **Invoice.** The adapter reads the BOLT11 invoice (bech32 checksum, network, amount, expiry, payment hash). It refuses a testnet invoice, an amountless invoice, an amount other than the order's `amountIn`, and an invoice with less than one minute left. The QR code shows the earlier of the invoice expiry and the order `expiresAt`.
- **One payment, one leg.** `claimOnce` binds each payment hash and each deposit address to one leg at start, and each order id and deposit transaction to one leg at completion.
- **Completion.** A `completed` order counts only when it is for this quote, delivers the expected chain and asset to the expected address, and has a positive `amountOut`. Any miss keeps the leg `processing` with an error log. The server then checks the output against the quote.
- **Webhook binding.** The leg `ref` is the `quoteId`, so the server's ref index finds the session. The adapter keeps what each leg expects in its shared store, and ignores a webhook for a quote it did not start.

## Not built yet

- **Payouts to Cash App** (`POST /v1/orchestration/offramp`, phase 3 of the issue). They need a withdraw target for a `$cashtag` or a Lightning address, with its own screening, which the server does not have yet. The docs also say that `completed` means the Lightning payment arrived, not that Cash App credited dollars.
- **Spark deposits** and **standing deposit addresses**.

## Verified and TO VERIFY

Confirmed in the docs and the OpenAPI spec: the base URL, server and client keys, account approval, amounts in the smallest unit, the estimate, limits, quote, onramp, status and webhook shapes, the signature scheme, the status values, the error format and codes, the invoice in `depositAddress`, the Cash App link format, and the decimals (BTC 8, Tron USDT 6, USDC 6 on these chains).

TO VERIFY with a real order:

- The USD to sats step: the estimate has no USD input, and Cash App sets its own rate.
- That the invoice amount always equals `amountIn` (the adapter refuses it otherwise).
- The case of the invoice in the Cash App link (the docs show lowercase).
- Whether `recipientAddress` and `destination` come back in the onramp and quote answers (the adapter checks them when present).
- The `paused` (screening) path, and whether the order can continue after review.
- Who is the regulated party for the USD onramp, and the full region rules (New York City).
- Refunds for the onramp (Orchestra takes a Lightning address or an amountless invoice as `refundAddress`; the adapter sends none).
