import { OPENRAMP_SECRET, PUBLIC_URL } from '$app/env/private'
import { mockAdapter } from '@openrampkit/adapter-mock'
import { createOpenRamp } from '@openrampkit/server'

// One instance per server process. The default memory store is fine for local development.
const g = globalThis as unknown as { __openramp?: ReturnType<typeof createOpenRamp> }

export const openramp =
  g.__openramp ??
  (g.__openramp = createOpenRamp({
    secret: OPENRAMP_SECRET,
    // src/routes/api/openramp/[...path]/+server.ts serves this path.
    baseUrl: `${PUBLIC_URL}/api/openramp`,
    // Mock providers only: no real money, works offline.
    adapters: [mockAdapter({ crypto: true, bridge: true, settleMs: 4000 })],
  }))
