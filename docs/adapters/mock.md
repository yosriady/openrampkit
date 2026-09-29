# Mock

`@openrampkit/adapter-mock` is a test provider for local development, demos and tests. It moves no money. It exercises every common surface: a hosted redirect checkout, QR codes, a deposit address and a wallet transaction.

```ts
import { mockAdapter } from '@openrampkit/adapter-mock'

mockAdapter()                                          // fiat legs only
mockAdapter({ crypto: true, bridge: true })            // also wallet, transfer and bridge
mockAdapter({ settleMs: 0, name: 'Sandbox provider' }) // instant, custom name
```

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `settleMs` | `number` | `3000` | Time from "paid" to "completed" |
| `crypto` | `boolean` | `false` | Add mock `wallet` and `transfer` legs. Use when the real Relay adapter is not configured. |
| `bridge` | `boolean` | `false` | Add a mock `bridge` leg for two-leg pathways. Use when Relay is not configured. |
| `name` | `string` | `'Test provider'` | Name shown to users |

Do not turn on `crypto` or `bridge` next to the real Relay adapter: both would offer the same methods.

## Legs

| Leg | Kind | Methods | From | To | Regions | Surface |
|---|---|---|---|---|---|---|
| `card` | `fiat_onramp` | card, apple_pay, google_pay | any fiat | USDC on Base | all | `REDIRECT` |
| `local` | `fiat_onramp` | vietqr, momo, qris, gopay, dana, gcash, qrph, promptpay, duitnow, touchngo, paynow, bank_transfer | VND, IDR, PHP, THB, MYR, SGD | USDC on Base | VN, ID, PH, TH, MY, SG | `QR` |
| `payin` | `fiat_payin` | qris, promptpay, vietqr, qrph, duitnow, paynow, card | any fiat | merchant account (same currency) | all | `QR` |
| `wallet` | `bridge_swap` | wallet | any crypto in a wallet | any crypto | all | `WALLET_TX` |
| `transfer` | `bridge_swap` | transfer | any crypto in a wallet | any crypto | all | `DEPOSIT_ADDRESS` |
| `bridge` | `bridge_swap` | (hop) | USDC on known chains | any crypto | all | none shown |

Because the fiat legs deliver USDC on Base, a destination on another chain (for example Monad) gets a two-leg pathway through the `bridge` leg (or Relay).

## Quotes

- Fiat legs use fixed test FX rates to USD (USD, EUR, GBP, SGD, MYR, THB, PHP, IDR, VND, INR, BRL, AUD, CAD, JPY, KRW). Other currencies fail with `NO_QUOTES`.
- Fees: 2.5% for `card`, 1% for `local`, 0.7% for `payin` (paid in the same currency).
- Crypto legs: 1:1 minus 5 basis points.
- Quotes expire after 60 seconds.

## How to finish each leg

| Leg | Action |
|---|---|
| `card` | A new tab opens the mock checkout at `{baseUrl}/adapters/mock/checkout`. **Pay** marks the order paid; **Decline payment** fails it. |
| `local`, `payin` | Press **Simulate payment (test mode)** (transition `simulate_payment`) |
| `transfer` | Press **Simulate deposit (test mode)** (transition `simulate_deposit`) |
| `wallet` | Send with a wallet adapter; the client fires `submit_tx` with the hash |
| `bridge` | Nothing: it is paid when it starts and settles after `settleMs` |

After "paid", the leg is `PROCESSING` (sub-state `SETTLING`) until `settleMs` has passed, then `COMPLETED` with a fake transaction hash.

| Hosted checkout | QR with the simulate button |
|---|---|
| ![](../screenshots/31-card-checkout.png) | ![](../screenshots/04-vn-qr.png) |

## Routes and webhooks

The mock adapter serves two routes under `{baseUrl}/adapters/mock/`:

- `GET checkout?ref=...&amount=...&currency=...`: the mock checkout page.
- `POST pay`: the form target. It updates the order and applies a leg event to the session, like a webhook would.

It has no webhook handler.

## Wallets

Pair it with `createMockWallet()` from `@openrampkit/client` to test "Pay with wallet" without a real wallet. See [Testing with mocks](../guide/testing.md).
