// Bridge standing deposit addresses: virtual accounts (fiat in) and liquidation addresses (USDC in).
// Fake fetch and Bridge fixtures. Each security rule has a test: the server-set destination, one user
// per customer, atomic deposit claims, the webhook-to-account binding, and the amount and currency checks.
import { describe, expect, it } from 'vitest'
import { checkAdapterShape, checkLegStep } from '@openrampkit/adapter'
import type { ScopedKV } from '@openrampkit/adapter'
import { fakeFetch, makeCtx, makeWebhookCtx, memoryKV, recordingLog } from '@openrampkit/adapter/testing'
import type { FakeRoute } from '@openrampkit/adapter/testing'
import { USDC, stateFor } from '@openrampkit/core'
import type { PathwayLeg } from '@openrampkit/core'
import { bridge } from './index.js'
import type { BridgeOptions } from './index.js'

const BASE = 'eip155:8453'
const ARB = 'eip155:42161'
const BASE_USDC = USDC[BASE]!
const ARB_USDC = USDC[ARB]!
const WALLET = '0x000000000000000000000000000000000000beef'
const DEST = { type: 'crypto' as const, chain: BASE, token: BASE_USDC, address: WALLET }
const LA_ADDR = '0x00000000000000000000000000000000000000la'.replace('la', '11')

const USD_INSTRUCTIONS = { currency: 'usd', bank_name: 'Lead Bank', bank_routing_number: '101019644', bank_account_number: '900123456789', bank_beneficiary_name: 'Jane Doe', payment_rails: ['ach_push', 'wire'] }
const vaObj = (over: Record<string, unknown> = {}) => ({ id: 'va_1', status: 'activated', customer_id: 'cust_1', source_deposit_instructions: USD_INSTRUCTIONS, destination: { currency: 'usdc', payment_rail: 'base', address: WALLET }, ...over })
const laObj = (over: Record<string, unknown> = {}) => ({ id: 'la_1', customer_id: 'cust_1', chain: 'arbitrum', currency: 'usdc', address: LA_ADDR, state: 'active', destination_payment_rail: 'base', destination_currency: 'usdc', destination_address: WALLET, ...over })
const active = { id: 'cust_1', status: 'active', endorsements: [{ name: 'base', status: 'approved' }, { name: 'sepa', status: 'approved' }] }

const opts = (over: Partial<BridgeOptions> = {}): BridgeOptions => ({ apiKey: 'sk-live-x', webhookPublicKey: 'pem', standing: true, customer: async () => ({ customerId: 'cust_1' }), ...over })

const iso = (ms = Date.now()) => new Date(ms).toISOString()
const vaEv = (type: string, over: Record<string, unknown> = {}) => ({ id: `e_${type}_${String(over.deposit_id ?? 'dep_1')}`, type, customer_id: 'cust_1', virtual_account_id: 'va_1', deposit_id: 'dep_1', amount: '100', currency: 'usd', created_at: iso(), ...over })
const drain = (over: Record<string, unknown> = {}) => ({ id: 'drn_1', customer_id: 'cust_1', liquidation_address_id: 'la_1', amount: '25', currency: 'usdc', state: 'funds_received', created_at: iso(), deposit_tx_hash: '0xdep', ...over })

type State = { vas: unknown[]; las: unknown[]; history: unknown[]; drains: unknown[]; customer: Record<string, unknown>; created?: Record<string, unknown> }

function routes(st: State): FakeRoute[] {
  return [
    { method: 'GET', match: /\/customers\/cust_\w+$/, reply: () => st.customer },
    { method: 'GET', match: /\/virtual_accounts\/va_1\/history/, reply: () => ({ count: st.history.length, data: st.history }) },
    { method: 'GET', match: /\/virtual_accounts\?/, reply: () => ({ count: st.vas.length, data: st.vas }) },
    { method: 'POST', match: /\/virtual_accounts$/, reply: (c) => st.created ?? vaObj({ destination: (c.body as { destination: unknown }).destination }) },
    { method: 'GET', match: /\/liquidation_addresses\/la_1\/drains/, reply: (c) => {
      const id = new URL(c.url).searchParams.get('drain_id')
      const data = id ? st.drains.filter((d) => (d as { id: string }).id === id) : st.drains
      return { count: data.length, data }
    } },
    { method: 'GET', match: /\/liquidation_addresses\?/, reply: () => ({ count: st.las.length, data: st.las }) },
    { method: 'POST', match: /\/liquidation_addresses$/, reply: () => st.created ?? laObj() },
  ]
}

function setup(over: Partial<BridgeOptions> = {}, shared: ScopedKV = memoryKV()) {
  const st: State = { vas: [], las: [], history: [], drains: [], customer: active }
  const ff = fakeFetch(routes(st))
  const log = recordingLog()
  const ctx = makeCtx({ fetch: ff.fetch, shared, log })
  const a = bridge(opts(over))
  return { st, a, ctx, shared, calls: ff.calls, log, w: makeWebhookCtx({ shared, fetch: ff.fetch, log }) }
}

const ui = (s: Parameters<typeof stateFor>[0]) => stateFor(s)
const leg: PathwayLeg = { adapterId: 'bridge', legId: 'standing', from: { asset: { kind: 'fiat', currency: 'USD' }, location: { kind: 'user_account' } }, to: { asset: { kind: 'crypto', chain: BASE, token: BASE_USDC }, location: { kind: 'address', address: WALLET } } }

async function account(t: ReturnType<typeof setup>, userId = 'u1') {
  return t.a.standingAccount!({ userId, origin: { currency: 'USD' }, destination: DEST }, t.ctx)
}
async function liq(t: ReturnType<typeof setup>, userId = 'u1') {
  return t.a.standingAddress!({ userId, origin: { chain: ARB, token: ARB_USDC }, destination: DEST }, t.ctx)
}
const vaDeps = (t: ReturnType<typeof setup>, ref: string, since = 0) => t.a.standingDeposits!({ ref, address: '900123456789', origin: { currency: 'USD' }, since }, t.ctx)
const laDeps = (t: ReturnType<typeof setup>, ref: string, since = 0) => t.a.standingDeposits!({ ref, address: LA_ADDR, origin: { chain: ARB, token: ARB_USDC }, since }, t.ctx)
const body = (category: string, obj: unknown, id = 'wh_1') => JSON.stringify({ api_version: 'v0', event_id: id, event_category: category, event_type: `${category}.created`, event_object: obj })

describe('bridge standing: shape', () => {
  it('is off by default, and with `standing` adds a hidden leg, the routes and the methods', async () => {
    const off = bridge(opts({ standing: false }))
    expect(off.standingAddress).toBeUndefined()
    expect(off.legs.some((l) => l.id === 'standing')).toBe(false)
    const on = bridge(opts())
    expect(checkAdapterShape(on)).toEqual([])
    expect(on.standingRoutes).toEqual(['convert', 'bank'])
    expect(on.legs.find((l) => l.id === 'standing')).toMatchObject({ methods: ['transfer'], surfaces: ['DEPOSIT_ADDRESS'] })
    // The planner never sees the standing leg.
    const planner = await on.catalog!({ currency: 'USD', direction: 'deposit' }, makeCtx({ fetch: fakeFetch([]).fetch }))
    expect(planner.some((l) => l.id === 'standing')).toBe(false)
    expect(planner.map((l) => l.id)).toContain('usd-ach')
  })
})

describe('bridge standing: virtual accounts (fiat in)', () => {
  it('opens a virtual account to the server destination, shows the bank details, and reuses it', async () => {
    const t = setup()
    const r = await account(t)
    expect(r).toMatchObject({ address: '900123456789', ref: 'bsa|va|va_1' })
    expect(r.bank.fields).toEqual(expect.arrayContaining([{ label: 'Routing number', value: '101019644', copy: true }, { label: 'Account number', value: '900123456789', copy: true }]))
    expect(r.bank.fields.some((f) => f.label === 'Amount')).toBe(false)
    const post = t.calls.find((c) => c.method === 'POST')!
    expect(post.body).toEqual({ source: { currency: 'usd' }, destination: { currency: 'usdc', payment_rail: 'base', address: WALLET } })
    expect(post.headers.get('Idempotency-Key')).toMatch(/^orb-sva-[0-9a-f]+$/)
    // Again: no new call to Bridge.
    const n = t.calls.length
    expect(await account(t)).toEqual(r)
    expect(t.calls.length).toBe(n)
  })

  it('reuses an account that Bridge already has for the route, and makes none', async () => {
    const t = setup()
    t.st.vas = [vaObj({ id: 'va_other', destination: { currency: 'usdc', payment_rail: 'base', address: '0x0000000000000000000000000000000000000bad' } }), vaObj()]
    expect((await account(t)).ref).toBe('bsa|va|va_1')
    expect(t.calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('security: refuses an account that Bridge says delivers to another destination (fail closed)', async () => {
    const t = setup()
    t.st.created = vaObj({ destination: { currency: 'usdc', payment_rail: 'base', address: '0x0000000000000000000000000000000000000bad' } })
    await expect(account(t)).rejects.toMatchObject({ status: 502 })
    t.st.created = vaObj({ destination: { currency: 'usdc', payment_rail: 'ethereum', address: WALLET } })
    await expect(account(t)).rejects.toMatchObject({ status: 502 })
    // No destination in Bridge's answer: no proof, refused.
    t.st.created = vaObj({ destination: undefined })
    await expect(account(t)).rejects.toMatchObject({ status: 502 })
    t.st.created = vaObj({ customer_id: 'cust_2' })
    await expect(account(t)).rejects.toMatchObject({ status: 502 })
  })

  it('security: the customer comes from the server only, belongs to one user, and must be active', async () => {
    // No hook and no earlier KYC: no account.
    const none = setup({ customer: undefined })
    await expect(account(none)).rejects.toMatchObject({ status: 409 })
    // A customer from an earlier Bridge KYC of the same user (the adapter's own record) works.
    await none.shared.put('user:u1', { customerId: 'cust_1' })
    expect((await account(none)).ref).toBe('bsa|va|va_1')
    // The hook gives the same customer for two users: the second user is refused.
    const t = setup()
    await account(t, 'u1')
    await expect(account(t, 'u2')).rejects.toMatchObject({ status: 409, error: { code: 'CONFLICT' } })
    expect(t.log.errors.some((e) => e.includes('two app users'))).toBe(true)
    // A customer that is not active, or has no endorsement for the rail.
    const paused = setup()
    paused.st.customer = { ...active, status: 'paused' }
    await expect(account(paused)).rejects.toMatchObject({ status: 409 })
    const noBase = setup()
    noBase.st.customer = { ...active, endorsements: [{ name: 'base', status: 'pending' }] }
    await expect(account(noBase)).rejects.toMatchObject({ status: 409 })
    // A currency without a rail, and a destination that is not USDC.
    const t2 = setup()
    await expect(t2.a.standingAccount!({ userId: 'u1', origin: { currency: 'JPY' }, destination: DEST }, t2.ctx)).rejects.toMatchObject({ status: 400 })
    await expect(t2.a.standingAccount!({ userId: 'u1', origin: { currency: 'USD' }, destination: { ...DEST, token: '0x0000000000000000000000000000000000000001' } }, t2.ctx)).rejects.toMatchObject({ status: 400 })
  })

  it('lists one deposit per deposit id once the money arrived, with its input in the account currency', async () => {
    const t = setup()
    const { ref } = await account(t)
    t.st.history = [
      vaEv('payment_processed', { amount: '99.5', currency: 'usdc' }),
      vaEv('funds_received'),
      // Only scheduled (ACH in transit): no session yet.
      vaEv('funds_scheduled', { deposit_id: 'dep_2' }),
      // A microdeposit is never a deposit.
      vaEv('microdeposit', { deposit_id: 'dep_3' }),
    ]
    const deps = await vaDeps(t, ref)
    expect(deps).toEqual([{ id: 'dep_1', legRef: 'bsd|va|va_1|dep_1', at: expect.any(Number), input: { value: '100', asset: { kind: 'fiat', currency: 'USD' } } }])
    // A repeat poll lists it again (the server dedupes by id).
    expect(await vaDeps(t, ref)).toEqual(deps)
  })

  it('security: amount and currency checks, and only events of this account and customer', async () => {
    const t = setup()
    const { ref } = await account(t)
    t.st.history = [
      vaEv('funds_received', { deposit_id: 'eur', currency: 'eur' }),
      vaEv('funds_received', { deposit_id: 'other_va', virtual_account_id: 'va_9' }),
      vaEv('funds_received', { deposit_id: 'other_cust', customer_id: 'cust_9' }),
      vaEv('payment_processed', { deposit_id: 'out_eurc', currency: 'eurc' }),
      vaEv('funds_received', { deposit_id: 'zero', amount: '0' }),
    ]
    const deps = await vaDeps(t, ref)
    // `zero` is a deposit with no usable amount: listed without an input.
    expect(deps).toEqual([{ id: 'zero', legRef: 'bsd|va|va_1|zero', at: expect.any(Number) }])
    expect(t.log.errors.filter((e) => e.includes('another currency'))).toHaveLength(2)
    // A deposit before the account existed belongs to earlier sessions.
    t.st.history = [vaEv('funds_received', { deposit_id: 'old', created_at: iso(Date.now() - 86_400_000) })]
    expect(await vaDeps(t, ref)).toEqual([])
    // The route of the ref must match.
    await expect(t.a.standingDeposits!({ ref, address: 'x', origin: { currency: 'EUR' }, since: 0 }, t.ctx)).rejects.toThrow(/does not match/)
    await expect(t.a.standingDeposits!({ ref: 'bsa|va|va_unknown', address: 'x', origin: { currency: 'USD' }, since: 0 }, t.ctx)).rejects.toThrow(/not known/)
  })

  it('security: one deposit, one owner (atomic claim shared with the session flow)', async () => {
    const t = setup()
    const { ref } = await account(t)
    t.st.history = [vaEv('funds_received'), vaEv('funds_received', { deposit_id: 'dep_2' })]
    // A session of the same account took dep_2 first.
    await t.shared.put('dep:dep_2', 'brg_session')
    const [a, b] = await Promise.all([vaDeps(t, ref), vaDeps(t, ref)])
    expect(a.map((d) => d.id)).toEqual(['dep_1'])
    expect(b).toEqual(a)
    expect(await t.shared.get('dep:dep_1')).toBe('standing:va_1')
    // status() of a deposit this account does not own: failed, never credited.
    const step = await t.a.status!({ leg, ref: 'bsd|va|va_1|dep_2' }, t.ctx)
    expect(step).toMatchObject({ status: 'failed', error: { code: 'DELIVERY_FAILED' } })
  })

  it('status follows the deposit to the destination, and fails a delivery somewhere else', async () => {
    const t = setup()
    const { ref } = await account(t)
    t.st.history = [vaEv('funds_received')]
    const [d] = await vaDeps(t, ref)
    const legRef = d!.legRef
    expect(await t.a.status!({ leg, ref: legRef }, t.ctx)).toMatchObject({ status: 'processing', detail: { code: 'settling' } })
    t.st.history = [vaEv('funds_received'), vaEv('payment_processed', { amount: '99.5', currency: 'usdc', destination_tx_hash: '0xabc', receipt: { final_amount: '99.5' } })]
    const done = await t.a.status!({ leg, ref: legRef }, t.ctx)
    expect(ui(done)).toBe('COMPLETED')
    expect(done).toMatchObject({ status: 'succeeded', providerRef: 'dep_1', output: { value: '99.5', asset: { kind: 'crypto', chain: BASE, token: BASE_USDC } }, transactions: [{ role: 'destination', chain: BASE, hash: '0xabc' }] })
    expect(checkLegStep(done)).toEqual([])
    t.st.history = [vaEv('funds_received'), vaEv('payment_processed', { currency: 'usdc', destination_payment_rail: 'ethereum' })]
    expect(await t.a.status!({ leg, ref: legRef }, t.ctx)).toMatchObject({ status: 'failed', error: { code: 'DELIVERY_FAILED' } })
    t.st.history = [vaEv('funds_received'), vaEv('refunded', { currency: 'usd' })]
    expect((await t.a.status!({ leg, ref: legRef }, t.ctx)).status).toBe('refunded')
  })

  it('webhooks: a new deposit is kept for the next poll, then events go to the owned deposit only', async () => {
    const t = setup()
    const { ref } = await account(t)
    // History is empty (Bridge lists it late): the webhook still makes the deposit known.
    expect(await t.a.webhook!.parse(body('virtual_account.activity', vaEv('funds_received')), t.w)).toEqual([])
    const deps = await vaDeps(t, ref)
    expect(deps.map((d) => d.id)).toEqual(['dep_1'])
    // Now this account owns dep_1: the next event maps to its leg ref, with the Bridge event id.
    const evs = await t.a.webhook!.parse(body('virtual_account.activity', vaEv('payment_processed', { currency: 'usdc', amount: '99.5' }), 'wh_2'), t.w)
    expect(evs).toEqual([{ ref: 'bsd|va|va_1|dep_1', eventId: 'wh_2', providerRef: 'dep_1', status: 'succeeded', output: { value: '99.5', asset: { kind: 'crypto', chain: BASE, token: BASE_USDC, symbol: 'USDC', decimals: 6 } } }])
  })

  it('security: a webhook binds to the account by the server index and its customer, never by the body alone', async () => {
    const t = setup()
    const { ref } = await account(t)
    t.st.history = [vaEv('funds_received')]
    await vaDeps(t, ref)
    // Another customer on the same account id: ignored.
    expect(await t.a.webhook!.parse(body('virtual_account.activity', vaEv('payment_processed', { customer_id: 'cust_evil', currency: 'usdc' })), t.w)).toEqual([])
    // An account that no standing address made: not a standing event.
    expect(await t.a.webhook!.parse(body('virtual_account.activity', vaEv('payment_processed', { virtual_account_id: 'va_x', currency: 'usdc' })), t.w)).toEqual([])
    // A deposit that a session owns goes to that session's ref, not to the standing account.
    await t.shared.put('dep:dep_7', 'brg_s1')
    await t.shared.put('leg:brg_s1', { kind: 'deposit', legId: 'usd-ach', userId: 'u1', since: 0, input: { value: '1', asset: { kind: 'fiat', currency: 'USD' } }, asset: { kind: 'crypto', chain: BASE, token: BASE_USDC }, address: WALLET, vaId: 'va_1' })
    expect(await t.a.webhook!.parse(body('virtual_account.activity', vaEv('funds_received', { deposit_id: 'dep_7' })), t.w)).toMatchObject([{ ref: 'brg_s1' }])
    // An account event (no deposit) is no leg event.
    expect(await t.a.webhook!.parse(body('virtual_account.activity', { id: 'e', type: 'account_update', virtual_account_id: 'va_1' }), t.w)).toEqual([])
  })
})

describe('bridge standing: liquidation addresses (USDC in)', () => {
  it('makes a liquidation address that drains to the server destination, and reuses it', async () => {
    const t = setup({ developerFeePercent: '0.5' })
    const r = await liq(t)
    expect(r).toMatchObject({ address: LA_ADDR, ref: 'bsa|la|la_1' })
    const post = t.calls.find((c) => c.method === 'POST')!
    expect(post.body).toEqual({ chain: 'arbitrum', currency: 'usdc', destination_payment_rail: 'base', destination_currency: 'usdc', destination_address: WALLET, custom_developer_fee_percent: '0.5' })
    expect(post.headers.get('Idempotency-Key')).toMatch(/^orb-sla-/)
    const n = t.calls.length
    expect(await liq(t)).toEqual(r)
    expect(t.calls.length).toBe(n)
  })

  it('finds an existing liquidation address for the route (Bridge refuses duplicates)', async () => {
    const t = setup()
    t.st.las = [laObj({ id: 'la_bank', external_account_id: 'ea_1', destination_address: undefined }), laObj()]
    expect((await liq(t)).ref).toBe('bsa|la|la_1')
    expect(t.calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('security: refuses an address that drains elsewhere, and routes it does not serve', async () => {
    const t = setup()
    t.st.created = laObj({ destination_address: '0x0000000000000000000000000000000000000bad' })
    await expect(liq(t)).rejects.toMatchObject({ status: 502 })
    t.st.created = laObj({ chain: 'ethereum' })
    await expect(liq(t)).rejects.toMatchObject({ status: 502 })
    t.st.created = laObj({ external_account_id: 'ea_1' })
    await expect(liq(t)).rejects.toMatchObject({ status: 502 })
    await expect(t.a.standingAddress!({ userId: 'u1', origin: { chain: BASE, token: BASE_USDC }, destination: DEST }, t.ctx)).rejects.toMatchObject({ status: 400 })
    await expect(t.a.standingAddress!({ userId: 'u1', origin: { chain: ARB, token: '0x0000000000000000000000000000000000000001' }, destination: DEST }, t.ctx)).rejects.toMatchObject({ status: 400 })
    // The customer binding holds here too.
    const u = setup()
    await liq(u, 'u1')
    await expect(liq(u, 'u2')).rejects.toMatchObject({ status: 409 })
  })

  it('lists drains once the funds are received, with the USDC input; checks currency, chain and owner', async () => {
    const t = setup()
    const { ref } = await liq(t)
    t.st.drains = [
      drain(),
      drain({ id: 'drn_wait', state: 'awaiting_funds' }),
      drain({ id: 'drn_usdt', currency: 'usdt' }),
      drain({ id: 'drn_chain', source_payment_rail: 'polygon' }),
      drain({ id: 'drn_other', liquidation_address_id: 'la_9' }),
      drain({ id: 'drn_cust', customer_id: 'cust_9' }),
      drain({ id: 'drn_new_state', state: 'brand_new' }),
      drain({ id: 'drn_old', created_at: iso(Date.now() - 86_400_000) }),
    ]
    await t.shared.put('drain:drn_taken', 'standing:la_other')
    t.st.drains.push(drain({ id: 'drn_taken' }))
    const deps = await laDeps(t, ref)
    expect(deps).toEqual([{ id: 'drn_1', legRef: 'bsd|la|la_1|drn_1', at: expect.any(Number), input: { value: '25', asset: { kind: 'crypto', chain: ARB, token: ARB_USDC, symbol: 'USDC', decimals: 6 } } }])
    expect(await t.shared.get('drain:drn_1')).toBe('standing:la_1')
  })

  it('status: delivered to the destination succeeds; elsewhere fails; no destination yet waits', async () => {
    const t = setup()
    const { ref } = await liq(t)
    t.st.drains = [drain()]
    const [d] = await laDeps(t, ref)
    const legRef = d!.legRef
    expect(await t.a.status!({ leg, ref: legRef }, t.ctx)).toMatchObject({ status: 'processing', providerRef: 'drn_1' })
    t.st.drains = [drain({ state: 'payment_processed', destination: { payment_rail: 'base', currency: 'usdc', to_address: WALLET }, destination_tx_hash: '0xout', receipt: { outgoing_amount: '24.9' } })]
    const done = await t.a.status!({ leg, ref: legRef }, t.ctx)
    expect(done).toMatchObject({ status: 'succeeded', output: { value: '24.9', asset: { chain: BASE, token: BASE_USDC } }, transactions: [{ role: 'source', chain: ARB, hash: '0xdep' }, { role: 'destination', chain: BASE, hash: '0xout' }] })
    expect(checkLegStep(done)).toEqual([])
    t.st.drains = [drain({ state: 'payment_processed', destination: { payment_rail: 'base', currency: 'usdc', to_address: '0x0000000000000000000000000000000000000bad' } })]
    expect(await t.a.status!({ leg, ref: legRef }, t.ctx)).toMatchObject({ status: 'failed', error: { code: 'DELIVERY_FAILED' } })
    t.st.drains = [drain({ state: 'payment_processed' })]
    expect((await t.a.status!({ leg, ref: legRef }, t.ctx)).status).toBe('processing')
    for (const [state, expected] of [['returned', 'failed'], ['refunded', 'refunded'], ['in_review', 'processing'], ['canceled', 'failed']] as const) {
      t.st.drains = [drain({ state })]
      expect([state, (await t.a.status!({ leg, ref: legRef }, t.ctx)).status]).toEqual([state, expected])
    }
  })

  it('webhooks: a drain event keeps a new drain for the poll, then maps owned drains; other addresses and customers are ignored', async () => {
    const t = setup()
    const { ref } = await liq(t)
    expect(await t.a.webhook!.parse(body('liquidation_address.drain', drain()), t.w)).toEqual([])
    expect((await laDeps(t, ref)).map((d) => d.id)).toEqual(['drn_1'])
    const ev = await t.a.webhook!.parse(body('liquidation_address.drain', drain({ state: 'payment_submitted' }), 'wh_9'), t.w)
    expect(ev).toEqual([{ ref: 'bsd|la|la_1|drn_1', eventId: 'wh_9', providerRef: 'drn_1', status: 'processing', detail: { code: 'settling', providerStatus: 'payment_submitted' }, transactions: [{ role: 'source', chain: ARB, hash: '0xdep' }] }])
    expect(await t.a.webhook!.parse(body('liquidation_address.drain', drain({ customer_id: 'cust_evil', state: 'payment_processed' })), t.w)).toEqual([])
    expect(await t.a.webhook!.parse(body('liquidation_address.drain', drain({ liquidation_address_id: 'la_9' })), t.w)).toEqual([])
    expect(await t.a.webhook!.parse(body('liquidation_address.drain', drain({ id: 'drn_x|evil' })), t.w)).toEqual([])
  })
})
