# Session stores

The server keeps every session in a `SessionStore`. Each request loads the session, changes it, and saves it with an optimistic version check. Adapters also keep small records in the same store (catalog caches, access tokens, deposit addresses, order records), and the server keeps its indexes there (provider reference to session, idempotency replays).

Because all state is in the store, any server instance can serve any request.

| Store | Use for | Atomic version check |
|---|---|---|
| `memoryStore()` | Local development, tests | Yes, in one process |
| `durableObjectStore(ns)` | **Production on Cloudflare Workers** (built in, no extra service) | Yes (one Durable Object per key) |
| `redisStore(redis)` | Production on Node, Vercel, Bun, Deno | Yes (Lua script) |
| `cloudflareKvStore(ns)` | Demos only | Best effort (KV is eventually consistent) |
| Your own | Postgres, DynamoDB | You decide |

::: tip Fewest moving parts
On Cloudflare, use `durableObjectStore`: the Worker and its Durable Object binding are the whole stack. On Vercel or a Node host, use Redis only when you run more than one instance; one process can use `memoryStore` for a demo, but it loses sessions on restart.
:::

## Durable Objects (Cloudflare)

Strongly consistent and part of Workers. The store uses one small Durable Object per key (`s:{sessionId}` for sessions, `k:{key}` for the rest). A Durable Object handles one request at a time, so the version check and the write are atomic. Values with a TTL are checked on read and deleted by a Durable Object alarm.

```ts
// src/index.ts: export the class from your Worker entry
export { OpenRampStore } from '@openrampkit/server'
import { createOpenRamp, durableObjectStore } from '@openrampkit/server'

createOpenRamp({ /* ... */ store: durableObjectStore(env.OPENRAMP_STORE, { sessionTtlSec: 7 * 24 * 3600 }) }) // the default TTL
```

```toml
# wrangler.toml
[[durable_objects.bindings]]
name = "OPENRAMP_STORE"
class_name = "OpenRampStore"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["OpenRampStore"]
```

The class uses the plain `fetch` protocol of Durable Objects and has no `cloudflare:*` imports, so the server package still builds for other runtimes. `wrangler dev` runs Durable Objects locally.

## Memory

```ts
createOpenRamp({ /* no store */ })          // memoryStore() by default
createOpenRamp({ store: memoryStore() })
```

Data lives in the process and is lost on restart. On serverless platforms, each instance has its own memory, so sessions disappear between requests. Do not use it in production.

## Cloudflare KV

```ts
import { cloudflareKvStore } from '@openrampkit/server'

createOpenRamp({ store: cloudflareKvStore(env.SESSIONS, { sessionTtlSec: 7 * 24 * 3600 }) })
```

- Sessions are stored under `s:{id}` for `sessionTtlSec` (default 7 days). Other keys are stored under `k:{key}`, with a TTL of at least 60 seconds (the KV minimum).
- KV reads can be stale for up to about a minute across locations, and there is no compare-and-set. Concurrent writes to one session can be lost. See [Cloudflare Workers](./cloudflare-workers.md#why-not-workers-kv).

`KVNamespaceLike` is the minimal shape: `get(key, 'text')` and `put(key, value, { expirationTtl })`.

## Redis

`redisStore` saves sessions with a server-side Lua script that compares the stored `version` and writes in one step. Other keys use `SET` with `EX`.

```ts
import { redisStore } from '@openrampkit/server'
redisStore(redis, { prefix: 'openramp:', sessionTtlSec: 7 * 24 * 3600 }) // the defaults
```

Keys: `{prefix}s:{id}` for sessions, `{prefix}k:{key}` for the rest.

::: code-group

```ts [Upstash (HTTP, e.g. Vercel Edge)]
import { Redis } from '@upstash/redis'
import { redisStore } from '@openrampkit/server'

// UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN
const store = redisStore(Redis.fromEnv())
```

```ts [ioredis (Node)]
import { Redis } from 'ioredis'
import { fromNodeRedis, redisStore } from '@openrampkit/server'

const store = redisStore(fromNodeRedis(new Redis(process.env.REDIS_URL!)))
```

:::

`@upstash/redis` matches the `RedisLike` shape directly (`get`, `set(key, value, { ex })`, `eval(script, keys, args)`), and its automatic JSON parsing is handled. `fromNodeRedis` adapts clients with the ioredis call style: `set(key, value, 'EX', seconds)` and `eval(script, numKeys, ...keysAndArgs)`.

::: tip node-redis v4 and later
The `redis` package (node-redis v4+) uses another call style (`set(key, value, { EX })`, `eval(script, { keys, arguments })`). Use `fromNodeRedisV4` for it:

```ts
import { createClient } from 'redis'
import { fromNodeRedisV4, redisStore } from '@openrampkit/server'

const client = await createClient({ url: process.env.REDIS_URL }).connect()
const store = redisStore(fromNodeRedisV4(client))
```
:::

## A custom store

Implement `SessionStore`:

```ts
interface SessionStore {
  get(id: string): Promise<SessionRecord | null>
  /** Optimistic lock: fails when the stored version is not `expectedVersion` */
  put(rec: SessionRecord, expectedVersion?: number): Promise<void>
  kv: {
    get<T = unknown>(key: string): Promise<T | undefined>
    put(key: string, value: unknown, ttlSec?: number): Promise<void>
  }
}
```

Rules:

- `put(rec, expectedVersion)`: when `expectedVersion` is given and a stored record exists with another `version`, throw `VersionConflictError` (exported from `@openrampkit/server`) and do not write. When `expectedVersion` is undefined (a new session), write without a check. The server increments `rec.version` before it calls `put`.
- The server turns a `VersionConflictError` into a `409` the client can retry, and retries provider webhook events up to 3 times.
- `kv.put` with `ttlSec` must expire the key after that many seconds. The server uses these TTLs: 2 minutes (rate-limit counters), 24 hours (idempotency replays), 14 days (the webhook outbox and the open-session list) and 30 days (provider reference index). Adapters set their own TTLs. To delete an entry, the server writes `null` with a 60-second TTL.
- `kv.get` must return `undefined` for a missing or expired key.
- Store the record as JSON. It holds only JSON values.
- Keep sessions for at least as long as providers may send webhooks for them (days, not minutes). The built-in stores keep them for 7 days.

A Postgres example:

```ts
import type { Sql } from 'postgres'
import { VersionConflictError } from '@openrampkit/server'
import type { SessionRecord, SessionStore } from '@openrampkit/server'

// tables: sessions(id text primary key, version int, data jsonb)
//         openramp_kv(key text primary key, value jsonb, expires_at timestamptz)
export function postgresStore(sql: Sql): SessionStore {
  return {
    async get(id) {
      const [row] = await sql`select data from sessions where id = ${id}`
      return (row?.data as SessionRecord) ?? null
    },
    async put(rec, expectedVersion) {
      if (expectedVersion === undefined) {
        await sql`insert into sessions (id, version, data) values (${rec.id}, ${rec.version}, ${sql.json(rec)})
                  on conflict (id) do update set version = excluded.version, data = excluded.data`
        return
      }
      const res = await sql`update sessions set version = ${rec.version}, data = ${sql.json(rec)}
                            where id = ${rec.id} and version = ${expectedVersion}`
      if (res.count === 0) {
        const [row] = await sql`select 1 from sessions where id = ${rec.id}`
        if (row) throw new VersionConflictError(`Session ${rec.id} changed`)
        await sql`insert into sessions (id, version, data) values (${rec.id}, ${rec.version}, ${sql.json(rec)})`
      }
    },
    kv: {
      async get(key) {
        const [row] = await sql`select value from openramp_kv where key = ${key} and (expires_at is null or expires_at > now())`
        return row?.value
      },
      async put(key, value, ttlSec) {
        const exp = ttlSec ? new Date(Date.now() + ttlSec * 1000) : null
        await sql`insert into openramp_kv (key, value, expires_at) values (${key}, ${sql.json(value)}, ${exp})
                  on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at`
      },
    },
  }
}
```

(`sql` here is a [postgres.js](https://github.com/porsager/postgres) client.) Delete expired `openramp_kv` rows and old sessions with a scheduled job.
