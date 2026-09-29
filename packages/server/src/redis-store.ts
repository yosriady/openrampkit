import { VersionConflictError } from './store.js'
import type { SessionRecord, SessionStore } from './store.js'

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

export type RedisStoreOptions = {
  /** Key prefix. Default `openramp:` */
  prefix?: string
  /** Session TTL in seconds. Default 7 days. */
  sessionTtlSec?: number
}

/** Session store on Redis with an atomic version check. Suitable for production. */
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
