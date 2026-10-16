import { mockAdapter } from '@openrampkit/adapter-mock'
import { createOpenRamp } from '@openrampkit/server'

const PUBLIC_URL = process.env.PUBLIC_URL ?? 'http://localhost:3000'

// One instance per server process. The default memory store is fine for local development.
// Nuxt auto-imports everything in server/utils, so the routes use `openramp` without an import.
const g = globalThis as unknown as { __openramp?: ReturnType<typeof createOpenRamp> }

export const openramp =
  g.__openramp ??
  (g.__openramp = createOpenRamp({
    secret: process.env.OPENRAMP_SECRET ?? 'dev-secret-change-me-dev-secret-change-me',
    // The catch-all route in server/api/openramp/[...path].ts serves this path.
    baseUrl: `${PUBLIC_URL}/api/openramp`,
    // Mock providers only: no real money, works offline.
    adapters: [mockAdapter({ crypto: true, bridge: true, settleMs: 4000 })],
  }))
