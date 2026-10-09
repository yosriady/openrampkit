// Admin tools: auth, the time index (order, filters, cursor, no lost entries), stats, resolve with an
// audit note and a webhook, replay, lookups, telemetry, and the dashboard page.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAdapter } from '@openrampkit/adapter'
import type { LegEvent } from '@openrampkit/adapter'
import { USDC } from '@openrampkit/core'
import type { LegSpec } from '@openrampkit/core'
import { createOpenRamp, memoryStore } from './index.js'
import type { OpenRampConfig, SessionStore } from './index.js'
import { amountOf, tokenMatches } from './admin.js'
import * as cryptoMod from './crypto.js'

// Watch the compare that the admin auth uses (the constant-time path).
vi.mock('./crypto.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./crypto.js')>()
  return { ...orig, safeEqual: vi.fn(orig.safeEqual) }
})

const BASE = 'https://app.test/api/openramp'
const TOKEN = 'admin-token-'.padEnd(40, 'x')
const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const DEST = { type: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']!, address: '0x000000000000000000000000000000000000beef' }
const SRC = { chain: 'eip155:8453', token: USDC['eip155:8453']!, symbol: 'USDC', decimals: 6, custody: 'user_wallet' as const }
const HOOKS = { url: 'https://app.test/hooks', secret: 'w'.repeat(32) }
/** A card provider with webhooks. Each start makes a new order ref. */
function hookedAdapter() {
  let n = 0
  const spec: LegSpec = {
    id: 'hook', kind: 'fiat_onramp', methods: ['card'],
    from: { asset: { kind: 'fiat', currencies: '*' }, location: ['user_account'] },
    to: { asset: { kind: 'crypto', chains: { 'eip155:8453': [USDC['eip155:8453']!] } }, location: ['address'] },
    regions: { allow: ['*'], deny: [] }, eta: { min: 1, max: 2 }, surfaces: ['REDIRECT'],
  }
  const poll = [{ name: 'poll', kind: 'AWAIT' as const, poll: { intervalMs: 1000, backoff: 1, maxIntervalMs: 1000, giveUpAfterMs: 60000 } }]
  return createAdapter({
    id: 'hooked', name: 'Hooked', legs: [spec],
    async quote({ leg, amountIn }) {
      return { adapterId: 'hooked', legId: leg.legId, input: { value: amountIn!.value, asset: { kind: 'fiat', currency: 'SGD' } }, output: { value: '9', asset: leg.to.asset }, fees: [], eta: { min: 1, max: 2 }, guarantee: 'estimate' as const, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
    },
    async start() {
      const ref = `order-${++n}`
      return { status: 'requires_action', ref, action: { kind: 'payment', surface: { kind: 'REDIRECT', url: 'https://provider.test/pay', popup: true }, transitions: poll } }
    },
    async status({ ref }) {
      return { status: 'requires_action', ref, action: { kind: 'payment', transitions: poll } }
    },
    webhook: {
      async verify(req) {
        return req.headers.get('x-sig') !== 'bad'
      },
      async parse(raw) {
        return JSON.parse(raw) as LegEvent[]
      },
    },
  })
}

type Sent = { type: string; ok: boolean; body: { type: string; sessionId: string; data: { object: Record<string, unknown> } } }

function make(extra: Partial<OpenRampConfig> = {}) {
  const sent: Sent[] = []
  let answer = 200
  const fetchFn: typeof fetch = async (_u, init) => {
    const body = JSON.parse(String(init?.body))
    sent.push({ type: body.type, ok: answer < 300, body })
    return new Response('x', { status: answer })
  }
  const ramp = createOpenRamp({
    secret: 's'.repeat(40), baseUrl: BASE, adapters: [hookedAdapter()], logger: quiet, webhooks: HOOKS, fetch: fetchFn,
    admin: { token: TOKEN }, ...extra,
  })
  const call = (path: string, init: RequestInit & { bearer?: string } = {}) => {
    const headers = new Headers(init.headers)
    if (init.bearer) headers.set('authorization', `Bearer ${init.bearer}`)
    if (init.body) headers.set('content-type', 'application/json')
    return ramp.handle(new Request(`${BASE}${path}`, { ...init, headers }))
  }
  const admin = (path: string, init: RequestInit = {}) => call(`/admin${path}`, { ...init, bearer: TOKEN })
  const post = (path: string, secret: string, body: unknown = {}) => call(path, { method: 'POST', bearer: secret, body: JSON.stringify(body) })
  const hook = (events: LegEvent[], headers: Record<string, string> = {}) => call('/webhooks/hooked', { method: 'POST', body: JSON.stringify(events), headers })
  const deposit = (userId = 'u') => ramp.sessions.create({ userId, country: 'SG', destination: DEST })
  const withdraw = (userId = 'w') => ramp.sessions.create({ userId, direction: 'withdraw', source: SRC })
  /** Create a deposit and start a card payment of `amount` SGD. Returns the session and its order ref. */
  async function pay(amount = '10') {
    const s = await deposit()
    await post(`/sessions/${s.id}/plan`, s.clientSecret)
    const q = await (await post(`/sessions/${s.id}/quotes`, s.clientSecret, { method: 'card', amount })).json()
    await post(`/sessions/${s.id}/select`, s.clientSecret, { quoteId: q.quotes[0].id })
    const view = await ramp.admin.get(s.id)
    return { ...s, ref: view!.providerRefs[0]!.ref }
  }
  return { ramp, call, admin, post, hook, deposit, withdraw, pay, sent, setAnswer: (n: number) => void (answer = n) }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('admin auth', () => {
  it('routes are off without a token, and a short token throws at startup', async () => {
    const t = make({ admin: undefined })
    expect((await t.call('/admin')).status).toBe(404)
    expect((await t.call('/admin/stats', { bearer: TOKEN })).status).toBe(404)
    const noToken = make({ admin: {} })
    expect((await noToken.call('/admin/sessions', { bearer: TOKEN })).status).toBe(404)
    expect(() => make({ admin: { token: 'short' } })).toThrow(/at least 32/)
    expect(() => make({ admin: { token: '' } })).toThrow(/at least 32/)
  })

  it('a missing or wrong token gets 401; the right token gets data', async () => {
    const t = make()
    expect((await t.call('/admin/stats')).status).toBe(401)
    expect((await t.call('/admin/stats', { bearer: 'nope' })).status).toBe(401)
    expect((await t.call('/admin/stats', { bearer: `${TOKEN}x` })).status).toBe(401)
    expect((await t.call('/admin/stats', { headers: { authorization: TOKEN } })).status).toBe(401)
    const ok = await t.admin('/stats')
    expect(ok.status).toBe(200)
    expect(ok.headers.get('cache-control')).toBe('no-store')
  })

  it('compares fixed-length hashes, whatever the length of the given token', async () => {
    const spy = vi.mocked(cryptoMod.safeEqual)
    spy.mockClear()
    expect(await tokenMatches(TOKEN, 'x')).toBe(false)
    expect(await tokenMatches(TOKEN, TOKEN.repeat(3))).toBe(false)
    expect(await tokenMatches(TOKEN, '')).toBe(false)
    expect(await tokenMatches(TOKEN, TOKEN)).toBe(true)
    expect(spy).toHaveBeenCalledTimes(4)
    for (const [a, b] of spy.mock.calls) {
      expect(a).toHaveLength(64)
      expect(b).toHaveLength(64)
    }
  })

  it('admin routes get no CORS headers, also with cors "*"', async () => {
    const t = make({ cors: { origins: '*' } })
    const res = await t.call('/admin/stats', { bearer: TOKEN, headers: { origin: 'https://evil.test' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('admin list', () => {
  it('lists newest first, with direction, state, stuck and olderThan filters, and a cursor', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-05T12:00:00Z') })
    const t = make()
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      ids.push((await (i % 2 ? t.withdraw() : t.deposit())).id)
      vi.advanceTimersByTime(60_000)
    }
    const all = await t.ramp.admin.list()
    expect(all.sessions.map((s) => s.id)).toEqual([...ids].reverse())
    expect(all.nextCursor).toBeUndefined()
    expect(all.sessions[0]).toMatchObject({ direction: 'deposit', status: 'requires_payment_method', state: 'SELECT_METHOD', stuck: false, deadLetters: 0 })

    expect((await t.ramp.admin.list({ direction: 'withdraw' })).sessions.map((s) => s.id)).toEqual([ids[3], ids[1]])
    expect((await t.ramp.admin.list({ state: 'succeeded' })).sessions).toEqual([])
    expect((await t.ramp.admin.list({ state: 'SELECT_METHOD' })).sessions).toHaveLength(5)
    // Created at least 3 minutes ago: the first three (the clock is 5 minutes after the first one).
    expect((await t.ramp.admin.list({ olderThan: 3 })).sessions.map((s) => s.id)).toEqual([ids[2], ids[1], ids[0]])

    // Pages of 2 cover every session once, in order.
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = await t.ramp.admin.list({ limit: 2, ...(cursor ? { cursor } : {}) })
      seen.push(...page.sessions.map((s) => s.id))
      cursor = page.nextCursor
    } while (cursor)
    expect(seen).toEqual([...ids].reverse())

    // Stuck: not final after 60 minutes.
    expect((await t.ramp.admin.list({ stuck: true })).sessions).toEqual([])
    vi.advanceTimersByTime(61 * 60_000)
    const stuck = await t.admin('/sessions?stuck=1&direction=deposit')
    expect((await stuck.json()).sessions.map((s: { id: string }) => s.id)).toEqual([ids[4], ids[2], ids[0]])
  })

  it('reads across days, newest day first', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-04T23:59:00Z') })
    const t = make()
    const a = await t.deposit()
    vi.setSystemTime(Date.parse('2026-10-05T00:01:00Z'))
    const b = await t.deposit()
    expect((await t.ramp.admin.list()).sessions.map((s) => s.id)).toEqual([b.id, a.id])
    const p1 = await t.ramp.admin.list({ limit: 1 })
    expect(p1.sessions[0]!.id).toBe(b.id)
    expect((await t.ramp.admin.list({ limit: 1, cursor: p1.nextCursor! })).sessions[0]!.id).toBe(a.id)
  })

  it('rejects bad filters', async () => {
    const t = make()
    expect((await t.admin('/sessions?direction=sideways')).status).toBe(400)
    expect((await t.admin('/sessions?cursor=%3Cx%3E')).status).toBe(400)
  })

  it.each([
    ['memory store', () => memoryStore()],
    ['custom store without queue (record fallback)', (): SessionStore => {
      const { queue: _q, ...rest } = memoryStore()
      return rest
    }],
  ])('concurrent session creation loses no index entry: %s', async (_name, store) => {
    const t = make({ store: store() })
    const made = await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 3 ? t.deposit(`u${i}`) : t.withdraw(`u${i}`))))
    const listed = await t.ramp.admin.list({ limit: 200 })
    expect(new Set(listed.sessions.map((s) => s.id))).toEqual(new Set(made.map((s) => s.id)))
  })

  it('without `admin` in the config, nothing is indexed', async () => {
    const t = make({ admin: undefined })
    await t.deposit()
    expect((await t.ramp.admin.list()).sessions).toEqual([])
  })
})

describe('admin get, find and stats', () => {
  it('get shows legs, outbox, provider refs and the timeline, without secrets', async () => {
    const t = make()
    const s = await t.pay('25')
    const v = (await t.ramp.admin.get(s.id))!
    // The user still has to pay: `requires_action`, not `processing`.
    expect(v).toMatchObject({ id: s.id, direction: 'deposit', status: 'requires_action', state: 'PAYMENT', amount: '25', currency: 'SGD', method: 'card', provider: 'Hooked' })
    expect((await t.ramp.admin.list({ state: 'requires_action' })).sessions.map((x) => x.id)).toEqual([s.id])
    expect((await t.ramp.admin.list({ state: 'processing' })).sessions).toEqual([])
    expect((await t.ramp.admin.stats()).byStatus).toMatchObject({ requires_action: 1 })
    expect(v.payment!.legs[0]).toMatchObject({ adapterId: 'hooked', ref: s.ref, status: 'requires_action', started: true })
    expect(v.providerRefs).toEqual([{ adapterId: 'hooked', ref: s.ref, attempt: 0, active: true }])
    expect(v.timeline.map((e) => e.type)).toEqual(['session.created', 'payment.started', 'leg.requires_action', 'session.requires_action'])
    expect(JSON.stringify(v)).not.toMatch(/secretHash|startUrls|provider\.test/)
    expect(await t.ramp.admin.get('ors_missing')).toBeNull()
    expect((await t.admin('/sessions/ors_missing')).status).toBe(404)
    expect((await (await t.admin(`/sessions/${s.id}`)).json()).id).toBe(s.id)
  })

  it('finds a session by provider ref and by transaction hash', async () => {
    const t = make()
    const s = await t.pay()
    const tx = `0x${'ab'.repeat(32)}`
    const src = `0x${'cd'.repeat(32)}`
    await t.hook([{ ref: s.ref, status: 'succeeded', transactions: [{ role: 'source', hash: src }, { role: 'destination', hash: tx }] }])
    const v = (await t.ramp.admin.get(s.id))!
    expect(v.transactions).toEqual([
      { role: 'source', chain: 'eip155:8453', hash: src, legIndex: 0, attempt: 0 },
      { role: 'destination', chain: 'eip155:8453', hash: tx, legIndex: 0, attempt: 0 },
    ])
    expect(v.payment!.legs[0]!.transactions.map((x) => x.role)).toEqual(['source', 'destination'])
    expect((await t.ramp.admin.findByRef('hooked', s.ref))!.id).toBe(s.id)
    expect(await t.ramp.admin.findByRef('hooked', 'nope')).toBeNull()
    expect((await t.ramp.admin.findByTx(undefined, tx.toUpperCase().replace('0X', '0x'))).map((x) => x.id)).toEqual([s.id])
    expect((await t.ramp.admin.findByTx('eip155:8453', tx)).map((x) => x.id)).toEqual([s.id])
    expect(await t.ramp.admin.findByTx('eip155:1', tx)).toEqual([])
    // The user's own origin transaction finds the session too.
    expect((await t.ramp.admin.findByTx(undefined, src)).map((x) => x.id)).toEqual([s.id])
    const r = await (await t.admin(`/find?provider=hooked&ref=${s.ref}`)).json()
    expect(r.sessions[0].id).toBe(s.id)
    expect((await (await t.admin(`/find?tx=${tx}`)).json()).sessions[0].id).toBe(s.id)
  })

  it('stats count states, directions, volume, stuck sessions, dead letters and webhook failures', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-05T12:00:00Z') })
    const t = make({ webhooks: { ...HOOKS, maxAttempts: 1 } })
    const a = await t.pay('10')
    const b = await t.pay('15.5')
    await t.hook([{ ref: a.ref, status: 'succeeded' }, { ref: b.ref, status: 'succeeded' }])
    await t.withdraw()
    t.setAnswer(500)
    const failing = await t.deposit() // its session.created webhook fails once and becomes a dead letter
    t.setAnswer(200)
    vi.advanceTimersByTime(61 * 60_000)

    const s = await t.ramp.admin.stats()
    expect(s).toMatchObject({ total: 4, truncated: false, byStatus: { succeeded: 2, requires_payment_method: 2 } })
    expect(s.byDirection.deposit).toMatchObject({ total: 3, byStatus: { succeeded: 2, requires_payment_method: 1 } })
    expect(s.byDirection.withdraw.total).toBe(1)
    expect(s.succeededVolume).toEqual([{ direction: 'deposit', currency: 'SGD', amount: '25.5', count: 2 }])
    expect(s.stuck).toMatchObject({ count: 2, afterMinutes: 60 })
    expect(s.outbox).toMatchObject({ deadLetters: 1, sessionsWithDeadLetters: 1 })
    expect(s.webhookFailures).toBe(1)
    expect((await t.ramp.admin.get(failing.id))!.deadLetters).toBe(1)
    // `since` limits the window
    expect((await t.ramp.admin.stats({ since: Date.now() - 60_000 })).total).toBe(0)
    expect((await (await t.admin(`/stats?since=${encodeURIComponent(new Date(Date.now() - 2 * 3600_000).toISOString())}`)).json()).total).toBe(4)
    expect((await t.admin('/stats?since=yesterday')).status).toBe(400)
  })
})

describe('admin resolve and replay', () => {
  it('resolve sets a final state, stores the audit note, and sends the matching webhook', async () => {
    const t = make()
    const s = await t.pay()
    const res = await t.admin(`/sessions/${s.id}/resolve`, { method: 'POST', body: JSON.stringify({ state: 'COMPLETED', note: 'Paid by bank transfer, ticket 123' }) })
    expect(res.status).toBe(200)
    const v = await res.json()
    expect(v).toMatchObject({ status: 'succeeded', state: 'COMPLETED', resolved: true, resolution: { state: 'COMPLETED', note: 'Paid by bank transfer, ticket 123', previous: 'PAYMENT' } })
    expect(v.timeline.at(-2)).toMatchObject({ type: 'admin.resolved', detail: { state: 'COMPLETED', previous: 'PAYMENT', note: 'Paid by bank transfer, ticket 123' } })
    const hook = t.sent.find((x) => x.type === 'session.succeeded')!
    expect(hook.ok).toBe(true)
    expect(hook.body.data.object).toMatchObject({ resolution: { by: 'admin', state: 'COMPLETED', note: 'Paid by bank transfer, ticket 123' } })
    expect((await t.ramp.sessions.retrieve(s.id))!.status).toBe('succeeded')

    // The same state again is refused; the browser cannot change the session now.
    expect((await t.admin(`/sessions/${s.id}/resolve`, { method: 'POST', body: JSON.stringify({ state: 'completed', note: 'again' }) })).status).toBe(409)
    // A late provider event updates the leg, not the session state.
    await t.hook([{ ref: s.ref, status: 'failed' }])
    const after = (await t.ramp.admin.get(s.id))!
    expect(after.state).toBe('COMPLETED')
    expect(after.payment!.legs[0]!.status).toBe('failed')
  })

  it('resolve needs a valid state and a note; a withdrawal gets session.failed (no withdrawal.* events)', async () => {
    const t = make()
    const w = await t.withdraw()
    await expect(t.ramp.admin.resolve(w.id, 'FAILED', '  ')).rejects.toMatchObject({ status: 400 })
    await expect(t.ramp.admin.resolve(w.id, 'DONE' as 'FAILED', 'x')).rejects.toMatchObject({ status: 400 })
    await expect(t.ramp.admin.resolve('ors_missing', 'FAILED', 'x')).rejects.toMatchObject({ status: 404 })
    const v = await t.ramp.admin.resolve(w.id, 'FAILED', 'Sanctions hit')
    expect(v).toMatchObject({ status: 'failed', state: 'FAILED' })
    expect(t.sent.map((x) => x.type)).toContain('session.failed')
    expect(t.sent.map((x) => x.type).filter((x) => x.startsWith('withdrawal.'))).toEqual([])
    expect(t.sent.find((x) => x.type === 'session.failed')!.body).toMatchObject({ data: { object: { session: { direction: 'withdraw' }, resolution: { by: 'admin', state: 'FAILED' } } } })
    const s = await t.deposit()
    await t.ramp.admin.resolve(s.id, 'EXPIRED', 'Old test session')
    expect((await t.post(`/sessions/${s.id}/plan`, s.clientSecret)).status).toBe(409)
  })

  it('replay sends dead letters again', async () => {
    const t = make({ webhooks: { ...HOOKS, maxAttempts: 1 } })
    t.setAnswer(500)
    const s = await t.deposit()
    expect((await t.ramp.admin.get(s.id))!.outbox).toMatchObject([{ type: 'session.created', dead: true, attempts: 1 }])
    t.setAnswer(200)
    const r = await t.admin(`/sessions/${s.id}/replay`, { method: 'POST' })
    expect(await r.json()).toEqual({ queued: 1 })
    const v = (await t.ramp.admin.get(s.id))!
    expect(v.outbox).toEqual([])
    expect(v.timeline.map((e) => e.type)).toContain('webhook.replayed')
    expect(t.sent.filter((x) => x.type === 'session.created').map((x) => x.ok)).toEqual([false, true])
    expect(await t.ramp.admin.replayWebhooks(s.id)).toEqual({ queued: 0 })
    expect((await t.admin('/sessions/ors_missing/replay', { method: 'POST' })).status).toBe(404)
  })
})

describe('telemetry and index cleanup', () => {
  it('reports quote latency, verify failures, outbox depth and sweep timing; a throwing callback is ignored', async () => {
    const metrics: Array<[string, number, Record<string, string>]> = []
    const t = make({
      telemetry: {
        onMetric(name, value, tags) {
          metrics.push([name, value, tags])
          throw new Error('metrics down')
        },
      },
    })
    await t.pay()
    expect((await t.hook([{ ref: 'x', status: 'succeeded' }], { 'x-sig': 'bad' })).status).toBe(401)
    await t.ramp.sweep()
    await t.ramp.sweep()
    const names = metrics.map((m) => m[0])
    expect(metrics.find((m) => m[0] === 'quote.latency_ms')![2]).toEqual({ adapter: 'hooked', ok: 'true' })
    expect(metrics.find((m) => m[0] === 'webhook.verify_failed')![2]).toEqual({ adapter: 'hooked' })
    expect(names).toEqual(expect.arrayContaining(['outbox.depth', 'open_sessions.depth', 'sweep.duration_ms', 'sweep.lag_ms']))
  })

  it('the sweep removes index days older than indexDays', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-01T12:00:00Z') })
    const store = memoryStore()
    const t = make({ store, admin: { token: TOKEN, indexDays: 2 } })
    await t.deposit()
    vi.setSystemTime(Date.parse('2026-10-05T12:00:00Z'))
    const fresh = await t.deposit()
    // `list` reads only the last 2 days, so the old session is not shown.
    expect((await t.ramp.admin.list()).sessions.map((s) => s.id)).toEqual([fresh.id])
    expect(await store.queue!.size('admin-index:2026-10-01')).toBe(1)
    await t.ramp.sweep()
    expect(await store.queue!.size('admin-index:2026-10-01')).toBe(0)
    expect(await store.queue!.size('admin-index:2026-10-05')).toBe(1)
  })
})

describe('admin page', () => {
  it('serves one self-contained page with a CSP nonce and no external script', async () => {
    const t = make()
    const res = await t.call('/admin')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    const csp = res.headers.get('content-security-policy')!
    const nonce = /script-src 'nonce-([0-9a-f]{32})'/.exec(csp)![1]!
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("connect-src 'self'")
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https:/)
    const html = await res.text()
    expect(html).toContain(`<script nonce="${nonce}">`)
    expect(html).toContain(`<style nonce="${nonce}">`)
    expect(html).not.toMatch(/<script[^>]*\bsrc=/)
    expect(html).not.toMatch(/<link[^>]*stylesheet/)
    expect(html).not.toMatch(/https?:\/\/(?!app\.test)/)
    expect(html).toContain('sessionStorage')
    // Reversed sessions: a filter, a stats card and a detail row
    expect(html).toContain('<option>reversed</option>')
    expect(html).toContain('Reversed after success')
    expect(html).toContain("['Reversal', s.reversal")
    expect(html).not.toMatch(/[\u2013\u2014]/)
    expect(html).not.toContain(TOKEN)
    // A new nonce per request
    const again = (await t.call('/admin')).headers.get('content-security-policy')!
    expect(again).not.toBe(csp)
    expect((await make({ admin: { token: TOKEN, page: false } }).call('/admin')).status).toBe(404)
  })
})

describe('amountOf', () => {
  const usdc = (amount: string) => ({ value: amount, asset: { kind: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']!, symbol: 'USDC', decimals: 6 } })
  const vnd = (amount: string) => ({ value: amount, asset: { kind: 'fiat' as const, currency: 'VND' } })
  const rec = (legs: Array<{ input: ReturnType<typeof usdc> | ReturnType<typeof vnd>; output: ReturnType<typeof usdc>; done?: ReturnType<typeof usdc> }>) =>
    ({ active: { legs: legs.map((l) => ({ quote: { input: l.input, output: l.output }, ...(l.done ? { step: { output: l.done } } : {}) })) } }) as unknown as Parameters<typeof amountOf>[0]

  it('shows what the user pays in when the quote has an amount', () => {
    expect(amountOf(rec([{ input: vnd('500000'), output: usdc('19.61') }]))).toEqual(vnd('500000'))
  })

  it('shows the amount that arrived when the flow has no amount up front (exchange transfer)', () => {
    expect(amountOf(rec([{ input: usdc('0'), output: usdc('0'), done: usdc('25') }]))).toEqual(usdc('25'))
    expect(amountOf(rec([{ input: usdc(''), output: usdc('12.5') }]))).toEqual(usdc('12.5'))
  })

  it('falls back to the quoted input when nothing is known yet', () => {
    expect(amountOf(rec([{ input: usdc('0'), output: usdc('0') }]))).toEqual(usdc('0'))
    expect(amountOf({} as Parameters<typeof amountOf>[0])).toBeUndefined()
  })
})
