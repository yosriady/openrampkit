# Architecture

OpenRampKit has three runtime parts: the browser UI, your OpenRampKit server, and your app backend. Providers sit behind the server, each wrapped by an adapter.

```
 Browser                                   Your infrastructure                          Providers
+-----------------------------+         +----------------------------------+         +------------------+
| <openramp-modal>            |         | OpenRampKit server               |         | Relay            |
|   renders a Snapshot        |  HTTPS  |   createOpenRamp({ adapters })   |  HTTPS  | Swapped          |
| DepositController           +-------->+   sessions, plan, quotes,        +-------->+ Coinbase         |
|   calls /sessions/:id/...   | Bearer  |   legs, start URLs               |         | Transak          |
| WalletAdapter (wagmi)       | client  |   SessionStore (KV, Redis)       +<--------+ Xendit           |
|   signs WALLET_TX           | secret  |   adapters (server only)         | provider| ...              |
+--------------+--------------+         +----+-------------------+---------+ webhooks+------------------+
               |                             ^                   |
               | POST /api/deposit-session   | sessions.create() | signed webhooks
               v                             |                   v (session.completed, ...)
        +------+-----------------------------+-------------------+------+
        | Your app backend: auth, user -> destination, credit balances  |
        +---------------------------------------------------------------+
```

## The packages

```
@openrampkit/core        types, money math, codes, region policy, flow table, planner, ranking
      ^        ^
      |        |
@openrampkit/adapter      createAdapter(), HTTP helpers, /testing kit
      ^
      |
@openrampkit/adapter-*    relay, swapped, coinbase, transak, xendit, mock
      ^
      |
@openrampkit/server       handler, sessions, planning, legs, webhooks, stores

@openrampkit/client       HTTP client, DepositController, createMockWallet     (depends on core)
@openrampkit/web          <openramp-modal> (Lit), openDeposit(), themes         (client, core)
@openrampkit/react        OpenRampProvider, DepositButton, hooks                (web, client, core)
@openrampkit/vue          OpenRampProvider, DepositButton, composables          (web, client, core)
@openrampkit/svelte       createOpenRamp(), stores, actions                     (web, client, core)
@openrampkit/solid        OpenRampProvider, DepositButton, primitives           (web, client, core)
@openrampkit/wagmi        wagmiWallet(): WalletAdapter                          (core)
```

`core` is pure: no network, no clock in the planner, no DOM. The server, the client and the adapter test kit all read the same flow table from it.

## Who does what

| Part | Knows | Does not know |
|---|---|---|
| Browser (`web`, `client`) | The client secret, the plan, quotes, the current step | Provider keys, the user id, how to reach providers |
| Server | Provider keys, sessions, the destination, adapters | Your users and balances |
| App backend | Users, auth, destinations, balances | Provider details |
| Adapter | One provider's API | Other adapters, HTTP routing, storage layout |

## One deposit, end to end

```
Browser                         Server                              Adapter / provider
   |  GET  /sessions/:id           |                                       |
   |------------------------------>| load session (Bearer id.secret)       |
   |  POST /sessions/:id/plan      |                                       |
   |------------------------------>| catalog() per adapter (optional)      |
   |                               | planPathways() -> methods, pathways   |
   |  POST /sessions/:id/quotes    |                                       |
   |------------------------------>| prepareDeposit() for hop legs         |
   |                               | quote() leg by leg, up to 5 pathways  |--> provider pricing APIs
   |                               | rankQuotes()                          |
   |  POST /sessions/:id/select    |                                       |
   |------------------------------>| start() first leg -> LegStep          |--> create order
   |  <- Step { PAYMENT, surface } | REDIRECT wrapped as /start/... URL    |
   |                               |                                       |
   |  user pays (QR, redirect,     |                                       |
   |  wallet tx, transfer)         |       POST /webhooks/:adapterId       |
   |                               |<--------------------------------------| verify(), parse()
   |  GET /sessions/:id/step (poll)| status() (at most every 2 s)          |
   |------------------------------>| leg succeeded: start() next leg       |
   |  <- Step { COMPLETED }        | notify(): session.completed --------------> your backend
```

## Design choices

- **Web standards only.** The server uses `fetch`, `Request`, `Response` and WebCrypto. The same code runs on Cloudflare Workers, Vercel, Node 20+, Bun and Deno.
- **Server-driven UI.** The modal renders whatever `Step` the server returns. A new provider needs no UI release, as long as it uses a known [surface](./surfaces.md).
- **State in a store, not in memory.** Each request loads the session, changes it, and saves it with an optimistic version check. Any instance can serve any request. See [Session stores](../deploy/stores.md).
- **Adapters are data plus functions.** Static `LegSpec` declarations feed the planner. `quote`, `start`, `transition`, `status` and `webhook` run the leg.

For the reasons behind these choices, read the [scope](../design/scope.md) and the [spec](../design/spec.md).
