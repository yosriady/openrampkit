// The MCP server keeps each session's client secret here. The agent sees only session ids,
// and can read only the sessions this server created. The same store keeps the counters for
// `limits` (sessions per hour, total per day).

import { add } from '@openrampkit/core'

export type RegistryEntry = {
  clientSecret: string
  direction: 'deposit' | 'withdraw'
  expiresAt: string
  preview?: boolean
  /** Id of the session's pay link, for `revokePayLink` */
  payLinkId?: string
}

export type SessionRegistry = {
  get(sessionId: string): Promise<RegistryEntry | undefined>
  set(sessionId: string, entry: RegistryEntry): Promise<void>
  /**
   * Add `amount` (a decimal string, can be negative) to the counter `key` and return the new total.
   * The counter starts at "0" and is dropped `ttlMs` after its first add.
   * It must be atomic across all MCP server instances that share this registry (for example Redis
   * `INCRBYFLOAT` plus `PEXPIRE NX`, or a database row update). Required when `limits` is set.
   */
  incr?(key: string, amount: string, ttlMs: number): Promise<string>
}

/** In-memory registry. Keeps up to `max` sessions (default 1,000); the oldest go first. One process only. */
export function memoryRegistry(max = 1000): SessionRegistry {
  const m = new Map<string, RegistryEntry>()
  const counters = new Map<string, { total: string; exp: number }>()
  return {
    async get(id) {
      return m.get(id)
    },
    async set(id, entry) {
      m.delete(id)
      m.set(id, entry)
      while (m.size > max) m.delete(m.keys().next().value!)
    },
    async incr(key, amount, ttlMs) {
      const now = Date.now()
      for (const [k, v] of counters) if (v.exp <= now) counters.delete(k)
      const c = counters.get(key) ?? { total: '0', exp: now + ttlMs }
      c.total = add(c.total, amount)
      counters.set(key, c)
      return c.total
    },
  }
}
