# Bridge

`@openrampkit/adapter-bridge` connects [Bridge](https://apidocs.bridge.xyz) (a Stripe company).

- **Deposits:** Bridge opens a virtual bank account for the user. The user sends ACH, wire, SEPA, SPEI, Pix or Faster Payments to it. Bridge converts the money to USDC and sends it on chain to the destination address. A destination that is not USDC on a Bridge network gets no quote (`NO_QUOTES`).
- **Withdrawals:** the user sends USDC to Bridge. Bridge pays out to the user's US bank account (ACH or wire) or IBAN (SEPA).
- **Standing deposit addresses** (option `standing: true`): a permanent virtual account for fiat in, and a permanent liquidation address for USDC in from another chain. See [Standing deposit addresses](#standing-deposit-addresses).

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
| `env` | `'sandbox' \| 'production'` | `'production'` | `production` is `https://api.bridge.xyz`. `sandbox` is `https://api.sandbox.bridge.xyz`. The server checks `env` against `livemode`. |
| `apiUrl` | `string` | from `env` | API base URL without `/v0` |
| `developerFeePercent` | `string` | none | Your fee in percent, for example `'0.5'`. Sent as `developer_fee_percent` on virtual accounts and transfers. Shown as the "App fee" in quotes. |
| `bridgeFeeBps` | `number` | `0` | Bridge's fee in basis points, for quotes only. Bridge pricing is per contract and the API has no fee quote. Set your contract rate. |
| `legs` | `string[]` | all | Offer only these legs |
| `withdraw` | `boolean` | `true` | Add the payout legs |
| `customer` | `(user) => Promise<{ customerId?, fullName?, email? } \| undefined>` | none | Find the Bridge customer of a user, or give the name and email for a new KYC link. Standing addresses use its `customerId`. |
| `standing` | `boolean` | `false` | Give [standing deposit addresses](#standing-deposit-addresses): virtual accounts (route `bank`) and liquidation addresses (route `convert`) |

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
- Bridge has no rate lock. The bank transfer converts at the rate of the day it arrives. So the guarantee is `estimate`, and quotes expire after 10 minutes (`quoteExpiresAt(10)`).
- Fees: the Bridge fee from `bridgeFeeBps` (`provider`) and your `developerFeePercent` (`app`) have an amount in the quote currency. For EUR, MXN, BRL and GBP, a third `provider` fee ("FX fee in the rate") has `amount: null`, because `buy_rate` contains it and Bridge does not say how much it is. All fees have `included: true`.

## Deposit flow

1. **Customer.** The adapter looks for the customer: the `customer` hook, then the customer or KYC link of an earlier session of the same user.
2. **KYC details.** When there is no customer and no KYC link, and the name or the email is not known, the step is `KYC` with a `FORM` (full legal name, email). The `submit_kyc` transition takes the answers.
3. **KYC link.** `POST /v0/kyc_links` with `type: 'individual'`, the rail endorsement and `redirect_uri` (the session return URL). The step is `KYC` with a `REDIRECT` to `tos_link` until the ToS is accepted, then to `kyc_link`. While Bridge reviews, the leg step is `{ status: 'processing', phase: 'kyc', detail: { code: 'kyc_review' } }`, so the session shows `KYC`. When the review ends with a step for the user, the leg can go back to `requires_action`. A rejected or offboarded user fails with `KYC_REJECTED`.
4. **Customer check.** `GET /v0/customers/{id}`. The customer must be `active` with the rail endorsement `approved`. A `paused` or `deposits_restricted` customer fails with `PROVIDER_DECLINED`.
5. **Virtual account.** `POST /v0/customers/{id}/virtual_accounts` with `source.currency`, `destination: { currency: 'usdc', payment_rail, address }` and the developer fee. The adapter keeps one virtual account for each customer, currency, chain and address, and uses it again in later sessions.
6. **Bank details.** The step is `PAYMENT` with `BANK_FIELDS`: amount, bank name, routing and account number, IBAN and BIC, CLABE, or sort code, beneficiary and bank address. For BRL, it is a `QR` of the Pix BR Code.
7. **Status.** `GET /v0/customers/{id}/virtual_accounts/{va}/history` and `virtual_account.activity` webhooks. The leg takes the first deposit after the session started that no other session took.

| Virtual account event | Leg |
|---|---|
| `funds_scheduled`, `funds_received`, `payment_submitted` | `processing`, detail code `settling` |
| `in_review` | `processing`, detail code `delayed` |
| `refund_in_flight` | `processing`, detail code `refunding` |
| `payment_processed` | `succeeded`, with the USDC amount and the `destination` transaction |
| `refund`, `refunded` | `refunded` |
| `refund_failed` | `failed` with `DELIVERY_FAILED` |
| `microdeposit`, `account_update`, `activation`, `deactivation` | ignored |
| other | no event: the adapter logs the unknown type once, and the deposit keeps its last known stage |

The `providerRef` of a deposit leg is the Bridge `deposit_id`, once the deposit arrives.

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
| `in_review` | `processing`, detail code `delayed` |
| `funds_received`, `payment_submitted` | `processing`, detail code `settling` |
| `refund_in_flight` | `processing`, detail code `refunding` |
| `payment_processed` | `succeeded`, with `receipt.final_amount` in the payout currency |
| `refunded` | `refunded` |
| `canceled`, `error`, `undeliverable`, `returned`, `refund_failed`, `missing_return_policy` | `failed` with `DELIVERY_FAILED` |
| other | no event: the adapter logs the unknown state once, and `status()` keeps the last known step |

The `providerRef` of a payout leg is the Bridge transfer id. The USDC transaction that the wallet (or the treasury) sent is the `source` transaction.

The adapter maps every Bridge status with `statusMap` from `@openrampkit/adapter`. The adapter uses transfers, not liquidation addresses. A transfer is one per session, so the leg ref and the webhook match one to one.

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

1. Create the endpoint: `POST /v0/webhooks` with `url: '{baseUrl}/webhooks/bridge'`, `event_epoch: 'webhook_creation'` and the categories `virtual_account.activity`, `transfer`, `kyc_link` and `customer`. With `standing: true`, add `liquidation_address.drain`.
2. Put the `public_key` from the answer in `webhookPublicKey`.
3. Turn the endpoint on: `PUT /v0/webhooks/{id}` with `status: 'active'`. A new endpoint is `disabled`.

Verification: the `X-Webhook-Signature` header is `t=<timestamp in ms>,v0=<base64 signature>`. Bridge signs `SHA-256("{t}.{raw body}")` with RSA PKCS#1 v1.5 and SHA-256. The adapter refuses an event more than 10 minutes from the server time. `kyc_link` and `customer` events give no leg event: the status poll moves the KYC step.

## Standing deposit addresses

With `standing: true`, the adapter gives [standing deposit addresses](../guide/deposit-addresses.md). Each user gets one permanent account or address for each route. Each deposit to it becomes a deposit session.

```ts
bridge({
  apiKey: process.env.BRIDGE_API_KEY!,
  webhookPublicKey: process.env.BRIDGE_WEBHOOK_PUBLIC_KEY!,
  standing: true,
  // Required in practice: the Bridge customer of the user, from your database
  customer: async ({ userId }) => ({ customerId: (await db.users.get(userId)).bridgeCustomerId }),
})

// Fiat in: a virtual account. The user pays USD by ACH or wire, and gets USDC on Base.
const account = await openramp.depositAddresses.get({
  userId: user.id,
  origin: { currency: 'USD' },
  destination: { type: 'crypto', chain: 'eip155:8453', token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', address: user.wallet },
  adapterId: 'bridge',
})
// account.address: the account number. account.bank.fields: routing number, account number, beneficiary, ...

// USDC in: a liquidation address. The user sends USDC on Arbitrum, and gets USDC on Base.
const address = await openramp.depositAddresses.get({
  userId: user.id,
  origin: { chain: 'eip155:42161', token: '0xaf88d065e77c8cc2239327c5edb3a432268e5831' },
  destination: { type: 'crypto', chain: 'eip155:8453', token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', address: user.wallet },
  adapterId: 'bridge',
})
```

| Route | Bridge object | Origin | Destination |
|---|---|---|---|
| `bank` | Virtual account | USD, EUR, MXN, BRL or GBP (the deposit rails in `legs`) | USDC on a Bridge network |
| `convert` | Liquidation address | USDC on a Bridge network | USDC on another Bridge network |

Pass `adapterId: 'bridge'` when another adapter (for example Relay) also serves `convert` routes: the server picks the first adapter in the list.

### The customer

Bridge needs a KYC-approved customer for each user. The adapter takes the customer id from the server only: the `customer` hook (`customerId`), else the customer that a Bridge KYC of an earlier deposit session made for the same user id. The browser never gives it. With no customer, `get` throws `409`. The customer must be `active`. For a virtual account, the rail endorsement must be `approved` (for example `base` for USD).

One Bridge customer belongs to one user id. The first user id that gets an address with a customer keeps it, and another user id with the same customer gets `409`. So a bug in your mapping cannot credit one user with another user's deposits.

### Virtual accounts (fiat in)

1. The adapter looks for a virtual account of the customer for this currency and destination (`GET /v0/customers/{id}/virtual_accounts`), else makes one (`POST`, with `source.currency`, `destination: { currency: 'usdc', payment_rail, address }` and the developer fee).
2. Bridge's answer must name the same destination (rail, currency and address) and customer. Else `get` fails with `502`, and no address is kept.
3. `StandingAddress.address` is the main account identifier, and `StandingAddress.bank.fields` holds the bank details (a Pix account shows its BR Code). The widget does not show bank accounts yet: show `bank.fields` in your app.
4. Deposits: `GET .../virtual_accounts/{va}/history`, grouped by `deposit_id`. A deposit makes a session once the money arrived (`funds_received` or a later stage; `funds_scheduled` alone is not enough). Its input is the `funds_received` amount in the account currency. Events in another currency, of another account or of another customer are skipped and logged.
5. Status: `GET .../history?deposit_id={id}`, with the table of [Deposit flow](#deposit-flow). `payment_processed` succeeds only when its currency and rail (when Bridge gives them) are USDC on the destination rail. Else the session fails with `DELIVERY_FAILED`.

The session flow and the standing account share one virtual account for the same customer, currency and destination. Both claim a deposit with the same key (`dep:{deposit_id}`), so one deposit goes to one of them only. An open deposit session of the same user takes the first deposit after it started.

### Liquidation addresses (USDC in)

1. The adapter looks for a liquidation address of the customer for this route (`GET /v0/customers/{id}/liquidation_addresses`), else makes one (`POST`, with `chain`, `currency: 'usdc'`, `destination_payment_rail`, `destination_currency: 'usdc'`, `destination_address`, and `custom_developer_fee_percent`). Bridge refuses a second address with the same source chain, currency and destination, so the adapter looks first.
2. Bridge's answer must name the same source chain and the same destination, with no bank account or Bridge wallet as destination. Else `get` fails with `502`.
3. Deposits: `GET .../liquidation_addresses/{la}/drains`. A drain makes a session once its state is past `awaiting_funds`. Its input is the drain amount in USDC on the origin chain. A drain in another currency or from another chain is skipped and logged.
4. Status: `GET .../drains?drain_id={id}`.

| Drain state | Leg |
|---|---|
| `awaiting_funds` | no session yet |
| `funds_received`, `payment_submitted` | `processing`, detail code `settling` |
| `in_review` | `processing`, detail code `delayed` |
| `refund_in_flight` | `processing`, detail code `refunding` |
| `payment_processed` | `succeeded`, with `receipt.outgoing_amount`, when `destination.to_address` is the destination. Another address, rail or currency fails with `DELIVERY_FAILED`. With no `destination` yet, the leg stays `processing`. |
| `refunded` | `refunded` |
| `undeliverable`, `returned`, `missing_return_policy`, `refund_failed`, `error`, `canceled` | `failed` with `DELIVERY_FAILED` |

Set up a [crypto return policy](https://apidocs.bridge.xyz/platform/orchestration/more/returns) with Bridge. A liquidation address is reused by any sender, so the adapter sets no `return_address`.

### Webhooks of standing addresses

The sweep polls each address (see [Polling](../guide/deposit-addresses.md#polling)). Webhooks add to it:

- The adapter finds the account by its own index (the Bridge id of the virtual account or liquidation address), never by a ref in the body. The event's `customer_id` must be the account's customer. Else the event is ignored.
- A deposit that the account does not own yet gives no leg event. The adapter keeps the event for the next poll (7 days), so a deposit that the history lists late still makes its session.
- An event of a deposit that the account owns gives a leg event with the deposit's leg ref and the Bridge `event_id`. The server finds the session by its own ref index.
- A deposit that a deposit session owns goes to that session.

### Idempotency and data

The create calls use a key from the customer and the route (`orb-sva-...`, `orb-sla-...`), so a retry gets the same account. The adapter keeps the account record in `shared` with no TTL: the Bridge ids, the customer id, the route and, for a virtual account, its bank details. It keeps deposit claims for 400 days, and webhook events for 7 days.

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
Standing deposit addresses (verified 2026-10-16): the virtual account list, create and history endpoints (`deposit_id`, `limit`, `starting_after`), the virtual account `destination` and `status` fields, the liquidation address list and create endpoints and fields (`chain`, `currency`, `destination_payment_rail`, `destination_currency`, `destination_address`, `custom_developer_fee_percent`, `state`), the rule that Bridge refuses a duplicate liquidation address, the drain list endpoint (`drain_id`, `limit`, `starting_after`), the drain fields and states, and the `liquidation_address.drain` webhook category.

- **TO VERIFY**: the endorsement that a USDC to USDC liquidation address needs. The adapter checks that the customer is `active`.
- **TO VERIFY**: the drain `currency` of a USDC address. The API reference shows `usdc` and the guide shows `usd`. The adapter accepts both, and nothing else.
- **TO VERIFY**: the `currency` of a `payment_processed` virtual account event. The adapter accepts `usdc` or none.
- **TO VERIFY**: whether Bridge allows two virtual accounts for the same customer, currency and destination. The adapter reuses the one it finds.
- **TO VERIFY**: how long Bridge keeps an `Idempotency-Key`. The adapter also looks for an existing account before each create.
- Not supported yet: payouts in MXN, BRL and GBP (the docs give no external account body for them), COP deposits, and USDT or EURC delivery. Standing addresses: USDT, EURC or multichain (`evm`) liquidation addresses, and bank accounts in the widget.
