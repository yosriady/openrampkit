# Mock

`@openrampkit/adapter-mock` is a test provider for local development, demos and tests. It moves no money. It exercises every common surface: a hosted redirect checkout, QR codes, a deposit address and a wallet transaction.

::: warning Test mode only
Anyone who knows an order ref can mark a mock payment as paid on the mock checkout page. So the mock refuses live sessions: with `livemode: true`, `quote()` and `start()` fail with `PROVIDER_UNAVAILABLE`. Do not configure it in production.
:::

```ts
import { mockAdapter } from '@openrampkit/adapter-mock'

mockAdapter()                                          // fiat legs only
mockAdapter({ crypto: true, bridge: true })            // also wallet, transfer and bridge
mockAdapter({ settleMs: 0, name: 'Sandbox provider' }) // instant, custom name
mockAdapter({ crypto: true, offramp: true })           // also withdraw to a wallet and to cash
```

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `settleMs` | `number` | `3000` | Time from "paid" to "completed" |
| `crypto` | `boolean` | `false` | Add mock `wallet` and `transfer` legs. Use when the real Relay adapter is not configured. |
| `bridge` | `boolean` | `false` | Add a mock `bridge` leg for two-leg pathways. Use when Relay is not configured. |
| `offramp` | `boolean` | `false` | Add a mock `offramp` leg for withdrawals to cash. See [Offramp leg](#offramp-leg). |
| `name` | `string` | `'Test provider'` | Name shown to users |
| `localChain` | `{ chain, rpcUrl, token, symbol?, decimals? }` | none | Test only. Add an `onchain` leg that pays with a real ERC-20 transfer on a local chain (for example Anvil). See [Local chain leg](#local-chain-leg). |

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
| `offramp` | `crypto_offramp` | bank_transfer, gcash, momo, promptpay | USDC on known chains (wallet or app address) | fiat in the user's account | all | `FORM`, then `WALLET_TX` |
| `onchain` | `bridge_swap` | wallet | `localChain.token` in a wallet | the same token to an address | all | `WALLET_TX` |

Because the fiat legs deliver USDC on Base, a destination on another chain (for example Monad) gets a two-leg pathway through the `bridge` leg (or Relay).

Solana destinations work too. A destination of USDC on Solana gets the two-leg pathway (fiat to Base, then `bridge`). The `wallet` leg from a Solana token asks for a Solana transfer (`SolanaTxRequest`, `type: 'transfer'`). The `transfer` leg shows a base58 test address for a Solana source. The `offramp` leg takes EVM USDC only.

The `wallet` leg (with `crypto: true`) also serves withdrawals to a wallet: it asks for one mock transaction to the target address.

## Offramp leg

`offramp: true` adds a `crypto_offramp` leg for [withdrawals to cash](../guide/withdraw.md#to-cash). It moves no money.

- Methods: `bank_transfer`, `gcash`, `momo`, `promptpay` (local methods only in their countries).
- Currencies: the test FX currencies below. Limits: 5 to 5000 USD.
- Quote: 1 USDC is 1 USD, minus a 1% fee in USDC, converted at the test FX rate.
- Steps:
  1. `FORM` (sub-state `PAYOUT_ACCOUNT`): the payout account. Bank transfer asks for the account holder name, the bank name and the account number. GCash, MoMo and PromptPay ask for the name and a phone number. Transition `submit_details`.
  2. `WALLET_TX` (sub-state `SEND_CRYPTO`): an ERC-20 USDC `transfer` of the quoted amount to a fake provider address. Transition `submit_tx`. With `custody: 'app'`, the server's treasury hook sends it.
  3. `PROCESSING` (`SETTLING`) for `settleMs`, then `COMPLETED` with the quoted payout as the output.

## Local chain leg

`localChain` adds an `onchain` leg for tests on a local dev chain. This leg sends a real transaction. Use it only with a test chain and a test token.

```ts
mockAdapter({
  localChain: { chain: 'eip155:31337', rpcUrl: 'http://127.0.0.1:8545', token: mockUsdcAddress },
})
```

- The destination must be an address on `chain` in `token`.
- Quote: 1:1 with no fee.
- Step 1: `WALLET_TX` (sub-state `SEND_CRYPTO`). The wallet sends an ERC-20 `transfer` of the quoted amount to the destination address. Transition `submit_tx` with the hash.
- Step 2: the adapter reads the receipt with `eth_getTransactionReceipt` at `rpcUrl`. The leg is `COMPLETED` when the receipt shows a `Transfer` of at least the quoted amount to the destination. It stays `PROCESSING` while there is no receipt. It is `FAILED` when the transaction reverted, pays less, pays another address or was already used for another payment.

This is the same check that the Relay adapter does for a same-chain wallet payment. See [Testing with mocks](../guide/testing.md#real-chain-test-with-anvil).

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
| `offramp` | Fill in the payout form (`submit_details`), then send with a wallet adapter or the treasury (`submit_tx`) |

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
