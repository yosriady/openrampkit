// Test helpers for the client package: fixtures, a fake client and the real server with the mock adapter.
// Not part of the build (tsup bundles src/index.ts only) and excluded from coverage.

import { vi } from 'vitest'
import { mockAdapter } from '@openrampkit/adapter-mock'
import type { MockOptions } from '@openrampkit/adapter-mock'
import { USDC } from '@openrampkit/core'
import type { Destination, MethodOption, OpenRampError, PlanResult, PublicSession, Quote, Step } from '@openrampkit/core'
import { createOpenRamp } from '@openrampkit/server'
import type { OpenRampConfig } from '@openrampkit/server'
import { createOpenRampClient } from './client.js'
import type { OpenRampClient } from './client.js'

export const BASE = 'http://localhost/api/openramp'
export const SECRET = 'test-secret-test-secret-test-secret-123'
export const BEEF = '0x000000000000000000000000000000000000beef'
export const BASE_DEST: Destination = { type: 'crypto', chain: 'eip155:8453', token: USDC['eip155:8453']!, address: BEEF }
/** Withdraw source: USDC on Base in the user's wallet */
export const BASE_SOURCE = { chain: 'eip155:8453', token: USDC['eip155:8453']!, custody: 'user_wallet' as const }

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function waitFor(fn: () => boolean, ms = 8000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('waitFor: timeout')
    await sleep(10)
  }
}

// ---------- fixtures ----------

export function step(p: Partial<Step> & { state: Step['state'] }): Step {
  return { sessionId: 'ors_1', transitions: [], ...p }
}

export function session(s: Step | Step['state'], extra: Partial<PublicSession> = {}): PublicSession {
  return {
    id: 'ors_1',
    direction: 'deposit',
    destination: BASE_DEST,
    status: 'open',
    currency: 'USD',
    step: typeof s === 'string' ? step({ state: s }) : s,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    livemode: false,
    ...extra,
  }
}

export function method(p: Partial<MethodOption> & { method: string }): MethodOption {
  return {
    name: p.method,
    kind: 'card',
    group: 'recommended',
    providers: ['Test provider'],
    pathwayIds: [`pw_${p.method}`],
    eta: { min: 60, max: 300 },
    ...p,
  }
}

export const METHODS: MethodOption[] = [
  method({ method: 'wallet', name: 'Wallet', kind: 'crypto', group: 'connected' }),
  method({ method: 'transfer', name: 'Transfer crypto', kind: 'crypto', group: 'more' }),
  method({ method: 'card', name: 'Card', kind: 'card', group: 'recommended', limits: { min: '10', max: '20000', currency: 'USD' } }),
  method({
    method: 'pix',
    name: 'Pix',
    kind: 'local',
    group: 'unavailable',
    reason: { code: 'REGION_UNSUPPORTED', message: 'Not in your region.', retryable: false },
  }),
]

export function plan(methods: MethodOption[] = METHODS, currency = 'USD'): PlanResult {
  return { pathways: [], methods, currency }
}

export function quote(p: Partial<Quote> & { id: string }): Quote {
  return {
    pathwayId: 'pw',
    method: 'card',
    provider: 'Test provider',
    legs: [],
    input: { value: '100', asset: { kind: 'fiat', currency: 'USD' } },
    output: { value: '97.5', asset: { kind: 'crypto', chain: 'eip155:8453', token: USDC['eip155:8453']!, symbol: 'USDC', decimals: 6 } },
    fees: [{ kind: 'provider', label: 'Fee', amount: '2.5', currency: 'USD' }],
    eta: { min: 60, max: 300 },
    ...p,
  }
}

export const POLL = { intervalMs: 1000, backoff: 2, maxIntervalMs: 4000, giveUpAfterMs: 20_000 }

/** A client whose methods are `vi.fn()`s with sensible defaults. Override any of them per test. */
export function fakeClient(over: Partial<{ [K in keyof OpenRampClient]: OpenRampClient[K] }> = {}) {
  const c = {
    baseUrl: BASE,
    getSession: vi.fn(async () => session('SELECT_METHOD')),
    plan: vi.fn(async () => plan()),
    quotes: vi.fn(async () => ({ quotes: [quote({ id: 'q1' }), quote({ id: 'q2', provider: 'Other' })], errors: [] as OpenRampError[] })),
    select: vi.fn(async () => session(step({ state: 'PAYMENT', surface: { kind: 'REDIRECT', url: 'https://pay.example/x', popup: true } }))),
    transition: vi.fn(async () => session(step({ state: 'PROCESSING' }))),
    step: vi.fn(async () => session(step({ state: 'PROCESSING' }))),
    ...over,
  }
  return c as unknown as OpenRampClient & { [K in Exclude<keyof OpenRampClient, 'baseUrl'>]: ReturnType<typeof vi.fn> }
}

// ---------- real server ----------

/** The real server handler with the mock adapter, reached through an in-process `fetch`. */
export function setupServer(mock: MockOptions = { settleMs: 0, crypto: true, bridge: true, offramp: true }, config: Partial<OpenRampConfig> = {}) {
  const ramp = createOpenRamp({
    secret: SECRET,
    baseUrl: BASE,
    adapters: [mockAdapter(mock)],
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...config,
  })
  const requests: Request[] = []
  const fetchToHandler: typeof fetch = async (input, init) => {
    const req = new Request(String(input), init)
    requests.push(req.clone())
    return ramp.handle(req)
  }
  const client = createOpenRampClient({ baseUrl: BASE, fetch: fetchToHandler })
  return { ramp, client, fetch: fetchToHandler, requests }
}
