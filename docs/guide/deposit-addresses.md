# Standing deposit addresses

A standing deposit address is a permanent address for one user and one route. Your app shows it once, for example "Your USDC on Arbitrum deposit address". Any deposit to it, at any time, is converted and delivered to the user's destination. Your backend gets webhooks for each deposit. No session exists before the money arrives.

Use it when users fund an account again and again, from an exchange or a wallet, without opening a modal each time.

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
| `destination` | A crypto destination with a valid chain, token and address. No `settlement` and no `calls`. |
| Route | Any route. The same token on the same chain needs an adapter that watches the chain (see [Same chain and token](#same-chain-and-token)). |
| `adapterId` | Optional. Default: the first adapter with `standingAddress` and a `transfer` leg that serves the route. |

With no such adapter, `get` throws `400` (`No configured adapter gives standing deposit addresses`, or for the same token on the same chain a message that names `chainWatch()`). An unknown `adapterId` throws `404`, and an adapter that does not serve the route throws `400`.

## Show it in the widget

Set `depositAddresses: { widget: true }` in the server config. The plan of a deposit session then has the method `deposit_address` ("Your deposit address") on the crypto tab, when:

- the destination is a crypto address with no `settlement` and no `calls`,
- an adapter gives standing addresses, and
- the session's `allowedMethods` and `policy.disabledMethods` allow `deposit_address`.

The user picks the network and the token they send. The widget calls `POST /sessions/:id/deposit-address` and shows the address for the session's user and destination, with a QR code, a copy button and a warning. A new token loads its own address. This session takes no payment: each deposit to the address becomes its own session, as above. The browser never sees the user id or the adapter id.

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

`get` with the same chain and token as origin and destination then returns the destination address, with `adapterId: 'chain-watch'`. A route that converts still goes to Relay. The adapter watches ERC-20 `Transfer` logs on EVM chains, and SOL and SPL transfers on Solana (native ETH transfers have no log, so they are refused). Each transfer in becomes one deposit session, as above:

- A transfer counts only after its confirmations (`confirmations`, default 12 blocks on EVM; `finalized` on Solana).
- Each log or signature makes one session, never two.
- Before the session succeeds, the adapter reads the transaction again. A transfer that a re-org removed, or with another amount, fails the session.
- Transfers below `minDeposit` are ignored.

Every transfer of the token into the address counts, whoever sent it. Use a destination that receives only these deposits. See [Read this first](../adapters/chain-watch.md#read-this-first).

## Relay notes

Relay is the first adapter with standing addresses. The address is a Relay open deposit address from the origin token to the destination, with the destination address as the recipient. The adapter keeps it in its shared store for 400 days after the last call. Each deposit is one Relay request: `depositId` is the deposit transaction (`tx:...`), else the request id, and the leg follows that request.

Relay binds the refund address to the deposit address. A standing address is reused by any sender, so choose the refund rule with care (the `refundTo` option):

- The default refunds a failed deposit to the address that sent it. That is right for wallets, but wrong for exchanges: the exchange hot wallet may not credit the refund.
- `refundTo: 'recipient'` refunds to the destination address. Set it when your destinations are the users' own wallets (EOAs) on every chain.
- An explicit address refunds there.

The refund address is part of the address key, so a change of `refundTo` gives new addresses. Old addresses keep their refund rule and stay watched.

## Limits

- **One route per address.** Send only the origin token on the origin chain. Another token or chain may be lost.
- **Providers.** Relay gives standing addresses that convert, and chain-watch gives them for the same token on the same chain. Bridge virtual accounts (a fiat bank account per user) could implement the same two methods next.
- **Native ETH.** chain-watch cannot watch native transfers on EVM chains (no log). Use a token such as USDC.
- **Polling only.** Deposits are found by the sweep, so run it every minute or so (see [Background sweep](../api/server.md#background-sweep)).

## For adapter authors

An adapter gives standing addresses with two optional methods, `standingAddress()` and `standingDeposits()`, plus `status()` for each deposit's `legRef` and a leg with the method `transfer`. `standingRoutes` says which routes it serves (`convert`, the default, or `same`). See [@openrampkit/adapter](../api/adapter.md#adapter).
