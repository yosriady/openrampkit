# Standing deposit addresses

A standing deposit address is a permanent address for one user and one route. Your app shows it once, for example "Your USDC on Arbitrum deposit address". Any deposit to it, at any time, is converted and delivered to the user's destination. Your backend gets webhooks for each deposit. No session exists before the money arrives.

Use it when users fund an account again and again, from an exchange, a wallet or a bank, without opening a modal each time.

The origin can also be a fiat currency: then the "address" is a standing bank account (see [Bank accounts](#bank-accounts)).

## How it works

1. Your backend calls `openramp.depositAddresses.get()` for a user and a route: the origin chain and token, and a crypto destination. The server asks an adapter for a reusable address, and keeps it.
2. The user sends the origin token to that address, today or months later.
3. `openramp.sweep()` polls the address. For each new deposit, the server makes a normal deposit session with an observed payment: one `transfer` leg that is already `processing`.
4. From there, the session works like any other: the sweep polls the provider until the leg ends, and your backend gets `session.succeeded` (or `session.failed`). The admin views, the timeline and the reversal rules apply.

One deposit makes one session, never two. A session is made only for a deposit that the provider reports.

## Server API

```ts
const address = await openramp.depositAddresses.get({
  userId: user.id,
  origin: { chain: 'eip155:42161', token: '0xaf88d065e77c8cc2239327c5edb3a432268e5831' }, // USDC on Arbitrum
  destination: {
    type: 'crypto',
    chain: 'eip155:8453', // Base
    token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC on Base
    address: user.wallet,
  },
  // adapterId: 'relay', // optional
})
// { id: 'sda_...', userId, adapterId: 'relay', address: '0x...', origin, destination, createdAt }

const all = await openramp.depositAddresses.list(user.id) // newest first
```

`get` makes the address on the first call. The same user, route and adapter always return the same address, also when two calls run at the same time (on a store with `putIfAbsent`: the memory, Redis and Durable Object stores). Call it each time you show the address: it is cheap, and it makes the next poll come at once.

The server checks the input like a session create:

| Field | Rule |
|---|---|
| `userId` | 1 to 256 characters |
| `origin.chain` | A CAIP-2 chain id |
| `origin.token` | A token address, or `native` |
| `origin.currency` | Instead of `chain` and `token`: an ISO 4217 currency (a [bank account](#bank-accounts)) |
| `destination` | A crypto destination with a valid chain, token and address. No `settlement` and no `calls`. |
| Route | Any route. The same token on the same chain needs an adapter that watches the chain (see [Same chain and token](#same-chain-and-token)). |
| `adapterId` | Optional. Default: the first adapter with `standingAddress` and a `transfer` leg that serves the route. |
| `dedicatedDestination` | Required (`true`) for the same token on the same chain, else `400`. It says that `destination.address` is an address that your backend made for this one user and that nothing else pays to. See [Same chain and token](#same-chain-and-token). |

With no such adapter, `get` throws `400` (`No configured adapter gives standing deposit addresses`, or for the same token on the same chain a message that names `chainWatch()`). An unknown `adapterId` throws `404`, and an adapter that does not serve the route throws `400`.

## Show it in the widget

Set `depositAddresses: { widget: true }` in the server config. The plan of a deposit session then has the method `deposit_address` ("Your deposit address") on the crypto tab, when:

- the destination is a crypto address with no `settlement` and no `calls`,
- an adapter gives standing addresses (or standing bank accounts, see below), and
- the session's `allowedMethods` and `policy.disabledMethods` allow `deposit_address`.

The user picks the network and the token they send. The widget calls `POST /sessions/:id/deposit-address` and shows the address for the session's user and destination, with a QR code, a copy button and a warning. A new token loads its own address. This session takes no payment: each deposit to the address becomes its own session, as above. The browser never sees the user id or the adapter id.

The widget gives only addresses that convert (another token or chain). For the destination token on the destination chain, it answers `400`: that address would be the session destination itself, so the payments of the session would count twice, and the browser could make the server credit transfers to an address it chose. Use `depositAddresses.get` with `dedicatedDestination: true` from your backend instead.

When an adapter also gives standing bank accounts and lists their currencies in `standingCurrencies` (Bridge with `standing: true` does), the screen has two tabs: "Crypto" and "Bank account". The bank tab calls the route with `{ currency }` and shows every bank field, with a copy button where the provider allows one. The method then has `standingOrigins: { crypto, currencies }`; with no adapter that converts tokens, `crypto` is false and the screen shows only the bank account. The browser picks only the currency, and only one that the adapter lists: the server sets the user, the destination and the adapter.

## Webhooks

Each deposit gives these events on its new session, in this order:

| Type | Fields in `data.object` |
|---|---|
| `session.created` | |
| `deposit_address.deposit` | `depositAddressId`, `sessionId`, `depositId`, `input` (the deposit, when the provider says it) |
| `session.processing` | `attempt`, `index`, `adapterId`, `legId` |
| `session.succeeded` or `session.failed` | as usual |

`data.object.session.standingAddressId` is set on every event of such a session. The session `metadata` has `depositAddressId` and `depositId`. **Credit at `session.succeeded`**, as for any deposit, and deduplicate by event id. Use `session.result.output` for the amount that arrived.

The session had no quote before the deposit. Its leg quote is an `estimate`: the input is the deposit (or `0` when the provider does not say it), and the output is `0` in the destination asset. `result.delivery` then checks the asset only.

A failure of such a session is final (`session.failed`, never `session.payment_failed`): the money arrived before the session, so no new attempt can pay it. Nobody holds its client secret, so no browser can act on it.

## Polling

The sweep keeps the addresses on a [store queue](../deploy/stores.md#queues), each with its next poll time:

- every 30 seconds after a deposit in the last hour, and right after a `get`;
- else the wait doubles after each empty poll, up to 10 minutes;
- after 90 days with no deposit and no `get`, the sweep stops polling the address. The next `get` starts it again, and the first poll finds the deposits made in the pause.

Each poll asks for the deposits of the last hour again, so a deposit that the provider lists late is not missed. `SweepResult.standing` counts the addresses polled and the new deposits.

## Same chain and token

When the user sends the destination token on the destination chain, no bridge is needed: the deposit address is the destination address itself. Add the [chain-watch adapter](../adapters/chain-watch.md) to serve such routes with no provider account:

```ts
import { chainWatch } from '@openrampkit/adapter-chain-watch'

createOpenRamp({
  // ...
  adapters: [relay({ apiKey }), chainWatch({ rpcUrls: { 'eip155:8453': process.env.BASE_RPC_URL! } })],
})
```

`get` with the same chain and token as origin and destination, and `dedicatedDestination: true`, then returns the destination address, with `adapterId: 'chain-watch'`. A route that converts still goes to Relay. The adapter watches ERC-20 `Transfer` logs on EVM chains, and SOL and SPL transfers on Solana (native ETH transfers have no log, so they are refused). Each transfer in becomes one deposit session, as above:

- A transfer counts only after its confirmations (`confirmations`, default 12 blocks on EVM; `finalized` on Solana).
- Each log or signature makes one session, never two.
- Before the session succeeds, the adapter reads the transaction again. A transfer that a re-org removed, or with another amount, fails the session.
- Transfers below `minDeposit` are ignored.

### Security of same-chain addresses

Every transfer of the token into the address counts as a deposit of its user, whoever sent it. So:

- **Use a dedicated deposit address per user**, made by your backend. Do not use the user's main wallet or an address that the user typed or connected: a user could give another person's wallet and get credit for every transfer to it. Do not use a shared address such as your treasury: the first user would get credit for the deposits of all users.
- **Only the backend can ask** (`dedicatedDestination: true`). The widget refuses this route.
- **One user per address.** Another user gets `409 CONFLICT`.
- **Nothing else may deliver to it.** A new deposit session or a converting standing address to a watched address throws `409`, because its delivery would count twice. Sessions made before the watch are not checked: do not watch an address with open deposit sessions.
- **One kind per destination, under races.** One atomic claim binds a destination to a watch or to converting addresses, so two requests at the same time cannot both win. During a rolling upgrade, an older server marks a converting address only with its own marker. A new watch reads that marker before and after its claim, so a watch and a converting address of an older server cannot both win either. When the two meet at the same time, both can be refused (`409`): the destination then stays closed to watches, so use another address.
- **One claim per transfer.** The server keeps the transaction claims (`txused:` keys) of all adapters in one namespace, so one transfer completes one payment only.

See [Security](../adapters/chain-watch.md#security) for the details.

## Relay notes

Relay is the first adapter with standing addresses. The address is a Relay open deposit address from the origin token to the destination, with the destination address as the recipient. The adapter keeps it in its shared store for 400 days after the last call. Each deposit is one Relay request: `depositId` is the deposit transaction (`tx:...`), else the request id, and the leg follows that request.

Relay binds the refund address to the deposit address. A standing address is reused by any sender, so choose the refund rule with care (the `refundTo` option):

- The default refunds a failed deposit to the address that sent it. That is right for wallets, but wrong for exchanges: the exchange hot wallet may not credit the refund.
- `refundTo: 'recipient'` refunds to the destination address. Set it when your destinations are the users' own wallets (EOAs) on every chain.
- An explicit address refunds there.

The refund address is part of the address key, so a change of `refundTo` gives new addresses. Old addresses keep their refund rule and stay watched.

## Bank accounts

With a fiat origin, the user pays by bank transfer to a standing bank account, and the provider converts each deposit and delivers it to the destination. The [Bridge adapter](../adapters/bridge.md#standing-deposit-addresses) gives one (a Bridge virtual account) with `standing: true`.

```ts
const account = await openramp.depositAddresses.get({
  userId: user.id,
  origin: { currency: 'USD' },
  destination: { type: 'crypto', chain: 'eip155:8453', token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', address: user.wallet },
})
// { id: 'sda_...', adapterId: 'bridge', address: '900123456789', origin: { currency: 'USD' },
//   bank: { fields: [{ label: 'Routing number', value: '101019644', copy: true }, ...] }, destination, createdAt }
```

- `address` is the main account identifier (account number, IBAN, CLABE or Pix code). `bank.fields` has every field the user needs, as in a `BANK_FIELDS` surface. Show them in your app, or let the widget show them (see [Show it in the widget](#show-it-in-the-widget)).
- The route kind is `bank`. The server uses the first adapter with `'bank'` in `standingRoutes` and a `standingAccount` method, or `adapterId`.
- A bank route delivers converted funds, so it binds its destination like a converting route: a same-chain watch of that destination is refused (`409`).
- Each deposit makes a deposit session as above. Its leg input is the deposit in the account currency. An input in another currency is left out.
- `dedicatedDestination` does not apply.

## Limits

- **One route per address.** Send only the origin token on the origin chain. Another token or chain may be lost.
- **Providers.** Relay gives standing addresses that convert, chain-watch gives them for the same token on the same chain, and Bridge (`standing: true`) gives bank accounts (fiat in) and USDC liquidation addresses.
- **Native ETH.** chain-watch cannot watch native transfers on EVM chains (no log). Use a token such as USDC.
- **Polling.** Deposits are found by the sweep, so run it every minute or so (see [Background sweep](../api/server.md#background-sweep)). Bridge webhooks add to the poll: a deposit that a webhook reported is found at the next poll, also when the provider's list shows it late.

## For adapter authors

An adapter gives standing addresses with two optional methods, `standingAddress()` and `standingDeposits()`, plus `status()` for each deposit's `legRef` and a leg with the method `transfer`. `standingRoutes` says which routes it serves (`convert`, the default, `same`, or `bank`). A `bank` route needs `standingAccount()` instead of `standingAddress()`. See [@openrampkit/adapter](../api/adapter.md#adapter).
