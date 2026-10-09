// Regression tests for the security review: body limits, input checks, idempotency scope, session
// deadline, unsafe surface URLs, secret lengths and the treasury double-send guard.
import { describe, expect, it, vi } from 'vitest'
import { createAdapter } from '@openrampkit/adapter'
import type { Adapter } from '@openrampkit/adapter'
import { mockAdapter } from '@openrampkit/adapter-mock'
import { USDC, timingSafeEqual } from '@openrampkit/core'
import type { LegSpec, Surface } from '@openrampkit/core'
import { safeEqual } from './crypto.js'
import { createOpenRamp } from './index.js'
import type { OpenRampConfig, TreasurySendInput } from './index.js'

const BASE = 'https://app.test/api/openramp'
const SECRET = 's'.repeat(40)
const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const DEST = { type: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']!, address: '0x000000000000000000000000000000000000beef' }

function make(extra: Partial<OpenRampConfig> = {}, adapters: Adapter[] = [mockAdapter({ settleMs: 0, crypto: true })]) {
  const ramp = createOpenRamp({ secret: SECRET, baseUrl: BASE, adapters, logger: quiet, ...extra })
  const call = (path: string, init: RequestInit & { secret?: string } = {}) => {
    const headers = new Headers(init.headers)
    if (init.secret) headers.set('authorization', `Bearer ${init.secret}`)
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
    return ramp.handle(new Request(`${BASE}${path}`, { ...init, headers }))
  }
  return { ramp, call }
}

const post = (secret: string, body: unknown, headers: Record<string, string> = {}) => ({ method: 'POST', secret, body: JSON.stringify(body), headers })

/** An adapter with one card leg whose start() returns `surface`. */
function surfaceAdapter(surface: Surface): Adapter {
  const spec: LegSpec = {
    id: 'pay', kind: 'fiat_onramp', methods: ['card'],
    from: { asset: { kind: 'fiat', currencies: '*' }, location: ['user_account'] },
    to: { asset: { kind: 'crypto', chains: { 'eip155:8453': [USDC['eip155:8453']!] } }, location: ['address'] },
    regions: { allow: ['*'], deny: [] }, eta: { min: 1, max: 2 }, surfaces: [surface.kind],
  }
  return createAdapter({
    id: 'surf', name: 'Surf', legs: [spec],
    async quote({ leg, amountIn }) {
      return { adapterId: 'surf', legId: leg.legId, input: amountIn!, output: { value: '9', asset: leg.to.asset }, fees: [], eta: { min: 1, max: 2 } }
    },
    async start() {
      return { state: 'PAYMENT', status: 'awaiting_user', ref: `r-${Math.random()}`, surface, transitions: [{ name: 'poll', kind: 'AWAIT', poll: { intervalMs: 1000, backoff: 1, maxIntervalMs: 1000, giveUpAfterMs: 60000 } }] }
    },
  })
}

async function selectWith(adapter: Adapter, livemode = false) {
  const { ramp, call } = make({ livemode }, [adapter])
  const s = await ramp.sessions.create({ userId: 'u', country: 'SG', destination: DEST })
  await call(`/sessions/${s.id}/plan`, post(s.clientSecret, { surfaces: ['REDIRECT', 'IFRAME', 'DEEPLINK', 'PROVIDER_SDK'] }))
  const q = await (await call(`/sessions/${s.id}/quotes`, post(s.clientSecret, { method: 'card', amount: '10' }))).json()
  return (await call(`/sessions/${s.id}/select`, post(s.clientSecret, { quoteId: q.quotes[0].id }))).json()
}

describe('constant-time compare', () => {
  it('the server uses the one implementation from core', () => {
    expect(safeEqual).toBe(timingSafeEqual)
  })
})

describe('config: secret lengths', () => {
  it('refuses a short webhooks.secret and a short tasksToken', () => {
    const base = { secret: SECRET, baseUrl: BASE, adapters: [] }
    expect(() => createOpenRamp({ ...base, webhooks: { url: 'https://app.test/h', secret: '' } })).toThrow(/webhooks.secret/)
    expect(() => createOpenRamp({ ...base, webhooks: { url: 'https://app.test/h', secret: 'short' } })).toThrow(/webhooks.secret/)
    expect(() => createOpenRamp({ ...base, tasksToken: 'short' })).toThrow(/tasksToken/)
    expect(() => createOpenRamp({ ...base, tasksToken: 't'.repeat(16), webhooks: { url: 'https://app.test/h', secret: 'w'.repeat(16) } })).not.toThrow()
  })
})

describe('body size limits', () => {
  it('answers 413 for a JSON body over 64 KiB and a webhook body over 1 MiB', async () => {
    const { ramp, call } = make()
    const s = await ramp.sessions.create({ userId: 'u', destination: DEST })
    const big = JSON.stringify({ pad: 'x'.repeat(70 * 1024) })
    const r = await call(`/sessions/${s.id}/plan`, { method: 'POST', secret: s.clientSecret, body: big })
    expect(r.status).toBe(413)
    // A body without Content-Length (a stream) is counted as it arrives.
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close() } })
    const streamed = await ramp.handle(
      new Request(`${BASE}/sessions/${s.id}/plan`, { method: 'POST', body: stream, headers: { authorization: `Bearer ${s.clientSecret}` }, duplex: 'half' } as RequestInit),
    )
    expect(streamed.status).toBe(413)
    const hooked = createAdapter({ ...mockAdapter(), id: 'hooked', webhook: { verify: async () => true, parse: async () => [] } })
    const h = make({}, [hooked])
    expect((await h.call('/webhooks/hooked', { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) })).status).toBe(413)
    expect((await h.call('/webhooks/hooked', { method: 'POST', body: '{}' })).status).toBe(200)
  })
})

describe('session input checks', () => {
  it('checks userId, metadata, ttlMinutes, country, amountBounds and the destination', async () => {
    const { ramp } = make()
    const bad = [
      { userId: '' },
      { userId: 'u'.repeat(257) },
      { ttlMinutes: 0 },
      { ttlMinutes: 60 * 24 * 8 },
      { metadata: { k: 'v'.repeat(501) } },
      { metadata: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, 'v'])) },
      { metadata: { k: 1 } },
      { country: 'Vietnam' },
      { amountBounds: { currency: 'USD', max: '1e9' } },
      { destination: { ...DEST, address: 'not-an-address' } },
      { destination: { ...DEST, address: '0x0000000000000000000000000000000000000000' } },
      { destination: { ...DEST, chain: 'base' } },
      { destination: { type: 'merchant', currency: 'pesos' } },
    ]
    for (const b of bad) {
      await expect(ramp.sessions.create({ userId: 'u', destination: DEST, ...b } as never)).rejects.toMatchObject({ status: 400 })
    }
    await expect(ramp.sessions.create({ userId: 'u', destination: DEST, metadata: { order: 'o1' }, ttlMinutes: 60, country: 'vn' })).resolves.toMatchObject({ id: expect.any(String) })
  })

  it('checks the quotes body and wallet addresses from the browser', async () => {
    const { ramp, call } = make()
    const s = await ramp.sessions.create({ userId: 'u', country: 'SG', destination: DEST })
    for (const body of [
      { method: 'card', amount: '-1' },
      { method: 'card', amount: '1e3' },
      { method: 'card', amount: ' 10' },
      { method: 'card', amount: '10', amountSide: 'both' },
      { method: 'card', amount: '10', source: { chain: 'eip155:8453', token: 'javascript:1' } },
      { method: 'x'.repeat(65), amount: '10' },
    ]) {
      expect((await call(`/sessions/${s.id}/quotes`, post(s.clientSecret, body))).status).toBe(400)
    }
    expect((await call(`/sessions/${s.id}/plan`, post(s.clientSecret, { walletAddress: 'x'.repeat(200) }))).status).toBe(400)
    expect((await call(`/sessions/${s.id}/plan`, post(s.clientSecret, { walletAddress: { $ne: 1 } }))).status).toBe(400)
    expect((await call(`/sessions/${s.id}/plan`, post(s.clientSecret, { walletAddress: '0x1111111111111111111111111111111111111111' }))).status).toBe(200)
  })

  it('a quote id such as __proto__ is an expired quote, not a 500', async () => {
    const { ramp, call } = make()
    const s = await ramp.sessions.create({ userId: 'u', destination: DEST })
    for (const quoteId of ['__proto__', 'constructor', 'toString']) {
      expect((await call(`/sessions/${s.id}/select`, post(s.clientSecret, { quoteId }))).status).toBe(410)
    }
  })
})

describe('idempotency keys', () => {
  it('are scoped per route, and a key that is not printable ASCII is refused', async () => {
    const { ramp, call } = make()
    const s = await ramp.sessions.create({ userId: 'u', destination: DEST })
    const key = { 'idempotency-key': 'k1' }
    const a = await call(`/sessions/${s.id}/select`, post(s.clientSecret, { quoteId: 'nope' }, key))
    expect(a.status).toBe(410)
    // The same key on another route runs that route: it does not replay the select answer.
    const b = await call(`/sessions/${s.id}/transitions/restart`, post(s.clientSecret, {}, key))
    expect(b.status).toBe(200)
    expect(b.headers.get('idempotent-replay')).toBeNull()
    // The same key on the same route replays.
    const c = await call(`/sessions/${s.id}/select`, post(s.clientSecret, { quoteId: 'nope' }, key))
    expect(c.headers.get('idempotent-replay')).toBe('true')
    expect((await call(`/sessions/${s.id}/select`, post(s.clientSecret, { quoteId: 'nope' }, { 'idempotency-key': 'x'.repeat(256) }))).status).toBe(400)
  })
})

describe('session deadline', () => {
  it('past expiresAt, a session cannot quote, select or restart', async () => {
    const { ramp, call } = make()
    const s = await ramp.sessions.create({ userId: 'u', country: 'SG', destination: DEST, ttlMinutes: 1 })
    await call(`/sessions/${s.id}/plan`, post(s.clientSecret, {}))
    const q = await (await call(`/sessions/${s.id}/quotes`, post(s.clientSecret, { method: 'card', amount: '10' }))).json()
    vi.useFakeTimers({ now: Date.now() + 2 * 60_000 })
    try {
      const sel = await call(`/sessions/${s.id}/select`, post(s.clientSecret, { quoteId: q.quotes[0].id }))
      expect(sel.status).toBe(410)
      expect((await sel.json()).error.code).toBe('SESSION_EXPIRED')
      expect((await call(`/sessions/${s.id}/transitions/restart`, post(s.clientSecret, {}))).status).toBe(410)
      expect((await call(`/sessions/${s.id}/quotes`, post(s.clientSecret, { method: 'card', amount: '10' }))).status).toBe(410)
      const pub = await (await call(`/sessions/${s.id}`, { secret: s.clientSecret })).json()
      expect(pub.status).toBe('expired')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('surface URLs from adapters', () => {
  it('a javascript: or data: URL fails the leg and never reaches the client', async () => {
    for (const surface of [
      { kind: 'REDIRECT', url: 'javascript:alert(document.cookie)', popup: true },
      { kind: 'IFRAME', url: 'data:text/html,<script>alert(1)</script>', origin: 'https://p.test' },
      { kind: 'DEEPLINK', url: 'javascript:alert(1)', appName: 'X' },
      { kind: 'PROVIDER_SDK', provider: 'x', params: { redirectUrl: 'javascript:alert(1)' } },
    ] as Surface[]) {
      const pub = await selectWith(surfaceAdapter(surface))
      expect(pub.step.state).toBe('FAILED')
      expect(pub.step.surface).toBeUndefined()
      expect(JSON.stringify(pub)).not.toContain('javascript:')
      expect(JSON.stringify(pub)).not.toContain('data:text')
    }
  })

  it('in live mode a provider redirect must be https; app schemes stay allowed for deep links', async () => {
    expect((await selectWith(surfaceAdapter({ kind: 'REDIRECT', url: 'http://p.test/pay', popup: true }), true)).step.state).toBe('FAILED')
    expect((await selectWith(surfaceAdapter({ kind: 'REDIRECT', url: 'https://p.test/pay', popup: true }), true)).step.surface.url).toMatch(`${BASE}/start/`)
    expect((await selectWith(surfaceAdapter({ kind: 'DEEPLINK', url: 'gcash://pay?x=1', appName: 'GCash' }), true)).step.surface.url).toBe('gcash://pay?x=1')
  })
})

describe('treasury double send', () => {
  it('two selects at the same time send from the treasury once', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const treasury = { address: '0x9999999999999999999999999999999999999999', send: vi.fn(async (_i: TreasurySendInput) => (await gate, { hash: `0x${'ab'.repeat(32)}` })) }
    const { ramp, call } = make({ treasury })
    const s = await ramp.sessions.create({ userId: 'u', direction: 'withdraw', source: { chain: 'eip155:8453', token: USDC['eip155:8453']!, custody: 'app' }, country: 'PH' })
    await call(`/sessions/${s.id}/target`, post(s.clientSecret, { type: 'crypto', chain: 'eip155:42161', token: USDC['eip155:42161']!, address: '0x2222222222222222222222222222222222222222' }))
    const q = await (await call(`/sessions/${s.id}/quotes`, post(s.clientSecret, { method: 'wallet', amount: '30' }))).json()
    const both = Promise.all([0, 1].map(() => call(`/sessions/${s.id}/select`, post(s.clientSecret, { quoteId: q.quotes[0].id }))))
    await new Promise((r) => setTimeout(r, 20))
    release()
    const statuses = (await both).map((r) => r.status).sort()
    expect(treasury.send).toHaveBeenCalledTimes(1)
    expect(statuses).toEqual([200, 409])
  })
})

describe('error messages', () => {
  it('a raw adapter error does not reach the browser', async () => {
    const leaky = createAdapter({ ...mockAdapter(), id: 'leaky', quote: async () => { throw new Error('HTTP 401 from api.provider.test: {"apiKey":"sk_live_123"}') } })
    const { ramp, call } = make({}, [leaky])
    const s = await ramp.sessions.create({ userId: 'u', country: 'SG', destination: DEST })
    await call(`/sessions/${s.id}/plan`, post(s.clientSecret, {}))
    const r = await (await call(`/sessions/${s.id}/quotes`, post(s.clientSecret, { method: 'card', amount: '10' }))).text()
    expect(r).not.toContain('sk_live_123')
  })
})

describe('request bodies without a body stream (Firefox)', () => {
  /** Firefox gives `Request.body` as undefined: only `text()` reads the body. */
  const noStream = (body: string) => {
    const req = new Request('https://app.test/x', { method: 'POST', body })
    Object.defineProperty(req, 'body', { value: undefined })
    return req
  }

  it('reads the body with text(), and still applies the size limit', async () => {
    const { readJson, readText } = await import('./http.js')
    expect(await readJson(noStream('{"a":1}'))).toEqual({ a: 1 })
    await expect(readText(noStream('x'.repeat(20)), 10)).rejects.toMatchObject({ status: 413 })
    const empty = new Request('https://app.test/x')
    expect(await readText(empty, 10)).toBe('')
  })
})
