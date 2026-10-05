import { VersionConflictError } from './store.js'
import type { SessionRecord, SessionStore, StoreQueue } from './store.js'

/**
 * The few Redis calls the store needs. `@upstash/redis` (HTTP, works on Cloudflare Workers and Vercel Edge)
 * matches this shape directly. For ioredis or node-redis, wrap the client with `fromNodeRedis`.
 */
export type RedisLike = {
  get(key: string): Promise<string | null | unknown>
  set(key: string, value: string, opts?: { ex?: number }): Promise<unknown>
  eval(script: string, keys: string[], args: string[]): Promise<unknown>
}

// Compare-and-set on the stored record's version, atomically in Redis. This is Redis EVAL (a fixed,
// server-side Lua script), not JavaScript eval: user data only ever goes in as KEYS/ARGV values.
// KEYS[1] = session key. ARGV[1] = expected version ('' = no check), ARGV[2] = new JSON, ARGV[3] = ttl seconds.
const CAS_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
if ARGV[1] ~= '' and cur then
  local v = cjson.decode(cur)['version']
  if tostring(v) ~= ARGV[1] then return 0 end
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
return 1
`

// Queue scripts. Each queue is a sorted set (id -> due time in ms) and a hash (id -> claim token).
// Both keys share a hash tag, so they live in one slot on Redis Cluster.
// KEYS[1] = sorted set, KEYS[2] = token hash.

// ARGV[1] = id, ARGV[2] = due time. A claimed id gets the new due time; an unclaimed one keeps the earlier time.
export const QUEUE_PUSH_SCRIPT = `
local cur = redis.call('ZSCORE', KEYS[1], ARGV[1])
local due = ARGV[2]
if cur and redis.call('HEXISTS', KEYS[2], ARGV[1]) == 0 and tonumber(cur) < tonumber(due) then due = cur end
redis.call('ZADD', KEYS[1], due, ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
return 1
`

// ARGV[1] = now, ARGV[2] = limit, ARGV[3] = lease end, ARGV[4] = token. Returns the claimed ids.
export const QUEUE_CLAIM_SCRIPT = `
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
for _, id in ipairs(ids) do
  redis.call('ZADD', KEYS[1], ARGV[3], id)
  redis.call('HSET', KEYS[2], id, ARGV[4])
end
return ids
`

// ARGV[1] = id, ARGV[2] = token. Removes the id only when it still has this claim.
export const QUEUE_ACK_SCRIPT = `
if redis.call('HGET', KEYS[2], ARGV[1]) == ARGV[2] then
  redis.call('ZREM', KEYS[1], ARGV[1])
  redis.call('HDEL', KEYS[2], ARGV[1])
  return 1
end
return 0
`

export const QUEUE_SIZE_SCRIPT = `return redis.call('ZCARD', KEYS[1])`

function redisQueue(redis: RedisLike, p: string): StoreQueue {
  const keys = (name: string) => [`${p}q:{${name}}`, `${p}qt:{${name}}`]
  return {
    async push(name, id, dueAt) {
      await redis.eval(QUEUE_PUSH_SCRIPT, keys(name), [id, String(Math.floor(dueAt))])
    },
    async claim(name, { now, limit, leaseMs, token }) {
      const ids = await redis.eval(QUEUE_CLAIM_SCRIPT, keys(name), [String(Math.floor(now)), String(limit), String(Math.floor(now + leaseMs)), token])
      return Array.isArray(ids) ? ids.map(String) : []
    },
    async ack(name, id, token) {
      return Number(await redis.eval(QUEUE_ACK_SCRIPT, keys(name), [id, token])) === 1
    },
    async size(name) {
      return Number(await redis.eval(QUEUE_SIZE_SCRIPT, keys(name), []))
    },
  }
}

export type RedisStoreOptions = {
  /** Key prefix. Default `openramp:` */
  prefix?: string
  /** Session TTL in seconds. Default 7 days. */
  sessionTtlSec?: number
}

/** Session store on Redis with an atomic version check and atomic queues (sorted sets). Suitable for production. */
export function redisStore(redis: RedisLike, opts: RedisStoreOptions = {}): SessionStore {
  const p = opts.prefix ?? 'openramp:'
  const ttl = opts.sessionTtlSec ?? 60 * 60 * 24 * 7
  const parse = <T>(v: unknown): T | undefined => {
    if (v === null || v === undefined) return undefined
    // Upstash may auto-parse JSON; node clients return strings.
    return (typeof v === 'string' ? JSON.parse(v) : v) as T
  }
  return {
    async get(id) {
      return parse<SessionRecord>(await redis.get(`${p}s:${id}`)) ?? null
    },
    async put(rec, expectedVersion) {
      const ok = await redis.eval(CAS_SCRIPT, [`${p}s:${rec.id}`], [expectedVersion === undefined ? '' : String(expectedVersion), JSON.stringify(rec), String(ttl)])
      if (Number(ok) !== 1) throw new VersionConflictError(`Session ${rec.id} changed`)
    },
    kv: {
      async get(key) {
        return parse(await redis.get(`${p}k:${key}`))
      },
      async put(key, value, ttlSec) {
        await redis.set(`${p}k:${key}`, JSON.stringify(value), ttlSec ? { ex: Math.max(1, Math.ceil(ttlSec)) } : undefined)
      },
    },
    queue: redisQueue(redis, p),
  }
}

/** Minimal ioredis shape (positional arguments) */
export type NodeRedisLike = {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>
}

/** Adapt an ioredis client (or anything with the same positional call style) to `RedisLike`. For node-redis v4+, use `fromNodeRedisV4`. */
export function fromNodeRedis(client: NodeRedisLike): RedisLike {
  return {
    get: (k) => client.get(k),
    set: (k, v, o) => (o?.ex ? client.set(k, v, 'EX', o.ex) : client.set(k, v)),
    eval: (script, keys, args) => client.eval(script, keys.length, ...keys, ...args),
  }
}

/** Minimal node-redis v4+ shape (options objects) */
export type NodeRedisV4Like = {
  get(key: string): Promise<string | null>
  set(key: string, value: string, opts?: { EX?: number }): Promise<unknown>
  eval(script: string, opts: { keys: string[]; arguments: string[] }): Promise<unknown>
}

/** Adapt a node-redis v4+ client (`createClient()` from `redis`) to `RedisLike`. */
export function fromNodeRedisV4(client: NodeRedisV4Like): RedisLike {
  return {
    get: (k) => client.get(k),
    set: (k, v, o) => (o?.ex ? client.set(k, v, { EX: o.ex }) : client.set(k, v)),
    eval: (script, keys, args) => client.eval(script, { keys, arguments: args }),
  }
}
