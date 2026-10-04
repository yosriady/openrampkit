# Payment methods

A payment method is the way the user pays: a card, a wallet, a bank rail or a local QR code. Each method has a code in `METHODS` (`packages/core/src/codes.ts`). Adapters map their provider ids to these codes.

The user sees a method when all of these are true:

1. An adapter that you configure has a leg for the method.
2. The method exists in the user's country (`METHOD_COUNTRIES`). A method that is not in that table exists everywhere.
3. The leg accepts the local currency of the user's country (`COUNTRY_CURRENCY`). A country that is not in the table uses USD.

The planner then sorts the methods by the country's priority list (`DEFAULT_METHOD_PRIORITY`). See [Pathways and legs](./pathways.md#grouping).

Adapters with a live catalog (Transak, Meld, Onramper, Swapped, Coinbase, MoonPay) can add or remove methods per user. So the exact list can change. The tables show the static legs and the catalog mappings.

## Global methods

| Method | Code | Regions | Adapters | Notes |
|---|---|---|---|---|
| Card | `card` | All | Coinbase, Transak, MoonPay, Stripe, Meld, Onramper, Swapped | |
| Apple Pay | `apple_pay` | All | Coinbase, Transak, MoonPay, Stripe, Meld, Onramper, Swapped | |
| Google Pay | `google_pay` | All | Coinbase, Transak, MoonPay, Stripe, Meld, Onramper, Swapped | Coinbase sends it as `CARD` |
| PayPal | `paypal` | All (catalog decides) | MoonPay, Peer (US); Meld, Onramper (catalog) | MoonPay: US, UK and EU. Coinbase has PayPal for sell only |
| Revolut Pay | `revolut_pay` | All (catalog decides) | MoonPay; Meld, Onramper (catalog) | |
| AstroPay | `astropay` | All (catalog decides) | Transak, Meld, Swapped (catalog) | Mostly Latin America. Transak id TO VERIFY |
| Alipay | `alipay` | All (catalog decides) | Onramper (catalog) | |

## Europe

| Method | Code | Regions | Adapters | Notes |
|---|---|---|---|---|
| SEPA | `sepa` | Euro countries, NO, IS, LI, CH | Transak, MoonPay, Meld, Onramper | MoonPay `sepa_bank_transfer` also covers SEPA Instant. Swapped sends EUR bank payments as `bank_transfer` |
| SEPA Instant | `sepa_instant` | Euro countries, NO, IS, LI, CH | Meld, Onramper | Meld `SEPA_INSTANT`, Onramper `sepainstant` |
| Faster Payments | `faster_payments` | GB | MoonPay, Transak, Meld, Onramper | MoonPay and Transak `gbp_bank_transfer`, Meld `UK_FASTER_PAYMENTS`, Onramper `fasterpaybank` |
| Pay by bank (open banking) | `open_banking` | GB and EEA | MoonPay (GB), Transak, Meld, Onramper | MoonPay `gbp_open_banking_payment`, Transak `pm_open_banking`, Meld `OPEN_BANKING`, Onramper `fasterpayopen` (GBP) or `openbanking` (EUR) |
| iDEAL | `ideal` | NL | Meld, Onramper | |
| Bancontact | `bancontact` | BE | Meld, Onramper | |
| BLIK | `blik` | PL | Meld; Swapped (catalog) | Polish users pay in PLN |
| Sofort | `sofort` | AT, BE, CH, DE, ES, IT, NL, PL | Meld, Onramper (catalog) | |
| Revolut | `revolut` | US, GB, EEA | Peer; Meld (catalog) | |
| Wise | `wise` | All | Peer | |

## Americas

| Method | Code | Regions | Adapters | Notes |
|---|---|---|---|---|
| ACH | `ach` | US | Coinbase, MoonPay, Stripe, Meld, Onramper | Coinbase `ACH`, Onramper `iach` |
| Venmo | `venmo` | US | MoonPay, Peer; Meld, Onramper (catalog) | |
| Cash App, Zelle, Chime | `cash_app`, `zelle`, `chime` | US | Peer; Meld (Cash App, Zelle, catalog) | |
| Interac e-Transfer | `interac` | CA | MoonPay, Meld, Onramper | Swapped has Interac for payouts (withdraw) |
| SPEI | `spei` | MX | Meld, Onramper; Swapped (catalog) | Meld also maps `STP` |
| PSE | `pse` | CO | Transak, Meld | Transak `pm_pse` is TO VERIFY per partner account |
| Bancolombia | `bancolombia` | CO | Onramper | |
| Khipu | `khipu` | CL, AR | Meld, Onramper | Static legs take CLP only |
| Pix | `pix` | BR | MoonPay, Meld, Onramper, Swapped | |
| Mercado Pago | `mercadopago` | AR, BR, CL, CO, MX, PE, UY | Meld (catalog) | Meld code `MERCADOPAGO` |

## Asia Pacific (outside Southeast Asia)

| Method | Code | Regions | Adapters | Notes |
|---|---|---|---|---|
| UPI | `upi` | IN | Transak, Meld, Onramper, Swapped | Transak and Meld ids are TO VERIFY |
| IMPS | `imps` | IN | Meld, Onramper | |
| PayID | `payid` | AU | Meld | |

For Southeast Asia (VietQR, QRIS, PromptPay, QR Ph, PayNow, GCash and more), see the [README](https://github.com/yosriady/openrampkit#payment-methods).

## Africa

| Method | Code | Regions | Adapters | Notes |
|---|---|---|---|---|
| M-Pesa | `mpesa` | KE | Meld; Onramper (catalog) | Onramper lists `mpesa`, but no Kenya query returned it on 2026-10-04 |
| Mobile money | `mobile_money` | 29 countries in Africa and Asia (for example GH, UG, TZ, ZM, RW, KE) | Meld; Swapped (catalog, KE and ZM) | Not the same as `momo` (MoMo, the Vietnamese wallet) |

## Local currencies

These countries use their local currency for quotes, so that the local methods can match: PL (PLN), CO (COP), CL (CLP), GH (GHS), UG (UGX), TZ (TZS), ZM (ZMW), RW (RWF), and every euro country (EUR). An adapter that does not accept the currency gives no legs in that country.

## Methods we did not add

No configured provider documents these methods, so they have no code: Trustly, Swish, MobilePay and NEFT. Meld's coverage list has no code for them. Use `open_banking` for bank payments in those countries.

## Sources

Each adapter source file has the source URL next to its mapping. The main sources are:

- MoonPay: [widget parameters](https://dev.moonpay.com/widget/on-ramp/customization/parameters.md), [buy quote](https://dev.moonpay.com/api-reference/widget/getbuyquote.md), [supported payment methods](https://support.moonpay.com/en/articles/380823-moonpay-s-supported-payment-methods).
- Transak: [live fiat currency list](https://api.transak.com/api/v2/currencies/fiat-currencies), [Get Fiat Currencies](https://docs.transak.com/api/public/get-fiat-currencies), [fee table](https://transak.notion.site/On-Ramp-Payment-Methods-Fees-Other-Details-b0761634feed4b338a69f4f186d906a5).
- Coinbase: [create an onramp session](https://docs.cdp.coinbase.com/api-reference/v2/rest-api/onramp/create-an-onramp-session), [payment methods](https://docs.cdp.coinbase.com/onramp/additional-resources/payment-methods).
- Stripe: [embedded components overview](https://docs.stripe.com/crypto/onramp/embedded-components-overview). Card, Apple Pay, Google Pay and ACH (US) only. No new methods.
- Meld: [payment method coverage](https://www.meld.io/coverage/payment-methods).
- Onramper: the live lists `GET https://api.onramper.com/supported/payment-types` and `GET /supported/payment-types/{fiat}?country=...`.
- Swapped: [get payment methods](https://docs.swapped.com/swapped-ramp/endpoints/onramp-endpoints/get-payment-methods).

## Add a method

1. Add the code, name and kind to `METHODS`.
2. If the method is local, add its countries to `METHOD_COUNTRIES`.
3. Add it to the priority list of each country where it is popular (`DEFAULT_METHOD_PRIORITY`).
4. If the country has no currency in `COUNTRY_CURRENCY`, add it.
5. Map the provider id in each adapter that supports it. Write the source URL in a comment. If the id is not confirmed, write `TO VERIFY`.
