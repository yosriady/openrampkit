import { mockAdapter } from '@openrampkit/adapter-mock'
import { lifi } from '@openrampkit/adapter-lifi'
import { relay } from '@openrampkit/adapter-relay'
import { xendit } from '@openrampkit/adapter-xendit'
import { createOpenRamp } from '@openrampkit/server'

const PUBLIC_URL = process.env.PUBLIC_URL ?? 'http://localhost:3000'
const MOCK = (process.env.OPENRAMP_MOCK ?? '1') === '1'
const BURN = '0x000000000000000000000000000000000000dead'

// One instance per server process. The default memory store is fine for local development.
const g = globalThis as unknown as { __openramp?: ReturnType<typeof createOpenRamp> }

export const openramp =
  g.__openramp ??
  (g.__openramp = createOpenRamp({
    secret: process.env.OPENRAMP_SECRET ?? 'dev-secret-change-me-dev-secret-change-me',
    baseUrl: `${PUBLIC_URL}/api/openramp`,
    // Mock mode: every pathway is simulated. Real mode: Relay moves real crypto; fiat is still mocked.
    adapters: [
      // `offramp: true` adds a mock withdraw-to-cash leg (bank transfer, GCash, MoMo, PromptPay payouts).
      ...(MOCK ? [mockAdapter({ crypto: true, bridge: true, offramp: true, settleMs: 4000 })] : [relay({ ...(process.env.RELAY_API_KEY ? { apiKey: process.env.RELAY_API_KEY } : {}) }), mockAdapter({ offramp: true, settleMs: 4000 })]),
      // LI.FI: a second wallet router next to Relay, in real mode when a LI.FI API key is set.
      ...(!MOCK && process.env.LIFI_API_KEY ? [lifi({ apiKey: process.env.LIFI_API_KEY, integrator: 'openrampkit-demo' })] : []),
      // Real merchant pay-in (QRIS, QR Ph, PromptPay, e-wallets) when Xendit test keys are set.
      ...(process.env.XENDIT_SECRET_KEY && process.env.XENDIT_WEBHOOK_TOKEN
        ? [xendit({ secretKey: process.env.XENDIT_SECRET_KEY, webhookToken: process.env.XENDIT_WEBHOOK_TOKEN })]
        : []),
    ],
    webhooks: { url: `${PUBLIC_URL}/api/hooks`, secret: process.env.OPENRAMP_WEBHOOK_SECRET ?? 'whsec_ZGV2LW9ubHktd2ViaG9vay1zZWNyZXQtbm90LWZvci1wcm9kdWN0aW9u' },
    // Admin tools and the ops dashboard at /api/openramp/admin, only when OPENRAMP_ADMIN_TOKEN is set
    // (at least 32 random characters). Put /admin behind your own auth or a VPN in production.
    ...(process.env.OPENRAMP_ADMIN_TOKEN ? { admin: { token: process.env.OPENRAMP_ADMIN_TOKEN } } : {}),
    // Withdraw: screen target addresses. Connect a sanctions API here (e.g. Chainalysis) in production.
    // The demo refuses the well-known burn address.
    screenAddress: async (address) => address.toLowerCase() !== BURN,
    // Withdraw with `custody: 'app'`: the app's hot wallet signs. The demo only pretends to send.
    treasury: {
      async send({ sessionId, chain, txs }) {
        console.log('[openramp treasury] demo send', { sessionId, chain, txs: txs.length })
        return { hash: `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('')}` }
      },
    },
  }))

export const isMock = MOCK
