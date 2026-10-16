# Flashnet

`@openrampkit/adapter-flashnet` uses the [Flashnet Orchestra API](https://docs.flashnet.xyz/orchestra/quickstart). It adds three ways to deposit:

- **Cash App** (`cash_app`): the user pays a Lightning invoice from the Cash App USD balance and gets USDC at the destination.
- **Lightning** (`lightning`): the same invoice, paid from any Lightning wallet.
- **Transfer from Bitcoin or Tron** (`transfer`): the user sends BTC on Bitcoin or USDT on Tron to an Orchestra deposit address and gets USDC at the destination.

It also adds two ways to withdraw (see [Payouts](#payouts-to-cash-app-or-a-lightning-address)):

- **Cash App** (`cash_app_payout`, method `cash_app`): USDC from the user's wallet or your treasury, paid over Lightning to a Cash App `$cashtag`.
- **Lightning** (`lightning_payout`, method `lightning`): the same payout to any Lightning address (`name@domain`).

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
| `legs` | `Array<'cash_app' \| 'lightning' \| 'transfer' \| 'cash_app_payout' \| 'lightning_payout'>` | all | The legs to offer |
| `invoiceSurface` | `'qr' \| 'deeplink'` | `'qr'` | How the Lightning invoice shows: a QR code that the user scans with the phone, or a button that opens Cash App (or the Lightning wallet). Use `'deeplink'` in a mobile app. |
| `refundAddresses` | `{ tron?: string; bitcoin?: string; evm?: string }` | none | Where a refund goes when the user's own address on the origin chain is not known. Orchestra requires a refund address for Tron deposits, so without `tron` the Tron route gets no quote. A payout needs one too: the sender (the connected wallet, or `treasury.address`), else `evm`. A refund to this address goes to you, not to the user. |
| `deliverAssets` | `FlashnetDeliverAsset[]` | USDC on Base, Solana, Ethereum, Arbitrum, Optimism, Polygon | Assets Orchestra may deliver, with the Orchestra chain and asset ids (`fnChain`, `fnAsset`) and the decimals |
| `apiUrl` | `string` | `https://orchestration.flashnet.xyz` | Override the host |

## Legs

| Leg | Kind | Method | From | Regions | Surface |
|---|---|---|---|---|---|
| `cash_app` | `fiat_onramp` | `cash_app` | USD (the Cash App balance) | US, not US-NY | `QR` (or `DEEPLINK`) |
| `lightning` | `fiat_onramp` | `lightning` | USD, paid as BTC over Lightning | All, not US-NY | `QR` (or `DEEPLINK`) |
| `transfer` | `bridge_swap` | `transfer` | BTC on Bitcoin, USDT on Tron | All | `DEPOSIT_ADDRESS` |
| `cash_app_payout` | `crypto_offramp` | `cash_app` | USDC on Base, Ethereum, Arbitrum, Optimism, Polygon; to a `$cashtag` | US, not US-NY | `WALLET_TX` |
| `lightning_payout` | `crypto_offramp` | `lightning` | The same; to a Lightning address | All, not US-NY | `WALLET_TX` |

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

## Payouts to Cash App or a Lightning address

A withdraw session pays out to a `lightning` target: the user types a `$cashtag` or a Lightning address on the "To Cash App" tab, or your backend sets it at creation. The server parses it, checks `allowedDestinations.lightning`, and runs your `screenLightningAddress` hook (see [Withdrawals](../guide/withdraw.md#to-cash-app)). The adapter reads the recipient only from that stored target.

```ts
openramp.sessions.create({
  userId: user.id,
  direction: 'withdraw',
  source: { chain: 'eip155:8453', token: USDC_BASE, custody: 'user_wallet' },
  allowedDestinations: { lightning: { domains: ['cash.app'] } }, // Cash App only
  country: 'US',
})
```

1. `quote()` takes the amount you send (exact in; an amount out gets no quote). It calls `GET /v1/orchestration/estimate` to `lightning:BTC` with the USDC amount in base units. The output is BTC (8 decimals), and the quote is an `estimate`: delivery is variable, and the dollar amount is not locked. The Cash App leg adds a fee line for the Cash App rate, with no stated amount. TO VERIFY: that the estimate prices a `lightning:BTC` destination as the offramp does.
2. `start()` calls `POST /v1/orchestration/offramp` with `sourceChain`, `sourceAsset: 'USDC'`, the quoted `amount`, `recipientAddress` (`$name` for Cash App, else `name@domain`), `refundAddress` (the sender on the source chain) and `tag`. The leg `ref` is the Orchestra `quoteId`.
3. The step is a `WALLET_TX`: an ERC-20 `transfer(depositAddress, amount)` on the USDC contract, which the adapter builds itself from the checked answer. The user signs it, or your [treasury](../guide/withdraw.md#custody-app) sends it.
4. `submit_tx` keeps the transaction hash and reports it to `POST /v1/orchestration/submit` (the documented fallback; Orchestra also detects EVM deposits by itself, so a failed call is only a warning).
5. The leg follows the order by status checks and webhooks, as above. `completed` gives the delivered sats as the output.

::: warning Cash App dollars
`completed` means the Lightning payment arrived. It does not confirm a dollar credit, the dollar amount, or the Cash App fee. To get dollars, the Cash App user turns on "Receive Lightning as dollars" in the Bitcoin section. Orchestra does not check that setting. The widget shows this hint under the input. Orchestra resolves the recipient at delivery, so a missing account, a refused callback, or an amount outside the wallet's limits can fail after funding. Recovery uses `refundAddress`.
:::

Payout safety checks (each fails closed):

- **Target.** The recipient comes only from the session's validated `lightning` destination, parsed again by the adapter. The Cash App leg pays only a `$cashtag`, the Lightning leg only another Lightning address. A `deliverTo` address is refused.
- **Amount and asset.** The amount is the quote's input in base units, and must equal the amount in the quote data. The source must be the session source (USDC on a supported chain). The answer must have the same `amountIn`, `amountMode: 'exact_in'` when present, the same source chain, asset, decimals and contract when present, `lightning:BTC` as the destination, the same recipient when present, no memo, and an EVM deposit address that is not zero.
- **One payout.** `claimOnce` binds each Orchestra quote to one session leg, each deposit address to one quote, each payout to one funding transaction, and each funding transaction to one payout. The server also starts a leg at most once (version check) and sends from the treasury at most once per step.
- **Completion.** A `completed` order counts only when it is for this quote, delivers `lightning:BTC` to the same recipient (`$alice` and `alice@cash.app` are the same), took the quoted source asset and amount (when the order names them), and has a positive `amountOut`. Else the leg stays `processing` with an error log.
- **Status binding.** The leg `ref` is the `quoteId`, so the server's ref index finds the session for a webhook. A funded payout never goes back to the wallet step, and an expired order after a funding transaction stays `processing`.

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

- **Spark deposits** and **standing deposit addresses**.
- **Payouts from Solana or other non-EVM sources.** Orchestra lists `lightning:BTC` for USDC on Solana too, but the adapter builds EVM transfers only.

## Verified and TO VERIFY

Confirmed in the docs and the OpenAPI spec: the base URL, server and client keys, account approval, amounts in the smallest unit, the estimate, limits, quote, onramp, status and webhook shapes, the signature scheme, the status values, the error format and codes, the invoice in `depositAddress`, the Cash App link format, and the decimals (BTC 8, Tron USDT 6, USDC 6 on these chains). For payouts: the offramp request and answer, the recipient rules (`$name` and `name@domain`; invoices and URLs refused), the required `refundAddress`, and `lightning:BTC` in the routes of USDC on Base, Ethereum, Arbitrum, Optimism and Polygon.

TO VERIFY with a real order:

- The USD to sats step: the estimate has no USD input, and Cash App sets its own rate.
- That the invoice amount always equals `amountIn` (the adapter refuses it otherwise).
- The case of the invoice in the Cash App link (the docs show lowercase).
- Whether `recipientAddress` and `destination` come back in the onramp and quote answers (the adapter checks them when present).
- The `paused` (screening) path, and whether the order can continue after review.
- Who is the regulated party for the USD onramp, and the full region rules (New York City).
- Refunds for the onramp (Orchestra takes a Lightning address or an amountless invoice as `refundAddress`; the adapter sends none).
- Payouts: that `GET /estimate` prices `lightning:BTC` as the offramp quote does; that the order echoes `sourceChain`, `sourceAsset` and `amountIn` as sent; that the order names the Lightning address in `recipientAddress` (as `alice@cash.app` or `$alice`); the `/submit` body for EVM; and the region rules of the offramp.
