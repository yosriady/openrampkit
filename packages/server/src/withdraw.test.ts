// Withdraw sessions: creation, the /target route (validation, allowedTargets, screening), custody by the
// user's wallet or the app's treasury, the mock offramp, events that carry a surface, and webhooks.
import { describe, expect, it, vi } from 'vitest'
import { createAdapter } from '@openrampkit/adapter'
import type { LegEvent } from '@openrampkit/adapter'
import { mockAdapter } from '@openrampkit/adapter-mock'
import { USDC } from '@openrampkit/core'
import type { PlanResult, PublicSession, Quote, WithdrawSource } from '@openrampkit/core'
import { createOpenRamp, isValidAddress } from './index.js'
import type { CreateSessionInput, OpenRampConfig, TreasurySendInput } from './index.js'
import { legStepFromEvent } from './legs.js'

const BASE = 'https://app.test/api/openramp'
const HOOK = 'https://app.test/hooks'
const SECRET = 's'.repeat(40)
const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const USER = '0x1111111111111111111111111111111111111111'
const ARB_ADDR = '0x2222222222222222222222222222222222222222'
const TX = `0x${'ab'.repeat(32)}`
const SRC_USER: WithdrawSource = { chain: 'eip155:8453', token: USDC['eip155:8453']!.toUpperCase().replace('0X', '0x'), custody: 'user_wallet' }
const SRC_APP: WithdrawSource = { chain: 'eip155:8453', token: USDC['eip155:8453']!, custody: 'app' }
const TO_ARB = { type: 'crypto', chain: 'eip155:42161', token: USDC['eip155:42161']!, address: ARB_ADDR }

type Hook = { type: string; data: { object: { session: PublicSession } } }

function make(extra: Partial<OpenRampConfig> = {}, adapters = [mockAdapter({ settleMs: 0, crypto: true, offramp: true })]) {
  const hooks: Hook[] = []
  const fetchHooks: typeof fetch = async (input, init) => {
    if (String(input) === HOOK) hooks.push(JSON.parse(String(init?.body)) as Hook)
    return new Response('{}')
  }
  const ramp = createOpenRamp({ secret: SECRET, baseUrl: BASE, adapters, logger: quiet, webhooks: { url: HOOK, secret: 'whsec_test_0123456789' }, fetch: fetchHooks, ...extra })
  const call = async <T = unknown>(path: string, secret: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const headers = new Headers({ authorization: `Bearer ${secret}` })
    if (body !== undefined) headers.set('content-type', 'application/json')
    const res = await ramp.handle(new Request(`${BASE}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }))
    return { status: res.status, body: (await res.json()) as T & { error?: { code: string; message: string } } }
  }
  const create = (input: Partial<CreateSessionInput> = {}) =>
    ramp.sessions.create({ userId: 'u1', direction: 'withdraw', source: SRC_USER, country: 'PH', ...input } as CreateSessionInput)
  return { ramp, call, create, hooks }
}

/** Target, quote and select in one go. Returns the session after select. */
async function run(t: ReturnType<typeof make>, s: { id: string; clientSecret: string }, target: unknown, method: string, amount = '25', wallet = true) {
  const plan = await t.call<PlanResult>(`/sessions/${s.id}/target`, s.clientSecret, { ...(target as object), walletConnected: wallet, ...(wallet ? { walletAddress: USER } : {}) })
  expect(plan.status).toBe(200)
  const q = await t.call<{ quotes: Quote[] }>(`/sessions/${s.id}/quotes`, s.clientSecret, { method, amount })
  expect(q.status).toBe(200)
  const sel = await t.call<PublicSession>(`/sessions/${s.id}/select`, s.clientSecret, { quoteId: q.body.quotes[0]!.id })
  expect(sel.status).toBe(200)
  return { plan: plan.body, quote: q.body.quotes[0]!, session: sel.body }
}

describe('withdraw sessions: creation', () => {
  it('needs a valid source, takes no destination, and publishes source and allowedTargets', async () => {
    const { create, ramp } = make()
    await expect(create({ source: undefined })).rejects.toMatchObject({ error: { code: 'BAD_REQUEST', message: expect.stringMatching(/source/) } })
    await expect(create({ source: { ...SRC_USER, chain: 'base' } })).rejects.toMatchObject({ status: 400 })
    await expect(create({ source: { ...SRC_USER, token: '0x12' } })).rejects.toMatchObject({ status: 400 })
    await expect(create({ source: { ...SRC_USER, custody: 'bank' as never } })).rejects.toMatchObject({ status: 400 })
    await expect(create({ destination: { type: 'merchant', currency: 'PHP' } })).rejects.toMatchObject({ error: { message: expect.stringMatching(/not `destination`/) } })
    await expect(ramp.sessions.create({ userId: 'u', direction: 'sideways' as never })).rejects.toMatchObject({ status: 400 })
    await expect(ramp.sessions.create({ userId: 'u' } as CreateSessionInput)).rejects.toMatchObject({ error: { message: /needs `destination`/ } })

    const s = await create({ allowedTargets: { crypto: { chains: ['eip155:42161'] } } })
    const pub = (await ramp.sessions.retrieve(s.id))!
    expect(pub).toMatchObject({ direction: 'withdraw', source: { chain: 'eip155:8453', token: USDC['eip155:8453'], symbol: 'USDC', decimals: 6, custody: 'user_wallet' }, allowedTargets: { crypto: { chains: ['eip155:42161'] } } })
    expect(pub.destination).toBeUndefined()
    // A native source gets the chain's symbol; an unknown token keeps what the app gave.
    const n = await create({ source: { chain: 'eip155:42161', token: 'native', custody: 'app' } })
    expect((await ramp.sessions.retrieve(n.id))!.source).toMatchObject({ symbol: 'ETH', decimals: 18 })
    const o = await create({ source: { chain: 'eip155:1', token: '0x' + '3'.repeat(40), symbol: 'ABC', decimals: 8, custody: 'user_wallet' } })
    expect((await ramp.sessions.retrieve(o.id))!.source).toMatchObject({ symbol: 'ABC', decimals: 8 })
    // Solana and other chains: token formats per namespace, addresses kept as given.
    const sol = await create({ source: { chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', token: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', custody: 'app' } })
    expect((await ramp.sessions.retrieve(sol.id))!.source!.token).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
    await expect(create({ source: { chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', token: '0xabc', custody: 'app' } })).rejects.toMatchObject({ status: 400 })
    await expect(create({ source: { chain: 'cosmos:cosmoshub-4', token: 'ibc/uatom0', custody: 'app' } })).resolves.toBeDefined()
    await expect(create({ source: { chain: 'cosmos:cosmoshub-4', token: 'x', custody: 'app' } })).rejects.toMatchObject({ status: 400 })
  })

  it('a withdraw session has no plan before the user picks a target', async () => {
    const t = make()
    const s = await t.create()
    const r = await t.call(`/sessions/${s.id}/plan`, s.clientSecret, { walletConnected: true })
    expect(r.status).toBe(409)
    expect(r.body.error?.message).toMatch(/Choose where to send/)
  })
})

describe('POST /sessions/:id/target', () => {
  it('validates the body: type, chain, token, address format and currency', async () => {
    const t = make()
    const s = await t.create()
    const bad = async (body: unknown) => (await t.call(`/sessions/${s.id}/target`, s.clientSecret, body)).status
    expect(await bad({ type: 'bank' })).toBe(400)
    expect(await bad({ ...TO_ARB, chain: 'arbitrum' })).toBe(400)
    expect(await bad({ ...TO_ARB, token: 'usdc' })).toBe(400)
    expect(await bad({ ...TO_ARB, address: '0x1234' })).toBe(400)
    expect(await bad({ ...TO_ARB, address: `0x${'0'.repeat(40)}` })).toBe(400)
    expect(await bad({ type: 'fiat', currency: 'PESO' })).toBe(400)
    const r = await t.call(`/sessions/${s.id}/target`, s.clientSecret, { ...TO_ARB, address: 'not an address' })
    expect(r.body.error).toMatchObject({ code: 'BAD_REQUEST', message: 'Enter a valid address for this network.' })
    expect((await t.call(`/sessions/${s.id}/target`, s.clientSecret, 'x', 'POST')).status).toBe(400)
  })

  it('refuses targets for deposit sessions', async () => {
    const t = make()
    const s = await t.ramp.sessions.create({ userId: 'u', destination: { type: 'merchant', currency: 'PHP' } })
    expect((await t.call(`/sessions/${s.id}/target`, s.clientSecret, TO_ARB)).status).toBe(409)
  })

  it('stores the target as the destination and returns the plan (wallet method for a crypto target)', async () => {
    const t = make()
    const s = await t.create()
    const r = await t.call<PlanResult>(`/sessions/${s.id}/target`, s.clientSecret, { ...TO_ARB, token: TO_ARB.token.toUpperCase().replace('0X', '0x'), walletConnected: true, walletAddress: USER })
    expect(r.status).toBe(200)
    expect(r.body.methods.map((m) => [m.method, m.group])).toEqual([['wallet', 'connected']])
    expect(r.body.pathways[0]!.legs[0]).toMatchObject({ legId: 'wallet', method: 'wallet', from: { location: { kind: 'user_wallet' } }, to: { location: { kind: 'address', address: ARB_ADDR } } })
    const pub = (await t.ramp.sessions.retrieve(s.id))!
    expect(pub.destination).toEqual({ type: 'crypto', chain: 'eip155:42161', token: USDC['eip155:42161'], address: ARB_ADDR, symbol: 'USDC', decimals: 6 })
    // A fiat target: payout methods for the user's country, the rest are filtered by country.
    const f = await t.call<PlanResult>(`/sessions/${s.id}/target`, s.clientSecret, { type: 'fiat', currency: 'php', walletConnected: true })
    expect(f.body.currency).toBe('PHP')
    expect(f.body.methods.map((m) => m.method)).toEqual(['gcash', 'bank_transfer'])
    expect(f.body.methods[0]!.group).toBe('recommended')
    expect((await t.ramp.sessions.retrieve(s.id))!.destination).toEqual({ type: 'fiat', currency: 'PHP' })
  })

  it('without a connected wallet, user-wallet withdrawals are unavailable with a reason', async () => {
    const t = make()
    const s = await t.create()
    const r = await t.call<PlanResult>(`/sessions/${s.id}/target`, s.clientSecret, TO_ARB)
    expect(r.body.methods[0]).toMatchObject({ method: 'wallet', group: 'unavailable', reason: { message: 'Connect your wallet to withdraw.' } })
    const q = await t.call(`/sessions/${s.id}/quotes`, s.clientSecret, { method: 'wallet', amount: '5' })
    expect(q.status).toBe(422)
  })

  it('applies allowedTargets: chains, currencies and whole target types', async () => {
    const t = make()
    const s = await t.create({ allowedTargets: { crypto: { chains: ['eip155:10'] }, fiat: { currencies: ['php'] } } })
    const r = await t.call(`/sessions/${s.id}/target`, s.clientSecret, TO_ARB)
    expect(r.status).toBe(403)
    expect(r.body.error?.code).toBe('TARGET_NOT_ALLOWED')
    expect((await t.call(`/sessions/${s.id}/target`, s.clientSecret, { type: 'fiat', currency: 'VND' })).status).toBe(403)
    expect((await t.call(`/sessions/${s.id}/target`, s.clientSecret, { type: 'fiat', currency: 'PHP' })).status).toBe(200)
    expect((await t.call(`/sessions/${s.id}/target`, s.clientSecret, { ...TO_ARB, chain: 'eip155:10', token: USDC['eip155:10'] })).status).toBe(200)
    const cryptoOnly = await t.create({ allowedTargets: { crypto: {} } })
    expect((await t.call(`/sessions/${cryptoOnly.id}/target`, cryptoOnly.clientSecret, { type: 'fiat', currency: 'PHP' })).status).toBe(403)
    expect((await t.call(`/sessions/${cryptoOnly.id}/target`, cryptoOnly.clientSecret, TO_ARB)).status).toBe(200)
    const fiatOnly = await t.create({ allowedTargets: { fiat: {} } })
    expect((await t.call(`/sessions/${fiatOnly.id}/target`, fiatOnly.clientSecret, TO_ARB)).status).toBe(403)
    expect((await t.call(`/sessions/${fiatOnly.id}/target`, fiatOnly.clientSecret, { type: 'fiat', currency: 'THB' })).status).toBe(200)
  })

  it('screens crypto addresses: refused is 403 ADDRESS_REJECTED, a failing hook is 503 (fail closed)', async () => {
    const screenAddress = vi.fn(async (address: string) => address !== ARB_ADDR)
    const t = make({ screenAddress })
    const s = await t.create()
    const r = await t.call(`/sessions/${s.id}/target`, s.clientSecret, TO_ARB)
    expect(r.status).toBe(403)
    expect(r.body.error).toMatchObject({ code: 'ADDRESS_REJECTED', message: expect.stringMatching(/cannot receive/) })
    expect(screenAddress).toHaveBeenCalledWith(ARB_ADDR, 'eip155:42161')
    expect((await t.ramp.sessions.retrieve(s.id))!.destination).toBeUndefined()
    expect((await t.call(`/sessions/${s.id}/target`, s.clientSecret, { ...TO_ARB, address: USER })).status).toBe(200)
    // Fiat targets are not screened.
    expect((await t.call(`/sessions/${s.id}/target`, s.clientSecret, { type: 'fiat', currency: 'PHP' })).status).toBe(200)
    expect(screenAddress).toHaveBeenCalledTimes(2)

    const failing = make({ screenAddress: async () => { throw new Error('screening down') } })
    const s2 = await failing.create()
    const r2 = await failing.call(`/sessions/${s2.id}/target`, s2.clientSecret, TO_ARB)
    expect(r2.status).toBe(503)
    expect(r2.body.error?.code).toBe('PROVIDER_UNAVAILABLE')
  })

  it('cannot change the target while a withdrawal is in progress; can after a restart', async () => {
    const t = make()
    const s = await t.create()
    await run(t, s, TO_ARB, 'wallet')
    expect((await t.call(`/sessions/${s.id}/target`, s.clientSecret, { type: 'fiat', currency: 'PHP' })).status).toBe(409)
    expect((await t.call(`/sessions/${s.id}/transitions/restart`, s.clientSecret, {})).status).toBe(200)
    expect((await t.call(`/sessions/${s.id}/target`, s.clientSecret, { type: 'fiat', currency: 'PHP' })).status).toBe(200)
  })
})

describe('withdraw to a wallet (custody: user_wallet)', () => {
  it('USDC on Base to an Arbitrum address: WALLET_TX from the user, then COMPLETED and withdrawal webhooks', async () => {
    const t = make()
    const s = await t.create()
    const { quote, session } = await run(t, s, TO_ARB, 'wallet')
    expect(quote.input).toMatchObject({ amount: '25', asset: { chain: 'eip155:8453', symbol: 'USDC' } })
    expect(quote.output.asset).toMatchObject({ chain: 'eip155:42161', token: USDC['eip155:42161'] })
    expect(session.step).toMatchObject({ state: 'PAYMENT', surface: { kind: 'WALLET_TX', chain: 'eip155:8453', txs: [{ to: ARB_ADDR, chainId: 8453 }] } })
    const sent = await t.call<PublicSession>(`/sessions/${s.id}/transitions/submit_tx`, s.clientSecret, { inputs: { txHash: TX } })
    expect(sent.body.step.state).toBe('PROCESSING')
    const done = await t.call<PublicSession>(`/sessions/${s.id}/step`, s.clientSecret)
    expect(done.body.step.state).toBe('COMPLETED')
    expect(done.body.status).toBe('completed')
    expect(t.hooks.map((h) => h.type)).toEqual(['session.created', 'leg.succeeded', 'session.completed', 'withdrawal.completed'])
    expect(t.hooks.at(-1)!.data.object.session).toMatchObject({ direction: 'withdraw', destination: { address: ARB_ADDR } })
    // The finished withdrawal can no longer restart.
    const again = await t.call(`/sessions/${s.id}/transitions/restart`, s.clientSecret, {})
    expect(again.body.error?.message).toBe('This withdrawal is complete.')
    expect((await t.call(`/sessions/${s.id}/target`, s.clientSecret, TO_ARB)).status).toBe(409)
  })
})

describe('withdraw to cash with the mock offramp', () => {
  it('GCash in PH: FORM (validated), then WALLET_TX to the provider, then COMPLETED with PHP out', async () => {
    const t = make()
    const s = await t.create()
    const { quote, session } = await run(t, s, { type: 'fiat', currency: 'PHP' }, 'gcash', '20')
    expect(quote).toMatchObject({ method: 'gcash', input: { amount: '20' }, output: { asset: { kind: 'fiat', currency: 'PHP' } }, fees: [{ amount: '0.200000', currency: 'USDC' }] })
    expect(quote.output.amount).toBe('1131.43') // (20 - 1%) / 0.0175
    expect(session.step).toMatchObject({ state: 'PAYMENT', surface: { kind: 'FORM', fields: [{ id: 'account_name' }, { id: 'phone', type: 'tel', label: 'GCash phone number' }] }, transitions: [{ name: 'submit_details', kind: 'SUBMIT' }] })

    const tr = (name: string, inputs: Record<string, unknown> = {}) => t.call<PublicSession>(`/sessions/${s.id}/transitions/${name}`, s.clientSecret, { inputs })
    expect((await tr('submit_details', { account_name: 'Juan' })).body.error?.message).toMatch(/gcash phone number/i)
    expect((await tr('submit_details', { account_name: 'Juan', phone: 'call me' })).body.error?.message).toBe('Enter a valid phone number.')
    expect((await tr('submit_tx', { txHash: TX })).status).toBe(409) // not offered yet
    const pay = await tr('submit_details', { account_name: 'Juan Dela Cruz', phone: '+63 917 123 4567' })
    expect(pay.body.step).toMatchObject({ state: 'PAYMENT', sub: 'SEND_CRYPTO', surface: { kind: 'WALLET_TX', chain: 'eip155:8453', txs: [{ to: USDC['eip155:8453'], chainId: 8453 }] } })
    const tx = (pay.body.step.surface as { txs: Array<{ data: string }> }).txs[0]!
    expect(tx.data.startsWith('0xa9059cbb')).toBe(true)
    expect(BigInt(`0x${tx.data.slice(-64)}`)).toBe(20_000_000n)
    // A status poll keeps the same step.
    expect((await t.call<PublicSession>(`/sessions/${s.id}/step`, s.clientSecret)).body.step.surface?.kind).toBe('WALLET_TX')
    expect((await tr('submit_tx', { txHash: TX })).body.step.state).toBe('PROCESSING')
    const done = await t.call<PublicSession>(`/sessions/${s.id}/step`, s.clientSecret)
    expect(done.body.step.state).toBe('COMPLETED')
    expect(t.hooks.map((h) => h.type)).toContain('withdrawal.completed')
  })

  it('bank transfer asks for bank fields; VND payout via MoMo is offered in VN only', async () => {
    const t = make()
    const s = await t.create({ country: 'VN' })
    const plan = await t.call<PlanResult>(`/sessions/${s.id}/target`, s.clientSecret, { type: 'fiat', currency: 'VND', walletConnected: true, walletAddress: USER })
    expect(plan.body.methods.map((m) => m.method)).toEqual(['momo', 'bank_transfer'])
    const q = await t.call<{ quotes: Quote[] }>(`/sessions/${s.id}/quotes`, s.clientSecret, { method: 'bank_transfer', amount: '10' })
    const sel = await t.call<PublicSession>(`/sessions/${s.id}/select`, s.clientSecret, { quoteId: q.body.quotes[0]!.id })
    const form = sel.body.step.surface as { kind: 'FORM'; fields: Array<{ id: string }> }
    expect(form.fields.map((f) => f.id)).toEqual(['account_name', 'bank_name', 'account_number'])
    const bad = await t.call(`/sessions/${s.id}/transitions/submit_details`, s.clientSecret, { inputs: { account_name: 'An', bank_name: 'VCB', account_number: '12' } })
    expect(bad.body.error?.message).toBe('Enter a valid account number.')
    const ok = await t.call<PublicSession>(`/sessions/${s.id}/transitions/submit_details`, s.clientSecret, { inputs: { account_name: 'An', bank_name: 'VCB', account_number: '0123456789' } })
    expect(ok.body.step.surface?.kind).toBe('WALLET_TX')
  })
})

describe('withdraw with custody: app (treasury)', () => {
  it('without a treasury hook, the methods are unavailable with a clear reason', async () => {
    const t = make()
    const s = await t.create({ source: SRC_APP })
    const r = await t.call<PlanResult>(`/sessions/${s.id}/target`, s.clientSecret, TO_ARB)
    expect(r.body.methods[0]).toMatchObject({ group: 'unavailable', reason: { code: 'PROVIDER_UNAVAILABLE', message: 'Withdrawals are not set up for this app yet.' } })
  })

  it('the treasury sends the WALLET_TX, the step goes straight to PROCESSING, then COMPLETED', async () => {
    const sends: TreasurySendInput[] = []
    const treasury = { address: '0x9999999999999999999999999999999999999999', send: vi.fn(async (i: TreasurySendInput) => (sends.push(i), { hash: TX })) }
    const t = make({ treasury })
    const s = await t.create({ source: SRC_APP })
    // No wallet is needed: the app signs.
    const { plan, session } = await run(t, s, TO_ARB, 'wallet', '30', false)
    expect(plan.methods[0]).toMatchObject({ method: 'wallet', group: 'recommended' })
    expect(plan.pathways[0]!.legs[0]!.from.location).toEqual({ kind: 'address', address: 'app' })
    expect(session.step.state).toBe('PROCESSING')
    expect(session.step.surface).toBeUndefined()
    expect(session.step.progress!.legs[0]).toMatchObject({ status: 'processing', txHash: TX })
    expect(sends).toEqual([{ sessionId: s.id, userId: 'u1', chain: 'eip155:8453', txs: [expect.objectContaining({ to: ARB_ADDR })], idempotencyKey: expect.stringMatching(new RegExp(`^${s.id}:0:`)) }])
    const done = await t.call<PublicSession>(`/sessions/${s.id}/step`, s.clientSecret)
    expect(done.body.step.state).toBe('COMPLETED')
    expect(treasury.send).toHaveBeenCalledTimes(1)
  })

  it('cash out from the treasury: the user fills the FORM, the treasury sends the USDC', async () => {
    const treasury = { send: vi.fn(async (_input: TreasurySendInput) => ({ hash: TX })) }
    const t = make({ treasury })
    const s = await t.create({ source: SRC_APP })
    const { session } = await run(t, s, { type: 'fiat', currency: 'PHP' }, 'gcash', '10', false)
    expect(session.step.surface?.kind).toBe('FORM')
    expect(treasury.send).not.toHaveBeenCalled()
    const r = await t.call<PublicSession>(`/sessions/${s.id}/transitions/submit_details`, s.clientSecret, { inputs: { account_name: 'Juan', phone: '09171234567' } })
    expect(r.body.step.state).toBe('PROCESSING')
    expect(treasury.send).toHaveBeenCalledTimes(1)
    expect(treasury.send.mock.calls[0]![0]).toMatchObject({ chain: 'eip155:8453', txs: [{ to: USDC['eip155:8453'] }] })
  })

  it('a failing treasury fails the leg and sends withdrawal.failed', async () => {
    const t = make({ treasury: { send: async () => { throw new Error('hot wallet empty') } } })
    const s = await t.create({ source: SRC_APP })
    const { session } = await run(t, s, TO_ARB, 'wallet', '5', false)
    expect(session.step.state).toBe('FAILED')
    expect(session.step.error).toMatchObject({ code: 'PAYMENT_FAILED', message: 'The withdrawal could not be sent. Contact support.' })
    expect(t.hooks.map((h) => h.type)).toEqual(expect.arrayContaining(['leg.failed', 'session.failed', 'withdrawal.failed']))
  })
})

// ---------- events that carry a surface ----------

/** An offramp that learns its deposit address from a webhook (like Swapped's sell `payment_pending`). */
function eventOfframp() {
  return createAdapter({
    id: 'evt',
    name: 'Event offramp',
    legs: [
      {
        id: 'sell',
        kind: 'crypto_offramp',
        methods: ['bank_transfer'],
        from: { asset: { kind: 'crypto', chains: '*' }, location: ['user_wallet', 'address'] },
        to: { asset: { kind: 'fiat', currencies: '*' }, location: ['user_account'] },
        regions: { allow: ['*'], deny: [] },
        eta: { min: 60, max: 600 },
        surfaces: ['WALLET_TX'],
        // It learns the deposit address from a webhook after the leg started.
        capabilities: ['webhooks', 'surface_after_processing'],
      },
    ],
    async quote({ leg, amountIn }) {
      return { adapterId: 'evt', legId: leg.legId, input: amountIn!, output: { amount: '1000', asset: leg.to.asset }, fees: [], eta: { min: 60, max: 600 } }
    },
    async start() {
      return { state: 'PROCESSING', status: 'processing', ref: 'order_1', transitions: [{ name: 'poll', kind: 'AWAIT', poll: { intervalMs: 1000, backoff: 1, maxIntervalMs: 1000, giveUpAfterMs: 60_000 } }] }
    },
    async transition({ ref, inputs }) {
      return { state: 'PROCESSING', status: 'processing', ref, transitions: [], txHash: String(inputs?.txHash) }
    },
    webhook: {
      verify: async () => true,
      parse: async (raw) => [JSON.parse(raw) as LegEvent],
    },
  })
}

const PENDING: LegEvent = {
  ref: 'order_1',
  status: 'awaiting_user',
  surface: { kind: 'WALLET_TX', chain: 'eip155:8453', txs: [{ to: USDC['eip155:8453']!, data: '0xa9059cbb', chainId: 8453 }] },
  transitions: [{ name: 'submit_tx', kind: 'SURFACE_RESULT', expects: 'tx_hash' }],
}

describe('provider events that carry a surface', () => {
  it('legStepFromEvent uses the event surface and transitions; default AWAIT; terminal events drop surfaces', () => {
    const cur = { state: 'PROCESSING' as const, status: 'processing' as const, transitions: [], ref: 'r', surface: { kind: 'QR' as const, payload: 'x', amount: '1', currency: 'PHP' } }
    const a = legStepFromEvent(cur, PENDING)
    expect(a).toMatchObject({ state: 'PAYMENT', status: 'awaiting_user', surface: { kind: 'WALLET_TX' }, transitions: [{ name: 'submit_tx' }] })
    const b = legStepFromEvent(cur, { ...PENDING, transitions: undefined } as LegEvent)
    expect(b.transitions).toEqual([expect.objectContaining({ kind: 'AWAIT' })])
    expect(b.surface?.kind).toBe('WALLET_TX')
    const c = legStepFromEvent(cur, { ref: 'r', status: 'processing' })
    expect(c.surface?.kind).toBe('QR') // no event surface: keep the current one
    const d = legStepFromEvent(cur, { ...PENDING, status: 'succeeded' })
    expect(d.surface).toBeUndefined()
    expect(d.transitions).toEqual([])
  })

  it('a webhook with a WALLET_TX surface switches the step; the user then submits the hash', async () => {
    const t = make({}, [eventOfframp()])
    const s = await t.create()
    const { session } = await run(t, s, { type: 'fiat', currency: 'PHP' }, 'bank_transfer', '10')
    expect(session.step.state).toBe('PROCESSING')
    const hook = await t.ramp.handle(new Request(`${BASE}/webhooks/evt`, { method: 'POST', body: JSON.stringify(PENDING) }))
    expect(hook.status).toBe(200)
    const now = await t.call<PublicSession>(`/sessions/${s.id}`, s.clientSecret)
    expect(now.body.step).toMatchObject({ state: 'PAYMENT', surface: { kind: 'WALLET_TX', chain: 'eip155:8453' }, transitions: [{ name: 'submit_tx', kind: 'SURFACE_RESULT' }] })
    const sent = await t.call<PublicSession>(`/sessions/${s.id}/transitions/submit_tx`, s.clientSecret, { inputs: { txHash: TX } })
    expect(sent.body.step).toMatchObject({ state: 'PROCESSING', progress: { legs: [{ txHash: TX }] } })
  })

  it('with custody app, the treasury sends a WALLET_TX that arrives by webhook, once per step', async () => {
    const treasury = { send: vi.fn(async () => ({ hash: TX })) }
    const t = make({ treasury }, [eventOfframp()])
    const s = await t.create({ source: SRC_APP })
    await run(t, s, { type: 'fiat', currency: 'PHP' }, 'bank_transfer', '10', false)
    const post = () => t.ramp.handle(new Request(`${BASE}/webhooks/evt`, { method: 'POST', body: JSON.stringify(PENDING) }))
    await post()
    const now = await t.call<PublicSession>(`/sessions/${s.id}`, s.clientSecret)
    expect(now.body.step).toMatchObject({ state: 'PROCESSING', progress: { legs: [{ txHash: TX }] } })
    expect(treasury.send).toHaveBeenCalledTimes(1)
    // A replayed webhook for the same step does not send twice.
    await post()
    expect(treasury.send).toHaveBeenCalledTimes(1)
  })

  it('a payout returned after success sends session.reversed and withdrawal.reversed', async () => {
    const t = make({}, [eventOfframp()])
    const s = await t.create()
    await run(t, s, { type: 'fiat', currency: 'PHP' }, 'bank_transfer', '10')
    const post = (ev: LegEvent) => t.ramp.handle(new Request(`${BASE}/webhooks/evt`, { method: 'POST', body: JSON.stringify(ev) }))
    await post({ ref: 'order_1', status: 'succeeded' })
    await post({ ref: 'order_1', status: 'reversed' })
    const now = await t.call<PublicSession>(`/sessions/${s.id}`, s.clientSecret)
    expect(now.body).toMatchObject({ status: 'reversed', step: { state: 'REVERSED' } })
    expect(t.hooks.map((h) => h.type)).toEqual(expect.arrayContaining(['withdrawal.completed', 'session.reversed', 'withdrawal.reversed']))
    expect(t.hooks.filter((h) => h.type === 'withdrawal.reversed')).toHaveLength(1)
  })

  it('without a transition to report the hash, the treasury step waits in PROCESSING', async () => {
    const treasury = { send: vi.fn(async () => ({ hash: TX })) }
    const t = make({ treasury }, [eventOfframp()])
    const s = await t.create({ source: SRC_APP })
    await run(t, s, { type: 'fiat', currency: 'PHP' }, 'bank_transfer', '10', false)
    await t.ramp.handle(new Request(`${BASE}/webhooks/evt`, { method: 'POST', body: JSON.stringify({ ...PENDING, transitions: undefined }) }))
    const now = await t.call<PublicSession>(`/sessions/${s.id}`, s.clientSecret)
    expect(now.body.step).toMatchObject({ state: 'PROCESSING', transitions: [{ kind: 'AWAIT' }], progress: { legs: [{ status: 'processing', txHash: TX }] } })
    expect(now.body.step.surface).toBeUndefined()
  })
})

describe('address format', () => {
  it('checks EVM, Solana and other chains', () => {
    expect(isValidAddress('eip155:1', ARB_ADDR)).toBe(true)
    expect(isValidAddress('eip155:1', ARB_ADDR.slice(0, 41))).toBe(false)
    expect(isValidAddress('eip155:1', `0x${'0'.repeat(40)}`)).toBe(false)
    expect(isValidAddress('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')).toBe(true)
    expect(isValidAddress('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', '0OIl')).toBe(false)
    expect(isValidAddress('bip122:000000000019d6689c085ae165831e93', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toBe(true)
    expect(isValidAddress('bip122:000000000019d6689c085ae165831e93', 'short')).toBe(false)
  })
})

describe('withdraw sessions: locked target', () => {
  const OTHER = '0x3333333333333333333333333333333333333333'

  it('sets the target at creation; /target answers 409 TARGET_LOCKED for the client secret and a pay link', async () => {
    const t = make()
    const s = await t.create({ target: { ...TO_ARB, address: ` ${ARB_ADDR} ` } as never, lockTarget: true })
    const pub = (await t.ramp.sessions.retrieve(s.id))!
    expect(pub).toMatchObject({ targetLocked: true, destination: { type: 'crypto', chain: 'eip155:42161', address: ARB_ADDR, symbol: 'USDC', decimals: 6 } })
    expect(t.hooks.find((h) => h.type === 'session.created')!.data.object.session).toMatchObject({ targetLocked: true, destination: { address: ARB_ADDR } })

    for (const secret of [s.clientSecret, (await t.ramp.sessions.payLink(s.id))!.url.split('/pay/')[1]!]) {
      const r = await t.call(`/sessions/${s.id}/target`, secret, { ...TO_ARB, address: OTHER })
      expect(r.status).toBe(409)
      expect(r.body.error).toMatchObject({ code: 'TARGET_LOCKED', retryable: false })
      // The same target is refused too: a locked target takes no /target call at all.
      expect((await t.call(`/sessions/${s.id}/target`, secret, { type: 'fiat', currency: 'PHP' })).body.error?.code).toBe('TARGET_LOCKED')
    }
    expect((await t.ramp.sessions.retrieve(s.id))!.destination).toMatchObject({ address: ARB_ADDR })

    // /plan, quotes and select pay out to the locked target.
    const plan = await t.call<PlanResult>(`/sessions/${s.id}/plan`, s.clientSecret, { walletConnected: true, walletAddress: USER })
    expect(plan.status).toBe(200)
    expect(plan.body.methods.find((m) => m.group !== 'unavailable')).toBeDefined()
    const q = await t.call<{ quotes: Quote[] }>(`/sessions/${s.id}/quotes`, s.clientSecret, { method: 'wallet', amount: '10' })
    const sel = await t.call<PublicSession>(`/sessions/${s.id}/select`, s.clientSecret, { quoteId: q.body.quotes[0]!.id })
    expect(sel.status).toBe(200)
    expect(sel.body.targetLocked).toBe(true)
    expect(JSON.stringify(sel.body.step.surface).toLowerCase()).toContain(ARB_ADDR.slice(2))
  })

  it('a fiat target can be locked; a target without lockTarget can still change', async () => {
    const t = make()
    const f = await t.create({ target: { type: 'fiat', currency: 'php' }, lockTarget: true })
    expect((await t.ramp.sessions.retrieve(f.id))!).toMatchObject({ targetLocked: true, destination: { type: 'fiat', currency: 'PHP' } })
    expect((await t.call(`/sessions/${f.id}/target`, f.clientSecret, TO_ARB)).status).toBe(409)
    expect((await t.call<PlanResult>(`/sessions/${f.id}/plan`, f.clientSecret, {})).body.currency).toBe('PHP')

    const open = await t.create({ target: TO_ARB as never })
    const pub = (await t.ramp.sessions.retrieve(open.id))!
    expect(pub.targetLocked).toBeUndefined()
    expect(pub.destination).toMatchObject({ address: ARB_ADDR })
    expect((await t.call(`/sessions/${open.id}/target`, open.clientSecret, { ...TO_ARB, address: OTHER })).status).toBe(200)
    expect((await t.ramp.sessions.retrieve(open.id))!.destination).toMatchObject({ address: OTHER })
  })

  it('checks the target at creation like /target: format, allowedTargets and screenAddress', async () => {
    const screenAddress = vi.fn(async (address: string) => address !== OTHER)
    const t = make({ screenAddress })
    await expect(t.create({ lockTarget: true })).rejects.toMatchObject({ status: 400, error: { message: '`lockTarget` needs `target`.' } })
    await expect(t.create({ target: TO_ARB as never, lockTarget: 'yes' as never })).rejects.toMatchObject({ status: 400 })
    await expect(t.ramp.sessions.create({ userId: 'u', destination: { type: 'fiat', currency: 'PHP' } as never, target: { type: 'fiat', currency: 'PHP' } })).rejects.toMatchObject({
      status: 400,
      error: { message: expect.stringMatching(/Only a withdraw session/) },
    })
    await expect(t.create({ target: { ...TO_ARB, address: '0x12' } as never, lockTarget: true })).rejects.toMatchObject({ status: 400 })
    await expect(t.create({ target: { type: 'cash' } as never, lockTarget: true })).rejects.toMatchObject({ status: 400 })
    await expect(t.create({ target: TO_ARB as never, lockTarget: true, allowedTargets: { fiat: {} } })).rejects.toMatchObject({ status: 403, error: { code: 'TARGET_NOT_ALLOWED' } })
    await expect(t.create({ target: { ...TO_ARB, address: OTHER } as never, lockTarget: true })).rejects.toMatchObject({ status: 403, error: { code: 'ADDRESS_REJECTED' } })
    expect(screenAddress).toHaveBeenCalledWith(OTHER, 'eip155:42161')
    // No session was stored for a refused target: no webhook either.
    expect(t.hooks.filter((h) => h.type === 'session.created')).toHaveLength(0)
  })
})
