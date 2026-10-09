# Session stores

The server keeps every session in a `SessionStore`. Each request loads the session, changes it, and saves it with an optimistic version check. Adapters also keep small records in the same store (catalog caches, access tokens, deposit addresses, order records), and the server keeps its indexes there (provider reference to session, idempotency replays).

The store also has two work queues for the [background sweep](../api/server.md#background-sweep): the webhook outbox and the open-session list. See [Queues](#queues).

Because all state is in the store, any server instance can serve any request.

| Store | Use for | Atomic version check | Atomic queues | `kv.putIfAbsent` |
|---|---|---|---|---|
| `memoryStore()` | Local development, tests | Yes, in one process | Yes, in one process | Yes, in one process |
| `durableObjectStore(ns)` | **Production on Cloudflare Workers** (built in, no extra service) | Yes (one Durable Object per key) | Yes (one Durable Object per queue) | Yes (inside the Durable Object of the key) |
| `redisStore(redis)` | Production on Node, Vercel, Bun, Deno | Yes (Lua script) | Yes (sorted sets and Lua scripts) | Yes (`SET NX EX` in a Lua script) |
| `cloudflareKvStore(ns)` | Demos only | Best effort (KV is eventually consistent) | No lost adds (one key per entry); a claim is best effort | No (adapters write, then read back) |
| Your own | Postgres, DynamoDB | You decide | Your `queue`, or the built-in fallback | Optional (see [A custom store](#a-custom-store)) |

`kv.putIfAbsent(key, value, ttlSec)` writes a value only when the key has no live value, as one atomic step. It returns true when it wrote. Adapters use it through `claimOnce` (see the [adapter API](../api/adapter.md#one-owner-per-record)) to record that a transaction or deposit belongs to one payment only. Without it, two requests at the same time can both take the same transaction.

::: tip Fewest moving parts
On Cloudflare, use `durableObjectStore`: the Worker and its Durable Object binding are the whole stack. On Vercel or a Node host, use Redis only when you run more than one instance; one process can use `memoryStore` for a demo, but it loses sessions on restart.
:::

## Durable Objects (Cloudflare)

Strongly consistent and part of Workers. The store uses one small Durable Object per key (`s:{sessionId}` for sessions, `k:{key}` for the rest), and one per queue (`q:{queue}`, with one storage key per entry). A Durable Object handles one request at a time, so the version check and the write, and each queue operation, are atomic. Values with a TTL are checked on read and deleted by a Durable Object alarm.

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
- Queue entries are stored under `q:{queue}:{id}`, one key per entry, with the entry in the key metadata. An add never overwrites another entry. A new entry can take up to a minute to show in `list`, and two sweeps at the same time can take the same entry.

`KVNamespaceLike` is the minimal shape: `get(key, 'text')`, `put(key, value, { expirationTtl, metadata })`, and for the queues `list({ prefix, cursor })` and `delete(key)`. A real KV namespace has all of them. Without `list` and `delete`, the store uses the [queue fallback](#queues).

## Redis

`redisStore` saves sessions with a server-side Lua script that compares the stored `version` and writes in one step. Other keys use `SET` with `EX`. `kv.putIfAbsent` runs `SET` with `NX` and `EX` in a Lua script, so it works with every `RedisLike` client. Each queue is a sorted set (id to due time) and a hash (id to claim token). Only Lua scripts change them, so each queue operation is atomic.

```ts
import { redisStore } from '@openrampkit/server'
redisStore(redis, { prefix: 'openramp:', sessionTtlSec: 7 * 24 * 3600 }) // the defaults
```

Keys: `{prefix}s:{id}` for sessions, `{prefix}k:{key}` for the rest, and `{prefix}q:{queue}` and `{prefix}qt:{queue}` for the queues. The queue name is in braces (a hash tag), so both queue keys are in one slot on Redis Cluster.

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

## Queues

The sweep works from two queues: `outbox` (ids of sessions with webhook events to send) and `open-sessions` (ids of sessions that are not final). The events themselves are in the session record. A queue entry is an id with a due time.

```ts
interface StoreQueue {
  /** Add id, due at dueAt. An unclaimed id keeps the earlier due time. A claimed id gets dueAt and loses its claim. */
  push(queue: string, id: string, dueAt: number): Promise<void>
  /** Claim up to limit ids that are due at now, earliest first. Each gets the due time now + leaseMs and the claim token. */
  claim(queue: string, opts: { now: number; limit: number; leaseMs: number; token: string }): Promise<string[]>
  /** Remove id only when it still has this claim token (no push came after the claim). */
  ack(queue: string, id: string, token: string): Promise<boolean>
  size(queue: string): Promise<number>
  /** Optional. Read up to limit entries with a due time of at most max, latest first (ties: id from high to low). Changes nothing. */
  range?(queue: string, opts: { max: number; limit: number }): Promise<Array<{ id: string; dueAt: number }>>
}
```

`range` is for the [admin time index](../guide/admin.md#the-time-index-and-its-limits) (`admin-index:{day}` queues). The sweep does not use it. All built-in stores and the fallback have it.

Why this design:

- **No lost adds.** Each entry is separate, and each operation is atomic. A session that is added while a sweep runs stays in the queue.
- **No lost work.** The sweep removes an entry with `ack` and its claim token. When a request adds the same id after the claim (for example for a new webhook event), the token no longer matches, and the entry stays.
- **Round robin.** A claim takes the entries that waited longest. The sweep puts a checked session back with the current time, so it goes to the back of the line.
- **Leases.** A claimed entry is not due until its lease ends (10 minutes). A second sweep at the same time skips it. When a sweep stops in the middle, the entry is due again after the lease.

All built-in stores have a `queue`. A custom store without `queue` gets a fallback: each queue is one record (id `__queue:{name}`), saved with `put(record, expectedVersion)` and retried on `VersionConflictError`. It is safe when your `put` has a real version check, but every add writes the whole record again. For more than a few hundred open sessions, implement `queue` (see the Postgres example below).

When you upgrade from a version that kept these lists as KV arrays (`outbox`, `open-sessions`), the first sweep moves the old entries to the queues.

## Record schema

Each session record has two numbers. Do not mix them up:

| Field | What it is |
|---|---|
| `version` | The optimistic-lock counter. Each write adds 1. `put(rec, expectedVersion)` compares it. |
| `schema` | The shape of the record. The server writes `SESSION_SCHEMA` (now `1`) in each new record. A record from a version before this field has no `schema`: it is schema 0. |

The server runs `migrateRecord()` on each record that it reads from the store. The function brings an older record up to the current schema, in memory. The next write saves the result. You do not run a migration script, and old sessions keep working after an upgrade.

Schema 0 to 1 sets:

- `updatedAt` to `createdAt` when it is missing.
- `ActivePayment.n` (the attempt number) to the number of earlier attempts, and `n` of each earlier attempt to its place in `attempts`.
- `quotes`, `startUrls`, `notified` and `outbox` to empty values when they are missing.

Rules:

- `migrateRecord` changes only session records. It returns other records (for example the `__queue:*` records of a custom store) as they are.
- A record with a newer `schema` than the server (written by a newer server, before a rollback) is returned as it is. Do not roll back across a schema change while sessions are open.
- A custom store does not need to know about `schema`. Store the whole record as JSON, as before.

The server tests load records written before `schema` existed (`packages/server/src/fixtures/records-v0.json`) and finish their payments.

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
    /** Optional, but recommended: write only when the key has no live value, atomically. True when it wrote. */
    putIfAbsent?(key: string, value: unknown, ttlSec: number): Promise<boolean>
  }
  /** Optional, but recommended: see Queues */
  queue?: StoreQueue
}
```

Rules:

- `put(rec, expectedVersion)`: when `expectedVersion` is given and a stored record exists with another `version`, throw `VersionConflictError` (exported from `@openrampkit/server`) and do not write. When `expectedVersion` is undefined (a new session), write without a check. The server increments `rec.version` before it calls `put`.
- The server turns a `VersionConflictError` into a `409` the client can retry, and retries provider webhook events up to 3 times.
- `kv.put` with `ttlSec` must expire the key after that many seconds. The server uses these TTLs: 2 minutes (rate-limit counters), 24 hours (idempotency replays) and 30 days (provider reference index). Adapters set their own TTLs. To delete an entry, the server writes `null` with a 60-second TTL.
- `queue`: every operation must be atomic. Queue entries have no TTL: the sweep removes them.
- `kv.get` must return `undefined` for a missing or expired key.
- `kv.putIfAbsent`: write only when the key is missing or expired, and return true. When a live value is there, do not write, and return false. The read and the write must be one atomic step. If your store cannot do this, leave it out: adapters then write, then read back. In Postgres: `insert ... on conflict (key) do update ... where openramp_kv.expires_at <= now()`, then check the row count.
- Store the record as JSON. It holds only JSON values.
- Keep sessions for at least as long as providers may send webhooks for them (days, not minutes). The built-in stores keep them for 7 days.

A Postgres example:

```ts
import type { Sql } from 'postgres'
import { VersionConflictError } from '@openrampkit/server'
import type { SessionRecord, SessionStore, StoreQueue } from '@openrampkit/server'

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

A queue for the same store. Each statement is atomic, and `for update skip locked` lets two sweeps claim different rows:

```ts
// table: openramp_queue(queue text, id text, due_at bigint, token text, primary key (queue, id))
const queue: StoreQueue = {
  async push(queue, id, dueAt) {
    await sql`insert into openramp_queue (queue, id, due_at) values (${queue}, ${id}, ${dueAt})
              on conflict (queue, id) do update set
                due_at = case when openramp_queue.token is null then least(openramp_queue.due_at, excluded.due_at) else excluded.due_at end,
                token = null`
  },
  async claim(queue, { now, limit, leaseMs, token }) {
    const rows = await sql`update openramp_queue set due_at = ${now + leaseMs}, token = ${token}
                           where (queue, id) in (select queue, id from openramp_queue where queue = ${queue} and due_at <= ${now}
                                                 order by due_at limit ${limit} for update skip locked)
                           returning id`
    return rows.map((r) => r.id as string)
  },
  async ack(queue, id, token) {
    const res = await sql`delete from openramp_queue where queue = ${queue} and id = ${id} and token = ${token}`
    return res.count === 1
  },
  async size(queue) {
    const [row] = await sql`select count(*)::int as n from openramp_queue where queue = ${queue}`
    return row!.n as number
  },
  async range(queue, { max, limit }) {
    const rows = await sql`select id, due_at from openramp_queue where queue = ${queue} and due_at <= ${Number.isFinite(max) ? max : Number.MAX_SAFE_INTEGER}
                           order by due_at desc, id desc limit ${limit}`
    return rows.map((r) => ({ id: r.id as string, dueAt: Number(r.due_at) }))
  },
}
```

`claim` can return the ids in another order than `due_at`. The sweep does not depend on the order inside one claim.
