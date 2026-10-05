# @openrampkit/server

The OpenRampKit server: a web-standard `Request -> Response` handler plus a small backend API. It runs on Cloudflare Workers, Vercel and Next.js, Node 20+, Bun and Deno.

```ts
import { createOpenRamp } from '@openrampkit/server'

const openramp = createOpenRamp({
  secret: process.env.OPENRAMP_SECRET!,
  baseUrl: 'https://app.example.com/api/openramp',
  adapters: [/* ... */],
})
```

## createOpenRamp(config)

`createOpenRamp` throws at startup when `secret` is shorter than 32 characters, when `webhooks.secret` or `tasksToken` is shorter than 16 characters, when an adapter targets another API version, or when two adapters share an id. It logs a warning when `treasury` has no `address`: then quotes for app-custody withdrawals use a placeholder sender.

| Option | Type | Default | Description |
|---|---|---|---|
| `secret` | `string` | required | Signs start URLs. At least 32 characters. |
| `baseUrl` | `string` | required | Public URL where the handler is mounted, e.g. `https://app.example.com/api/openramp`. Its path is stripped from incoming requests. It also builds the return URL, the webhook URLs and the start URLs. |
| `adapters` | `Adapter[]` | required | Provider adapters |
| `store` | `SessionStore` | `memoryStore()` | Where sessions live. Use a shared store in production. See [Session stores](../deploy/stores.md). |
| `livemode` | `boolean` | `false` | Marks sessions and events as live. Adapters may switch to sandbox when it is false (Coinbase). |
| `policy.maxLegs` | `1 \| 2` | `2` | Longest pathway |
| `policy.regions` | `RegionPolicy` | allow all | App-wide region policy, applied on top of each leg's policy |
| `policy.methodPriority` | `Record<country, string[]>` | built-in | Method order per country |
| `policy.disabledMethods` | `string[]` | none | Methods never offered |
| `policy.hopPreference` | `CryptoAsset[]` | USDC on Base, Arbitrum, Polygon, Optimism, Ethereum | Hop assets for two-leg pathways, most preferred first. See [Hops](../concepts/pathways.md#hops). |
| `webhooks` | `{ url: string; secret: string; retryHours?: number; maxAttempts?: number }` | none | Signed webhooks to your backend. `secret` must have at least 16 characters (use 32 random bytes). `sweep()` retries failed deliveries for `retryHours` (default `24`), or until `maxAttempts` attempts in all when you set it. Then the event is a dead letter. See [Delivery](../guide/webhooks.md#delivery). |
| `tasksToken` | `string` | none | Bearer token for `POST /tasks/sweep` and `GET /health?deep=1`. At least 16 characters. Without it, those two are off. |
| `geo` | `(req) => { country?, region? } \| undefined` | Cloudflare / Vercel headers | Country and region for `POST /sessions` |
| `authorize` | `(req, body) => Promise<CreateSessionInput \| null>` | none | Enables `POST /sessions` from the browser or another service |
| `cors` | `{ origins: string[] \| '*' }` | same origin only | Allowed origins for CORS |
| `logger` | `Logger` | console (no debug) | `debug`, `info`, `warn`, `error` |
| `returnUrl` | `string` | `{baseUrl}/return` | Where providers send the user back |
| `fetch` | `typeof fetch` | global `fetch` | Used by the server and passed to adapters |
| `timeouts.quote` | `number` (ms) | `9000` | Per quoted pathway |
| `timeouts.webhook` | `number` (ms) | `4000` | Per outgoing webhook |
| `limits.providerCallsPerMinute` | `number` | `60` | Per session: requests to `/plan`, `/target`, `/quotes`, `/select` and `/transitions/*` in one minute. More get `429 RATE_LIMITED`. |
| `screenAddress` | `(address, chain) => Promise<boolean>` | none | Withdraw: check a "To wallet" address. `false` or an error refuses it (fail closed). See [Screen addresses](../guide/withdraw.md#screen-addresses). |
| `treasury` | `TreasuryHook` | none | Withdraw with `custody: 'app'`: sends the transactions from your wallet. See [Custody](../guide/withdraw.md#custody-app). |
| `payPage` | `false \| { scriptUrl?, title? }` | on, script from esm.sh | The hosted pay page `GET /pay/:credential`. `false` turns it off. See [The pay link](../guide/agents.md#the-pay-link). |

The default geo lookup reads `cf-ipcountry` or `x-vercel-ip-country` (ignoring `XX`), and `x-vercel-ip-country-region` for the region (as `{country}-{region}`).

## Return value

```ts
const openramp = createOpenRamp(config)

openramp.handle(req)          // Promise<Response>. Mount at baseUrl.
openramp.fetch(req)           // Same as handle, for `export default openramp` on Workers, Bun, Deno
openramp.nextHandlers()       // { GET, POST, OPTIONS } for a Next.js App Router catch-all route

await openramp.sessions.create(input)  // Promise<CreatedSession>
await openramp.sessions.retrieve(id)   // Promise<PublicSession | null>
await openramp.sessions.refresh(id)    // Promise<PublicSession | null>: ask the active leg's adapter for status now
await openramp.sessions.payLink(id, { ttlMinutes? }) // Promise<PayLink | null>: { id, url, expiresAt }, a signed link to the pay page
await openramp.sessions.revokePayLink(id, linkId)    // Promise<boolean>: make one pay link stop working; false when the session does not exist

await openramp.sweep({ limit? })       // Promise<SweepResult>: retry webhooks, refresh open payments, expire sessions

await openramp.webhooks.verify(req, rawBody) // Promise<boolean>: verify a webhook this server sent
await openramp.webhooks.replay(sessionId)    // Promise<number>: send the dead letters of a session again
```

`handle` never throws. Errors become JSON responses (see [HTTP routes](./http.md#errors)). It answers `OPTIONS` with `204` and the CORS headers.

`sessions.revokePayLink(id, linkId)` takes the `id` that `payLink` returned. The pay page and the session routes then refuse that link. Other links of the session and the client secret keep working. A session keeps at most 100 revoked link ids. See [`POST /sessions/:id/pay-link/revoke`](./http.md#post-sessions-id-pay-link-revoke).

`sessions.refresh(id)` skips the 2-second rate limit that browser polls have. It sends any webhooks that become due. You rarely need it: `sweep()` refreshes every open session.

`webhooks.verify` returns `false` when `config.webhooks` is not set.

`webhooks.replay(sessionId)` sends again the events of one session whose retries stopped (dead letters). They keep their event ids and get a new retry window. It returns the number of events, or `0` when the session has none.

The type of the returned object is exported as `OpenRamp`.

## Background sweep

Users close tabs, and webhook deliveries fail. `openramp.sweep()` does the background work. Run it every minute or so:

- from a scheduler that runs your code (a [Cloudflare Cron Trigger](../deploy/cloudflare-workers.md#cron-trigger), a [Vercel Cron Job](../deploy/nextjs.md#background-sweep), or any cron), or
- over HTTP with `POST {baseUrl}/tasks/sweep` and `Authorization: Bearer {tasksToken}` (see [HTTP routes](./http.md#post-tasks-sweep)).

Each run does three things:

1. **Retries failed webhooks.** Each event is saved in its session record (the outbox), and the session id goes on the outbox queue. A delivery that fails (no 2xx answer, or a timeout) stays there. The sweep sends it again when it is due. The wait starts at 30 seconds and doubles after each failed attempt, up to 2 hours. After `webhooks.retryHours` (default 24), or `webhooks.maxAttempts` attempts when you set it, the event becomes a dead letter in the session record. The server logs `webhook moved to dead letter after retries` as an error. `openramp.webhooks.replay(sessionId)` sends the dead letters again.
2. **Refreshes open payments.** For each open session with an active payment, it asks the active leg's adapter for status, like `sessions.refresh(id)`. This settles legs without provider webhooks (Relay) after the user leaves. It also asks for the status of earlier attempts that the user left with `restart` and that still wait. When one of them was paid, the session completes with it.
3. **Expires idle sessions.** A session past its expiry moves to `EXPIRED` when no payment started, or when the active leg still waits for the user (`awaiting_user`). The server sends `session.expired`. A leg that the provider is processing is not expired: the sweep refreshes it instead.

```ts
type SweepResult = {
  webhooks: { retried: number; delivered: number; dropped: number; pending: number }
  sessions: { checked: number; changed: number; expired: number; open: number }
}
```

`limit` (default `50`) caps the sessions with webhooks to retry and the open sessions to check in one run. The rest wait for the next run. `webhooks.pending` is the number of sessions on the outbox queue. A session can stay there for up to 30 seconds after its last event was sent; the next due run removes it.

The outbox queue and the open-session list are [store queues](../deploy/stores.md#queues): one entry per session id, with an atomic add. A session that is added while a sweep runs is never lost. Each run takes the entries that waited longest, so every open session gets its turn (round robin), also with more than `limit` open sessions. The run holds a 10-minute lease on what it took, so a second sweep at the same time skips those entries.

::: warning At-least-once delivery
A delivery can still arrive more than once, for example after a timeout. A repeat has the same event id. Deduplicate by event id (`openramp-id`) in your backend. See [Credit exactly once](../guide/webhooks.md#credit-exactly-once).
:::

The server tracks only the sessions it creates. A session goes back on the open-session list after a `restart`, and when a provider event arrives for it.

## CreateSessionInput

| Field | Type | Default | Description |
|---|---|---|---|
| `userId` | `string` | required | Your user id. Passed to adapters and echoed in webhooks. |
| `direction` | `'deposit' \| 'withdraw'` | `'deposit'` | See [Withdrawals](../guide/withdraw.md) |
| `destination` | `Destination` | required for a deposit | Where the money goes. See below. A withdraw session must not have one (`400`): the user picks the target, or the app sets `target`. |
| `source` | `WithdrawSource` | required for a withdrawal | `{ chain, token, symbol?, decimals?, custody }`: the asset that leaves, and who holds it (`'user_wallet'` or `'app'`) |
| `allowedTargets` | `AllowedTargets` | any target | Withdraw only: `{ crypto?: { chains? }, fiat?: { currencies? } }`. See [Allowed targets](../guide/withdraw.md#allowed-targets). |
| `target` | `WithdrawTarget` | none | Withdraw only: set the target at creation. Same shape as the body of [`POST /sessions/:id/target`](./http.md#post-sessions-id-target): `{ type: 'crypto', chain, token, address, symbol?, decimals? }` or `{ type: 'fiat', currency }`. The server checks the format, `allowedTargets` and `screenAddress`, and stores it as the destination. A refused target throws (`400`, `403` or `503`) and no session is made. |
| `lockTarget` | `boolean` | `false` | Withdraw with `target` only. Nobody can change the target: `POST /sessions/:id/target` answers `409 TARGET_LOCKED`. The session shows `targetLocked: true`, and the modal skips the target screen. See [Locked targets](../guide/withdraw.md#locked-targets). |
| `country` | `string` | none | ISO 3166-1 alpha-2. Picks the currency and local methods. |
| `region` | `string` | none | ISO 3166-2, e.g. `US-NY` |
| `email` | `string` | none | Prefilled at providers that support it |
| `locale` | `string` | none | BCP 47. Picks the modal language; adapters get `en` when unset. |
| `amountBounds` | `{ min?, max?, currency }` | none | Shown on the amount screen and enforced by the server on what the user pays (see below) |
| `allowedMethods` | `string[]` | all | Only these methods are planned and quoted |
| `metadata` | `Record<string, string>` | none | Echoed in every webhook. At most 50 keys. A key has at most 40 characters, a value at most 500. |
| `ttlMinutes` | `number` | `30` | Session lifetime. More than 0 and at most 10080 (7 days). |

The server checks the input and throws a `400` (`BAD_REQUEST`) when a field is not valid:

- `userId`: a string of 1 to 256 characters.
- `country`: two letters. `region`: at most 16 characters. `email`: at most 254. `locale`: at most 35.
- `amountBounds.min` and `amountBounds.max`: decimal strings, for example `"25.50"`.
- `destination` of type `crypto`: a CAIP-2 `chain`, a token address or `native`, and an `address` that is valid for the chain (an EVM address must not be the zero address). Other types: an ISO 4217 `currency`.

These checks also apply to the input that `authorize` returns for `POST /sessions`.

```ts
type Destination =
  | { type: 'crypto'; chain: string; token: string; address: string; symbol?: string; decimals?: number;
      calls?: ContractCall[]; settlement?: { contract: string } }
  | { type: 'merchant'; currency: string; accountRef?: string }
  | { type: 'fiat'; currency: string } // withdraw to cash: set by the server from the user's target
```

`chain` is CAIP-2 (`eip155:8453`), `token` is an address or `native`. Pass `symbol` and `decimals` so the modal can format amounts without a lookup.

`settlement` pays through an `OpenRampSettlement` contract. It needs an EVM chain, an EVM `address` (the recipient) and an ERC-20 `token`. `calls` need `settlement`, and a call cannot send native value. The server answers `400` when one of these rules fails. See [On-chain settlement](../concepts/settlement.md).

### Amount bounds

The server checks `amountBounds` against the input of each quote (what the user pays). It checks only when the bounds currency matches the input: a fiat currency code for fiat inputs, or a token symbol (for example `USDC`) for crypto inputs. Other inputs pass.

- `POST /sessions/:id/quotes` drops a quote outside the bounds and adds `AMOUNT_TOO_LOW` or `AMOUNT_TOO_HIGH` (with `recovery: 'requote'`) to `errors`.
- `POST /sessions/:id/select` checks again and answers `422` with the same code.

Provider limits still apply.

`sessions.create` returns `CreatedSession`:

```ts
type CreatedSession = { id: string; clientSecret: string; expiresAt: string }
```

Give `clientSecret` to the browser. Keep `id` if you want to look the session up later.

## verifyWebhook

```ts
import { verifyWebhook } from '@openrampkit/server'

await verifyWebhook(secret, headers, rawBody, toleranceSec = 300) // Promise<boolean>
```

Use it in a service that does not have the `openramp` instance. See [Webhooks to your backend](../guide/webhooks.md).

## Stores

```ts
import { memoryStore, durableObjectStore, OpenRampStore, cloudflareKvStore, redisStore, fromNodeRedis, fromNodeRedisV4, scopedKV, VersionConflictError } from '@openrampkit/server'
```

| Export | Description |
|---|---|
| `memoryStore()` | In memory. Development and tests only. |
| `durableObjectStore(ns, { sessionTtlSec? })` | Cloudflare Durable Objects. Strongly consistent; the production choice on Workers. |
| `OpenRampStore` | The Durable Object class for `durableObjectStore`. Export it from your Worker entry. |
| `cloudflareKvStore(ns, { sessionTtlSec? })` | Workers KV, for demos. Eventually consistent: the version check is best effort. |
| `redisStore(redis, { prefix?, sessionTtlSec? })` | Redis with an atomic version check (Lua). Works with `@upstash/redis` directly. |
| `fromNodeRedis(client)` | Wraps an ioredis client for `redisStore` |
| `fromNodeRedisV4(client)` | Wraps a node-redis v4+ client for `redisStore` |
| `scopedKV(store, prefix)` | A prefixed key-value view, as adapters get |
| `VersionConflictError` | Thrown by `put` on a version mismatch |

Types: `SessionStore`, `SessionRecord`, `ActiveLeg`, `StoredQuote`, `DurableObjectNamespaceLike`, `DurableObjectStateLike`, `KVNamespaceLike`, `RedisLike`, `NodeRedisLike`, `NodeRedisV4Like`, `RedisStoreOptions`. See [Session stores](../deploy/stores.md) for the interface and a custom store.

## Other exports

Types: `OpenRampConfig`, `CreateSessionInput`, `CreatedSession`, `OpenRamp`, `PayLink`, `SweepResult`, `TreasuryHook`, `TreasurySendInput`.

`isValidAddress(chain, address)` checks an address format for a chain: `0x` and 40 hex digits (not the zero address) on EVM chains, base58 of 32 to 44 characters on Solana. The `/target` route uses it.
