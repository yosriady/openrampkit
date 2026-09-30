// The MCP server keeps each session's client secret here. The agent sees only session ids,
// and can read only the sessions this server created.

export type RegistryEntry = { clientSecret: string; direction: 'deposit' | 'withdraw'; expiresAt: string; preview?: boolean }

export type SessionRegistry = {
  get(sessionId: string): Promise<RegistryEntry | undefined>
  set(sessionId: string, entry: RegistryEntry): Promise<void>
}

/** In-memory registry. Keeps up to `max` sessions (default 1,000); the oldest go first. */
export function memoryRegistry(max = 1000): SessionRegistry {
  const m = new Map<string, RegistryEntry>()
  return {
    async get(id) {
      return m.get(id)
    },
    async set(id, entry) {
      m.delete(id)
      m.set(id, entry)
      while (m.size > max) m.delete(m.keys().next().value!)
    },
  }
}
