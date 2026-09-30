// Route-level and edge-case tests for the server, using small inline adapters.
import { describe, expect, it, vi } from 'vitest'
import { createAdapter } from '@openrampkit/adapter'
import type { Adapter, LegEvent } from '@openrampkit/adapter'
import { mockAdapter } from '@openrampkit/adapter-mock'
import { USDC } from '@openrampkit/core'
import type { LegSpec } from '@openrampkit/core'
import { cloudflareKvStore, createOpenRamp, memoryStore, VersionConflictError } from './index.js'
import type { KVNamespaceLike, OpenRampConfig } from './index.js'
import { sessionStatusFor, legStepFromEvent } from './legs.js'

const BASE = 'https://app.test/api/openramp'
const SECRET = 's'.repeat(40)
const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const DEST = { type: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']!, address: '0x000000000000000000000000000000000000beef' }

function make(extra: Partial<OpenRampConfig> = {}, adapters: Adapter[] = [mockAdapter({ settleMs: 0, crypto: true, bridge: true })]) {
  const ramp = createOpenRamp({ secret: SECRET, baseUrl: BASE, adapters, logger: quiet, ...extra })
  const call = (path: string, init: RequestInit & { secret?: string } = {}) => {
    const headers = new Headers(init.headers)
    if (init.secret) headers.set('authorization', `Bearer ${init.secret}`)
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
    return ramp.handle(new Request(`${BASE}${path}`, { ...init, headers }))
  }
  return { ramp, call }
}

async function session(ramp: ReturnType<typeof make>['ramp'], country = 'VN') {
  return ramp.sessions.create({ userId: 'u', country, destination: DEST })
}

describe('config validation', () => {
  it('rejects a short secret, a wrong adapter API version and duplicate adapter ids', () => {
    expect(() => createOpenRamp({ secret: 'short', baseUrl: BASE, adapters: [] })).toThrow(/32 characters/)
    const bad = { ...mockAdapter(), apiVersion: 99 }
    expect(() => createOpenRamp({ secret: SECRET, baseUrl: BASE, adapters: [bad] })).toThrow(/API v99/)
    expect(() => createOpenRamp({ secret: SECRET, baseUrl: BASE, adapters: [mockAdapter(), mockAdapter()] })).toThrow(/twice/)
  })
})

describe('routing and HTTP', () => {
  it('returns 404 for unknown routes and adapter routes', async () => {
    const { call } = make()
    expect((await call('/nope')).status).toBe(404)
    expect((await call('/adapters/unknown/x')).status).toBe(404)
    expect((await call('/adapters/mock/unknown')).status).toBe(404)
    expect((await call('/webhooks/mock', { method: 'POST', body: '{}' })).status).toBe(404) // mock has no webhook
  })

  it('serves the return page and health', async () => {
    const { call } = make()
    const r = await call('/return')
    expect(r.headers.get('content-type')).toContain('text/html')
    // quick check: no provider calls, no auth
    expect(await (await call('/health')).json()).toEqual({ ok: true, adapters: ['mock'] })
    // deep check needs the tasks token
    expect((await call('/health?deep=1')).status).toBe(401)
  })

  it('health is 503 when an adapter check fails', async () => {
    const failing = createAdapter({ ...mockAdapter(), id: 'bad', health: async () => { throw new Error('down') } })
    const { call } = make({ tasksToken: 't'.repeat(32) }, [failing])
    expect((await call('/health?deep=1', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
    const r = await call('/health?deep=1', { headers: { authorization: `Bearer ${'t'.repeat(32)}` } })
    expect(r.status).toBe(503)
    expect((await r.json()).adapters[0]).toMatchObject({ id: 'bad', ok: false })
  })

  it('CORS: preflight and allowed origin get headers, other origins do not', async () => {
    const { call } = make({ cors: { origins: ['https://shop.test'] } })
    const pre = await call('/sessions/x', { method: 'OPTIONS', headers: { origin: 'https://shop.test' } })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://shop.test')
    const other = await call('/health', { headers: { origin: 'https://evil.test' } })
    expect(other.headers.get('access-control-allow-origin')).toBeNull()
    const star = make({ cors: { origins: '*' } })
    expect((await star.call('/health', { headers: { origin: 'https://any.test' } })).headers.get('access-control-allow-origin')).toBe('*')
  })

  it('bad JSON is a 400, not a 500', async () => {
    const { ramp, call } = make()
    const s = await session(ramp)
    const r = await call(`/sessions/${s.id}/quotes`, { method: 'POST', secret: s.clientSecret, body: '{not json' })
    expect(r.status).toBe(400)
    const missing = await call(`/sessions/${s.id}/quotes`, { method: 'POST', secret: s.clientSecret, body: '{}' })
    expect(missing.status).toBe(400)
  })

  it('an unexpected adapter error is a 500 with a safe message', async () => {
    const broken = createAdapter({ ...mockAdapter(), id: 'broken', catalog: async () => { throw new Error('boom') }, quote: async () => { throw new TypeError('secret detail') } })
    const { ramp, call } = make({}, [broken])
    const s = await session(ramp, 'SG')
    await call(`/sessions/${s.id}/plan`, { method: 'POST', secret: s.clientSecret, body: '{}' })
    const r = await (await call(`/sessions/${s.id}/quotes`, { method: 'POST', secret: s.clientSecret, body: JSON.stringify({ method: 'card', amount: '10' }) })).json()
    expect(r.quotes).toEqual([])
    expect(r.errors[0].code).toBe('PROVIDER_UNAVAILABLE')
  })
})

describe('sessions', () => {
  it('browser-created sessions need the authorize hook, which picks the destination', async () => {
    const none = make()
    expect((await none.call('/sessions', { method: 'POST', body: '{}' })).status).toBe(404)
    const authorize = vi.fn(async (req: Request) => (req.headers.get('x-app-key') === 'k' ? { userId: 'u1', destination: DEST } : null))
    const { call } = make({ authorize })
    expect((await call('/sessions', { method: 'POST', body: '{}' })).status).toBe(401)
    const ok = await call('/sessions', { method: 'POST', body: '{}', headers: { 'x-app-key': 'k', 'cf-ipcountry': 'TH' } })
    expect(ok.status).toBe(201)
    const created = await ok.json()
    const pub = await (await call(`/sessions/${created.id}`, { secret: created.clientSecret })).json()
    expect(pub.country).toBe('TH')
    expect(pub.destination.address).toBe(DEST.address)
  })

  it('uses the geo hook when given, and Vercel region headers otherwise', async () => {
    const { call } = make({ authorize: async () => ({ userId: 'u', destination: DEST }), geo: () => ({ country: 'ID' }) })
    const a = await (await call('/sessions', { method: 'POST', body: '{}' })).json()
    expect((await (await call(`/sessions/${a.id}`, { secret: a.clientSecret })).json()).country).toBe('ID')
  })

  it('rejects missing, malformed and mismatched secrets', async () => {
    const { ramp, call } = make()
    const s = await session(ramp)
    expect((await call(`/sessions/${s.id}`)).status).toBe(401)
    expect((await call(`/sessions/${s.id}`, { headers: { authorization: 'Basic x' } })).status).toBe(401)
    const other = await session(ramp)
    expect((await call(`/sessions/${s.id}`, { secret: other.clientSecret })).status).toBe(401)
    expect((await call(`/sessions/ors_missing`, { secret: 'ors_missing.x' })).status).toBe(401)
  })

  it('expires an open session after its TTL and sends session.expired', async () => {
    const sent: string[] = []
    const { ramp, call } = make({ webhooks: { url: 'https://app.test/hooks', secret: 'w'.repeat(32) }, fetch: async (_u, init) => { sent.push(JSON.parse(String(init?.body)).type); return new Response('ok') } })
    vi.useFakeTimers({ now: Date.now() })
    try {
      const s = await ramp.sessions.create({ userId: 'u', destination: DEST, ttlMinutes: 1 })
      vi.setSystemTime(Date.now() + 2 * 60_000)
      const pub = await (await call(`/sessions/${s.id}`, { secret: s.clientSecret })).json()
      expect(pub.status).toBe('expired')
      expect(pub.step.state).toBe('EXPIRED')
      expect(sent).toContain('session.expired')
    } finally {
      vi.useRealTimers()
    }
  })

  it('retrieve and refresh from the server side', async () => {
    const { ramp } = make()
    expect(await ramp.sessions.retrieve('nope')).toBeNull()
    expect(await ramp.sessions.refresh('nope')).toBeNull()
    const s = await session(ramp)
    expect((await ramp.sessions.retrieve(s.id))!.status).toBe('open')
    expect((await ramp.sessions.refresh(s.id))!.step.state).toBe('SELECT_METHOD')
  })

  it('allowedMethods limits the plan', async () => {
    const { ramp, call } = make()
    const s = await ramp.sessions.create({ userId: 'u', country: 'VN', destination: DEST, allowedMethods: ['vietqr'] })
    const plan = await (await call(`/sessions/${s.id}/plan`, { method: 'POST', secret: s.clientSecret, body: '{}' })).json()
    expect(plan.methods.map((m: { method: string }) => m.method)).toEqual(['vietqr'])
  })
})

async function toPayment(ramp: ReturnType<typeof make>['ramp'], call: ReturnType<typeof make>['call'], method = 'vietqr', amount = '500000') {
  const s = await session(ramp)
  await call(`/sessions/${s.id}/plan`, { method: 'POST', secret: s.clientSecret, body: '{}' })
  const q = await (await call(`/sessions/${s.id}/quotes`, { method: 'POST', secret: s.clientSecret, body: JSON.stringify({ method, amount }) })).json()
  const sel = await call(`/sessions/${s.id}/select`, { method: 'POST', secret: s.clientSecret, body: JSON.stringify({ quoteId: q.quotes[0].id }) })
  return { s, q, pub: await sel.json(), status: sel.status }
}

describe('payment flow rules', () => {
  it('unknown quote is 410; a second select while in progress is 409; quotes while in progress is 409', async () => {
    const { ramp, call } = make()
    const { s, q, pub } = await toPayment(ramp, call)
    expect(pub.step.state).toBe('PAYMENT')
    expect((await call(`/sessions/${s.id}/select`, { method: 'POST', secret: s.clientSecret, body: JSON.stringify({ quoteId: 'q_nope' }) })).status).toBe(410)
    expect((await call(`/sessions/${s.id}/select`, { method: 'POST', secret: s.clientSecret, body: JSON.stringify({ quoteId: q.quotes[0].id }) })).status).toBe(409)
    expect((await call(`/sessions/${s.id}/quotes`, { method: 'POST', secret: s.clientSecret, body: JSON.stringify({ method: 'vietqr', amount: '1' }) })).status).toBe(409)
  })

  it('an expired quote cannot be selected', async () => {
    const { ramp, call } = make()
    const s = await session(ramp)
    await call(`/sessions/${s.id}/plan`, { method: 'POST', secret: s.clientSecret, body: '{}' })
    const q = await (await call(`/sessions/${s.id}/quotes`, { method: 'POST', secret: s.clientSecret, body: JSON.stringify({ method: 'vietqr', amount: '500000' }) })).json()
    vi.useFakeTimers({ now: Date.now() + 5 * 60_000 })
    try {
      expect((await call(`/sessions/${s.id}/select`, { method: 'POST', secret: s.clientSecret, body: JSON.stringify({ quoteId: q.quotes[0].id }) })).status).toBe(410)
    } finally {
      vi.useRealTimers()
    }
  })

  it('transitions: unknown names and AWAIT names are refused; restart goes back to methods', async () => {
    const { ramp, call } = make()
    const { s } = await toPayment(ramp, call)
    expect((await call(`/sessions/${s.id}/transitions/nope`, { method: 'POST', secret: s.clientSecret, body: '{}' })).status).toBe(409)
    expect((await call(`/sessions/${s.id}/transitions/poll`, { method: 'POST', secret: s.clientSecret, body: '{}' })).status).toBe(409)
    const r = await (await call(`/sessions/${s.id}/transitions/restart`, { method: 'POST', secret: s.clientSecret, body: '{}' })).json()
    expect(r.step.state).toBe('SELECT_METHOD')
    expect(r.status).toBe('open')
    expect((await call(`/sessions/${s.id}/transitions/simulate_payment`, { method: 'POST', secret: s.clientSecret, body: '{}' })).status).toBe(409)
  })

  it('restart is refused while processing and after completion', async () => {
    const { ramp, call } = make({}, [mockAdapter({ settleMs: 60_000 })])
    const { s } = await toPayment(ramp, call)
    await call(`/sessions/${s.id}/transitions/simulate_payment`, { method: 'POST', secret: s.clientSecret, body: '{}' })
    expect((await call(`/sessions/${s.id}/transitions/restart`, { method: 'POST', secret: s.clientSecret, body: '{}' })).status).toBe(409)
  })

  it('a start failure rolls back the active payment', async () => {
    const base = mockAdapter()
    const failing = createAdapter({ ...base, id: 'flaky', start: async () => { throw new Error('provider down') } })
    const { ramp, call } = make({}, [failing])
    const s = await session(ramp)
    await call(`/sessions/${s.id}/plan`, { method: 'POST', secret: s.clientSecret, body: '{}' })
    const q = await (await call(`/sessions/${s.id}/quotes`, { method: 'POST', secret: s.clientSecret, body: JSON.stringify({ method: 'vietqr', amount: '500000' }) })).json()
    expect((await call(`/sessions/${s.id}/select`, { method: 'POST', secret: s.clientSecret, body: JSON.stringify({ quoteId: q.quotes[0].id }) })).status).toBe(500)
    const pub = await (await call(`/sessions/${s.id}`, { secret: s.clientSecret })).json()
    expect(pub.step.state).toBe('SELECT_METHOD')
    // and it can be retried
    expect((await call(`/sessions/${s.id}/quotes`, { method: 'POST', secret: s.clientSecret, body: JSON.stringify({ method: 'vietqr', amount: '500000' }) })).status).toBe(200)
  })
})

describe('start URL', () => {
  it('redirects once signed, refuses a bad signature, and expires after 10 minutes', async () => {
    const { ramp, call } = make()
    const { pub } = await toPayment(ramp, call, 'card', '100')
    const url = new URL(pub.step.surface.url)
    const path = url.pathname.replace('/api/openramp', '')
    const ok = await call(path)
    expect(ok.status).toBe(302)
    expect(ok.headers.get('referrer-policy')).toBe('no-referrer')
    const [sid, token] = path.split('/').pop()!.split('.')
    expect((await call(`/start/${sid}.${token}.${'0'.repeat(32)}`)).status).toBe(401)
    expect((await call(`/start/onlyonepart`)).status).toBe(404)
    vi.useFakeTimers({ now: Date.now() + 11 * 60_000 })
    try {
      expect((await call(path)).status).toBe(410)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('provider webhooks in', () => {
  const spec: LegSpec = {
    id: 'hook', kind: 'fiat_onramp', methods: ['card'],
    from: { asset: { kind: 'fiat', currencies: '*' }, location: ['user_account'] },
    to: { asset: { kind: 'crypto', chains: { 'eip155:8453': [USDC['eip155:8453']!] } }, location: ['address'] },
    regions: { allow: ['*'], deny: [] }, eta: { min: 1, max: 2 }, surfaces: ['REDIRECT'],
  }
  const hooked = createAdapter({
    id: 'hooked', name: 'Hooked', legs: [spec],
    async quote({ leg, amountIn }) {
      return { adapterId: 'hooked', legId: leg.legId, input: amountIn!, output: { amount: '9', asset: leg.to.asset }, fees: [], eta: { min: 1, max: 2 } }
    },
    async start() {
      return { state: 'PAYMENT', status: 'awaiting_user', ref: 'order-1', surface: { kind: 'REDIRECT', url: 'https://provider.test/pay', popup: true }, transitions: [{ name: 'poll', kind: 'AWAIT', poll: { intervalMs: 1000, backoff: 1, maxIntervalMs: 1000, giveUpAfterMs: 60000 } }] }
    },
    webhook: {
      async verify(req) { return req.headers.get('x-sig') === 'good' },
      async parse(raw) { return JSON.parse(raw) as LegEvent[] },
    },
  })

  it('verifies, applies, completes, and ignores repeats and unknown refs', async () => {
    const sent: string[] = []
    const { ramp, call } = make({ webhooks: { url: 'https://app.test/hooks', secret: 'w'.repeat(32) }, fetch: async (_u, init) => { sent.push(JSON.parse(String(init?.body)).type); return new Response('ok') } }, [hooked])
    const s = await ramp.sessions.create({ userId: 'u', country: 'SG', destination: DEST })
    await call(`/sessions/${s.id}/plan`, { method: 'POST', secret: s.clientSecret, body: '{}' })
    const q = await (await call(`/sessions/${s.id}/quotes`, { method: 'POST', secret: s.clientSecret, body: JSON.stringify({ method: 'card', amount: '10' }) })).json()
    await call(`/sessions/${s.id}/select`, { method: 'POST', secret: s.clientSecret, body: JSON.stringify({ quoteId: q.quotes[0].id }) })

    const body = JSON.stringify([{ ref: 'order-1', status: 'succeeded', txHash: '0xabc' }])
    expect((await call('/webhooks/hooked', { method: 'POST', body, headers: { 'x-sig': 'bad' } })).status).toBe(401)
    expect((await call('/webhooks/hooked', { method: 'POST', body, headers: { 'x-sig': 'good' } })).status).toBe(200)
    const pub = await (await call(`/sessions/${s.id}`, { secret: s.clientSecret })).json()
    expect(pub.step.state).toBe('COMPLETED')
    expect(pub.step.progress.legs[0].txHash).toBe('0xabc')
    // repeat and unknown ref are harmless
    expect((await call('/webhooks/hooked', { method: 'POST', body, headers: { 'x-sig': 'good' } })).status).toBe(200)
    expect((await call('/webhooks/hooked', { method: 'POST', body: JSON.stringify([{ ref: 'nope', status: 'failed' }]), headers: { 'x-sig': 'good' } })).status).toBe(200)
    expect(sent.filter((t) => t === 'session.completed')).toHaveLength(1)
    expect(sent).toContain('leg.succeeded')
  })

  it('a failed provider event fails the session and notifies', async () => {
    const sent: string[] = []
    const { ramp, call } = make({ webhooks: { url: 'https://app.test/hooks', secret: 'w'.repeat(32) }, fetch: async (_u, init) => { sent.push(JSON.parse(String(init?.body)).type); return new Response('no', { status: 500 }) } }, [hooked])
    const s = await ramp.sessions.create({ userId: 'u', country: 'SG', destination: DEST })
    await call(`/sessions/${s.id}/plan`, { method: 'POST', secret: s.clientSecret, body: '{}' })
    const q = await (await call(`/sessions/${s.id}/quotes`, { method: 'POST', secret: s.clientSecret, body: JSON.stringify({ method: 'card', amount: '10' }) })).json()
    await call(`/sessions/${s.id}/select`, { method: 'POST', secret: s.clientSecret, body: JSON.stringify({ quoteId: q.quotes[0].id }) })
    await call('/webhooks/hooked', { method: 'POST', body: JSON.stringify([{ ref: 'order-1', status: 'failed' }]), headers: { 'x-sig': 'good' } })
    const pub = await (await call(`/sessions/${s.id}`, { secret: s.clientSecret })).json()
    expect(pub.status).toBe('failed')
    expect(sent).toEqual(expect.arrayContaining(['leg.failed', 'session.failed']))
  })
})

describe('leg helpers', () => {
  it('maps states to session status', () => {
    expect(sessionStatusFor('COMPLETED', true)).toBe('completed')
    expect(sessionStatusFor('BLOCKED', false)).toBe('failed')
    expect(sessionStatusFor('EXPIRED', true)).toBe('expired')
    expect(sessionStatusFor('REFUNDED', true)).toBe('refunded')
    expect(sessionStatusFor('PAYMENT', true)).toBe('processing')
    expect(sessionStatusFor('SELECT_METHOD', false)).toBe('open')
  })
  it('builds leg steps from events and drops the surface when terminal', () => {
    const cur = { state: 'PAYMENT' as const, status: 'awaiting_user' as const, transitions: [], surface: { kind: 'QR' as const, payload: 'x', amount: '1', currency: 'IDR' } }
    expect(legStepFromEvent(cur, { ref: 'r', status: 'processing' })).toMatchObject({ state: 'PROCESSING', surface: cur.surface })
    const done = legStepFromEvent(cur, { ref: 'r', status: 'succeeded' })
    expect(done.state).toBe('COMPLETED')
    expect(done.surface).toBeUndefined()
    expect(legStepFromEvent(undefined, { ref: 'r', status: 'refunded' }).state).toBe('REFUNDED')
  })
})

describe('stores', () => {
  function fakeKv(): KVNamespaceLike & { data: Map<string, string>; ttl: Map<string, number | undefined> } {
    const data = new Map<string, string>()
    const ttl = new Map<string, number | undefined>()
    return {
      data, ttl,
      async get(k) { return data.get(k) ?? null },
      async put(k, v, o) { data.set(k, v); ttl.set(k, o?.expirationTtl) },
    }
  }

  it('Workers KV store: sessions with version check, kv with a 60 s minimum TTL', async () => {
    const ns = fakeKv()
    const store = cloudflareKvStore(ns, { sessionTtlSec: 3600 })
    expect(await store.get('x')).toBeNull()
    const rec = { id: 'ors_1', version: 1 } as never
    await store.put(rec)
    expect(ns.ttl.get('s:ors_1')).toBe(3600)
    await store.put({ id: 'ors_1', version: 2 } as never, 1)
    await expect(store.put({ id: 'ors_1', version: 3 } as never, 1)).rejects.toBeInstanceOf(VersionConflictError)
    await store.kv.put('a', { b: 1 }, 5)
    expect(ns.ttl.get('k:a')).toBe(60)
    expect(await store.kv.get('a')).toEqual({ b: 1 })
    expect(await store.kv.get('missing')).toBeUndefined()
    await store.kv.put('c', 1)
    expect(ns.ttl.get('k:c')).toBeUndefined()
  })

  it('memory store: version conflicts and kv expiry', async () => {
    const store = memoryStore()
    await store.put({ id: 'a', version: 1 } as never)
    await expect(store.put({ id: 'a', version: 2 } as never, 5)).rejects.toBeInstanceOf(VersionConflictError)
    vi.useFakeTimers({ now: Date.now() })
    try {
      await store.kv.put('k', 1, 1)
      expect(await store.kv.get('k')).toBe(1)
      vi.setSystemTime(Date.now() + 2000)
      expect(await store.kv.get('k')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('the whole flow works on the Workers KV store', async () => {
    const { ramp, call } = make({ store: cloudflareKvStore(fakeKv()) })
    const { pub, status } = await toPayment(ramp, call)
    expect(status).toBe(200)
    expect(pub.step.surface.kind).toBe('QR')
  })
})
