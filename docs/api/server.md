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
| `webhooks` | `{ url: string; secret: string }` | none | Signed webhooks to your backend |
| `geo` | `(req) => { country?, region? } \| undefined` | Cloudflare / Vercel headers | Country and region for `POST /sessions` |
| `authorize` | `(req, body) => Promise<CreateSessionInput \| null>` | none | Enables `POST /sessions` from the browser or another service |
| `cors` | `{ origins: string[] \| '*' }` | same origin only | Allowed origins for CORS |
| `logger` | `Logger` | console (no debug) | `debug`, `info`, `warn`, `error` |
| `returnUrl` | `string` | `{baseUrl}/return` | Where providers send the user back |
| `fetch` | `typeof fetch` | global `fetch` | Used by the server and passed to adapters |
| `timeouts.quote` | `number` (ms) | `9000` | Per quoted pathway |
| `timeouts.webhook` | `number` (ms) | `4000` | Per outgoing webhook |

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

await openramp.webhooks.verify(req, rawBody) // Promise<boolean>: verify a webhook this server sent
```

`handle` never throws. Errors become JSON responses (see [HTTP routes](./http.md#errors)). It answers `OPTIONS` with `204` and the CORS headers.

`sessions.refresh(id)` skips the 2-second rate limit that browser polls have. Use it from a cron job to settle sessions whose users closed the tab. It sends any webhooks that become due.

`webhooks.verify` returns `false` when `config.webhooks` is not set.

The type of the returned object is exported as `OpenRamp`.

## CreateSessionInput

| Field | Type | Default | Description |
|---|---|---|---|
| `userId` | `string` | required | Your user id. Passed to adapters and echoed in webhooks. |
| `destination` | `Destination` | required | Where the money goes. See below. |
| `direction` | `'deposit' \| 'withdraw'` | `'deposit'` | Withdraw is in progress and not documented yet |
| `country` | `string` | none | ISO 3166-1 alpha-2. Picks the currency and local methods. |
| `region` | `string` | none | ISO 3166-2, e.g. `US-NY` |
| `email` | `string` | none | Prefilled at providers that support it |
| `locale` | `string` | none | BCP 47. Picks the modal language; adapters get `en` when unset. |
| `amountBounds` | `{ min?, max?, currency }` | none | Shown as a hint on the amount screen. Not enforced by the server. |
| `allowedMethods` | `string[]` | all | Only these methods are planned and quoted |
| `metadata` | `Record<string, string>` | none | Echoed in every webhook |
| `ttlMinutes` | `number` | `30` | Session lifetime |

```ts
type Destination =
  | { type: 'crypto'; chain: string; token: string; address: string; symbol?: string; decimals?: number; calls?: ContractCall[] }
  | { type: 'merchant'; currency: string; accountRef?: string }
```

`chain` is CAIP-2 (`eip155:8453`), `token` is an address or `native`. Pass `symbol` and `decimals` so the modal can format amounts without a lookup.

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
import { memoryStore, cloudflareKvStore, redisStore, fromNodeRedis, scopedKV, VersionConflictError } from '@openrampkit/server'
```

| Export | Description |
|---|---|
| `memoryStore()` | In memory. Development and tests only. |
| `cloudflareKvStore(ns, { sessionTtlSec? })` | Workers KV. Eventually consistent: the version check is best effort. |
| `redisStore(redis, { prefix?, sessionTtlSec? })` | Redis with an atomic version check (Lua). Works with `@upstash/redis` directly. |
| `fromNodeRedis(client)` | Wraps an ioredis-style client for `redisStore` |
| `scopedKV(store, prefix)` | A prefixed key-value view, as adapters get |
| `VersionConflictError` | Thrown by `put` on a version mismatch |

Types: `SessionStore`, `SessionRecord`, `ActiveLeg`, `StoredQuote`, `KVNamespaceLike`, `RedisLike`, `NodeRedisLike`, `RedisStoreOptions`. See [Session stores](../deploy/stores.md) for the interface and a custom store.

## Other exports

Types: `OpenRampConfig`, `CreateSessionInput`, `CreatedSession`, `OpenRamp`.
