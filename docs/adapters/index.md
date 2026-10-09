# Adapters

An adapter connects one provider to the OpenRampKit server. You create it with the provider's factory and pass it in `adapters`:

```ts
import { createOpenRamp } from '@openrampkit/server'
import { relay } from '@openrampkit/adapter-relay'
import { swapped } from '@openrampkit/adapter-swapped'
import { xendit } from '@openrampkit/adapter-xendit'

createOpenRamp({
  secret: process.env.OPENRAMP_SECRET!,
  baseUrl: 'https://app.example.com/api/openramp',
  adapters: [
    relay({ apiKey: process.env.RELAY_API_KEY }),
    swapped({ publicKey: process.env.SWAPPED_PUBLIC_KEY!, secretKey: process.env.SWAPPED_SECRET_KEY! }),
    xendit({ secretKey: process.env.XENDIT_SECRET_KEY!, webhookToken: process.env.XENDIT_WEBHOOK_TOKEN! }),
  ],
})
```

To get the keys and webhook secrets for each provider, see [Get provider keys](../guide/provider-keys.md).

Each adapter is its own package, for example `@openrampkit/adapter-relay`. The packages are not on npm yet. See [Try it before the npm release](../guide/installation.md#try-it-before-the-npm-release).

Each adapter id may appear once. The server refuses an adapter built for another API version.

For withdrawals, three adapters have legs today: Relay (`wallet`, to any address), Swapped (`sell-*`, to cash) and Mock (`wallet` and `offramp`). See [Withdrawals](../guide/withdraw.md).

## Overview

| Adapter | Package | Legs | Methods | Countries | Surfaces | Account | Status |
|---|---|---|---|---|---|---|---|
| [Relay](./relay.md) | `@openrampkit/adapter-relay` | `wallet`, `transfer`, `bridge` | wallet, transfer | All | `WALLET_TX`, `DEPOSIT_ADDRESS` | API key (Relay requires one for quotes from 2 Oct 2026; always set it) | Working |
| [LI.FI](./lifi.md) | `@openrampkit/adapter-lifi` | `wallet` | wallet | All | `WALLET_TX` | Optional API key | New; some details TO VERIFY |
| [Swapped](./swapped.md) | `@openrampkit/adapter-swapped` | One per Swapped payment group (live catalog); `sell-*` payout legs for withdrawals | card, Apple Pay, Google Pay, bank transfer, VietQR, MoMo, GCash, GoPay, DANA, PIX, UPI, BLIK, SPEI, mobile money and more; payouts: bank transfer, Skrill, PIX, Interac | Per method, from the catalog; not US-TX | `IFRAME` (sell: then `WALLET_TX`) | Yes | Working; status polling is TO VERIFY |
| [Coinbase](./coinbase.md) | `@openrampkit/adapter-coinbase` | `card`, `apple_pay`, `google_pay`, `ach` | card, Apple Pay, Google Pay, ACH (US) | Where Coinbase operates, not JP | `REDIRECT` | Yes (CDP) | Working; several details TO VERIFY |
| [Binance](./binance.md) | `@openrampkit/adapter-binance` | `account` | Connect exchange (`exchange`): pay from the Binance balance | Where Binance serves users; not US, CA, NL | `REDIRECT` | Yes, with Binance partner approval | New; several details TO VERIFY |
| [Transak](./transak.md) | `@openrampkit/adapter-transak` | `card`, `apple_pay`, `google_pay`, `bank_transfer`, `upi`, `faster_payments`, `open_banking`, `pse` (live catalog) | card, Apple Pay, Google Pay, bank transfer, SEPA, UPI, Faster Payments, pay by bank, PSE and more | Per fiat currency, from the catalog | `IFRAME` (or `REDIRECT`) | Yes | Working; several details TO VERIFY |
| [MoonPay](./moonpay.md) | `@openrampkit/adapter-moonpay` | `card`, `apple_pay`, `google_pay`, `ach`, `sepa`, `gbp_bank`, `gbp_open_banking`, `pix`, `paypal`, `venmo`, `revolut_pay`, `interac` | Same; `gbp_bank` is Faster Payments, `gbp_open_banking` is pay by bank | Where MoonPay allows buying (live catalog) | `REDIRECT` (or `IFRAME`) | Yes | New; some details TO VERIFY |
| [Stripe](./stripe.md) | `@openrampkit/adapter-stripe` | `card`, `apple_pay`, `google_pay`, `ach` | Same | US (not HI) and EU | `PROVIDER_SDK` (or `REDIRECT`) | Yes, with onramp approval | New; some details TO VERIFY |
| [Xendit](./xendit.md) | `@openrampkit/adapter-xendit` | One per country and channel, e.g. `id-qris` | QRIS, DANA, OVO, ShopeePay, QR Ph, GCash, Maya, GrabPay, PromptPay, TrueMoney, Touch 'n Go, MoMo, ZaloPay, PayNow | ID, PH, TH, MY, VN, SG | `QR`, `REDIRECT`, `DEEPLINK` | Yes | Working (merchant destination only) |
| [Mock](./mock.md) | `@openrampkit/adapter-mock` | `card`, `local`, `payin`, optional `wallet`, `transfer`, `bridge`, `offramp` | Every common method | All (local methods in SEA) | `REDIRECT`, `QR`, `WALLET_TX`, `DEPOSIT_ADDRESS`, `FORM` | No | For tests; moves no money |
| [Meld](./meld.md) | `@openrampkit/adapter-meld` | One per payment method (live catalog) | card, Apple Pay, Google Pay, UPI, IMPS, PIX, SEPA, SEPA Instant, ACH, iDEAL, Bancontact, BLIK, PayID, SPEI, PSE, Khipu, M-Pesa, mobile money and more | Per method and country | `REDIRECT` | Yes | New; in progress; some details TO VERIFY |
| [Onramper](./onramper.md) | `@openrampkit/adapter-onramper` | One per payment type (live catalog) | card, Apple Pay, Google Pay, SEPA, SEPA Instant, ACH, PIX, UPI, IMPS, iDEAL, Bancontact, Faster Payments, pay by bank, SPEI, Bancolombia, Khipu and more | Per method and country | `REDIRECT` | Yes (with a signing key) | New; in progress; some details TO VERIFY |
| [Bridge](./bridge.md) | `@openrampkit/adapter-bridge` | `usd-ach`, `usd-wire`, `eur-sepa`, `mxn-spei`, `brl-pix`, `gbp-fps`; `payout-*` legs for withdrawals | ACH, bank transfer (wire), SEPA, SPEI, Pix, Faster Payments; payouts: ACH, wire, SEPA | All except the Bridge deny list and US-NY | `BANK_FIELDS`, `QR`, `REDIRECT`, `FORM` (payout: then `WALLET_TX`) | Yes, with KYC per user | New; some details TO VERIFY |
| [Peer](./peer.md) | `@openrampkit/adapter-peer` | `venmo`, `cashapp`, `zelle`, `chime`, `paypal`, `revolut`, `wise` | Venmo, Cash App, Zelle, Chime, PayPal, Revolut, Wise | US; Revolut in GB and EEA; Wise everywhere | `REDIRECT` (or `IFRAME`) | Yes | New; opt-in P2P marketplace (read the warning) |

See [Payment methods](../concepts/payment-methods.md) for each method, its countries and its adapters.

"TO VERIFY" means the source code marks a provider detail as not yet checked against the live API. Each adapter page lists them.

## Provider webhooks

Adapters with a `webhook` handler receive provider callbacks at:

```
{baseUrl}/webhooks/{adapterId}
```

For example `https://app.example.com/api/openramp/webhooks/swapped`. Register this URL in the provider's dashboard. The adapter verifies the signature and turns the payload into leg events. The server finds the session by the provider reference and updates it. Repeated webhooks are safe: a leg that already ended ignores later events.

Adapters without webhooks (Relay) are driven by status checks: the browser's poll (`GET /sessions/:id/step`), and the [background sweep](../api/server.md#background-sweep) (or `openramp.sessions.refresh(id)`) after the user leaves.

## Adapter routes

An adapter may serve its own pages at `{baseUrl}/adapters/{adapterId}/*`. The mock adapter uses this for its hosted checkout.

## Common patterns

- **Static legs plus a live catalog.** Swapped, Coinbase, Transak, MoonPay, Meld, Onramper and Peer declare static legs and refine them with `catalog()` at plan time (cached in the store). If the catalog call fails, the server logs a warning and uses the static legs.
- **Delivery for hops.** Onramp adapters deliver to `deliverTo.address` when the server gives one (the Relay deposit address in a two-leg pathway), else to the session's destination address.
- **References.** Every started leg returns a `ref` (an order id, a deposit address or a request id). Webhooks and status checks find the leg by it.

## Wallets

Wallet adapters are separate: they run in the browser and sign `WALLET_TX` surfaces. See [Wallets (wagmi)](./wagmi.md).

## Write your own

See [Writing an adapter](./writing-an-adapter.md).
