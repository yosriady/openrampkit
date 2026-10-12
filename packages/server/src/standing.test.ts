// Standing deposit addresses: one address per user and route, one session per deposit (never two),
// the usual session webhooks, the poll backoff and the 90-day stop.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAdapter } from '@openrampkit/adapter'
import type { StandingDeposit } from '@openrampkit/adapter'
import { USDC } from '@openrampkit/core'
import type { LegSpec, LegStatus } from '@openrampkit/core'
import { createOpenRamp, memoryStore } from './index.js'
import type { OpenRampConfig, SessionStore } from './index.js'
import { STANDING_FAST_MS, STANDING_IDLE_MAX_MS } from './standing.js'

const BASE = 'https://app.test/api/openramp'
const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const DEST = { type: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']!, address: '0x000000000000000000000000000000000000beef' }
const ORIGIN = { chain: 'eip155:42161', token: USDC['eip155:42161']! }
const HOOKS = { url: 'https://app.test/hooks', secret: 'w'.repeat(32) }
const DAY = 24 * 60 * 60_000

const transferSpec: LegSpec = {
  id: 'transfer',
  kind: 'bridge_swap',
  methods: ['transfer'],
  from: { asset: { kind: 'crypto', chains: '*' }, location: ['user_wallet'] },
  to: { asset: { kind: 'crypto', chains: '*' }, location: ['address'] },
  regions: { allow: ['*'], deny: [] },
  eta: { min: 10, max: 60 },
  surfaces: ['DEPOSIT_ADDRESS'],
}

/** A provider with standing addresses. `deposits` is what it lists; `statusOf` answers `status()` by ref. */
function standingAdapter() {
  const deposits: StandingDeposit[] = []
  const statusOf: Record<string, LegStatus> = {}
  const calls = { address: 0, deposits: 0, since: [] as number[] }
  const fail = { deposits: false }
  let n = 0
  const adapter = createAdapter({
    id: 'fake',
    name: 'Fake',
    legs: [transferSpec],
    async quote() {
      throw new Error('no quotes in this test')
    },
    async start() {
      throw new Error('no starts in this test')
    },
    async standingAddress(input, ctx) {
      calls.address++
      const key = `sa:${input.userId}:${input.origin.chain}:${input.destination.chain}`
      // A slow provider: two calls at the same time both get a new address.
      await new Promise((r) => setTimeout(r, 5))
      const cached = await ctx.shared.get<{ address: string; ref: string }>(key)
      if (cached) return cached
      const v = { address: `0x${(++n).toString(16).padStart(40, 'a')}`, ref: `ref-${n}` }
      await ctx.shared.put(key, v)
      return v
    },
    async standingDeposits({ since }) {
      calls.deposits++
      calls.since.push(since)
      if (fail.deposits) throw new Error('provider down')
      return deposits.filter((d) => d.at >= since)
    },
    async status({ ref }) {
      const status = statusOf[ref] ?? 'processing'
      return {
        status,
        ref,
        ...(status === 'succeeded' ? { output: { value: '9.9', asset: { kind: 'crypto' as const, chain: DEST.chain, token: DEST.token } }, transactions: [{ role: 'destination' as const, hash: '0xout' }] } : {}),
        ...(status === 'failed' ? { error: { code: 'DELIVERY_FAILED' as const, message: 'failed', recovery: 'contact_support' as const, retryable: false } } : {}),
      }
    },
  })
  return { adapter, deposits, statusOf, calls, fail }
}

type Sent = { type: string; sessionId: string; object: Record<string, unknown> }

function make(extra: Partial<OpenRampConfig> = {}) {
  const fake = standingAdapter()
  const sent: Sent[] = []
  const fetchFn: typeof fetch = async (_u, init) => {
    const body = JSON.parse(String(init?.body))
    sent.push({ type: body.type, sessionId: body.sessionId, object: body.data.object })
    return new Response('ok')
  }
  const store = (extra.store ?? memoryStore()) as SessionStore
  const ramp = createOpenRamp({ secret: 's'.repeat(40), baseUrl: BASE, adapters: [fake.adapter], logger: quiet, webhooks: HOOKS, fetch: fetchFn, store, ...extra })
  const get = (userId = 'u1') => ramp.depositAddresses.get({ userId, origin: ORIGIN, destination: DEST })
  /** The session ids that `deposit_address.deposit` named, in order */
  const depositSessions = () => sent.filter((s) => s.type === 'deposit_address.deposit').map((s) => s.sessionId)
  /** The next poll time of a standing address, or undefined when the watch stopped */
  const dueAt = async (id: string) => (await store.queue!.range!('standing-addresses', { max: Number.MAX_SAFE_INTEGER, limit: 100 })).find((x) => x.id === id)?.dueAt
  return { ramp, fake, sent, store, get, depositSessions, dueAt }
}

const deposit = (id: string, extra: Partial<StandingDeposit> = {}): StandingDeposit => ({
  id,
  legRef: `sreq:${id}`,
  at: Date.now(),
  input: { value: '10', asset: { kind: 'crypto', chain: ORIGIN.chain, token: ORIGIN.token } },
  ...extra,
})

afterEach(() => vi.useRealTimers())

describe('depositAddresses.get and list', () => {
  it('returns the same address for the same user and route, and calls the adapter once', async () => {
    const t = make()
    const a = await t.get()
    expect(a).toMatchObject({ id: expect.stringMatching(/^sda_[0-9a-f]{24}$/), userId: 'u1', adapterId: 'fake', origin: ORIGIN, destination: DEST })
    expect(a.address).toMatch(/^0x[0-9a-f]{40}$/)
    const b = await t.get()
    expect(b).toEqual(a)
    expect(t.fake.calls.address).toBe(1)
    // A token in other case is the same route.
    const c = await t.ramp.depositAddresses.get({ userId: 'u1', origin: { chain: ORIGIN.chain, token: ORIGIN.token.toUpperCase().replace('0X', '0x') }, destination: DEST })
    expect(c.id).toBe(a.id)
    // Another user gets another address.
    const other = await t.get('u2')
    expect(other.id).not.toBe(a.id)
    expect(other.address).not.toBe(a.address)
  })

  it('two calls at the same time return one address', async () => {
    const t = make()
    const [a, b] = await Promise.all([t.get(), t.get()])
    expect(t.fake.calls.address).toBe(2) // both asked the provider
    expect(a.address).toBe(b.address)
    expect(a.id).toBe(b.id)
    expect(await t.ramp.depositAddresses.list('u1')).toEqual([a])
  })

  it('list returns the addresses of one user, newest first', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-10T00:00:00Z'), toFake: ['Date'] })
    const t = make()
    const a = await t.get()
    vi.setSystemTime(Date.now() + 1000)
    const b = await t.ramp.depositAddresses.get({ userId: 'u1', origin: { chain: 'eip155:10', token: USDC['eip155:10']! }, destination: DEST })
    await t.get('u2')
    expect((await t.ramp.depositAddresses.list('u1')).map((x) => x.id)).toEqual([b.id, a.id])
    expect(await t.ramp.depositAddresses.list('nobody')).toEqual([])
  })

  it('checks the input like a session create', async () => {
    const t = make()
    const get = (input: unknown) => t.ramp.depositAddresses.get(input as Parameters<typeof t.ramp.depositAddresses.get>[0])
    const cases: Array<[unknown, RegExp]> = [
      [{ userId: '', origin: ORIGIN, destination: DEST }, /userId/],
      [{ userId: 'u', origin: ORIGIN, destination: { type: 'fiat', currency: 'USD' } }, /crypto `destination`/],
      [{ userId: 'u', origin: ORIGIN, destination: { ...DEST, address: 'nope' } }, /destination.address/],
      [{ userId: 'u', origin: { chain: 'arbitrum', token: ORIGIN.token }, destination: DEST }, /origin.chain/],
      [{ userId: 'u', origin: { chain: ORIGIN.chain, token: 'usdc' }, destination: DEST }, /origin.token/],
      [{ userId: 'u', origin: { chain: DEST.chain, token: DEST.token }, destination: DEST }, /same token on the same chain/],
      [{ userId: 'u', origin: ORIGIN, destination: { ...DEST, settlement: { contract: '0x0000000000000000000000000000000000000001' } } }, /settlement/],
    ]
    for (const [input, message] of cases) {
      await expect(get(input)).rejects.toMatchObject({ status: 400, error: { code: 'BAD_REQUEST', message: expect.stringMatching(message) } })
    }
    expect(t.fake.calls.address).toBe(0)
  })

  it('throws a clear error when no adapter gives standing addresses, or the adapter id is unknown', async () => {
    const plain = createAdapter({
      id: 'plain',
      name: 'Plain',
      legs: [transferSpec],
      async quote() {
        throw new Error('x')
      },
      async start() {
        throw new Error('x')
      },
      async status({ ref }) {
        return { status: 'processing', ref }
      },
    })
    const ramp = createOpenRamp({ secret: 's'.repeat(40), baseUrl: BASE, adapters: [plain], logger: quiet })
    await expect(ramp.depositAddresses.get({ userId: 'u', origin: ORIGIN, destination: DEST })).rejects.toMatchObject({
      status: 400,
      error: { message: expect.stringMatching(/No configured adapter gives standing deposit addresses/) },
    })
    await expect(ramp.depositAddresses.get({ userId: 'u', origin: ORIGIN, destination: DEST, adapterId: 'plain' })).rejects.toMatchObject({ status: 400 })
    await expect(ramp.depositAddresses.get({ userId: 'u', origin: ORIGIN, destination: DEST, adapterId: 'nope' })).rejects.toMatchObject({ status: 404 })
  })
})

describe('sweep: one session per deposit', () => {
  it('makes one session per deposit, never twice, and the session completes with the usual webhooks', async () => {
    const t = make()
    const addr = await t.get()
    expect((await t.ramp.sweep()).standing).toEqual({ checked: 1, deposits: 0 })
    t.fake.deposits.push(deposit('d1'))
    // The address is polled again only when it is due.
    expect((await t.ramp.sweep()).standing.checked).toBe(0)
    await t.get() // a get makes the next poll come at once
    expect((await t.ramp.sweep()).standing).toEqual({ checked: 1, deposits: 1 })
    const [sid] = t.depositSessions()
    const s = await t.ramp.sessions.retrieve(sid!)
    expect(s).toMatchObject({
      status: 'processing',
      userId: 'u1',
      standingAddressId: addr.id,
      metadata: { depositAddressId: addr.id, depositId: 'd1' },
      destination: DEST,
      payment: { method: 'transfer', provider: 'Fake', legs: [{ adapterId: 'fake', legId: 'transfer', ref: 'sreq:d1', status: 'processing', input: { value: '10' } }] },
    })
    expect(t.sent.filter((e) => e.sessionId === sid).map((e) => e.type)).toEqual(['session.created', 'deposit_address.deposit', 'session.processing'])
    expect(t.sent.find((e) => e.type === 'deposit_address.deposit')!.object).toMatchObject({ depositAddressId: addr.id, sessionId: sid, depositId: 'd1', input: { value: '10' } })

    // The same deposit again (a repeat poll, and after the seen list is gone): no second session.
    await t.get()
    expect((await t.ramp.sweep()).standing).toEqual({ checked: 1, deposits: 0 })
    await t.store.kv.put(`sda:${addr.id}:poll`, null)
    await t.get()
    expect((await t.ramp.sweep()).standing).toEqual({ checked: 1, deposits: 0 })
    expect(t.depositSessions()).toEqual([sid])

    // The provider reports success: the open-session list moves the session on.
    t.fake.statusOf['sreq:d1'] = 'succeeded'
    await t.ramp.sweep()
    const done = await t.ramp.sessions.retrieve(sid!)
    expect(done).toMatchObject({ status: 'succeeded', result: { output: { value: '9.9' }, outputConfirmed: true, delivery: { status: 'ok' } } })
    expect(t.sent.filter((e) => e.sessionId === sid).map((e) => e.type)).toContain('session.succeeded')

    // A second deposit: a second session.
    t.fake.deposits.push(deposit('d2'))
    await t.get()
    expect((await t.ramp.sweep()).standing.deposits).toBe(1)
    expect(t.depositSessions()).toHaveLength(2)
    expect(new Set(t.depositSessions()).size).toBe(2)
  })

  it('two sweeps at the same time make one session', async () => {
    const t = make()
    await t.get()
    t.fake.deposits.push(deposit('d1'), deposit('d2'))
    const [a, b] = await Promise.all([t.ramp.sweep(), t.ramp.sweep()])
    expect(a.standing.deposits + b.standing.deposits).toBe(2)
    expect(t.depositSessions()).toHaveLength(2)
    expect(new Set(t.depositSessions()).size).toBe(2)
  })

  it('a deposit whose leg ref already has a session is not a new deposit (the provider changed its id)', async () => {
    const t = make()
    await t.get()
    t.fake.deposits.push(deposit('id:1', { legRef: 'sreq:1' }))
    await t.ramp.sweep()
    t.fake.deposits.push(deposit('tx:0xabc', { legRef: 'sreq:1' }))
    await t.get()
    expect((await t.ramp.sweep()).standing.deposits).toBe(0)
    expect(t.depositSessions()).toHaveLength(1)
  })

  it('a failed deposit ends the session (failed, not a retryable attempt)', async () => {
    const t = make()
    await t.get()
    t.fake.deposits.push(deposit('d1'))
    await t.ramp.sweep()
    const [sid] = t.depositSessions()
    t.fake.statusOf['sreq:d1'] = 'failed'
    await t.ramp.sweep()
    expect(await t.ramp.sessions.retrieve(sid!)).toMatchObject({ status: 'failed' })
    const types = t.sent.filter((e) => e.sessionId === sid).map((e) => e.type)
    expect(types).toContain('session.failed')
    expect(types).not.toContain('session.payment_failed')
  })

  it('a session in progress does not expire at its deadline', async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
    const t = make()
    await t.get()
    t.fake.deposits.push(deposit('d1'))
    await t.ramp.sweep()
    const [sid] = t.depositSessions()
    vi.setSystemTime(Date.now() + 3 * DAY)
    await t.ramp.sweep()
    expect(await t.ramp.sessions.retrieve(sid!)).toMatchObject({ status: 'processing' })
    t.fake.statusOf['sreq:d1'] = 'succeeded'
    await t.ramp.sweep()
    expect(await t.ramp.sessions.retrieve(sid!)).toMatchObject({ status: 'succeeded' })
  })

  it('a malformed deposit is skipped, and a provider error waits for the next poll', async () => {
    const t = make()
    await t.get()
    t.fake.deposits.push({ id: '', legRef: 'x', at: Date.now() }, deposit('d1', { input: { value: 'lots', asset: { kind: 'crypto', chain: ORIGIN.chain, token: ORIGIN.token } } }))
    t.fake.fail.deposits = true
    expect((await t.ramp.sweep()).standing).toEqual({ checked: 1, deposits: 0 })
    t.fake.fail.deposits = false
    await t.get()
    expect((await t.ramp.sweep()).standing).toEqual({ checked: 1, deposits: 1 })
    // An input that is not a decimal is dropped: the leg quote input is 0.
    const s = await t.ramp.sessions.retrieve(t.depositSessions()[0]!)
    expect(s!.payment!.legs[0]!.input.value).toBe('0')
  })

  it('a sweep that stopped after its claim: the next poll makes the session, with the same id', async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
    const inner = memoryStore()
    let failNext = true
    const store: SessionStore = {
      ...inner,
      async put(rec, v) {
        // The first write of a new deposit session fails, as if the process stopped there.
        if (failNext && rec.id.startsWith('ors_') && v === undefined) {
          failNext = false
          throw new Error('store down')
        }
        return inner.put(rec, v)
      },
    }
    const t = make({ store })
    await t.get()
    t.fake.deposits.push(deposit('d1'))
    expect((await t.ramp.sweep()).standing.deposits).toBe(0)
    // Within 2 minutes the claim may belong to a running sweep: wait.
    vi.setSystemTime(Date.now() + 31_000)
    expect((await t.ramp.sweep()).standing.deposits).toBe(0)
    vi.setSystemTime(Date.now() + 2 * 60_000)
    await t.get()
    expect((await t.ramp.sweep()).standing.deposits).toBe(1)
    expect(t.depositSessions()).toHaveLength(1)
    await t.get()
    vi.setSystemTime(Date.now() + 60_000)
    expect((await t.ramp.sweep()).standing.deposits).toBe(0)
  })
})

describe('sweep: a stale claim', () => {
  it('one sweep takes over a stale claim and writes its own claim; a stopped sweep then does not write', async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
    const t = make()
    await t.get()
    t.fake.deposits.push(deposit('d1'))
    // A claim from a sweep that stopped 3 minutes ago, with no session
    const kv = t.store.kv
    const keys: string[] = []
    const realPut = kv.putIfAbsent!.bind(kv)
    kv.putIfAbsent = async (k, v, ttl) => {
      if (k.startsWith('standingdep:') && !k.includes(':take:')) {
        keys.push(k)
        await kv.put(k, { sessionId: 'stale', at: Date.now() - 3 * 60_000 }, ttl)
        return false
      }
      return realPut(k, v, ttl)
    }
    expect((await t.ramp.sweep()).standing.deposits).toBe(1)
    expect(t.depositSessions()).toHaveLength(1)
    // The claim now names this sweep, so the stopped sweep's check before its write fails
    expect(await kv.get<{ sessionId: string }>(keys[0]!)).toMatchObject({ sessionId: expect.stringMatching(/^ors_/) })
  })
})

describe('sweep: poll backoff and the 90-day stop', () => {
  it('polls every 30 s after a deposit, doubles to 10 minutes when idle, and a get starts again fast', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-10T00:00:00Z'), toFake: ['Date'] })
    const t = make()
    const addr = await t.get()
    const intervals: number[] = []
    for (let i = 0; i < 7; i++) {
      await t.ramp.sweep()
      const due = (await t.dueAt(addr.id))!
      intervals.push(due - Date.now())
      vi.setSystemTime(due)
    }
    expect(intervals).toEqual([STANDING_FAST_MS, 60_000, 120_000, 240_000, 480_000, STANDING_IDLE_MAX_MS, STANDING_IDLE_MAX_MS])
    // A deposit: 30 s for the next hour.
    t.fake.deposits.push(deposit('d1'))
    await t.ramp.sweep()
    expect((await t.dueAt(addr.id))! - Date.now()).toBe(STANDING_FAST_MS)
    vi.setSystemTime(Date.now() + 40 * 60_000)
    await t.ramp.sweep()
    expect((await t.dueAt(addr.id))! - Date.now()).toBe(STANDING_FAST_MS)
    vi.setSystemTime(Date.now() + 30 * 60_000)
    await t.ramp.sweep()
    expect((await t.dueAt(addr.id))! - Date.now()).toBe(60_000)
    // A get: the next poll comes at once, then 30 s.
    vi.setSystemTime(Date.now() + 1000)
    await t.get()
    expect(await t.dueAt(addr.id)).toBe(Date.now())
    await t.ramp.sweep()
    expect((await t.dueAt(addr.id))! - Date.now()).toBe(STANDING_FAST_MS)
  })

  it('each poll asks again for the last hour, not for all time', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-10T00:00:00Z'), toFake: ['Date'] })
    const t = make()
    const addr = await t.get()
    await t.ramp.sweep()
    vi.setSystemTime(Date.now() + 5 * 60 * 60_000)
    await t.get()
    await t.ramp.sweep()
    const created = Date.parse(addr.createdAt)
    expect(t.fake.calls.since[0]).toBe(created - 10 * 60_000)
    // One hour before the first poll is earlier than the address: the window still starts at the address.
    expect(t.fake.calls.since[1]).toBe(created - 10 * 60_000)
    // The second window starts one hour before the first poll (the overlap), not at the address creation.
    vi.setSystemTime(Date.now() + 5 * 60 * 60_000)
    await t.get()
    await t.ramp.sweep()
    expect(t.fake.calls.since[2]).toBe(Date.now() - 5 * 60 * 60_000 - 60 * 60_000)
  })

  it('stops after 90 days with no deposit and no get; a later get starts the watch again', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-01-01T00:00:00Z'), toFake: ['Date'] })
    const t = make()
    const addr = await t.get()
    await t.ramp.sweep()
    vi.setSystemTime(Date.now() + 91 * DAY)
    const before = t.fake.calls.deposits
    expect((await t.ramp.sweep()).standing.checked).toBe(0)
    expect(t.fake.calls.deposits).toBe(before)
    expect(await t.dueAt(addr.id)).toBeUndefined()
    expect((await t.ramp.sweep()).standing.checked).toBe(0)
    // A deposit during the pause is found once the watch starts again.
    t.fake.deposits.push(deposit('late'))
    await t.get()
    expect(await t.dueAt(addr.id)).toBe(Date.now())
    expect((await t.ramp.sweep()).standing).toEqual({ checked: 1, deposits: 1 })
  })
})

describe('widget: "Your deposit address"', () => {
  async function session(t: ReturnType<typeof make>, input: Record<string, unknown> = {}) {
    const s = await t.ramp.sessions.create({ userId: 'u1', country: 'SG', destination: DEST, ...input } as never)
    const call = (path: string, body: unknown = {}) =>
      t.ramp.handle(new Request(`${BASE}/sessions/${s.id}${path}`, { method: 'POST', headers: { authorization: `Bearer ${s.clientSecret}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    return { s, call }
  }

  it('the plan offers the method only with depositAddresses.widget', async () => {
    const off = make()
    const a = await session(off)
    const planOff = await (await a.call('/plan')).json()
    expect(planOff.methods.map((m: { method: string }) => m.method)).not.toContain('deposit_address')
    expect((await a.call('/deposit-address', ORIGIN)).status).toBe(404)

    const on = make({ depositAddresses: { widget: true } })
    const b = await session(on)
    const plan = await (await b.call('/plan')).json()
    expect(plan.methods.find((m: { method: string }) => m.method === 'deposit_address')).toMatchObject({ name: 'Your deposit address', kind: 'crypto', group: 'more' })
  })

  it('the route returns the session user\'s address, the same on each call, without the user id', async () => {
    const t = make({ depositAddresses: { widget: true } })
    const { call } = await session(t)
    const r1 = await (await call('/deposit-address', ORIGIN)).json()
    const r2 = await (await call('/deposit-address', ORIGIN)).json()
    expect(r1).toEqual(r2)
    expect(r1).toMatchObject({ id: expect.stringMatching(/^sda_/), address: expect.stringMatching(/^0x/), origin: ORIGIN, destination: { chain: DEST.chain, token: DEST.token } })
    expect(r1.userId).toBeUndefined()
    expect(r1.adapterId).toBeUndefined()
    // The backend API sees the same address for this user
    expect((await t.get('u1')).address).toBe(r1.address)
  })

  it('refuses a bad body, and hides the method when allowedMethods leaves it out', async () => {
    const t = make({ depositAddresses: { widget: true } })
    const { call } = await session(t)
    expect((await call('/deposit-address', { chain: 'eip155:42161' })).status).toBe(400)
    expect((await call('/deposit-address', { chain: 'nope', token: ORIGIN.token })).status).toBe(400)
    const limited = await session(t, { allowedMethods: ['transfer'] })
    const plan = await (await limited.call('/plan')).json()
    expect(plan.methods.map((m: { method: string }) => m.method)).not.toContain('deposit_address')
    // The route has the same gates as the plan
    expect((await limited.call('/deposit-address', ORIGIN)).status).toBe(409)
    const disabled = make({ depositAddresses: { widget: true }, policy: { disabledMethods: ['deposit_address'] } })
    expect((await (await session(disabled)).call('/deposit-address', ORIGIN)).status).toBe(409)
  })
})
