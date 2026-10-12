// Orchestration: provider health counts, the success rate as the ranking tie break, the circuit
// breaker (open, cool-down, half-open probe, off switches), failover at start, and the admin view.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAdapter } from '@openrampkit/adapter'
import type { LegEvent } from '@openrampkit/adapter'
import { OpenRampException, USDC, openRampError } from '@openrampkit/core'
import type { LegSpec, LegStep } from '@openrampkit/core'
import { createOpenRamp, memoryStore } from './index.js'
import type { OpenRampConfig, SessionStore } from './index.js'
import { createRuntime } from './runtime.js'
import { canFailOver, isProviderFailure, recordHealth, recordLegOutcome } from './health.js'
import type { HealthCounts } from './health.js'

const BASE = 'https://app.test/api/openramp'
const TOKEN = 'admin-token-'.padEnd(40, 'x')
const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const DEST = { type: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']!, address: '0x000000000000000000000000000000000000beef' }
const poll = [{ name: 'poll', kind: 'AWAIT' as const, poll: { intervalMs: 1000, backoff: 1, maxIntervalMs: 1000, giveUpAfterMs: 60000 } }]

type Behavior = 'ok' | 'unavailable' | 'amount_too_low' | 'hang' | 'bad_request' | 'timeout' | 'raw'

/** A card provider. `quoteMode` and `startMode` decide each call; the counters show what was called. */
function cardAdapter(id: string, opts: { output?: string; eta?: number; expiresInMs?: number } = {}) {
  const ctl = { quoteMode: 'ok' as Behavior, startMode: 'ok' as Behavior | 'failed_step', quotes: 0, starts: 0 }
  let n = 0
  const spec: LegSpec = {
    id: 'card', kind: 'fiat_onramp', methods: ['card'],
    from: { asset: { kind: 'fiat', currencies: '*' }, location: ['user_account'] },
    to: { asset: { kind: 'crypto', chains: { 'eip155:8453': [USDC['eip155:8453']!] } }, location: ['address'] },
    regions: { allow: ['*'], deny: [] }, eta: { min: 1, max: opts.eta ?? 60 }, surfaces: ['REDIRECT'],
  }
  const fail = (mode: Behavior): Promise<never> => {
    if (mode === 'hang') return new Promise<never>(() => {})
    if (mode === 'amount_too_low') throw new OpenRampException(openRampError('AMOUNT_TOO_LOW'), 422)
    if (mode === 'bad_request') throw new OpenRampException(openRampError('BAD_REQUEST'), 400)
    if (mode === 'timeout') throw new Error('Timed out after 4000 ms')
    if (mode === 'raw') throw new Error('something odd')
    throw new OpenRampException(openRampError('PROVIDER_UNAVAILABLE'), 502)
  }
  const adapter = createAdapter({
    id, name: id.toUpperCase(), legs: [spec],
    async quote({ leg, amountIn }) {
      ctl.quotes++
      if (ctl.quoteMode !== 'ok') return fail(ctl.quoteMode)
      return {
        adapterId: id, legId: leg.legId, input: { value: amountIn!.value, asset: { kind: 'fiat', currency: 'SGD' } },
        output: { value: opts.output ?? '9', asset: leg.to.asset }, fees: [], eta: { min: 1, max: opts.eta ?? 60 }, guarantee: 'estimate' as const,
        expiresAt: new Date(Date.now() + (opts.expiresInMs ?? 3_600_000)).toISOString(),
      }
    },
    async start(): Promise<LegStep> {
      ctl.starts++
      if (ctl.startMode === 'failed_step') return { status: 'failed', ref: `${id}-${++n}`, error: openRampError('PROVIDER_UNAVAILABLE') }
      if (ctl.startMode !== 'ok') return fail(ctl.startMode)
      return { status: 'requires_action', ref: `${id}-${++n}`, action: { kind: 'payment', surface: { kind: 'REDIRECT', url: 'https://provider.test/pay', popup: true }, transitions: poll } }
    },
    async status({ ref }) {
      return { status: 'requires_action', ref, action: { kind: 'payment', transitions: poll } }
    },
    webhook: {
      async verify() {
        return true
      },
      async parse(raw) {
        return JSON.parse(raw) as LegEvent[]
      },
    },
  })
  return { adapter, ctl }
}

function make(adapters: ReturnType<typeof cardAdapter>[], extra: Partial<OpenRampConfig> = {}) {
  const store: SessionStore = extra.store ?? memoryStore()
  const metrics: Array<{ name: string; tags: Record<string, string> }> = []
  const config: OpenRampConfig = {
    secret: 's'.repeat(40), baseUrl: BASE, adapters: adapters.map((a) => a.adapter), logger: quiet, store,
    admin: { token: TOKEN }, telemetry: { onMetric: (name, _v, tags) => void metrics.push({ name, tags }) }, ...extra,
  }
  const ramp = createOpenRamp(config)
  // A second runtime on the same store, to write health counts directly.
  const rt = createRuntime(config)
  const call = (path: string, init: RequestInit & { secret?: string } = {}) => {
    const headers = new Headers(init.headers)
    if (init.secret) headers.set('authorization', `Bearer ${init.secret}`)
    if (init.body) headers.set('content-type', 'application/json')
    return ramp.handle(new Request(`${BASE}${path}`, { ...init, headers }))
  }
  const post = (path: string, secret: string, body: unknown = {}) => call(path, { method: 'POST', secret, body: JSON.stringify(body) })
  async function session() {
    const s = await ramp.sessions.create({ userId: 'u', country: 'SG', destination: DEST })
    await post(`/sessions/${s.id}/plan`, s.clientSecret)
    return s
  }
  async function quote(s: { id: string; clientSecret: string }, amount = '10') {
    return (await (await post(`/sessions/${s.id}/quotes`, s.clientSecret, { method: 'card', amount })).json()) as {
      quotes: Array<{ id: string; provider: string; legs: Array<{ adapterId: string }> }>
      errors: Array<{ code: string; message: string }>
    }
  }
  const health = async (id: string) => (await ramp.admin.providers()).find((p) => p.adapterId === id)!
  /** Write counts for an adapter in the current hour */
  const seed = (id: string, c: Partial<HealthCounts>) => recordHealth(rt, id, c)
  return { ramp, rt, store, call, post, session, quote, health, seed, metrics }
}

afterEach(() => vi.useRealTimers())

describe('provider health counts', () => {
  it('counts quote and start outcomes, and leg results; business errors are not failures', async () => {
    const a = cardAdapter('a', { output: '9' })
    const b = cardAdapter('b', { output: '8' })
    const t = make([a, b], { timeouts: { quote: 50 } })
    const s = await t.session()
    b.ctl.quoteMode = 'amount_too_low'
    await t.quote(s)
    expect((await t.health('a')).counts).toMatchObject({ quoteOk: 1, quoteFail: 0 })
    // AMOUNT_TOO_LOW is an answer from a working provider.
    expect((await t.health('b')).counts).toMatchObject({ quoteOk: 0, quoteFail: 0 })

    b.ctl.quoteMode = 'unavailable'
    await t.quote(s)
    b.ctl.quoteMode = 'hang'
    const r = await t.quote(s)
    expect(r.errors.map((e) => e.code)).toEqual(['PROVIDER_UNAVAILABLE'])
    // One session counts one quote failure per adapter: its browser cannot open the breaker for everyone.
    expect((await t.health('b')).counts).toMatchObject({ quoteOk: 0, quoteFail: 1 })
    // A timeout in another session is a failure too.
    await t.quote(await t.session())
    expect((await t.health('b')).counts).toMatchObject({ quoteOk: 0, quoteFail: 2 })

    const pub = await (await t.post(`/sessions/${s.id}/select`, s.clientSecret, { quoteId: r.quotes[0]!.id })).json()
    expect(pub.step.state).toBe('PAYMENT')
    expect((await t.health('a')).counts).toMatchObject({ quoteOk: 4, startOk: 1 })
    await t.call('/webhooks/a', { method: 'POST', body: JSON.stringify([{ ref: 'a-1', status: 'succeeded', eventId: 'e1' }]) })
    expect((await t.health('a')).counts.legSucceeded).toBe(1)
  })

  it('a leg that fails because of the user is not a provider failure; a provider failure counts once', async () => {
    const a = cardAdapter('a', { output: '9' })
    const t = make([a])
    const pay = async () => {
      const s = await t.session()
      const r = await t.quote(s)
      await t.post(`/sessions/${s.id}/select`, s.clientSecret, { quoteId: r.quotes[0]!.id })
      return s
    }
    await pay() // a-1
    await t.call('/webhooks/a', { method: 'POST', body: JSON.stringify([{ ref: 'a-1', status: 'failed', error: openRampError('PAYMENT_FAILED'), eventId: 'u1' }]) })
    expect((await t.health('a')).counts.legFailed).toBe(0)
    await pay() // a-2
    await t.call('/webhooks/a', { method: 'POST', body: JSON.stringify([{ ref: 'a-2', status: 'failed', error: openRampError('KYC_REJECTED'), eventId: 'u2' }]) })
    expect((await t.health('a')).counts.legFailed).toBe(0)
    await pay() // a-3
    const fail = { ref: 'a-3', status: 'failed', error: openRampError('DELIVERY_FAILED') }
    await t.call('/webhooks/a', { method: 'POST', body: JSON.stringify([{ ...fail, eventId: 'p1' }]) })
    // The same outcome again (another event id) does not count twice
    await t.call('/webhooks/a', { method: 'POST', body: JSON.stringify([{ ...fail, eventId: 'p2' }]) })
    expect((await t.health('a')).counts.legFailed).toBe(1)
  })

  it('recordLegOutcome counts one leg once, as a retried save would call it again', async () => {
    const t = make([cardAdapter('a')])
    const ids = { sessionId: 'ors_x', attempt: 0, index: 0, adapterId: 'a' }
    await recordLegOutcome(t.rt, ids, 'succeeded')
    await recordLegOutcome(t.rt, ids, 'succeeded')
    await recordLegOutcome(t.rt, { ...ids, attempt: 1 }, 'failed')
    await recordLegOutcome(t.rt, { ...ids, attempt: 2 }, 'failed', openRampError('PAYMENT_FAILED'))
    expect((await t.health('a')).counts).toMatchObject({ legSucceeded: 1, legFailed: 1 })
  })

  it('parallel quote requests of one session count one failure per adapter', async () => {
    const a = cardAdapter('a', { output: '9' })
    const b = cardAdapter('b', { output: '8' })
    b.ctl.quoteMode = 'unavailable'
    const t = make([a, b])
    const s = await t.session()
    await Promise.all([t.quote(s, '10'), t.quote(s, '11'), t.quote(s, '12'), t.quote(s, '13')])
    expect((await t.health('b')).counts.quoteFail).toBe(1)
  })

  it('keeps hourly buckets for the window only', async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
    const t = make([cardAdapter('a')], { routing: { healthWindowHours: 3 } })
    await t.seed('a', { quoteOk: 5 })
    vi.setSystemTime(Date.now() + 60 * 60_000)
    await t.seed('a', { quoteOk: 2, quoteFail: 1 })
    expect((await t.health('a')).counts).toMatchObject({ quoteOk: 7, quoteFail: 1 })
    vi.setSystemTime(Date.now() + 2 * 60 * 60_000)
    // The first hour left the 3 hour window.
    expect((await t.health('a')).counts).toMatchObject({ quoteOk: 2, quoteFail: 1 })
    vi.setSystemTime(Date.now() + 3 * 60 * 60_000)
    expect((await t.health('a')).counts).toMatchObject({ quoteOk: 0, quoteFail: 0 })
  })

  it('a store that fails health reads and writes never fails a request', async () => {
    const inner = memoryStore()
    const broken = (k: string) => k.startsWith('health:')
    const store: SessionStore = {
      ...inner,
      kv: {
        get: async (k) => (broken(k) ? Promise.reject(new Error('kv down')) : inner.kv.get(k)),
        put: async (k, v, ttl) => (broken(k) ? Promise.reject(new Error('kv down')) : inner.kv.put(k, v, ttl)),
        putIfAbsent: async (k, v, ttl) => (broken(k) ? Promise.reject(new Error('kv down')) : inner.kv.putIfAbsent!(k, v, ttl)),
      },
    }
    const a = cardAdapter('a')
    const t = make([a, cardAdapter('b', { output: '8' })], { store })
    const s = await t.session()
    const r = await t.quote(s)
    expect(r.quotes).toHaveLength(2)
    const res = await t.post(`/sessions/${s.id}/select`, s.clientSecret, { quoteId: r.quotes[0]!.id })
    expect(res.status).toBe(200)
    expect((await t.health('a')).counts.quoteOk).toBe(0)
  })

  it('classifies errors for health and failover', () => {
    expect(isProviderFailure(new OpenRampException(openRampError('NO_QUOTES')))).toBe(false)
    expect(isProviderFailure(new OpenRampException(openRampError('RATE_LIMITED')))).toBe(true)
    expect(isProviderFailure(new Error('boom'))).toBe(true)
    // PROVIDER_UNAVAILABLE fails over even when not retryable (a setup error at one provider).
    expect(canFailOver(new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { retryable: false })))).toBe(true)
    expect(canFailOver(new OpenRampException(openRampError('INTERNAL')))).toBe(true)
    expect(canFailOver(new OpenRampException(openRampError('PROVIDER_ERROR')))).toBe(false)
    expect(canFailOver(new OpenRampException(openRampError('AMOUNT_TOO_LOW', { retryable: true })))).toBe(false)
    expect(canFailOver(new OpenRampException(openRampError('KYC_REJECTED')))).toBe(false)
    // A timeout never fails over: the provider may have made the order.
    expect(canFailOver(new Error('Timed out after 50 ms'))).toBe(false)
    expect(canFailOver(Object.assign(new Error('x'), { timeout: true }))).toBe(false)
    expect(canFailOver(new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message: 'X did not answer in time.' }), 504))).toBe(false)
    expect(canFailOver(new Error('boom'))).toBe(false)
  })
})

describe('ranking by recent success rate', () => {
  it('breaks a tie of output and ETA by success rate; output and ETA still come first', async () => {
    const a = cardAdapter('a')
    const b = cardAdapter('b')
    const t = make([a, b])
    const s = await t.session()
    // Planner order first when there is no data.
    expect((await t.quote(s)).quotes.map((q) => q.legs[0]!.adapterId)).toEqual(['a', 'b'])
    await t.seed('a', { startOk: 10, startFail: 10 })
    await t.seed('b', { startOk: 19, legSucceeded: 5, legFailed: 1 })
    expect((await t.quote(s)).quotes.map((q) => q.legs[0]!.adapterId)).toEqual(['b', 'a'])
  })

  it('treats an adapter with too few samples as neutral', async () => {
    const t = make([cardAdapter('a'), cardAdapter('b'), cardAdapter('c')])
    const s = await t.session()
    await t.seed('a', { startOk: 5, startFail: 15 }) // 0.25
    await t.seed('b', { startOk: 3 }) // too few: neutral, the mean of the rated ones (0.6)
    await t.seed('c', { startOk: 19, startFail: 1 }) // 0.95
    expect((await t.quote(s)).quotes.map((q) => q.legs[0]!.adapterId)).toEqual(['c', 'b', 'a'])
  })

  it('never puts a better rate before more output or a faster ETA', async () => {
    const t = make([cardAdapter('a', { output: '9.5' }), cardAdapter('b', { output: '9', eta: 30 }), cardAdapter('c', { output: '9', eta: 60 })])
    const s = await t.session()
    // Leg failures lower the success rate but do not open the breaker.
    await t.seed('a', { legFailed: 30 })
    await t.seed('b', { legFailed: 30 })
    await t.seed('c', { legSucceeded: 30 })
    expect((await t.quote(s)).quotes.map((q) => q.legs[0]!.adapterId)).toEqual(['a', 'b', 'c'])
  })
})

describe('circuit breaker', () => {
  it('skips an adapter that mostly fails, then lets one probe through after the cool-down', async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
    const a = cardAdapter('a')
    const b = cardAdapter('b', { output: '8' })
    const t = make([a, b])
    const s = await t.session()
    await t.seed('a', { quoteOk: 3, quoteFail: 17 }) // 85% of 20
    const r = await t.quote(s)
    expect(a.ctl.quotes).toBe(0)
    expect(r.quotes.map((q) => q.legs[0]!.adapterId)).toEqual(['b'])
    expect(r.errors).toEqual([expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE', message: expect.stringContaining('A') })])
    expect(t.metrics.some((m) => m.name === 'breaker.opened' && m.tags.adapter === 'a')).toBe(true)
    expect((await t.health('a')).breaker.state).toBe('open')

    // Still in the cool-down.
    vi.setSystemTime(Date.now() + 5 * 60_000)
    await t.quote(s)
    expect(a.ctl.quotes).toBe(0)

    // Half open: one probe. It fails, so the breaker opens again.
    vi.setSystemTime(Date.now() + 6 * 60_000)
    expect((await t.health('a')).breaker.state).toBe('half_open')
    a.ctl.quoteMode = 'unavailable'
    await t.quote(s)
    expect(a.ctl.quotes).toBe(1)
    await t.quote(s)
    expect(a.ctl.quotes).toBe(1)

    // Next cool-down: the probe works and closes the breaker; old failures do not open it again.
    vi.setSystemTime(Date.now() + 11 * 60_000)
    a.ctl.quoteMode = 'ok'
    expect((await t.quote(s)).quotes).toHaveLength(2)
    expect((await t.health('a')).breaker.state).toBe('closed')
    expect((await t.quote(s)).quotes).toHaveLength(2)
    expect(a.ctl.quotes).toBe(3)
  })

  it('only one request probes in the half-open state', async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
    const a = cardAdapter('a')
    const t = make([a, cardAdapter('b', { output: '8' })], { timeouts: { quote: 50 } })
    const s1 = await t.session()
    const s2 = await t.session()
    await t.seed('a', { quoteFail: 20 })
    await t.quote(s1)
    vi.setSystemTime(Date.now() + 11 * 60_000)
    a.ctl.quoteMode = 'hang'
    // The first request holds the probe (it waits on A); the second skips A.
    const first = t.quote(s1)
    const second = await t.quote(s2)
    expect(second.quotes.map((q) => q.legs[0]!.adapterId)).toEqual(['b'])
    expect(a.ctl.quotes).toBe(1)
    // The probe timed out: the breaker opens again.
    await first
    expect((await t.health('a')).breaker.state).toBe('open')
  })

  it('needs enough samples', async () => {
    const a = cardAdapter('a')
    const t = make([a, cardAdapter('b', { output: '8' })])
    const s = await t.session()
    await t.seed('a', { quoteFail: 19 })
    await t.quote(s)
    expect(a.ctl.quotes).toBe(1)
    // One more sample, a good one: 19 of 20 failed (95%), so the next request skips A.
    expect((await t.health('a')).recentFailureRate).toBeCloseTo(19 / 20)
    await t.quote(s)
    expect(a.ctl.quotes).toBe(1)
  })

  it('turns off with `breaker: false` or `breakerFailureRate: 1`', async () => {
    for (const routing of [{ breaker: false }, { breakerFailureRate: 1 }]) {
      const a = cardAdapter('a')
      const t = make([a, cardAdapter('b', { output: '8' })], { routing })
      const s = await t.session()
      await t.seed('a', { quoteFail: 50 })
      expect((await t.quote(s)).quotes).toHaveLength(2)
      expect(a.ctl.quotes).toBe(1)
      expect((await t.health('a')).breaker.state).toBe('closed')
    }
  })
})

describe('failover at start', () => {
  it('starts the next best quote when the first provider is unavailable', async () => {
    const a = cardAdapter('a', { output: '9.5' })
    const b = cardAdapter('b', { output: '9.45' })
    const t = make([a, b])
    const s = await t.session()
    const r = await t.quote(s)
    expect(r.quotes.map((q) => q.legs[0]!.adapterId)).toEqual(['a', 'b'])
    a.ctl.startMode = 'unavailable'
    const res = await t.post(`/sessions/${s.id}/select`, s.clientSecret, { quoteId: r.quotes[0]!.id })
    expect(res.status).toBe(200)
    const pub = await res.json()
    expect(pub.step.state).toBe('PAYMENT')
    expect(pub.payment.quoteId).toBe(r.quotes[1]!.id)
    expect(pub.payment.legs[0].adapterId).toBe('b')
    // The failed try left nothing: no earlier attempt, attempt number 0.
    expect(pub.payment.attempt).toBe(0)
    const admin = (await t.ramp.admin.get(s.id))!
    expect(admin.attempts ?? []).toHaveLength(0)
    expect(admin.timeline.map((e) => e.type)).toEqual(expect.arrayContaining(['payment.start_failed', 'payment.failover']))
    expect(admin.timeline.find((e) => e.type === 'payment.failover')!.detail).toMatchObject({ from: 'a', to: 'b' })
    expect(t.metrics.find((m) => m.name === 'payment.failover')!.tags).toEqual({ from: 'a', to: 'b' })
    expect((await t.health('a')).counts.startFail).toBe(1)
    expect((await t.health('b')).counts.startOk).toBe(1)
  })

  it('never fails over on a timeout, a user error or an unknown error', async () => {
    for (const [mode, expectFailover] of [['unavailable', true], ['timeout', false], ['amount_too_low', false], ['bad_request', false], ['raw', false]] as const) {
      const a = cardAdapter('a', { output: '9.5' })
      const b = cardAdapter('b', { output: '9.45' })
      const t = make([a, b])
      const s = await t.session()
      const r = await t.quote(s)
      a.ctl.startMode = mode
      const res = await t.post(`/sessions/${s.id}/select`, s.clientSecret, { quoteId: r.quotes[0]!.id })
      expect(b.ctl.starts).toBe(expectFailover ? 1 : 0)
      expect(res.status === 200).toBe(expectFailover)
    }
  })

  it('never fails over once the provider returned a step', async () => {
    const a = cardAdapter('a', { output: '9.5' })
    const b = cardAdapter('b', { output: '9.45' })
    const t = make([a, b])
    const s = await t.session()
    const r = await t.quote(s)
    a.ctl.startMode = 'failed_step'
    const pub = await (await t.post(`/sessions/${s.id}/select`, s.clientSecret, { quoteId: r.quotes[0]!.id })).json()
    expect(b.ctl.starts).toBe(0)
    expect(pub.payment.legs[0].adapterId).toBe('a')
  })

  it('tries at most 2 more quotes, then returns the first error and leaves no half state', async () => {
    const all = ['a', 'b', 'c', 'd'].map((id, i) => cardAdapter(id, { output: String(9.5 - i / 100) }))
    const t = make(all)
    const s = await t.session()
    const r = await t.quote(s)
    all[0]!.ctl.startMode = 'unavailable'
    for (const x of all.slice(1)) x.ctl.startMode = 'unavailable'
    const before = await (await t.call(`/sessions/${s.id}`, { secret: s.clientSecret })).json()
    const res = await t.post(`/sessions/${s.id}/select`, s.clientSecret, { quoteId: r.quotes[0]!.id })
    expect(res.status).toBe(502)
    expect((await res.json()).error.code).toBe('PROVIDER_UNAVAILABLE')
    expect(all.map((x) => x.ctl.starts)).toEqual([1, 1, 1, 0])
    const after = await (await t.call(`/sessions/${s.id}`, { secret: s.clientSecret })).json()
    expect(after.payment).toBeUndefined()
    expect(after.status).toBe(before.status)
    expect(after.step).toEqual(before.step)
    const admin = (await t.ramp.admin.get(s.id))!
    expect(admin.timeline.some((e) => e.type === 'payment.failover')).toBe(false)
    // The session can still pay: a working quote starts.
    all[3]!.ctl.startMode = 'ok'
    expect((await t.post(`/sessions/${s.id}/select`, s.clientSecret, { quoteId: r.quotes[3]!.id })).status).toBe(200)
  })

  it('skips expired quotes and quotes of an earlier quote request', async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
    const a = cardAdapter('a', { output: '9.5' })
    const b = cardAdapter('b', { output: '9.45', expiresInMs: 60_000 })
    const c = cardAdapter('c', { output: '9.42' })
    const t = make([a, b, c])
    const s = await t.session()
    const old = await t.quote(s)
    vi.setSystemTime(Date.now() + 2 * 60_000)
    const r = await t.quote(s, '20')
    vi.setSystemTime(Date.now() + 2 * 60_000)
    // Now B's new quote expired too, and the old round's quotes do not count.
    a.ctl.startMode = 'unavailable'
    const pub = await (await t.post(`/sessions/${s.id}/select`, s.clientSecret, { quoteId: r.quotes[0]!.id })).json()
    expect(pub.payment.legs[0].adapterId).toBe('c')
    expect(pub.payment.quoteId).toBe(r.quotes.find((q) => q.legs[0]!.adapterId === 'c')!.id)
    expect(old.quotes.map((q) => q.id)).not.toContain(pub.payment.quoteId)
  })

  it('never starts a quote with other terms: more than 1% less output, or another input', async () => {
    const a = cardAdapter('a', { output: '9.5' })
    const b = cardAdapter('b', { output: '9.3' })
    const t = make([a, b])
    const s = await t.session()
    const r = await t.quote(s)
    a.ctl.startMode = 'unavailable'
    expect((await t.post(`/sessions/${s.id}/select`, s.clientSecret, { quoteId: r.quotes[0]!.id })).status).toBe(502)
    expect(b.ctl.starts).toBe(0)
    // Same output, but the stored input of B differs from the confirmed quote
    const a2 = cardAdapter('a', { output: '9.5' })
    const b2 = cardAdapter('b', { output: '9.5' })
    const t2 = make([a2, b2])
    const s2 = await t2.session()
    const r2 = await t2.quote(s2)
    const rec = (await t2.store.get(s2.id))!
    const qb = r2.quotes.find((q) => q.legs[0]!.adapterId === 'b')!.id
    rec.quotes[qb]!.quote.input = { ...rec.quotes[qb]!.quote.input, value: '10.5' }
    await t2.store.put(rec, rec.version)
    a2.ctl.startMode = 'unavailable'
    const first = r2.quotes.find((q) => q.legs[0]!.adapterId === 'a')!.id
    expect((await t2.post(`/sessions/${s2.id}/select`, s2.clientSecret, { quoteId: first })).status).toBe(502)
    expect(b2.ctl.starts).toBe(0)
  })

  it('skips quotes outside amountBounds', async () => {
    const a = cardAdapter('a', { output: '9.5' })
    const b = cardAdapter('b', { output: '9.45' })
    const t = make([a, b])
    const s = await t.ramp.sessions.create({ userId: 'u', country: 'SG', destination: DEST, amountBounds: { min: '5', currency: 'SGD' } })
    await t.post(`/sessions/${s.id}/plan`, s.clientSecret)
    const r = await t.quote(s)
    // Change the stored input of B's quote to below the minimum.
    const rec = (await t.store.get(s.id))!
    const qb = r.quotes.find((q) => q.legs[0]!.adapterId === 'b')!.id
    rec.quotes[qb]!.quote.input = { ...rec.quotes[qb]!.quote.input, value: '1' }
    await t.store.put(rec, rec.version)
    a.ctl.startMode = 'unavailable'
    const res = await t.post(`/sessions/${s.id}/select`, s.clientSecret, { quoteId: r.quotes[0]!.id })
    expect(res.status).toBe(502)
    expect(b.ctl.starts).toBe(0)
  })
})

describe('admin provider health', () => {
  it('GET /admin/providers shows counts, rates and the breaker state per adapter', async () => {
    const t = make([cardAdapter('a'), cardAdapter('b')])
    await t.seed('a', { quoteOk: 2, quoteFail: 18, startOk: 15, legSucceeded: 4, legFailed: 1 })
    expect((await t.call('/admin/providers')).status).toBe(401)
    const res = await t.call('/admin/providers', { secret: TOKEN })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json()
    expect(body.providers).toEqual([
      {
        adapterId: 'a', windowHours: 24,
        counts: { quoteOk: 2, quoteFail: 18, startOk: 15, startFail: 0, legSucceeded: 4, legFailed: 1 },
        successRate: 19 / 20, recentFailureRate: 18 / 35, breaker: { state: 'closed' },
      },
      {
        adapterId: 'b', windowHours: 24,
        counts: { quoteOk: 0, quoteFail: 0, startOk: 0, startFail: 0, legSucceeded: 0, legFailed: 0 },
        successRate: null, recentFailureRate: null, breaker: { state: 'closed' },
      },
    ])
  })
})
