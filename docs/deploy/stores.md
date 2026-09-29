# Session stores

The server keeps every session in a `SessionStore`. Each request loads the session, changes it, and saves it with an optimistic version check. Adapters also keep small records in the same store (catalog caches, access tokens, deposit addresses, order records), and the server keeps its indexes there (provider reference to session, idempotency replays).

Because all state is in the store, any server instance can serve any request.

| Store | Use for | Atomic version check |
|---|---|---|
| `memoryStore()` | Local development, tests | Yes, in one process |
| `cloudflareKvStore(ns)` | Demos and low traffic on Workers | Best effort (KV is eventually consistent) |
| `redisStore(redis)` | Production | Yes (Lua script) |
| Your own | Postgres, DynamoDB, Durable Objects | You decide |

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
- KV reads can be stale for up to about a minute across locations, and there is no compare-and-set. Concurrent writes to one session can be lost. See [Cloudflare Workers](./cloudflare-workers.md#kv-caveat).

`KVNamespaceLike` is the minimal shape: `get(key, 'text')` and `put(key, value, { expirationTtl })`.

## Redis

`redisStore` saves sessions with a server-side Lua script that compares the stored `version` and writes in one step. Other keys use `SET` with `EX`.

```ts
import { redisStore } from '@openrampkit/server'
redisStore(redis, { prefix: 'openramp:', sessionTtlSec: 7 * 24 * 3600 }) // the defaults
```

Keys: `{prefix}s:{id}` for sessions, `{prefix}k:{key}` for the rest.

::: code-group

```ts [Upstash (HTTP, Workers and Edge)]
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
The `redis` package (node-redis v4+) uses another call style (`set(key, value, { EX })`, `eval(script, { keys, arguments })`). `fromNodeRedis` does not fit it despite the name. Use ioredis, or write a small `RedisLike` wrapper:

```ts
import { createClient } from 'redis'
import type { RedisLike } from '@openrampkit/server'

const client = await createClient({ url: process.env.REDIS_URL }).connect()
const redis: RedisLike = {
  get: (k) => client.get(k),
  set: (k, v, o) => (o?.ex ? client.set(k, v, { EX: o.ex }) : client.set(k, v)),
  eval: (script, keys, args) => client.eval(script, { keys, arguments: args }),
}
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
- `kv.put` with `ttlSec` must expire the key after that many seconds. The server uses TTLs of 24 hours (idempotency replays) and 30 days (provider reference index).
- Store the record as JSON. It holds only JSON values.
- Keep sessions for at least as long as providers may send webhooks for them (days, not minutes). The built-in stores keep them for 7 days.

A Postgres example:

```ts
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
