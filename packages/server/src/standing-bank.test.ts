// Standing bank accounts (a fiat origin, the `bank` route): the address record has the bank details,
// each bank deposit makes one deposit session with a fiat input, the input currency is checked, and the
// destination is bound like a converting route.
import { describe, expect, it, vi } from 'vitest'
import { createAdapter } from '@openrampkit/adapter'
import type { StandingDeposit } from '@openrampkit/adapter'
import { USDC } from '@openrampkit/core'
import type { LegSpec, LegStatus } from '@openrampkit/core'
import { createOpenRamp, memoryStore } from './index.js'
import type { SessionStore } from './index.js'

const BASE = 'https://app.test/api/openramp'
const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const DEST = { type: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']!, address: '0x000000000000000000000000000000000000beef' }
const HOOKS = { url: 'https://app.test/hooks', secret: 'w'.repeat(32) }

const transferSpec: LegSpec = {
  id: 'standing',
  kind: 'wallet_transfer',
  methods: ['transfer'],
  from: { asset: { kind: 'crypto', chains: '*' }, location: ['user_wallet'] },
  to: { asset: { kind: 'crypto', chains: '*' }, location: ['address'] },
  regions: { allow: ['*'], deny: [] },
  eta: { min: 10, max: 60 },
  surfaces: ['DEPOSIT_ADDRESS'],
}

const FIELDS = [
  { label: 'Routing number', value: '101019644', copy: true },
  { label: 'Account number', value: '900123456789', copy: true },
]

function bankAdapter(opts: { bank?: unknown; routes?: Array<'convert' | 'same' | 'bank'>; currencies?: string[] } = {}) {
  const deposits: StandingDeposit[] = []
  const statusOf: Record<string, LegStatus> = {}
  const calls = { account: 0, inputs: [] as unknown[] }
  const adapter = createAdapter({
    id: 'bank',
    name: 'Bank',
    legs: [transferSpec],
    standingRoutes: opts.routes ?? ['bank'],
    ...(opts.currencies ? { standingCurrencies: opts.currencies } : {}),
    async quote() {
      throw new Error('no quotes')
    },
    async start() {
      throw new Error('no starts')
    },
    async standingAccount(input) {
      calls.account++
      return { address: '900123456789', ref: `acct:${input.userId}:${input.origin.currency}`, bank: ('bank' in opts ? opts.bank : { fields: FIELDS }) as { fields: typeof FIELDS } }
    },
    async standingDeposits(input) {
      calls.inputs.push(input)
      return deposits.filter((d) => d.at >= input.since)
    },
    async status({ ref }) {
      const status = statusOf[ref] ?? 'processing'
      return { status, ref, ...(status === 'succeeded' ? { output: { value: '99', asset: { kind: 'crypto' as const, chain: DEST.chain, token: DEST.token } }, transactions: [{ role: 'destination' as const, hash: '0xout' }] } : {}) }
    },
  })
  return { adapter, deposits, statusOf, calls }
}

function make(fake = bankAdapter(), extra: { adapters?: ReturnType<typeof createAdapter>[]; config?: Partial<Parameters<typeof createOpenRamp>[0]> } = {}) {
  const sent: Array<{ type: string; sessionId: string; object: Record<string, unknown> }> = []
  const fetchFn: typeof fetch = async (_u, init) => {
    const body = JSON.parse(String(init?.body))
    sent.push({ type: body.type, sessionId: body.sessionId, object: body.data.object })
    return new Response('ok')
  }
  const store = memoryStore() as SessionStore
  const ramp = createOpenRamp({ secret: 's'.repeat(40), baseUrl: BASE, adapters: extra.adapters ?? [fake.adapter], logger: quiet, webhooks: HOOKS, fetch: fetchFn, store, ...extra.config })
  const get = (userId = 'u1', currency = 'usd') => ramp.depositAddresses.get({ userId, origin: { currency }, destination: DEST })
  return { ramp, fake, sent, store, get }
}

describe('standing bank accounts (fiat origin)', () => {
  it('returns the bank details, the same account for the same user and currency, and calls the adapter once', async () => {
    const t = make()
    const a = await t.get()
    expect(a).toMatchObject({ id: expect.stringMatching(/^sda_/), userId: 'u1', adapterId: 'bank', address: '900123456789', origin: { currency: 'USD' }, bank: { fields: FIELDS }, destination: DEST })
    expect(await t.get('u1', 'USD')).toEqual(a)
    expect(t.fake.calls.account).toBe(1)
    expect(await t.ramp.depositAddresses.list('u1')).toEqual([a])
    // Another currency is another route.
    expect((await t.get('u1', 'EUR')).id).not.toBe(a.id)
  })

  it('checks the input, and needs an adapter that serves the bank route', async () => {
    const t = make()
    const get = (input: unknown) => t.ramp.depositAddresses.get(input as Parameters<typeof t.ramp.depositAddresses.get>[0])
    await expect(get({ userId: 'u', origin: { currency: 'US' }, destination: DEST })).rejects.toMatchObject({ status: 400, error: { message: expect.stringMatching(/origin.currency/) } })
    await expect(get({ userId: 'u', origin: { currency: 'USD', chain: 'eip155:1' }, destination: DEST })).rejects.toMatchObject({ status: 400 })
    await expect(get({ userId: 'u', origin: { currency: 'USD' }, destination: { type: 'fiat', currency: 'USD' } })).rejects.toMatchObject({ status: 400 })
    // A crypto origin with an adapter that only serves bank accounts: refused, no adapter call.
    await expect(get({ userId: 'u', origin: { chain: 'eip155:42161', token: USDC['eip155:42161'] }, destination: DEST })).rejects.toMatchObject({ status: 400 })
    expect(t.fake.calls.account).toBe(0)
    // An adapter with standingAccount but without 'bank' in its routes does not serve it.
    const noBank = make(bankAdapter({ routes: ['convert'] }))
    await expect(noBank.get()).rejects.toMatchObject({ status: 400, error: { message: expect.stringMatching(/standing bank accounts/) } })
  })

  it('refuses bank details that are not well formed (fail closed)', async () => {
    for (const bank of [undefined, { fields: [] }, { fields: [{ label: 'x', value: '' }] }, { fields: 'nope' }]) {
      const t = make(bankAdapter({ bank }))
      await expect(t.get()).rejects.toMatchObject({ status: 502 })
      expect(await t.ramp.depositAddresses.list('u1')).toEqual([])
    }
  })

  it('a bank route binds its destination like a converting route: a same-chain watch of it is refused', async () => {
    const watch = createAdapter({
      id: 'watch',
      name: 'Watch',
      legs: [{ ...transferSpec, id: 'transfer' }],
      standingRoutes: ['same'],
      async quote() {
        throw new Error('x')
      },
      async start() {
        throw new Error('x')
      },
      async standingAddress(input) {
        return { address: input.destination.address, ref: 'w' }
      },
      async standingDeposits() {
        return []
      },
      async status({ ref }) {
        return { status: 'processing', ref }
      },
    })
    const fake = bankAdapter()
    const t = make(fake, { adapters: [fake.adapter, watch] })
    await t.get()
    await expect(t.ramp.depositAddresses.get({ userId: 'u1', origin: { chain: DEST.chain, token: DEST.token }, destination: DEST, dedicatedDestination: true })).rejects.toMatchObject({ status: 409 })
  })

  it('makes one deposit session per bank deposit, with a fiat input, and passes the currency to standingDeposits', async () => {
    const t = make()
    const addr = await t.get()
    t.fake.deposits.push({ id: 'dep_1', legRef: 'bsd|va|va_1|dep_1', at: Date.now(), input: { value: '100', asset: { kind: 'fiat', currency: 'USD' } } })
    expect((await t.ramp.sweep()).standing).toEqual({ checked: 1, deposits: 1 })
    expect(t.fake.calls.inputs[0]).toMatchObject({ ref: 'acct:u1:USD', address: '900123456789', origin: { currency: 'USD' } })
    const sid = t.sent.find((e) => e.type === 'deposit_address.deposit')!.sessionId
    const s = await t.ramp.sessions.retrieve(sid)
    expect(s).toMatchObject({
      status: 'processing',
      userId: 'u1',
      standingAddressId: addr.id,
      destination: DEST,
      payment: { method: 'transfer', legs: [{ adapterId: 'bank', legId: 'standing', ref: 'bsd|va|va_1|dep_1', input: { value: '100', asset: { kind: 'fiat', currency: 'USD' } } }] },
    })
    // Again: no second session.
    await t.get()
    expect((await t.ramp.sweep()).standing.deposits).toBe(0)
    t.fake.statusOf['bsd|va|va_1|dep_1'] = 'succeeded'
    await t.ramp.sweep()
    expect(await t.ramp.sessions.retrieve(sid)).toMatchObject({ status: 'succeeded', result: { output: { value: '99' } } })
  })

  it('an input in another currency than the account is left out (the session still records the deposit)', async () => {
    const t = make()
    await t.get()
    t.fake.deposits.push({ id: 'dep_eur', legRef: 'bsd|va|va_1|dep_eur', at: Date.now(), input: { value: '100', asset: { kind: 'fiat', currency: 'EUR' } } })
    t.fake.deposits.push({ id: 'dep_crypto', legRef: 'bsd|va|va_1|dep_crypto', at: Date.now(), input: { value: '100', asset: { kind: 'crypto', chain: DEST.chain, token: DEST.token } } })
    expect((await t.ramp.sweep()).standing.deposits).toBe(2)
    const inputs = t.sent.filter((e) => e.type === 'deposit_address.deposit').map((e) => e.object.input)
    expect(inputs).toEqual([undefined, undefined])
  })
})

describe('widget: standing bank accounts', () => {
  const widget = (currencies: string[] | undefined = ['USD', 'eur'], config: Partial<Parameters<typeof createOpenRamp>[0]> = {}) => {
    const fake = bankAdapter(currencies ? { currencies } : {})
    return make(fake, { config: { depositAddresses: { widget: true }, ...config } })
  }
  async function session(t: ReturnType<typeof make>, input: Record<string, unknown> = {}) {
    const s = await t.ramp.sessions.create({ userId: 'u1', country: 'US', destination: DEST, ...input } as never)
    const call = (path: string, body: unknown = {}) =>
      t.ramp.handle(new Request(`${BASE}/sessions/${s.id}${path}`, { method: 'POST', headers: { authorization: `Bearer ${s.clientSecret}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    return { s, call }
  }
  const methodOf = async (call: Awaited<ReturnType<typeof session>>['call']) =>
    ((await (await call('/plan')).json()).methods as Array<{ method: string; standingOrigins?: unknown }>).find((m) => m.method === 'deposit_address')

  it('the plan offers the method with the bank currencies, and no crypto origin when no adapter converts tokens', async () => {
    const t = widget()
    expect(await methodOf((await session(t)).call)).toMatchObject({ method: 'deposit_address', providers: ['Bank'], standingOrigins: { crypto: false, currencies: ['USD', 'EUR'] } })
    // No currencies in `standingCurrencies`: the widget offers no bank account (the backend API still does)
    expect(await methodOf((await session(widget([]))).call)).toBeUndefined()
    // Off without the option
    expect(await methodOf((await session(make(bankAdapter({ currencies: ['USD'] })))).call)).toBeUndefined()
  })

  it("the route returns the session user's bank account for the session destination, with its bank details", async () => {
    const t = widget()
    const { call } = await session(t)
    const res = await call('/deposit-address', { currency: 'usd' })
    expect(res.status).toBe(200)
    const view = await res.json()
    expect(view).toEqual({ id: expect.stringMatching(/^sda_/), address: '900123456789', origin: { currency: 'USD' }, bank: { fields: FIELDS }, destination: { chain: DEST.chain, token: DEST.token } })
    // The backend API sees the same account for this user
    expect((await t.get('u1', 'USD')).id).toBe(view.id)
    expect(t.fake.calls.account).toBe(1)
  })

  it('the browser picks only a listed currency: the user, the destination and the adapter come from the server', async () => {
    const t = widget()
    const { call } = await session(t)
    // Fields that the server sets are ignored
    const view = await (await call('/deposit-address', { currency: 'EUR', userId: 'u2', destination: { ...DEST, address: '0x000000000000000000000000000000000000dEaD' }, adapterId: 'other' })).json()
    expect(view.destination).toEqual({ chain: DEST.chain, token: DEST.token })
    expect(await t.ramp.depositAddresses.list('u2')).toEqual([])
    expect((await t.ramp.depositAddresses.list('u1')).map((a) => a.id)).toEqual([view.id])
    // A currency that the adapter does not list, a bad currency, or both kinds of origin: refused, no adapter call
    const before = t.fake.calls.account
    for (const body of [{ currency: 'GBP' }, { currency: 12 }, { currency: '' }, { currency: 'USD', chain: 'eip155:42161', token: USDC['eip155:42161'] }]) {
      expect((await call('/deposit-address', body)).status).toBe(400)
    }
    expect(t.fake.calls.account).toBe(before)
    // A crypto origin with an adapter that gives only bank accounts
    expect((await call('/deposit-address', { chain: 'eip155:42161', token: USDC['eip155:42161'] })).status).toBe(409)
  })

  it('the route has the same gates as the plan', async () => {
    const t = widget()
    const limited = await session(t, { allowedMethods: ['transfer'] })
    expect(await methodOf(limited.call)).toBeUndefined()
    expect((await limited.call('/deposit-address', { currency: 'USD' })).status).toBe(409)
    const disabled = widget(['USD'], { policy: { disabledMethods: ['deposit_address'] } })
    expect((await (await session(disabled)).call('/deposit-address', { currency: 'USD' })).status).toBe(409)
    const off = make(bankAdapter({ currencies: ['USD'] }))
    expect((await (await session(off)).call('/deposit-address', { currency: 'USD' })).status).toBe(404)
    expect(t.fake.calls.account + disabled.fake.calls.account + off.fake.calls.account).toBe(0)
  })
})

describe('widget: standing bank accounts go only to the session user', () => {
  const ACCOUNT = '900123456789'
  const widget = (config: Partial<Parameters<typeof createOpenRamp>[0]> = {}) => make(bankAdapter({ currencies: ['USD'] }), { config: { depositAddresses: { widget: true }, ...config } })
  async function session(t: ReturnType<typeof make>, userId = 'u1') {
    const s = await t.ramp.sessions.create({ userId, country: 'US', destination: DEST })
    const call = (path: string, body?: unknown, auth = s.clientSecret, key?: string) =>
      t.ramp.handle(
        new Request(`${BASE}/sessions/${s.id}${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      )
    return { s, call }
  }
  const payCredential = async (call: Awaited<ReturnType<typeof session>>['call']) => {
    const link = (await (await call('/pay-link', {})).json()) as { url: string }
    return link.url.slice(link.url.indexOf('/pay/') + 5)
  }

  it('a pay link gets 403 for a bank account and an address, cannot replay the user\'s answer, and its plan has no deposit_address', async () => {
    const t = widget()
    const { call } = await session(t)
    // The user asks first, with an Idempotency-Key
    expect((await call('/deposit-address', { currency: 'USD' }, undefined, 'k1')).status).toBe(200)
    const cred = await payCredential(call)
    const calls = t.fake.calls.account
    for (const body of [{ currency: 'USD' }, { chain: 'eip155:42161', token: USDC['eip155:42161'] }]) {
      const res = await call('/deposit-address', body, cred)
      expect(res.status).toBe(403)
      expect(await res.text()).not.toContain(ACCOUNT)
    }
    // The same key and body as the user's request: refused before the idempotency cache
    const replay = await call('/deposit-address', { currency: 'USD' }, cred, 'k1')
    expect(replay.status).toBe(403)
    expect(await replay.text()).not.toContain(ACCOUNT)
    expect(t.fake.calls.account).toBe(calls)
    const plan = await (await call('/plan', {}, cred)).json()
    expect(plan.methods.map((m: { method: string }) => m.method)).not.toContain('deposit_address')
    // The client secret still sees the method
    const own = await (await call('/plan', {})).json()
    expect(own.methods.map((m: { method: string }) => m.method)).toContain('deposit_address')
  })

  it("each session gets only its own user's account", async () => {
    const t = widget()
    const a = await (await (await session(t, 'u1')).call('/deposit-address', { currency: 'USD' })).json()
    const b = await (await (await session(t, 'u2')).call('/deposit-address', { currency: 'USD' })).json()
    expect(a.id).not.toBe(b.id)
    expect((await t.ramp.depositAddresses.list('u1')).map((x) => x.id)).toEqual([a.id])
    expect((await t.ramp.depositAddresses.list('u2')).map((x) => x.id)).toEqual([b.id])
    expect(t.fake.calls.account).toBe(2)
  })

  it('refuses a final session (409) and a session past its deadline (410)', async () => {
    const t = widget()
    const canceled = await session(t)
    expect((await canceled.call('/cancel', {})).status).toBe(200)
    expect((await canceled.call('/deposit-address', { currency: 'USD' })).status).toBe(409)
    const late = await session(t)
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 48 * 60 * 60_000)
      expect((await late.call('/deposit-address', { currency: 'USD' })).status).toBe(410)
    } finally {
      vi.useRealTimers()
    }
    expect(t.fake.calls.account).toBe(0)
  })

  it('refuses a session of another mode: a test session never gets an account from a live server (409)', async () => {
    const t = widget()
    const { s } = await session(t)
    const live = createOpenRamp({ secret: 's'.repeat(40), baseUrl: BASE, adapters: [t.fake.adapter], logger: quiet, webhooks: HOOKS, store: t.store, livemode: true, depositAddresses: { widget: true } })
    const res = await live.handle(
      new Request(`${BASE}/sessions/${s.id}/deposit-address`, { method: 'POST', headers: { authorization: `Bearer ${s.clientSecret}`, 'content-type': 'application/json' }, body: JSON.stringify({ currency: 'USD' }) }),
    )
    expect(res.status).toBe(409)
    expect(t.fake.calls.account).toBe(0)
  })

  it('counts against the rate limit, and the bank details show nowhere else: session view, history, logs', async () => {
    const lines: string[] = []
    const log = (msg: string, data?: unknown) => void lines.push(`${msg} ${JSON.stringify(data ?? {})}`)
    const t = widget({ limits: { providerCallsPerMinute: 3 }, history: true, logger: { debug: log, info: log, warn: log, error: log } })
    const { call } = await session(t)
    const view = await (await call('/deposit-address', { currency: 'USD' })).json()
    // Only what the widget shows: no user id, adapter id or provider ref
    expect(Object.keys(view).sort()).toEqual(['address', 'bank', 'destination', 'id', 'origin'])
    expect(JSON.stringify(view)).not.toContain('acct:')
    expect(await (await call('')).text()).not.toContain(ACCOUNT)
    expect(await (await call('/history')).text()).not.toContain(ACCOUNT)
    expect(lines.join('\n')).not.toContain(ACCOUNT)
    // The limit is 3: the first call, the history call (it counts too), then one more
    expect((await call('/deposit-address', { currency: 'USD' })).status).toBe(200)
    expect((await call('/deposit-address', { currency: 'USD' })).status).toBe(429)
  })
})
