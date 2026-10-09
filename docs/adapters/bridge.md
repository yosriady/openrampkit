# Bridge

`@openrampkit/adapter-bridge` connects [Bridge](https://apidocs.bridge.xyz) (a Stripe company).

- **Deposits:** Bridge opens a virtual bank account for the user. The user sends ACH, wire, SEPA, SPEI, Pix or Faster Payments to it. Bridge converts the money to USDC and sends it on chain to the destination address.
- **Withdrawals:** the user sends USDC to Bridge. Bridge pays out to the user's US bank account (ACH or wire) or IBAN (SEPA).

Bridge needs KYC for each user. The adapter sends the user to the Bridge hosted pages for the terms of service and for KYC. Then it shows the bank details.

```ts
import { bridge } from '@openrampkit/adapter-bridge'

bridge({
  apiKey: process.env.BRIDGE_API_KEY!,
  webhookPublicKey: process.env.BRIDGE_WEBHOOK_PUBLIC_KEY!,
  // Optional: give the Bridge customer id when your app already has one
  customer: async ({ userId }) => {
    const u = await db.users.get(userId)
    return u.bridgeCustomerId ? { customerId: u.bridgeCustomerId } : { fullName: u.legalName, email: u.email }
  },
})
```

## Access

- Bridge has no self-serve sign-up. Contact Bridge sales to get an account.
- For the sandbox, ask Bridge support for a developer account. Then make a sandbox key in the dashboard (turn on the "Sandbox" toggle). Only dashboard admins can make keys. Sandbox keys start with `sk-test`.
- In the sandbox, KYC links do not work and no money moves. Make the customer with `POST /v0/customers`, approve it with `POST /v0/customers/{id}/simulate_kyc_approval`, and give its id with the `customer` hook. The sandbox sends no payment webhooks.
- Production: Bridge does KYB of your company. The steps are not in the public docs.

To get the keys, see [Get provider keys](../guide/provider-keys.md#bridge).

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | required | Bridge API key. Sent as the `Api-Key` header. |
| `webhookPublicKey` | `string` | required | The public key (PEM) of your webhook endpoint. `\n` escapes are accepted. |
| `env` | `'sandbox' \| 'production'` | `'production'` | `production` is `https://api.bridge.xyz`. `sandbox` is `https://api.sandbox.bridge.xyz`. |
| `apiUrl` | `string` | from `env` | API base URL without `/v0` |
| `developerFeePercent` | `string` | none | Your fee in percent, for example `'0.5'`. Sent as `developer_fee_percent` on virtual accounts and transfers. Shown as the "App fee" in quotes. |
| `bridgeFeeBps` | `number` | `0` | Bridge's fee in basis points, for quotes only. Bridge pricing is per contract and the API has no fee quote. Set your contract rate. |
| `legs` | `string[]` | all | Offer only these legs |
| `withdraw` | `boolean` | `true` | Add the payout legs |
| `customer` | `(user) => Promise<{ customerId?, fullName?, email? } \| undefined>` | none | Find the Bridge customer of a user, or give the name and email for a new KYC link |

## Legs

Deposit legs (`fiat_onramp`) deliver USDC to an `address` on Base, Ethereum, Arbitrum, Optimism, Polygon, Avalanche or Solana.

| Leg | Method | Currency | Endorsement | Min | Surface |
|---|---|---|---|---|---|
| `usd-ach` | `ach` | USD | `base` | 1 | `BANK_FIELDS` |
| `usd-wire` | `bank_transfer` | USD | `base` | 1 | `BANK_FIELDS` |
| `eur-sepa` | `sepa` | EUR | `sepa` | 1 | `BANK_FIELDS` |
| `mxn-spei` | `spei` | MXN | `spei` | 50 | `BANK_FIELDS` |
| `brl-pix` | `pix` | BRL | `pix` | 10 | `QR` (the Pix BR Code) |
| `gbp-fps` | `faster_payments` | GBP | `faster_payments` | 2 | `BANK_FIELDS` |

Payout legs (`crypto_offramp`) take USDC from `user_wallet` or `address` on the same chains.

| Leg | Method | Currency | Bridge rail | Min (USDC) |
|---|---|---|---|---|
| `payout-usd-ach` | `ach` | USD | `ach` | 1 |
| `payout-usd-wire` | `bank_transfer` | USD | `wire` | 1 |
| `payout-eur-sepa` | `sepa` | EUR | `sepa` | 1 |

Every leg also uses `REDIRECT` (the Bridge ToS and KYC pages) and `FORM` (name and email, or the payout account).

Minimums come from the Bridge rail pages. Bridge treats a deposit under 1 USD as a microdeposit and does not convert it. Pix has a limit of 500,000 USD for each customer each month.

Regions: all countries, except the countries that Bridge does not serve (`BRIDGE_DENY`): DZ, BI, CN, JP, TN, the prohibited list (AF, BY, CD, CU, PS, IR, IQ, LB, LY, MM, KP, RU, SO, SS, SD, SY, VE, YE) and `US-NY`. The planner shows each deposit leg only to users whose local currency is the leg currency.

## Quotes

- USD: 1 USD gives 1 USDC, less the fees.
- EUR, MXN, BRL and GBP: `GET /v0/exchange_rates?from={currency}&to=usd`. The adapter uses `buy_rate`, which includes the Bridge FX fee. The rate is kept for 30 seconds.
- Payouts in EUR: `GET /v0/exchange_rates?from=usd&to=eur`.
- Exact output works: the adapter rounds the fiat input up to the minor unit.
- Bridge has no rate lock. The bank transfer converts at the rate of the day it arrives. Quotes are estimates and expire after 10 minutes.

## Deposit flow

1. **Customer.** The adapter looks for the customer: the `customer` hook, then the customer or KYC link of an earlier session of the same user.
2. **KYC details.** When there is no customer and no KYC link, and the name or the email is not known, the step is `KYC` with a `FORM` (full legal name, email). The `submit_kyc` transition takes the answers.
3. **KYC link.** `POST /v0/kyc_links` with `type: 'individual'`, the rail endorsement and `redirect_uri` (the session return URL). The step is `KYC` with a `REDIRECT` to `tos_link` until the ToS is accepted, then to `kyc_link`. While Bridge reviews, the step is `KYC` with status `processing`. A rejected or offboarded user fails with `KYC_REJECTED`.
4. **Customer check.** `GET /v0/customers/{id}`. The customer must be `active` with the rail endorsement `approved`. A `paused` or `deposits_restricted` customer fails with `PROVIDER_DECLINED`.
5. **Virtual account.** `POST /v0/customers/{id}/virtual_accounts` with `source.currency`, `destination: { currency: 'usdc', payment_rail, address }` and the developer fee. The adapter keeps one virtual account for each customer, currency, chain and address, and uses it again in later sessions.
6. **Bank details.** The step is `PAYMENT` with `BANK_FIELDS`: amount, bank name, routing and account number, IBAN and BIC, CLABE, or sort code, beneficiary and bank address. For BRL, it is a `QR` of the Pix BR Code.
7. **Status.** `GET /v0/customers/{id}/virtual_accounts/{va}/history` and `virtual_account.activity` webhooks. The leg takes the first deposit after the session started that no other session took.

| Virtual account event | Leg |
|---|---|
| `funds_scheduled`, `funds_received`, `in_review`, `payment_submitted`, `refund_in_flight` | `processing` |
| `payment_processed` | `succeeded`, with the USDC amount and the destination transaction hash |
| `refund`, `refunded` | `refunded` |
| `refund_failed` | `failed` with `DELIVERY_FAILED` |
| `microdeposit`, `account_update`, `activation`, `deactivation` | ignored |

::: warning One open deposit at a time
A virtual account is persistent. When a user has two open deposit sessions to the same address, the first deposit goes to the session that sees it first. Webhooks go to the newest session that showed the account.
:::

## Withdraw flow

1. KYC, as for deposits.
2. **Payout account.** The step is `PAYMENT` with a `FORM`. US accounts: first and last name, bank name, routing number (9 digits), account number, checking or savings, street, city, postal code and state. IBAN: first and last name, IBAN, BIC, street, city, postal code and country (3 letters). The `submit_details` transition checks the formats and calls `POST /v0/customers/{id}/external_accounts`.
3. **Transfer.** `POST /v0/transfers` with `amount`, `on_behalf_of`, `client_reference_id` (the leg ref), `source: { payment_rail, currency: 'usdc', from_address }` and `destination: { payment_rail, currency, external_account_id }`. When the sender address is not known, the adapter sends `features.allow_any_from_address: true`.
4. **Send USDC.** The step is `WALLET_TX`: an ERC-20 transfer (EVM) or an SPL transfer (Solana) to `source_deposit_instructions.to_address`. The `submit_tx` transition takes the transaction hash.
5. **Status.** `GET /v0/transfers/{id}` and `transfer` webhooks.

| Transfer state | Leg |
|---|---|
| `awaiting_funds` | the `WALLET_TX` step (or `processing` after `submit_tx`) |
| `in_review`, `funds_received`, `payment_submitted`, `refund_in_flight` | `processing` |
| `payment_processed` | `succeeded`, with `receipt.final_amount` in the payout currency |
| `refunded` | `refunded` |
| `canceled`, `error`, `undeliverable`, `returned`, `refund_failed`, `missing_return_policy` | `failed` with `DELIVERY_FAILED` |

The adapter uses transfers, not liquidation addresses. A transfer is one per session, so the leg ref and the webhook match one to one.

## Idempotency

Bridge needs an `Idempotency-Key` header on every POST. The keys are:

| Call | Key |
|---|---|
| KYC link | `{sessionId}:bridge:kyc:{ref}` |
| Virtual account | `{sessionId}:bridge:va:{ref}` |
| External account | `{sessionId}:bridge:ea:{ref}` |
| Transfer | `{sessionId}:bridge:transfer:{ref}` |

The leg ref is `brg_` and 20 hex characters.

## Webhooks

1. Create the endpoint: `POST /v0/webhooks` with `url: '{baseUrl}/webhooks/bridge'`, `event_epoch: 'webhook_creation'` and the categories `virtual_account.activity`, `transfer`, `kyc_link` and `customer`.
2. Put the `public_key` from the answer in `webhookPublicKey`.
3. Turn the endpoint on: `PUT /v0/webhooks/{id}` with `status: 'active'`. A new endpoint is `disabled`.

Verification: the `X-Webhook-Signature` header is `t=<timestamp in ms>,v0=<base64 signature>`. Bridge signs `SHA-256("{t}.{raw body}")` with RSA PKCS#1 v1.5 and SHA-256. The adapter refuses an event more than 10 minutes from the server time. `kyc_link` and `customer` events give no leg event: the status poll moves the KYC step.

## Data

The adapter keeps only Bridge ids in `shared`: customer, KYC link, virtual account, external account and transfer. It also keeps the virtual account deposit instructions, to show them again on the next poll. It does not keep the user's name, email or payout account number.

## Verified vs TO VERIFY

Verified against the Bridge docs and OpenAPI spec (2026-10-05): base URLs, `Api-Key`, `Idempotency-Key` on every POST, the KYC link fields and statuses, endorsement names, virtual account request and deposit instruction fields, the virtual account event types, the transfer request and states, external account bodies, the exchange rate endpoint, the webhook signature scheme, the country list and the rail minimums.

- **TO VERIFY**: the ETAs of each rail. Bridge publishes no settlement times in the API docs.
- **TO VERIFY**: `pix` or `pix_onramp` as the endorsement for Pix deposits.
- **TO VERIFY**: `buy_rate` is the rate the user gets when `from` converts into `to`.
- **TO VERIFY**: how to add an endorsement to a customer that Bridge approved without it. The adapter sends the user back to the KYC link.
- **TO VERIFY**: `features.allow_any_from_address` when the sender address is not known.
- **TO VERIFY**: the wire payout minimum.
- **TO VERIFY**: the refund event name. The docs table says `refunded` and the OpenAPI enum says `refund`. The adapter accepts both.
- **TO VERIFY**: when Bridge fills `customer_id` on a KYC link. The adapter waits for it.
- Not supported yet: payouts in MXN, BRL and GBP (the docs give no external account body for them), COP deposits, and USDT or EURC delivery.
