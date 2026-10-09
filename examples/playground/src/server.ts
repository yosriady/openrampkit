// The real OpenRampKit server, running in this browser tab with the mock adapter and the memory store.
// Nothing leaves the page: the widget's `fetch` calls `openramp.handle()` directly, and the server's
// own outgoing webhooks are answered by a fake backend below. No provider accounts, no real money.

import { mockAdapter } from '@openrampkit/adapter-mock'
import type { MockOptions } from '@openrampkit/adapter-mock'
import type { Adapter } from '@openrampkit/adapter'
import { createOpenRamp, generateWebhookSecret, memoryStore } from '@openrampkit/server'
import type { CreateSessionInput, OpenRamp, WebhookEvent } from '@openrampkit/server'

/** Any absolute URL works: no request to it leaves the page. */
const ORIGIN = 'https://playground.openrampkit.invalid'
export const BASE_URL = `${ORIGIN}/api/openramp`
const HOOKS_URL = `${ORIGIN}/api/hooks`

export type ReceivedWebhook = { type: string; sessionId?: string; verified: boolean; at: string }

const listeners = new Set<(w: ReceivedWebhook) => void>()
/** Called for every signed webhook that the fake backend receives. */
export function onWebhook(fn: (w: ReceivedWebhook) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function randomSecret(): string {
  return [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** A Standard Webhooks secret (`whsec_` and base64), new for each page load */
const webhookSecret = generateWebhookSecret()

/**
 * DEMO ONLY: a fixed admin token, so that the playground can open the ops dashboard for the sessions in
 * this tab. A real server keeps a random admin token in a secret store and never sends it to a browser.
 */
export const DEMO_ADMIN_TOKEN = 'playground-demo-admin-token-not-a-secret'

/**
 * Four mock providers with different fees, FX spreads, speeds and coverage, so that the widget can
 * compare routes. All are test only: they move no money. Card checkout uses test card fields in the
 * widget (`cardCheckout: 'form'`), because a static site cannot serve the hosted checkout page.
 */
export const MOCK_PROVIDERS: MockOptions[] = [
  {
    // Wide coverage: every method, plus crypto, exchange transfers, bridge and withdraw to cash.
    id: 'mock', name: 'Mock Onramp A', crypto: true, bridge: true, offramp: true, exchange: true,
    cardCheckout: 'form', settleMs: 2500, feeBps: { card: 250, local: 100, offramp: 100 },
    eta: { card: { min: 60, max: 300 }, local: { min: 30, max: 180 } },
  },
  {
    // Cards and the big local methods, with a small FX spread. Slower.
    id: 'mock-b', name: 'Mock Onramp B', offramp: true, cardCheckout: 'form', settleMs: 2500,
    feeBps: { card: 199, local: 60, offramp: 80 }, spreadBps: 60,
    eta: { card: { min: 120, max: 600 }, local: { min: 60, max: 600 }, offramp: { min: 300, max: 1800 } },
    methods: ['card', 'apple_pay', 'vietqr', 'momo', 'qris', 'gopay', 'dana', 'promptpay', 'qrph', 'gcash', 'duitnow', 'bank_transfer'],
  },
  {
    // Local QR rails only, in Southeast Asia: lowest fee and fastest for VietQR, QRIS and friends.
    id: 'mock-local', name: 'Mock Local Rails', settleMs: 2500, feeBps: { local: 40 }, spreadBps: 30,
    eta: { local: { min: 5, max: 60 } },
    methods: ['vietqr', 'qris', 'promptpay', 'qrph', 'duitnow', 'paynow'],
    countries: ['VN', 'ID', 'TH', 'PH', 'MY', 'SG'],
  },
  {
    // Cards and wallet pay in every country.
    id: 'mock-card', name: 'Mock Card Onramp', cardCheckout: 'form', settleMs: 2500,
    feeBps: { card: 149 }, spreadBps: 50, eta: { card: { min: 30, max: 120 } },
    methods: ['card', 'apple_pay', 'google_pay'],
  },
]

/**
 * An OpenRampKit server in this tab. Its outgoing requests go to the fake backend below; the only
 * other requests that may leave the page are the ones that `passthrough` allows (testnet mode
 * reads the public testnet RPC).
 */
export function createPlaygroundServer(opts: { adapters: Adapter[]; passthrough?: (url: string) => boolean }): { openramp: OpenRamp; fakeFetch: typeof fetch } {
  const openramp: OpenRamp = createOpenRamp({
    // A new random secret per page load. It never leaves this tab.
    secret: randomSecret(),
    baseUrl: BASE_URL,
    store: memoryStore(),
    adapters: opts.adapters,
    webhooks: { url: HOOKS_URL, secret: webhookSecret },
    // Admin tools (time index, `GET /admin` dashboard) with the demo token above.
    admin: { token: DEMO_ADMIN_TOKEN },
    logger: { debug: () => {}, info: () => {}, warn: (m, d) => console.warn(`[openramp] ${m}`, d ?? ''), error: (m, d) => console.error(`[openramp] ${m}`, d ?? '') },
    // Outgoing requests from the server: the webhook to "your backend", and allowed RPC calls.
    fetch: async (input, init) => {
      const req = new Request(input, init)
      if (req.url === HOOKS_URL) {
        const body = await req.text()
        // Standard Webhooks headers: webhook-id, webhook-timestamp and webhook-signature
        const verified = await openramp.webhooks.verify(req, body)
        const event = JSON.parse(body) as WebhookEvent
        const w: ReceivedWebhook = { type: event.type, verified, at: event.createdAt, sessionId: event.sessionId }
        for (const fn of listeners) fn(w)
        return new Response('ok')
      }
      if (opts.passthrough?.(req.url)) return fetch(req)
      return new Response('The playground does not call external services.', { status: 502 })
    },
  })
  /** Give this to the widget as `fetch`. Every request goes to the in-page server. */
  const fakeFetch: typeof fetch = (input, init) => openramp.handle(new Request(input, init))
  return { openramp, fakeFetch }
}

export const { openramp, fakeFetch } = createPlaygroundServer({ adapters: MOCK_PROVIDERS.map((p) => mockAdapter(p)) })

/** What your backend does in a real app: decide the user, then create the session. */
export async function createSession(opts: { direction: 'deposit' | 'withdraw'; country: string; locale?: string; allowedMethods?: string[] }): Promise<string> {
  const common = {
    userId: 'demo-user',
    country: opts.country,
    ...(opts.locale ? { locale: opts.locale } : {}),
    ...(opts.allowedMethods ? { allowedMethods: opts.allowedMethods } : {}),
    metadata: { source: 'playground' },
  }
  const input: CreateSessionInput =
    opts.direction === 'withdraw'
      ? {
          ...common,
          direction: 'withdraw',
          source: { chain: 'eip155:8453', token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', decimals: 6, custody: 'user_wallet' },
          allowedDestinations: { crypto: { chains: ['eip155:8453', 'eip155:42161', 'eip155:10', 'eip155:137', 'eip155:1'] }, fiat: {} },
        }
      : {
          ...common,
          destination: {
            type: 'crypto',
            chain: 'eip155:8453',
            token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
            symbol: 'USDC',
            decimals: 6,
            address: '0x000000000000000000000000000000000000dEaD',
          },
        }
  const { clientSecret } = await openramp.sessions.create(input)
  return clientSecret
}
