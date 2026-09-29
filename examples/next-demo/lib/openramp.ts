import { mockAdapter } from '@openrampkit/adapter-mock'
import { relay } from '@openrampkit/adapter-relay'
import { createOpenRamp } from '@openrampkit/server'

const PUBLIC_URL = process.env.PUBLIC_URL ?? 'http://localhost:3000'
const MOCK = (process.env.OPENRAMP_MOCK ?? '1') === '1'

// One instance per server process. The default memory store is fine for local development.
const g = globalThis as unknown as { __openramp?: ReturnType<typeof createOpenRamp> }

export const openramp =
  g.__openramp ??
  (g.__openramp = createOpenRamp({
    secret: process.env.OPENRAMP_SECRET ?? 'dev-secret-change-me-dev-secret-change-me',
    baseUrl: `${PUBLIC_URL}/api/openramp`,
    // Mock mode: every pathway is simulated. Real mode: Relay moves real crypto; fiat is still mocked.
    adapters: MOCK ? [mockAdapter({ crypto: true, bridge: true, settleMs: 4000 })] : [relay(), mockAdapter({ settleMs: 4000 })],
    webhooks: { url: `${PUBLIC_URL}/api/hooks`, secret: process.env.OPENRAMP_WEBHOOK_SECRET ?? 'whsec_dev' },
  }))

export const isMock = MOCK
