// Delivery and state guarantees: no lost outbox or open-session entries during a sweep, deterministic
// event ids with delivery after commit, late events for an attempt left by `restart`, and retryable
// answers for provider events that could not be applied.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAdapter } from '@openrampkit/adapter'
import type { LegEvent } from '@openrampkit/adapter'
import { USDC } from '@openrampkit/core'
import type { LegSpec, LegStatus, LegStep } from '@openrampkit/core'
import { createOpenRamp, memoryStore, VersionConflictError } from './index.js'
import type { OpenRampConfig, SessionRecord, SessionStore } from './index.js'
import { eventId } from './notify.js'

const BASE = 'https://app.test/api/openramp'
const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const DEST = { type: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']!, address: '0x000000000000000000000000000000000000beef' }
const HOOKS = { url: 'https://app.test/hooks', secret: 'w'.repeat(32) }

type Sent = { type: string; id: string; header: string; sessionId: string; ok: boolean }

const STATE: Record<LegStatus, LegStep['state']> = {
  pending: 'PROCESSING',
  requires_action: 'PAYMENT',
  processing: 'PROCESSING',
  succeeded: 'COMPLETED',
  failed: 'FAILED',
  refunded: 'REFUNDED',
  expired: 'EXPIRED',
  reversed: 'REVERSED',
}

/** A card provider with webhooks. Each start makes a new order ref; `status` answers from `statusOf`. */
function hookedAdapter() {
  let n = 0
  const statusOf: Record<string, LegStatus> = {}
  const spec: LegSpec = {
    id: 'hook', kind: 'fiat_onramp', methods: ['card'],
    from: { asset: { kind: 'fiat', currencies: '*' }, location: ['user_account'] },
    to: { asset: { kind: 'crypto', chains: { 'eip155:8453': [USDC['eip155:8453']!] } }, location: ['address'] },
    regions: { allow: ['*'], deny: [] }, eta: { min: 1, max: 2 }, surfaces: ['REDIRECT'],
  }
  const poll = [{ name: 'poll', kind: 'AWAIT' as const, poll: { intervalMs: 1000, backoff: 1, maxIntervalMs: 1000, giveUpAfterMs: 60000 } }]
  const adapter = createAdapter({
    id: 'hooked', name: 'Hooked', legs: [spec],
    async quote({ leg, amountIn }) {
      return { adapterId: 'hooked', legId: leg.legId, input: amountIn!, output: { value: '9', asset: leg.to.asset }, fees: [], eta: { min: 1, max: 2 }, guarantee: 'estimate' as const, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
    },
    async start() {
      const ref = `order-${++n}`
      return { state: 'PAYMENT', status: 'requires_action', ref, surface: { kind: 'REDIRECT', url: 'https://provider.test/pay', popup: true }, transitions: poll }
    },
    async status({ ref }) {
      const status = statusOf[ref] ?? 'requires_action'
      return { state: STATE[status], status, ref, transitions: status === 'requires_action' ? poll : [] }
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
  return { adapter, statusOf }
}

/** App backend that records each webhook. `answer` decides the HTTP status (or waits). */
function appBackend() {
  const sent: Sent[] = []
  let answer: (e: { type: string; sessionId: string }) => Promise<number> | number = () => 200
  const fetchFn: typeof fetch = async (_u, init) => {
    const body = JSON.parse(String(init?.body))
    const status = await answer(body)
    sent.push({ type: body.type, id: body.id, header: new Headers(init?.headers).get('webhook-id')!, sessionId: body.sessionId, ok: status < 300 })
    return new Response('x', { status })
  }
  return { sent, fetchFn, setAnswer: (f: typeof answer) => void (answer = f), delivered: (type: string) => sent.filter((s) => s.ok && s.type === type) }
}

function make(extra: Partial<OpenRampConfig> = {}) {
  const hooked = hookedAdapter()
  const app = appBackend()
  const ramp = createOpenRamp({ secret: 's'.repeat(40), baseUrl: BASE, adapters: [hooked.adapter], logger: quiet, webhooks: HOOKS, fetch: app.fetchFn, ...extra })
  const call = (path: string, init: RequestInit & { secret?: string } = {}) => {
    const headers = new Headers(init.headers)
    if (init.secret) headers.set('authorization', `Bearer ${init.secret}`)
    if (init.body) headers.set('content-type', 'application/json')
    return ramp.handle(new Request(`${BASE}${path}`, { ...init, headers }))
  }
  const post = (path: string, secret: string, body: unknown = {}) => call(path, { method: 'POST', secret, body: JSON.stringify(body) })
  const hook = (events: LegEvent[]) => call('/webhooks/hooked', { method: 'POST', body: JSON.stringify(events) })
  /** Create a session and start a card payment (state PAYMENT, waiting for the user). */
  async function toPayment(s?: { id: string; clientSecret: string }) {
    s ??= await ramp.sessions.create({ userId: 'u', country: 'SG', destination: DEST })
    await post(`/sessions/${s.id}/plan`, s.clientSecret)
    const q = await (await post(`/sessions/${s.id}/quotes`, s.clientSecret, { method: 'card', amount: '10' })).json()
    const pub = await (await post(`/sessions/${s.id}/select`, s.clientSecret, { quoteId: q.quotes[0].id })).json()
    expect(pub.step.state).toBe('PAYMENT')
    return s
  }
  return { ramp, call, post, hook, toPayment, app, statusOf: hooked.statusOf }
}

/** A promise you open by hand, and a promise that resolves when the gate is reached. */
function gate() {
  let open!: () => void
  let reached!: () => void
  const opened = new Promise<void>((r) => (open = r))
  const wasReached = new Promise<void>((r) => (reached = r))
  return { open, opened, reached, wasReached }
}

afterEach(() => vi.useRealTimers())

describe('P0-1: outbox and open-session list do not lose concurrent adds', () => {
  it('a session created (and its failed webhook queued) while a sweep runs is kept on both lists', async () => {
    vi.useFakeTimers({ now: Date.now() })
    const { ramp, app } = make()
    app.setAnswer(() => 503)
    const a = await ramp.sessions.create({ userId: 'a', destination: DEST })
    vi.setSystemTime(Date.now() + 31_000)

    // The sweep claims A and waits in the delivery of A's event.
    const g = gate()
    app.setAnswer(async (e) => {
      if (e.sessionId !== a.id) return 503
      g.reached()
      await g.opened
      return 200
    })
    const running = ramp.sweep()
    await g.wasReached
    // Meanwhile: a new session. Its webhook fails, so it must go on the outbox list too.
    const b = await ramp.sessions.create({ userId: 'b', destination: DEST })
    g.open()
    const r = await running
    expect(r.webhooks).toMatchObject({ retried: 1, delivered: 1, pending: 1 })
    expect(r.sessions.open).toBe(2)

    app.setAnswer(() => 200)
    vi.setSystemTime(Date.now() + 31_000)
    const r2 = await ramp.sweep()
    expect(r2.webhooks).toMatchObject({ delivered: 1, pending: 0 })
    expect(app.delivered('session.created').map((s) => s.sessionId).sort()).toEqual([a.id, b.id].sort())
  })

  it('two sweeps at the same time deliver an event once (the claim holds a lease)', async () => {
    vi.useFakeTimers({ now: Date.now() })
    const { ramp, app } = make()
    app.setAnswer(() => 503)
    await ramp.sessions.create({ userId: 'a', destination: DEST })
    vi.setSystemTime(Date.now() + 31_000)
    const g = gate()
    app.setAnswer(async () => {
      g.reached()
      await g.opened
      return 200
    })
    const first = ramp.sweep()
    await g.wasReached
    const second = await ramp.sweep()
    g.open()
    await first
    expect(second.webhooks.retried).toBe(0)
    expect(app.delivered('session.created')).toHaveLength(1)
  })

  it('round robin: with a small limit, every open session gets its turn', async () => {
    vi.useFakeTimers({ now: Date.now() })
    const base = memoryStore()
    const gets: string[] = []
    const store: SessionStore = { ...base, get: async (id) => (gets.push(id), base.get(id)) }
    const { ramp } = make({ store, webhooks: undefined })
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      ids.push((await ramp.sessions.create({ userId: `u${i}`, destination: DEST })).id)
      vi.setSystemTime(Date.now() + 1)
    }
    const turns: string[][] = []
    for (let run = 0; run < 3; run++) {
      gets.length = 0
      vi.setSystemTime(Date.now() + 1000)
      expect((await ramp.sweep({ limit: 2 })).sessions).toMatchObject({ checked: 2, open: 5 })
      turns.push([...gets])
    }
    expect(turns.slice(0, 2)).toEqual([[ids[0], ids[1]], [ids[2], ids[3]]])
    // then the last new one, and one of the first two again (they were pushed back at the same time)
    expect(turns[2]![0]).toBe(ids[4])
    expect([ids[0], ids[1]]).toContain(turns[2]![1])
  })
})

describe('P0-2: events are saved with the change and delivered after the commit', () => {
  it('a 409 retry of a provider event makes the same event id and delivers it once', async () => {
    const base = memoryStore()
    let conflicts = 1
    const store: SessionStore = {
      ...base,
      async put(rec, v) {
        // Another request changes the session at the same moment the provider event completes it.
        if (v !== undefined && rec.step.state === 'COMPLETED' && conflicts > 0) {
          conflicts--
          throw new VersionConflictError('changed')
        }
        return base.put(rec, v)
      },
    }
    const { hook, toPayment, app, ramp } = make({ store })
    const s = await toPayment()
    expect((await hook([{ ref: 'order-1', status: 'succeeded', txHash: '0xabc' }])).status).toBe(200)
    expect(conflicts).toBe(0)
    expect((await ramp.sessions.retrieve(s.id))!.status).toBe('succeeded')

    const done = app.sent.filter((e) => e.type === 'session.succeeded')
    expect(done).toHaveLength(1)
    expect(done[0]!.id).toBe(await eventId(s.id, 'session.succeeded:{}'))
    expect(done[0]!.header).toBe(done[0]!.id)
    expect(app.sent.filter((e) => e.type === 'leg.succeeded')).toHaveLength(1)
    // nothing is left to send: the outbox entry from the save is cleared when it is due
    vi.useFakeTimers({ now: Date.now() + 31_000 })
    expect((await ramp.sweep()).webhooks).toMatchObject({ retried: 0, pending: 0 })
    expect(app.sent.filter((e) => e.type === 'session.succeeded')).toHaveLength(1)
  })

  it('a retry after a failed delivery keeps the event id', async () => {
    vi.useFakeTimers({ now: Date.now() })
    const { ramp, app } = make()
    app.setAnswer(() => 500)
    const s = await ramp.sessions.create({ userId: 'u', destination: DEST })
    app.setAnswer(() => 200)
    vi.setSystemTime(Date.now() + 31_000)
    await ramp.sweep()
    const tries = app.sent.filter((e) => e.type === 'session.created')
    expect(tries.map((t) => t.ok)).toEqual([false, true])
    expect(new Set(tries.map((t) => t.id))).toEqual(new Set([await eventId(s.id, 'session.created:{}')]))
  })

  it('when the change is not saved, no event goes out, and the provider gets 503', async () => {
    const base = memoryStore()
    let block = true
    const store: SessionStore = {
      ...base,
      async put(rec, v) {
        if (block && v !== undefined && rec.step.state === 'COMPLETED') throw new VersionConflictError('changed')
        return base.put(rec, v)
      },
    }
    const { hook, toPayment, app, ramp } = make({ store })
    const s = await toPayment()
    expect((await hook([{ ref: 'order-1', status: 'succeeded' }])).status).toBe(503)
    expect(app.sent.filter((e) => e.type === 'session.succeeded' || e.type === 'leg.succeeded')).toEqual([])
    // not saved: the session still waits for the user to pay
    expect((await ramp.sessions.retrieve(s.id))!.status).toBe('requires_action')
    // the provider sends it again
    block = false
    expect((await hook([{ ref: 'order-1', status: 'succeeded' }])).status).toBe(200)
    expect(app.delivered('session.succeeded')).toHaveLength(1)
  })
})

describe('session status while the user must act', () => {
  it('is requires_action while the active leg waits for the user, then processing, then completed', async () => {
    const { hook, toPayment, post, ramp } = make()
    const s = await ramp.sessions.create({ userId: 'u', country: 'SG', destination: DEST })
    expect((await ramp.sessions.retrieve(s.id))!.status).toBe('requires_payment_method')
    await toPayment(s)
    let pub = await ramp.sessions.retrieve(s.id)
    expect(pub).toMatchObject({ status: 'requires_action', step: { state: 'PAYMENT', progress: { legs: [{ status: 'requires_action' }] } } })
    expect((await hook([{ ref: 'order-1', status: 'processing' }])).status).toBe(200)
    pub = await ramp.sessions.retrieve(s.id)
    expect(pub).toMatchObject({ status: 'processing', step: { state: 'PROCESSING' } })
    expect((await hook([{ ref: 'order-1', status: 'succeeded' }])).status).toBe(200)
    expect((await ramp.sessions.retrieve(s.id))!.status).toBe('succeeded')
    // restart from a waiting payment goes back to open
    const s2 = await toPayment()
    const r = await (await post(`/sessions/${s2.id}/transitions/restart`, s2.clientSecret)).json()
    expect(r.status).toBe('requires_payment_method')
  })
})

describe('transaction hashes in the result', () => {
  it('keeps the source transaction next to the fill, also when a later step leaves it out', async () => {
    const { hook, toPayment, ramp, statusOf } = make()
    const s = await toPayment()
    expect((await hook([{ ref: 'order-1', status: 'processing', txHash: '0xsrc', sourceTxHash: '0xsrc' }])).status).toBe(200)
    let pub = await ramp.sessions.retrieve(s.id)
    expect(pub!.result).toMatchObject({ txHashes: ['0xsrc'], sourceTxHashes: ['0xsrc'] })
    // The fill arrives by webhook: the main hash changes, the source stays.
    expect((await hook([{ ref: 'order-1', status: 'processing', txHash: '0xfill' }])).status).toBe(200)
    pub = await ramp.sessions.retrieve(s.id)
    expect(pub!.result).toMatchObject({ txHashes: ['0xfill'], sourceTxHashes: ['0xsrc'] })
    // A status check without hashes completes the leg: the server keeps the source hash.
    statusOf['order-1'] = 'succeeded'
    await ramp.sessions.refresh(s.id)
    pub = await ramp.sessions.retrieve(s.id)
    expect(pub!.status).toBe('succeeded')
    expect(pub!.result!.sourceTxHashes).toEqual(['0xsrc'])
    expect(pub!.step.progress!.legs[0]).toMatchObject({ status: 'succeeded', sourceTxHash: '0xsrc' })
  })

  it('has no sourceTxHashes when no leg reports one', async () => {
    const { hook, toPayment, ramp } = make()
    const s = await toPayment()
    await hook([{ ref: 'order-1', status: 'succeeded', txHash: '0x1' }])
    const pub = await ramp.sessions.retrieve(s.id)
    expect(pub!.result!.txHashes).toEqual(['0x1'])
    expect(pub!.result!.sourceTxHashes).toBeUndefined()
  })
})

describe('P0-5: restart while waiting for payment keeps the attempt', () => {
  it('a late success for the left attempt completes the session', async () => {
    const { hook, toPayment, post, app, ramp } = make()
    const s = await toPayment()
    const r = await (await post(`/sessions/${s.id}/transitions/restart`, s.clientSecret)).json()
    expect(r.step.state).toBe('SELECT_METHOD')
    // still on the open list, so the sweep polls it
    expect((await ramp.sweep()).sessions).toMatchObject({ checked: 1, open: 1 })

    expect((await hook([{ ref: 'order-1', status: 'succeeded', txHash: '0x1' }])).status).toBe(200)
    const pub = await ramp.sessions.retrieve(s.id)
    expect(pub!.status).toBe('succeeded')
    expect(pub!.result!.txHashes).toEqual(['0x1'])
    expect(app.delivered('session.succeeded')).toHaveLength(1)
  })

  it('the paid attempt becomes active again when the new attempt still waits for the user', async () => {
    const { hook, toPayment, post, ramp } = make()
    const s = await toPayment()
    await post(`/sessions/${s.id}/transitions/restart`, s.clientSecret)
    await toPayment(s) // order-2, waiting
    expect((await hook([{ ref: 'order-1', status: 'succeeded' }])).status).toBe(200)
    expect((await ramp.sessions.retrieve(s.id))!.status).toBe('succeeded')
    // a later event for the new attempt does not undo it
    expect((await hook([{ ref: 'order-2', status: 'failed' }])).status).toBe(200)
    expect((await ramp.sessions.retrieve(s.id))!.status).toBe('succeeded')
  })

  it('a late success while another payment is under way sends session.late_payment', async () => {
    const { hook, toPayment, post, app, ramp } = make()
    const s = await toPayment()
    await post(`/sessions/${s.id}/transitions/restart`, s.clientSecret)
    await toPayment(s)
    expect((await hook([{ ref: 'order-2', status: 'processing' }])).status).toBe(200)
    expect((await hook([{ ref: 'order-1', status: 'succeeded', txHash: '0x9' }])).status).toBe(200)
    const late = app.delivered('session.late_payment')
    expect(late).toHaveLength(1)
    expect(app.sent.find((e) => e.type === 'session.late_payment')).toBeDefined()
    expect((await ramp.sessions.retrieve(s.id))!.step.state).toBe('PROCESSING')
  })

  it('the sweep polls the left attempt and completes the session', async () => {
    const { toPayment, post, ramp, statusOf } = make()
    const s = await toPayment()
    await post(`/sessions/${s.id}/transitions/restart`, s.clientSecret)
    statusOf['order-1'] = 'succeeded'
    expect((await ramp.sweep()).sessions).toMatchObject({ checked: 1, changed: 1, open: 0 })
    expect((await ramp.sessions.retrieve(s.id))!.status).toBe('succeeded')
  })
})

describe('P0-6: provider events that are not applied get a retryable answer', () => {
  it('an unknown ref gets 503; the same event applies when the provider sends it again', async () => {
    const { hook, toPayment, ramp } = make()
    const early = await hook([{ ref: 'order-1', status: 'succeeded' }])
    expect(early.status).toBe(503)
    expect(early.headers.get('retry-after')).toBe('30')
    const s = await toPayment()
    expect((await hook([{ ref: 'order-1', status: 'succeeded' }])).status).toBe(200)
    expect((await ramp.sessions.retrieve(s.id))!.status).toBe('succeeded')
    // a repeat of the terminal status is verified and ignored
    expect((await hook([{ ref: 'order-1', status: 'succeeded' }])).status).toBe(200)
  })
})

describe('P1-9: retries for about 24 hours, then a dead letter', () => {
  it('keeps a dead letter after the retry window, and replay sends it again with the same id', async () => {
    vi.useFakeTimers({ now: Date.now() })
    const store = memoryStore()
    const errors: string[] = []
    const { ramp, app } = make({ store, logger: { ...quiet, error: (m) => errors.push(m) } })
    app.setAnswer(() => 503)
    const s = await ramp.sessions.create({ userId: 'u', destination: DEST, ttlMinutes: 7 * 24 * 60 })
    let dropped = 0
    for (let h = 0; h < 26; h += 2) {
      vi.setSystemTime(Date.now() + 2 * 60 * 60_000)
      dropped += (await ramp.sweep()).webhooks.dropped
    }
    expect(dropped).toBe(1)
    expect(errors).toContain('webhook moved to dead letter after retries')
    const tries = app.sent.filter((e) => e.type === 'session.created').length
    expect(tries).toBeGreaterThan(10)
    const rec = (await store.get(s.id)) as SessionRecord
    expect(rec.outbox).toHaveLength(1)
    expect(rec.outbox![0]!.deadAt).toBeDefined()
    expect((await ramp.sweep()).webhooks).toMatchObject({ retried: 0, pending: 0 })

    app.setAnswer(() => 200)
    expect(await ramp.webhooks.replay(s.id)).toBe(1)
    const ok = app.delivered('session.created')
    expect(ok).toHaveLength(1)
    expect(ok[0]!.id).toBe(await eventId(s.id, 'session.created:{}'))
    expect((await store.get(s.id))!.outbox).toBeUndefined()
    expect(await ramp.webhooks.replay(s.id)).toBe(0)
  })
})

describe('upgrade from the KV array lists', () => {
  it('moves the old open-session list and outbox entries to the queues', async () => {
    const store = memoryStore()
    const { ramp, app } = make({ store })
    const s = await ramp.sessions.create({ userId: 'u', destination: DEST })
    vi.useFakeTimers({ now: Date.now() + 31_000 })
    await ramp.sweep() // clears the new outbox entry of this session; the session stays open
    // The data an earlier version left behind
    await store.kv.put('open-sessions', [s.id])
    await store.kv.put('outbox', ['evt_old'])
    await store.kv.put('outbox:evt_old', { id: 'evt_old', type: 'session.succeeded', sessionId: s.id, body: '{"id":"evt_old","type":"session.succeeded"}', attempts: 2, nextAt: 0 })
    const r = await ramp.sweep()
    expect(r.webhooks).toMatchObject({ retried: 1, delivered: 1, pending: 0 })
    expect(r.sessions).toMatchObject({ checked: 1, open: 1 })
    expect(app.delivered('session.succeeded').map((e) => e.id)).toEqual(['evt_old'])
    expect(await store.kv.get('outbox')).toBeNull()
    expect(await store.kv.get('open-sessions')).toBeNull()
  })
})
