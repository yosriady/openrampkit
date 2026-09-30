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

`createOpenRamp` throws at startup when `secret` is shorter than 32 characters, when an adapter targets another API version, or when two adapters share an id.

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
| `webhooks` | `{ url: string; secret: string; maxAttempts?: number }` | none | Signed webhooks to your backend. `secret` must have at least 16 characters (use 32 random bytes). `sweep()` retries failed deliveries up to `maxAttempts` (default `8`) times in all. See [Delivery](../guide/webhooks.md#delivery). |
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
await openramp.sessions.payLink(id, { ttlMinutes? }) // Promise<PayLink | null>: { url, expiresAt }, a signed link to the pay page

await openramp.sweep({ limit? })       // Promise<SweepResult>: retry webhooks, refresh open payments, expire sessions

await openramp.webhooks.verify(req, rawBody) // Promise<boolean>: verify a webhook this server sent
```

`handle` never throws. Errors become JSON responses (see [HTTP routes](./http.md#errors)). It answers `OPTIONS` with `204` and the CORS headers.

`sessions.refresh(id)` skips the 2-second rate limit that browser polls have. It sends any webhooks that become due. You rarely need it: `sweep()` refreshes every open session.

`webhooks.verify` returns `false` when `config.webhooks` is not set.

The type of the returned object is exported as `OpenRamp`.

## Background sweep

Users close tabs, and webhook deliveries fail. `openramp.sweep()` does the background work. Run it every minute or so:

- from a scheduler that runs your code (a [Cloudflare Cron Trigger](../deploy/cloudflare-workers.md#cron-trigger), a [Vercel Cron Job](../deploy/nextjs.md#background-sweep), or any cron), or
- over HTTP with `POST {baseUrl}/tasks/sweep` and `Authorization: Bearer {tasksToken}` (see [HTTP routes](./http.md#post-tasks-sweep)).

Each run does three things:

1. **Retries failed webhooks.** A delivery that fails (no 2xx answer, or a timeout) goes to an outbox in the store. The sweep sends it again when it is due. The wait starts at 30 seconds and doubles after each failed attempt, up to 1 hour. After `webhooks.maxAttempts` attempts in all (default 8), the server drops the event and logs `webhook dropped after retries` as an error.
2. **Refreshes open payments.** For each open session with an active payment, it asks the active leg's adapter for status, like `sessions.refresh(id)`. This settles legs without provider webhooks (Relay) after the user leaves.
3. **Expires idle sessions.** An open session past its expiry with no payment started moves to `EXPIRED`, and the server sends `session.expired`.

```ts
type SweepResult = {
  webhooks: { retried: number; delivered: number; dropped: number; pending: number }
  sessions: { checked: number; changed: number; expired: number; open: number }
}
```

`limit` (default `50`) caps the webhooks retried and the sessions checked in one run. The rest wait for the next run.

::: warning At-least-once delivery
The outbox and the list of open sessions are small lists in the store's key-value space. Key-value stores are not atomic, so two sweeps that run at the same time can send the same webhook twice. Deduplicate by event id (`openramp-id`) in your backend. See [Credit exactly once](../guide/webhooks.md#credit-exactly-once).
:::

The server tracks only the sessions it creates, and keeps up to the last 1,000 open session ids.

## CreateSessionInput

| Field | Type | Default | Description |
|---|---|---|---|
| `userId` | `string` | required | Your user id. Passed to adapters and echoed in webhooks. |
| `direction` | `'deposit' \| 'withdraw'` | `'deposit'` | See [Withdrawals](../guide/withdraw.md) |
| `destination` | `Destination` | required for a deposit | Where the money goes. See below. A withdraw session must not have one (`400`): the user picks the target. |
| `source` | `WithdrawSource` | required for a withdrawal | `{ chain, token, symbol?, decimals?, custody }`: the asset that leaves, and who holds it (`'user_wallet'` or `'app'`) |
| `allowedTargets` | `AllowedTargets` | any target | Withdraw only: `{ crypto?: { chains? }, fiat?: { currencies? } }`. See [Allowed targets](../guide/withdraw.md#allowed-targets). |
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
  | { type: 'crypto'; chain: string; token: string; address: string; symbol?: string; decimals?: number; calls?: ContractCall[] }
  | { type: 'merchant'; currency: string; accountRef?: string }
  | { type: 'fiat'; currency: string } // withdraw to cash: set by the server from the user's target
```

`chain` is CAIP-2 (`eip155:8453`), `token` is an address or `native`. Pass `symbol` and `decimals` so the modal can format amounts without a lookup.

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
