import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { checkAdapterShape, checkLegQuote, checkLegStep, resultChannels } from '@openrampkit/adapter'
import type { AdapterContext, ScopedKV } from '@openrampkit/adapter'
import { USDC, isRegionAllowed, stateFor } from '@openrampkit/core'
import type { LegQuote, PathwayLeg } from '@openrampkit/core'
import { TEST_DESTINATION, fakeFetch, makeCtx, makeWebhookCtx, memoryKV, recordingLog, runAdapterConformance } from '@openrampkit/adapter/testing'
import type { FakeCall, FakeRoute } from '@openrampkit/adapter/testing'
import { PAYTRIE_LIMITS, PAYTRIE_MAX_CODES, PAYTRIE_MAX_WRONG_CODES, PAYTRIE_TRANSITIONS as T, canonicalEmail, emailKey, paytrie, paytrieSignature } from './index.js'

const API_KEY = 'pt_api_key_test'
const SECRET = 'whsec_paytrie_test_secret'
const EMAIL = 'jane@example.com'
const USER_ID = '550e8400-e29b-41d4-a716-446655440000'
const TX_ID = '3943bb00-1551-4f1d-bf32-2d82608bc15e'
const TOKEN = 'eyJhbGciOiJIUzI1NiIs.test.token'
const WALLET = TEST_DESTINATION.type === 'crypto' ? TEST_DESTINATION.address : ''
const BASE_USDC = { kind: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']! }
const cad = (value: string) => ({ value, asset: { kind: 'fiat' as const, currency: 'CAD' } })

const leg: PathwayLeg = {
  adapterId: 'paytrie',
  legId: 'interac',
  from: { asset: { kind: 'fiat', currency: 'CAD' }, location: { kind: 'user_account' } },
  to: { asset: BASE_USDC, location: { kind: 'address', address: 'deposit' } },
}

const opts = { apiKey: API_KEY, webhookSecret: SECRET }

// Shapes from the v2 docs (Price Quotes, Authentication, Customer Onboarding, Transactions, Webhooks)
const ok = (data: unknown) => ({ success: true, data })
const QUOTE = {
  quoteId: 337362,
  leftSideLabel: 'CAD',
  leftSideValue: 1000,
  rightSideLabel: 'USDC-BASE',
  rightSideValue: 714.5,
  breakdown: { paytrieFee: 5, sponsoredFee: 0, referralDiscount: 0, feeRate: 0.006, minFee: 5, gasFee: 21.5, gasPrice: 20, usdToCad: 1.3625 },
  timestamp: '2026-06-18T22:42:02.974Z',
}
const TX = (status: string, extra: Record<string, unknown> = {}) => ({
  id: TX_ID,
  date: '2025-07-25T14:02:36.000Z',
  coin: 'USDC',
  leftSideLabel: 'CAD',
  leftSideValue: 1000,
  rightSideLabel: 'USDC-BASE',
  rightSideValue: 714.5,
  status,
  wallet: WALLET,
  paymentType: 'interac',
  paymentId: 'pay_123456789',
  rmtId: 'CA1MRUaaErpx',
  depositAddress: null,
  ...extra,
})
const HASH = `0x${'ab'.repeat(32)}`

type Opts = { userStatus?: string; users?: unknown[]; tx?: unknown; txStatus?: number; created?: unknown; createStatus?: number; verifyStatus?: number }
const routes = (o: Opts = {}, over: FakeRoute[] = []): FakeRoute[] => [
  ...over,
  { match: '/v2/quotes', reply: () => ok(QUOTE) },
  { method: 'GET', match: '/v2/users?email=', reply: () => ok(o.users ?? [{ id: USER_ID, accessibleBy: ['jwt'] }]) },
  { method: 'POST', match: '/v2/auth/login-codes/verify', status: o.verifyStatus ?? 200, reply: () => (o.verifyStatus ? { success: false, errors: [{ field: 'code', message: 'Invalid code' }] } : ok({ accessToken: TOKEN, tokenType: 'Bearer', expiresIn: 3600 })) },
  { method: 'POST', match: '/v2/auth/login-codes', status: 202 },
  { method: 'GET', match: `/v2/users/${USER_ID}/kyc-url`, reply: () => ok({ url: 'https://in.sumsub.com/websdk/p/abc', expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() }) },
  { method: 'GET', match: `/v2/users/${USER_ID}`, reply: () => ok({ id: USER_ID, accessibleBy: ['jwt'], status: o.userStatus ?? 'verified' }) },
  { method: 'PUT', match: '/cancel', reply: () => ok(TX('cancelled')) },
  { method: 'POST', match: '/v2/transactions', status: o.createStatus ?? 201, reply: () => (o.createStatus ? { success: false, errors: [{ field: 'leftSideValue', message: 'You have reached your 24 hour limit.' }] } : ok(o.created ?? TX('awaiting-fiat'))) },
  { method: 'GET', match: `/v2/transactions/${TX_ID}`, status: o.txStatus ?? 200, reply: () => ok(o.tx ?? TX('complete', { paymentId: HASH })) },
]

/** A store with an atomic putIfAbsent (one synchronous check and write), like the built-in stores */
function atomicKV(): ScopedKV & { data: Map<string, unknown> } {
  const kv = memoryKV()
  const held = new Map<string, number>()
  return {
    ...kv,
    async put(key: string, value: unknown, ttlSec?: number) {
      // A plain write also makes the key live (until its TTL), like the built-in stores
      held.set(key, ttlSec ? Date.now() + ttlSec * 1000 : Number.POSITIVE_INFINITY)
      await kv.put(key, value, ttlSec)
    },
    async putIfAbsent(key: string, value: unknown, ttlSec: number) {
      const until = held.get(key)
      if (until !== undefined && until > Date.now()) return false
      held.set(key, Date.now() + ttlSec * 1000)
      await kv.put(key, value, ttlSec)
      return true
    },
  }
}

function setup(o: Opts = {}, extra: { session?: Partial<AdapterContext['session']>; over?: FakeRoute[]; adapterOpts?: Partial<Parameters<typeof paytrie>[0]> } = {}) {
  const { fetch, calls } = fakeFetch(routes(o, extra.over))
  const store = atomicKV()
  const shared = atomicKV()
  const log = recordingLog()
  const ctx = makeCtx({ fetch, store, shared, log, session: { country: 'CA', email: EMAIL, ...extra.session } })
  const adapter = paytrie({ ...opts, ...extra.adapterOpts })
  return { adapter, ctx, calls, store, shared, log }
}

/** Another session of the same server: its own session store, the same adapter, shared store and fetch */
function otherSession(s: ReturnType<typeof setup>, n: number, session: Partial<AdapterContext['session']> = {}): ReturnType<typeof setup> {
  const store = atomicKV()
  const ctx = makeCtx({ fetch: s.ctx.fetch, store, shared: s.shared, log: s.log, session: { id: `sess_${n}`, userId: `user_${n}`, country: 'CA', email: EMAIL, ...session } })
  return { ...s, ctx, store }
}

async function quoteAndStart(s: ReturnType<typeof setup>) {
  const q = await s.adapter.quote({ leg, amountIn: cad('1000') }, s.ctx)
  const step = await s.adapter.start({ leg, quote: q }, s.ctx)
  return { q, step }
}

/** Start, then sign in with the code: the order exists (for a verified user) */
async function toPayment(s: ReturnType<typeof setup>) {
  const { step } = await quoteAndStart(s)
  const paid = await s.adapter.transition!({ leg, ref: step.ref!, name: T.code, inputs: { code: '1234' } }, s.ctx)
  return { ref: step.ref!, step: paid }
}

const posts = (calls: FakeCall[], path: string) => calls.filter((c) => c.method === 'POST' && c.url.endsWith(path))

// ---------- webhooks ----------

const HOOK_URL = 'https://app.test/api/openramp/webhooks/paytrie'
const envelope = (status: string, extra: Record<string, unknown> = {}, env: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: 'b3f1c2d4-5678-4abc-9012-3456789abcde',
    apiVersion: 'v2',
    occurredAt: '2026-05-19T20:41:09.000Z',
    type: 'transaction.update',
    payload: {
      transactionId: TX_ID,
      status,
      email: EMAIL,
      wallet: WALLET,
      paymentId: status === 'complete' ? HASH : null,
      leftSideLabel: 'CAD',
      leftSideValue: 1000.0,
      rightSideLabel: 'USDC-BASE',
      rightSideValue: 714.5,
      interacSecurityAnswer: null,
      externalSessionId: null,
      ...extra,
    },
    ...env,
  })
const sign = (body: string, ts = String(Math.floor(Date.now() / 1000)), secret = SECRET) => `v1=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`
const hookReq = (body: string, headers: Record<string, string> = { 'x-paytrie-timestamp': String(Math.floor(Date.now() / 1000)), 'x-paytrie-signature': sign(body) }) =>
  new Request(HOOK_URL, { method: 'POST', body, headers })

describe('paytrie adapter', () => {
  it('passes the conformance kit', async () => {
    const shared = atomicKV()
    const { fetch } = fakeFetch(routes())
    const adapter = paytrie(opts)
    // The webhook finds its leg only through our index: one order made by a fixture first
    const report = await runAdapterConformance(adapter, {
      ctx: () => makeCtx({ fetch, store: atomicKV(), shared, session: { country: 'CA', email: EMAIL } }),
      fixtures: [
        { name: 'session email, verified user', leg, quote: { amountIn: cad('1000') }, transitions: [{ name: T.code, inputs: { code: '1234' } }], expect: { start: 'AUTH', status: 'COMPLETED' } },
        { name: 'amount out', leg, quote: { amountOut: { value: '714.5', asset: BASE_USDC } }, start: false },
      ],
      errorPaths: [{ leg, quote: { amountIn: cad('100') }, ctx: (f) => makeCtx({ fetch: f, session: { country: 'CA' } }) }],
      webhooks: [
        { name: 'complete', request: () => hookReq(envelope('complete')), rawBody: envelope('complete'), events: 1 },
        { name: 'bad signature', request: () => hookReq(envelope('complete'), { 'x-paytrie-timestamp': String(Math.floor(Date.now() / 1000)), 'x-paytrie-signature': sign('other') }), rawBody: envelope('complete'), valid: false },
      ],
      webhookCtx: makeWebhookCtx({ fetch, shared }),
    })
    expect(report.problems).toEqual([])
    expect(report.events[0]![0]).toMatchObject({ status: 'succeeded', providerRef: TX_ID, transactions: [{ role: 'destination', hash: HASH, chain: 'eip155:8453' }] })
  })

  it('declares one Interac leg for CA in CAD, with a result channel', () => {
    const a = paytrie(opts)
    expect(checkAdapterShape(a)).toEqual([])
    expect(a.env).toBe('production')
    expect(a.legs).toHaveLength(1)
    const l = a.legs[0]!
    expect(l).toMatchObject({ id: 'interac', kind: 'fiat_onramp', methods: ['interac'], limits: { min: '10', max: '9999', currency: 'CAD' } })
    expect(isRegionAllowed(l.regions, 'CA')).toBe(true)
    expect(isRegionAllowed(l.regions, 'US')).toBe(false)
    expect(resultChannels(a)).toEqual({ polling: true, webhooks: true })
    expect(resultChannels(paytrie({ apiKey: API_KEY }))).toEqual({ polling: true, webhooks: false })
  })

  it('checks its options', () => {
    expect(() => paytrie({ apiKey: '' })).toThrow(/apiKey/)
    expect(() => paytrie({ ...opts, tokenKey: 'short' })).toThrow(/tokenKey/)
    // No documented sandbox host
    expect(() => paytrie({ ...opts, env: 'sandbox' })).toThrow(/sandbox/)
    expect(paytrie({ ...opts, env: 'sandbox', apiUrl: 'https://staging.paytrie.test' }).env).toBe('sandbox')
    expect(() => paytrie({ ...opts, deliverAssets: [{ chain: 'eip155:1', token: USDC['eip155:1']!, label: 'usdc eth' }] })).toThrow(/label/)
  })

  describe('quote', () => {
    it('prices CAD to USDC with the fee breakdown', async () => {
      const s = setup()
      const q = await s.adapter.quote({ leg, amountIn: cad('1000') }, s.ctx)
      expect(checkLegQuote(q)).toEqual([])
      expect(q).toMatchObject({ adapterId: 'paytrie', legId: 'interac', input: cad('1000'), guarantee: 'estimate', data: { label: 'USDC-BASE', quoteId: 337362 } })
      expect(q.output).toEqual({ value: '714.5', asset: { ...BASE_USDC, symbol: 'USDC', decimals: 6 } })
      expect(q.fees).toEqual([
        { kind: 'provider', label: 'PayTrie fee', amount: cad('5'), included: true },
        { kind: 'network', label: 'Network fee', amount: cad('21.5'), included: true },
      ])
      const url = new URL(s.calls[0]!.url)
      expect(url.pathname).toBe('/v2/quotes')
      expect(Object.fromEntries(url.searchParams)).toEqual({ leftSideLabel: 'CAD', rightSideLabel: 'USDC-BASE', leftSideValue: '1000.00' })
      expect(s.calls[0]!.headers.get('x-api-key')).toBe(API_KEY)
      expect(s.calls[0]!.headers.get('authorization')).toBeNull()
    })

    it('quotes an exact output with rightSideValue', async () => {
      const s = setup()
      await s.adapter.quote({ leg, amountOut: { value: '714.5', asset: BASE_USDC } }, s.ctx)
      expect(new URL(s.calls[0]!.url).searchParams.get('rightSideValue')).toBe('714.500000')
    })

    it('refuses amounts outside the Platform API limits before any call', async () => {
      const s = setup()
      await expect(s.adapter.quote({ leg, amountIn: cad('9.99') }, s.ctx)).rejects.toMatchObject({ error: { code: 'AMOUNT_TOO_LOW' } })
      await expect(s.adapter.quote({ leg, amountIn: cad('10000') }, s.ctx)).rejects.toMatchObject({ error: { code: 'AMOUNT_TOO_HIGH' } })
      expect(s.calls).toHaveLength(0)
    })

    it('takes CAD only, and only the tokens it knows', async () => {
      const s = setup()
      await expect(s.adapter.quote({ leg, amountIn: { value: '100', asset: { kind: 'fiat', currency: 'USD' } } }, s.ctx)).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
      const other = { ...leg, to: { ...leg.to, asset: { kind: 'crypto' as const, chain: 'eip155:8453', token: '0x0000000000000000000000000000000000000001' } } }
      await expect(s.adapter.quote({ leg: other, amountIn: cad('100') }, s.ctx)).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
    })

    it('gives no quote when PayTrie answers for another pair', async () => {
      const s = setup({}, { over: [{ match: '/v2/quotes', reply: () => ok({ ...QUOTE, rightSideLabel: 'USDC-ETH' }) }] })
      await expect(s.adapter.quote({ leg, amountIn: cad('1000') }, s.ctx)).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
    })

    it('shows the PayTrie message of a 400', async () => {
      const s = setup({}, { over: [{ match: '/v2/quotes', status: 400, reply: () => ({ success: false, errors: [{ field: 'rightSideLabel', message: 'Unsupported token' }] }) }] })
      await expect(s.adapter.quote({ leg, amountIn: cad('100') }, s.ctx)).rejects.toMatchObject({ error: { code: 'NO_QUOTES', message: 'PayTrie: Unsupported token' } })
    })
  })

  describe('sign-in', () => {
    it('with the session email: looks the user up, emails a code and shows the OTP step', async () => {
      const s = setup()
      const { step } = await quoteAndStart(s)
      expect(checkLegStep(step)).toEqual([])
      expect(stateFor(step)).toBe('AUTH')
      expect(step.ref).toMatch(/^ptr_[0-9a-f]{24}$/)
      expect(step.action).toMatchObject({ kind: 'auth', surface: { kind: 'OTP', channel: 'email', to: 'j***@example.com' } })
      expect(step.action!.transitions.map((t) => t.name)).toEqual([T.code, T.resend])
      expect(new URL(s.calls[1]!.url).searchParams.get('email')).toBe(EMAIL)
      expect(posts(s.calls, '/v2/auth/login-codes')[0]!.body).toEqual({ email: EMAIL })
    })

    it('without a session email: asks for it, then emails a code', async () => {
      const s = setup({}, { session: { email: undefined }, adapterOpts: { requireSessionEmail: false } })
      const { step } = await quoteAndStart(s)
      expect(step.action).toMatchObject({ kind: 'auth', surface: { kind: 'FORM', fields: [{ id: 'email', type: 'email' }] } })
      await expect(s.adapter.transition!({ leg, ref: step.ref!, name: T.email, inputs: { email: 'nope' } }, s.ctx)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
      const next = await s.adapter.transition!({ leg, ref: step.ref!, name: T.email, inputs: { email: 'sam@example.ca' } }, s.ctx)
      expect(next.action?.surface).toMatchObject({ kind: 'OTP', to: 's***@example.ca' })
    })

    it('by default refuses a session with no email (requireSessionEmail is true)', async () => {
      const s = setup({}, { session: { email: undefined } })
      await expect(quoteAndStart(s)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
      expect(s.calls.filter((c) => !c.url.includes('/v2/quotes'))).toHaveLength(0)
    })

    it('sends a user with no PayTrie account to the PayTrie sign-up page, then checks again', async () => {
      const s = setup({ users: [] })
      const { step } = await quoteAndStart(s)
      expect(step.action).toMatchObject({ kind: 'auth', surface: { kind: 'REDIRECT', url: 'https://app.paytrie.com/SignupEmail', popup: true } })
      expect(posts(s.calls, '/v2/auth/login-codes')).toHaveLength(0)
      const again = await s.adapter.transition!({ leg, ref: step.ref!, name: T.signedUp }, s.ctx)
      expect(again.action?.surface?.kind).toBe('REDIRECT')
    })

    it('never lets the client change the session email', async () => {
      const s = setup({ users: [] })
      const { step } = await quoteAndStart(s)
      await expect(s.adapter.transition!({ leg, ref: step.ref!, name: T.email, inputs: { email: 'attacker@example.com' } }, s.ctx)).rejects.toMatchObject({ error: { code: 'CONFLICT' } })
    })

    it('counts wrong codes, and needs a new code after too many', async () => {
      const s = setup({ verifyStatus: 401 })
      const { step } = await quoteAndStart(s)
      const ref = step.ref!
      for (let i = 0; i < PAYTRIE_MAX_WRONG_CODES; i++) {
        await expect(s.adapter.transition!({ leg, ref, name: T.code, inputs: { code: '0000' } }, s.ctx)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
      }
      const verifies = posts(s.calls, '/verify').length
      await expect(s.adapter.transition!({ leg, ref, name: T.code, inputs: { code: '1234' } }, s.ctx)).rejects.toMatchObject({ error: { code: 'RATE_LIMITED' } })
      // The guess never reached PayTrie
      expect(posts(s.calls, '/verify')).toHaveLength(verifies)
      // A new code resets the count; a malformed code never reaches PayTrie
      await expect(s.adapter.transition!({ leg, ref, name: T.resend }, s.ctx)).resolves.toMatchObject({ action: { surface: { kind: 'OTP' } } })
      await expect(s.adapter.transition!({ leg, ref, name: T.code, inputs: { code: '12a4' } }, s.ctx)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
      expect(posts(s.calls, '/verify')).toHaveLength(verifies)
    })

    it('sends at most a few codes per leg', async () => {
      const s = setup()
      const { step } = await quoteAndStart(s)
      for (let i = 1; i < PAYTRIE_MAX_CODES; i++) await s.adapter.transition!({ leg, ref: step.ref!, name: T.resend }, s.ctx)
      await expect(s.adapter.transition!({ leg, ref: step.ref!, name: T.resend }, s.ctx)).rejects.toMatchObject({ error: { code: 'RATE_LIMITED' } })
      expect(posts(s.calls, '/v2/auth/login-codes')).toHaveLength(PAYTRIE_MAX_CODES)
    })

    it('runs each transition only from its own stage', async () => {
      const s = setup()
      const { step } = await quoteAndStart(s)
      await expect(s.adapter.transition!({ leg, ref: step.ref!, name: T.kycDone }, s.ctx)).rejects.toMatchObject({ error: { code: 'CONFLICT' } })
      await expect(s.adapter.transition!({ leg, ref: step.ref!, name: 'create_order' }, s.ctx)).rejects.toMatchObject({ error: { code: 'CONFLICT' } })
    })

    it('keeps the access token sealed in the store and out of every step', async () => {
      const s = setup()
      const { step } = await toPayment(s)
      expect(JSON.stringify(step)).not.toContain(TOKEN)
      expect(JSON.stringify([...s.store.data.values()])).not.toContain(TOKEN)
      expect(JSON.stringify([...s.shared.data.values()])).not.toContain(TOKEN)
    })
  })

  describe('limits across sessions', () => {
    // `1234` is the right code; anything else is wrong (401)
    const codeRoute: FakeRoute = {
      method: 'POST',
      match: '/v2/auth/login-codes/verify',
      reply: (c) =>
        (c.body as { code?: string })?.code === '1234'
          ? ok({ accessToken: TOKEN, tokenType: 'Bearer', expiresIn: 3600 })
          : new Response(JSON.stringify({ success: false, errors: [{ field: 'code', message: 'Invalid code' }] }), { status: 401 }),
    }
    const L = PAYTRIE_LIMITS
    const guess = (s: ReturnType<typeof setup>, ref: string, code: string) => s.adapter.transition!({ leg, ref, name: T.code, inputs: { code } }, s.ctx)
    const startAll = (sessions: Array<ReturnType<typeof setup>>) => Promise.all(sessions.map(async (x) => ({ x, ref: (await quoteAndStart(x)).step.ref! })))

    it('stops concurrent wrong codes from many sessions for one email at the limit', async () => {
      const s = setup({}, { over: [codeRoute] })
      const sessions = Array.from({ length: L.sendsPerEmail }, (_, i) => otherSession(s, i + 10))
      const legs = await startAll(sessions)
      // Every session guesses at the same time, a few codes each
      const results = (await Promise.all(legs.map(async ({ x, ref }) => {
        const out: PromiseSettledResult<unknown>[] = []
        for (const code of ['0001', '0002', '0003']) out.push(...(await Promise.allSettled([guess(x, ref, code)])))
        return out
      }))).flat()
      expect(posts(s.calls, '/verify')).toHaveLength(L.triesPerEmail)
      const codes = results.map((r) => (r.status === 'rejected' ? (r.reason as { error: { code: string } }).error.code : 'ok'))
      expect(codes.filter((c) => c === 'BAD_REQUEST')).toHaveLength(L.triesPerEmail)
      expect(codes.filter((c) => c === 'RATE_LIMITED')).toHaveLength(results.length - L.triesPerEmail)
      // Locked: even the right code does not reach PayTrie now
      await expect(guess(legs[0]!.x, legs[0]!.ref, '1234')).rejects.toMatchObject({ error: { code: 'RATE_LIMITED' } })
      expect(posts(s.calls, '/verify')).toHaveLength(L.triesPerEmail)
    })

    it('stops concurrent checks on one leg too (one check at a time)', async () => {
      const s = setup({}, { over: [codeRoute] })
      const { step } = await quoteAndStart(s)
      const all = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => guess(s, step.ref!, `000${i}`)))
      expect(posts(s.calls, '/verify').length).toBeLessThanOrEqual(1)
      expect(all.filter((r) => r.status === 'rejected')).toHaveLength(8)
    })

    it('after a lockout, needs a new code once the window has passed', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        const s = setup({}, { over: [codeRoute] })
        const a = otherSession(s, 21)
        const b = otherSession(s, 22)
        const [la, lb] = await startAll([a, b])
        for (const code of ['0001', '0002', '0003']) await expect(guess(a, la!.ref, code)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
        for (const code of ['0004', '0005']) await expect(guess(b, lb!.ref, code)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
        await expect(guess(a, la!.ref, '1234')).rejects.toMatchObject({ error: { code: 'RATE_LIMITED' } })
        vi.setSystemTime(Date.now() + (L.triesWindowSec + 60) * 1000)
        // The old code (sent before the lockout) never counts again
        await expect(guess(a, la!.ref, '1234')).rejects.toMatchObject({ error: { code: 'RATE_LIMITED', message: expect.stringContaining('new code') } })
        await a.adapter.transition!({ leg, ref: la!.ref, name: T.resend }, a.ctx)
        await expect(guess(a, la!.ref, '1234')).resolves.toMatchObject({ status: 'requires_action', action: { kind: 'payment' } })
      } finally {
        vi.useRealTimers()
      }
    })

    it('a new code does not reset the tries of the email', async () => {
      const s = setup({}, { over: [codeRoute] })
      const { step } = await quoteAndStart(s)
      for (const code of ['0001', '0002', '0003']) await expect(guess(s, step.ref!, code)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
      await s.adapter.transition!({ leg, ref: step.ref!, name: T.resend }, s.ctx)
      for (const code of ['0004', '0005']) await expect(guess(s, step.ref!, code)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
      await expect(guess(s, step.ref!, '0006')).rejects.toMatchObject({ error: { code: 'RATE_LIMITED' } })
      expect(posts(s.calls, '/verify')).toHaveLength(L.triesPerEmail)
    })

    it('a correct code gives its try back', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        const s = setup({}, { over: [codeRoute] })
        const a = otherSession(s, 31)
        const b = otherSession(s, 32)
        const [la, lb] = await startAll([a, b])
        for (const code of ['0001', '0002', '0003', '0004']) await expect(guess(a, la!.ref, code)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
        await guess(a, la!.ref, '1234')
        // The freed slot is live for 1 more second (ScopedKV has no delete)
        vi.setSystemTime(Date.now() + 2000)
        await expect(guess(b, lb!.ref, '0005')).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
        await expect(guess(b, lb!.ref, '0006')).rejects.toMatchObject({ error: { code: 'RATE_LIMITED' } })
      } finally {
        vi.useRealTimers()
      }
    })

    it('limits code emails per email across sessions and app users', async () => {
      const s = setup()
      const sessions = Array.from({ length: L.sendsPerEmail + 1 }, (_, i) => otherSession(s, i + 40))
      const all = await Promise.allSettled(sessions.map((x) => quoteAndStart(x)))
      expect(all.filter((r) => r.status === 'fulfilled')).toHaveLength(L.sendsPerEmail)
      expect(all.find((r) => r.status === 'rejected')).toMatchObject({ reason: { error: { code: 'RATE_LIMITED' } } })
      expect(posts(s.calls, '/v2/auth/login-codes')).toHaveLength(L.sendsPerEmail)
      // The same email in other spelling counts as the same email
      const upper = otherSession(s, 99, { email: `  ${EMAIL.toUpperCase()}` })
      await expect(quoteAndStart(upper)).rejects.toMatchObject({ error: { code: expect.stringMatching(/RATE_LIMITED|BAD_REQUEST/) } })
      expect(posts(s.calls, '/v2/auth/login-codes')).toHaveLength(L.sendsPerEmail)
    })

    it('limits code emails per app user across emails', async () => {
      // Each email is its own PayTrie account here
      const perEmailUser: FakeRoute = {
        method: 'GET',
        match: '/v2/users?email=',
        reply: (c) => ok([{ id: `acct-${new URL(c.url).searchParams.get('email')!.split('@')[0]}`, accessibleBy: ['jwt'] }]),
      }
      const s = setup({}, { over: [perEmailUser] })
      const sessions = Array.from({ length: L.sendsPerUser + 1 }, (_, i) => otherSession(s, i + 60, { userId: 'one_app_user', email: `user${i}@example.com` }))
      const all = await Promise.allSettled(sessions.map((x) => quoteAndStart(x)))
      expect(all.filter((r) => r.status === 'fulfilled')).toHaveLength(L.sendsPerUser)
      expect(posts(s.calls, '/v2/auth/login-codes')).toHaveLength(L.sendsPerUser)
    })

    // Issue: the email key was not how PayTrie names an account, so other spellings got new counters.
    it('takes only plain ASCII emails, and counts and sends one canonical spelling', async () => {
      const refused = [
        'ｊane@example.com', // fullwidth
        'jane@examıple.com', // dotless i
        'jane@Kexample.com', // Kelvin sign
        'ja​ne@example.com', // zero-width space
        'ja­ne@example.com', // soft hyphen
        'ja ne@example.com',
        'ja\tne@example.com',
        'ja\u0000ne@example.com',
        'jane@example.com.',
        '"jane"@example.com',
        '"ja@ne"@example.com',
        'jane..doe@example.com',
        '.jane@example.com',
        'jane@exämple.com',
        'jane@[127.0.0.1]',
        'jane@localhost',
      ]
      for (const e of refused) expect(canonicalEmail(e), JSON.stringify(e)).toBeUndefined()
      expect(canonicalEmail('  Jane.Doe+ramp@Example.COM \n')).toBe('jane.doe+ramp@example.com')
      expect(canonicalEmail('jane@xn--exmple-cua.com')).toBe('jane@xn--exmple-cua.com')
      await expect(emailKey('ｊane@example.com')).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })

      // A session email in another spelling is refused before any PayTrie call
      for (const e of ['ｊane@example.com', 'ja​ne@example.com', 'jane@example.com.']) {
        const x = setup({}, { session: { email: e } })
        await expect(quoteAndStart(x)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
        expect(x.calls.filter((c) => !c.url.includes('/v2/quotes'))).toHaveLength(0)
      }
      // A typed email too
      const typed = setup({}, { session: { email: undefined }, adapterOpts: { requireSessionEmail: false } })
      const { step } = await quoteAndStart(typed)
      await expect(typed.adapter.transition!({ leg, ref: step.ref!, name: T.email, inputs: { email: 'ｊane@example.com' } }, typed.ctx)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })

      // PayTrie gets exactly the string that the limits count
      const s = setup({}, { over: [codeRoute] })
      const mixed = otherSession(s, 70, { email: '  Jane@Example.COM ' })
      const started = await quoteAndStart(mixed)
      await expect(guess(mixed, started.step.ref!, '0001')).rejects.toBeTruthy()
      expect(new URL(s.calls.find((c) => c.url.includes('/v2/users?email='))!.url).searchParams.get('email')).toBe(EMAIL)
      expect(posts(s.calls, '/v2/auth/login-codes')[0]!.body).toEqual({ email: EMAIL })
      expect(posts(s.calls, '/verify')[0]!.body).toEqual({ email: EMAIL, code: '0001' })
    })

    it('counts every spelling of one PayTrie account together (keyed on the PayTrie user id)', async () => {
      // Plus tags are valid ASCII, but here PayTrie maps them all to USER_ID
      const s = setup({}, { over: [codeRoute] })
      const sessions = Array.from({ length: L.sendsPerEmail + 1 }, (_, i) => otherSession(s, i + 80, { email: `jane+${i}@example.com` }))
      const all = await Promise.allSettled(sessions.map((x) => quoteAndStart(x)))
      expect(all.filter((r) => r.status === 'fulfilled')).toHaveLength(L.sendsPerEmail)
      expect(posts(s.calls, '/v2/auth/login-codes')).toHaveLength(L.sendsPerEmail)
      // Code checks: other spellings share the tries of the account
      // Keep each leg with its own session: the refused send can be any one of the concurrent starts.
      const legs = all.flatMap((r, i) => (r.status === 'fulfilled' ? [{ x: sessions[i]!, ref: r.value.step.ref! }] : []))
      for (let i = 0; i < L.triesPerEmail; i++) await expect(guess(legs[i]!.x, legs[i]!.ref, `000${i}`)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
      await expect(guess(legs[0]!.x, legs[0]!.ref, '1234')).rejects.toMatchObject({ error: { code: 'RATE_LIMITED' } })
      expect(posts(s.calls, '/verify')).toHaveLength(L.triesPerEmail)
    })

    // Issue: rate limit bypasses (a give-back without a token, a lock only after an extra try, old codes)
    it('gives a try back only for an access token (a 2xx without one keeps the slot)', async () => {
      const noToken: FakeRoute = { method: 'POST', match: '/v2/auth/login-codes/verify', reply: () => ({ success: false, errors: [{ field: 'code', message: 'Invalid code' }] }) }
      const s = setup({}, { over: [noToken] })
      const sessions = Array.from({ length: 2 }, (_, i) => otherSession(s, i + 90))
      const legs = await startAll(sessions)
      for (let i = 0; i < L.triesPerEmail; i++) {
        const { x, ref } = legs[i % 2]!
        await expect(guess(x, ref, `000${i}`)).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
      }
      await expect(guess(legs[0]!.x, legs[0]!.ref, '1234')).rejects.toMatchObject({ error: { code: 'RATE_LIMITED' } })
      expect(posts(s.calls, '/verify')).toHaveLength(L.triesPerEmail)
    })

    it('locks the email on the last wrong try, so the same code never gets a new window', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        const s = setup({}, { over: [codeRoute] })
        const a = otherSession(s, 101)
        const b = otherSession(s, 102)
        const [la, lb] = await startAll([a, b])
        // Exactly the limit, never one more
        for (const code of ['0001', '0002', '0003']) await expect(guess(a, la!.ref, code)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
        for (const code of ['0004', '0005']) await expect(guess(b, lb!.ref, code)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
        vi.setSystemTime(Date.now() + (L.triesWindowSec + 60) * 1000)
        // The window passed, but the codes sent before the lock never count again
        await expect(guess(b, lb!.ref, '1234')).rejects.toMatchObject({ error: { code: 'RATE_LIMITED', message: expect.stringContaining('new code') } })
        expect(posts(s.calls, '/verify')).toHaveLength(L.triesPerEmail)
      } finally {
        vi.useRealTimers()
      }
    })

    it('never checks a code that is older than an hour (a lock always outlives a code)', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        const s = setup({}, { over: [codeRoute] })
        const { step } = await quoteAndStart(s)
        vi.setSystemTime(Date.now() + 61 * 60_000)
        await expect(guess(s, step.ref!, '1234')).rejects.toMatchObject({ error: { code: 'BAD_REQUEST', message: expect.stringContaining('new code') } })
        expect(posts(s.calls, '/verify')).toHaveLength(0)
      } finally {
        vi.useRealTimers()
      }
    })

    it('keeps no plain email in the shared store', async () => {
      const s = setup({}, { over: [codeRoute] })
      const { step } = await quoteAndStart(s)
      await expect(guess(s, step.ref!, '0001')).rejects.toBeTruthy()
      expect(JSON.stringify([...s.shared.data.keys()])).not.toContain(EMAIL)
      const ek = await emailKey(EMAIL)
      expect([...s.shared.data.keys()].some((k) => k.startsWith(`te:${ek}`))).toBe(true)
    })
  })

  describe('order', () => {
    it('creates the transaction with the server wallet, the quote id and the leg ref, then shows the Interac details', async () => {
      const s = setup()
      const { ref, step } = await toPayment(s)
      const create = posts(s.calls, '/v2/transactions')
      expect(create).toHaveLength(1)
      expect(create[0]!.body).toEqual({ leftSideLabel: 'CAD', leftSideValue: 1000, rightSideLabel: 'USDC-BASE', wallet: WALLET, quoteId: 337362, externalSessionId: ref })
      expect(create[0]!.headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
      expect(checkLegStep(step)).toEqual([])
      expect(stateFor(step)).toBe('PAYMENT')
      expect(step).toMatchObject({ status: 'requires_action', providerRef: TX_ID, detail: { code: 'bank_details' }, action: { kind: 'payment', surface: { kind: 'BANK_FIELDS' } } })
      const fields = (step.action!.surface as { fields: Array<{ label: string; value: string }> }).fields
      expect(fields).toContainEqual({ label: 'Interac reference', value: 'CA1MRUaaErpx', copy: true })
      expect(fields).toContainEqual({ label: 'Amount (CAD)', value: '1000.00', copy: true })
      expect(await s.shared.get(`ptx:${TX_ID}`)).toEqual({ ref, wallet: WALLET, chain: 'eip155:8453', label: 'USDC-BASE' })
    })

    it('ignores a wallet, token or amount that the client sends', async () => {
      const s = setup()
      const { step } = await quoteAndStart(s)
      await s.adapter.transition!(
        { leg, ref: step.ref!, name: T.code, inputs: { code: '1234', wallet: '0x000000000000000000000000000000000000dead', rightSideLabel: 'USDC-ETH', leftSideValue: 1 } },
        s.ctx,
      )
      expect(posts(s.calls, '/v2/transactions')[0]!.body).toMatchObject({ wallet: WALLET, rightSideLabel: 'USDC-BASE', leftSideValue: 1000 })
    })

    it('delivers to the hop address that the server gives', async () => {
      const s = setup({ created: TX('awaiting-fiat', { wallet: '0x00000000000000000000000000000000000000aa' }) })
      const q = await s.adapter.quote({ leg, amountIn: cad('1000') }, s.ctx)
      const step = await s.adapter.start({ leg, quote: q, deliverTo: { address: '0x00000000000000000000000000000000000000aa' } }, s.ctx)
      await s.adapter.transition!({ leg, ref: step.ref!, name: T.code, inputs: { code: '1234' } }, s.ctx)
      expect(posts(s.calls, '/v2/transactions')[0]!.body).toMatchObject({ wallet: '0x00000000000000000000000000000000000000aa' })
    })

    it('leaves out a stale quote id', async () => {
      const s = setup()
      const q = await s.adapter.quote({ leg, amountIn: cad('1000') }, s.ctx)
      const old: LegQuote = { ...q, data: { ...(q.data as object), quotedAt: Date.now() - 11 * 60_000 } }
      const step = await s.adapter.start({ leg, quote: old }, s.ctx)
      await s.adapter.transition!({ leg, ref: step.ref!, name: T.code, inputs: { code: '1234' } }, s.ctx)
      expect(posts(s.calls, '/v2/transactions')[0]!.body).not.toHaveProperty('quoteId')
    })

    it('creates one order when two code submissions race', async () => {
      const s = setup()
      const { step } = await quoteAndStart(s)
      const both = await Promise.allSettled([
        s.adapter.transition!({ leg, ref: step.ref!, name: T.code, inputs: { code: '1234' } }, s.ctx),
        s.adapter.transition!({ leg, ref: step.ref!, name: T.code, inputs: { code: '1234' } }, s.ctx),
      ])
      expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(both.find((r) => r.status === 'rejected')).toMatchObject({ reason: { error: { code: 'CONFLICT' } } })
      expect(posts(s.calls, '/v2/transactions')).toHaveLength(1)
    })

    it('cancels and fails closed when PayTrie answers with another wallet', async () => {
      const s = setup({ created: TX('awaiting-fiat', { wallet: '0x000000000000000000000000000000000000dead' }) })
      const { step } = await toPayment(s)
      expect(step).toMatchObject({ status: 'failed', error: { code: 'PROVIDER_UNAVAILABLE', recovery: 'contact_support' } })
      expect(s.calls.some((c) => c.method === 'PUT' && c.url.endsWith(`/transactions/${TX_ID}/cancel`))).toBe(true)
      expect(await s.shared.get(`ptx:${TX_ID}`)).toBeUndefined()
    })

    it('fails closed when PayTrie answers with another token or amount', async () => {
      for (const created of [TX('awaiting-fiat', { rightSideLabel: 'USDC-ETH' }), TX('awaiting-fiat', { leftSideValue: 10 }), { ...TX('awaiting-fiat'), id: undefined }]) {
        const s = setup({ created })
        const { step } = await toPayment(s)
        expect(step.status).toBe('failed')
      }
    })

    it('never creates a second order after an unknown outcome', async () => {
      const s = setup({ createStatus: 503 })
      const { ref, step } = await toPayment(s)
      expect(step).toMatchObject({ status: 'failed', error: { recovery: 'contact_support', retryable: false } })
      await expect(s.adapter.transition!({ leg, ref, name: T.code, inputs: { code: '1234' } }, s.ctx)).rejects.toMatchObject({ error: { code: 'CONFLICT' } })
      expect(posts(s.calls, '/v2/transactions')).toHaveLength(1)
    })

    it('shows a PayTrie limit message, and lets a later attempt run', async () => {
      const s = setup({ createStatus: 400 })
      const { step } = await quoteAndStart(s)
      await expect(s.adapter.transition!({ leg, ref: step.ref!, name: T.code, inputs: { code: '1234' } }, s.ctx)).rejects.toMatchObject({
        error: { code: 'PROVIDER_DECLINED', message: 'PayTrie: You have reached your 24 hour limit.' },
      })
      await expect(s.adapter.transition!({ leg, ref: step.ref!, name: T.code, inputs: { code: '1234' } }, s.ctx)).rejects.toMatchObject({ error: { code: 'PROVIDER_DECLINED' } })
      expect(posts(s.calls, '/v2/transactions')).toHaveLength(2)
    })
  })

  describe('KYC', () => {
    it('sends an unverified user to the PayTrie KYC page, and creates the order once verified', async () => {
      let status = 'initial'
      const s2 = setup({}, { over: [{ method: 'GET', match: /\/v2\/users\/[^/?]+$/, reply: () => ok({ id: USER_ID, status }) }] })
      const { step } = await toPayment(s2)
      expect(step).toMatchObject({ status: 'requires_action', detail: { code: 'kyc_verify' }, action: { kind: 'kyc', surface: { kind: 'REDIRECT', url: 'https://in.sumsub.com/websdk/p/abc' } } })
      expect(stateFor(step)).toBe('KYC')
      expect(posts(s2.calls, '/v2/transactions')).toHaveLength(0)
      // Still in KYC: the poll keeps the link it has
      const poll = await s2.adapter.status!({ leg, ref: step.ref! }, s2.ctx)
      expect(poll.action?.kind).toBe('kyc')
      expect(s2.calls.filter((c) => c.url.endsWith('/kyc-url'))).toHaveLength(1)
      status = 'verified'
      const done = await s2.adapter.transition!({ leg, ref: step.ref!, name: T.kycDone }, s2.ctx)
      expect(stateFor(done)).toBe('PAYMENT')
      expect(posts(s2.calls, '/v2/transactions')).toHaveLength(1)
    })

    it('waits during the review, and fails a rejected user', async () => {
      const review = setup({ userStatus: 'in-review' })
      const { step } = await toPayment(review)
      expect(step).toMatchObject({ status: 'processing', phase: 'kyc', detail: { code: 'kyc_review' } })
      const rejected = setup({ userStatus: 'rejected' })
      expect((await toPayment(rejected)).step).toMatchObject({ status: 'failed', error: { code: 'KYC_REJECTED' } })
      const unknown = setup({ userStatus: 'mystery' })
      expect((await toPayment(unknown)).step).toMatchObject({ status: 'processing', phase: 'kyc' })
      expect(posts(unknown.calls, '/v2/transactions')).toHaveLength(0)
    })

    it('asks for a new code when the token expired, and never emails one from a poll', async () => {
      const s = setup({ userStatus: 'in-review' })
      const { ref } = await toPayment(s)
      await s.store.put(`t:${ref}`, null, 1)
      const codes = posts(s.calls, '/v2/auth/login-codes').length
      const step = await s.adapter.status!({ leg, ref }, s.ctx)
      expect(step).toMatchObject({ status: 'requires_action', action: { kind: 'auth', surface: { kind: 'FORM', fields: [] }, transitions: [{ name: T.sendCode }] } })
      expect(posts(s.calls, '/v2/auth/login-codes')).toHaveLength(codes)
      const otp = await s.adapter.transition!({ leg, ref, name: T.sendCode }, s.ctx)
      expect(otp.action?.surface?.kind).toBe('OTP')
    })
  })

  describe('status', () => {
    const cases: Array<[string, string, string?]> = [
      ['awaiting-fiat', 'requires_action'],
      ['processing-fiat', 'processing', 'processing'],
      ['finalizing-fiat', 'processing', 'settling'],
      ['sending-crypto', 'processing', 'confirming'],
      ['complete', 'succeeded'],
      ['cancelled', 'failed'],
      ['expired', 'expired'],
      ['expired-contact-support', 'failed'],
      ['refunded', 'refunded'],
      ['replaced', 'failed'],
    ]
    for (const [provider, status, detail] of cases) {
      it(`maps ${provider} to ${status}`, async () => {
        const s = setup({ tx: TX(provider) })
        const { ref } = await toPayment(s)
        const step = await s.adapter.status!({ leg, ref }, s.ctx)
        expect(checkLegStep(step)).toEqual([])
        expect(step.status).toBe(status)
        if (detail) expect(step.detail).toEqual({ code: detail, providerStatus: provider })
      })
    }

    it('reports the output and the chain hash on complete, and drops the token', async () => {
      const s = setup()
      const { ref } = await toPayment(s)
      const step = await s.adapter.status!({ leg, ref }, s.ctx)
      expect(step).toMatchObject({ status: 'succeeded', providerRef: TX_ID, output: { value: '714.5' }, transactions: [{ role: 'destination', hash: HASH, chain: 'eip155:8453' }] })
      expect(s.calls.at(-1)!.headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
      expect(await s.store.get(`t:${ref}`)).toBeNull()
    })

    it('does not take a provider payment id for a chain hash', async () => {
      const s = setup({ tx: TX('complete') })
      const { ref } = await toPayment(s)
      const step = await s.adapter.status!({ leg, ref }, s.ctx)
      expect(step.status).toBe('succeeded')
      expect(step.transactions).toBeUndefined()
    })

    it('keeps the step for an unknown status (never a success by accident)', async () => {
      const s = setup({ tx: TX('awaiting-crypto') })
      const { ref } = await toPayment(s)
      const step = await s.adapter.status!({ leg, ref }, s.ctx)
      expect(step.status).toBe('requires_action')
      expect(s.log.warnings.some((w) => w.includes('unknown provider status'))).toBe(true)
    })

    it('never reports success for a transaction to another wallet or token', async () => {
      for (const tx of [TX('complete', { wallet: '0x000000000000000000000000000000000000dead' }), TX('complete', { rightSideLabel: 'USDC-ETH' }), TX('complete', { wallet: undefined })]) {
        const s = setup({ tx })
        const { ref } = await toPayment(s)
        const step = await s.adapter.status!({ leg, ref }, s.ctx)
        expect(step.status).toBe('requires_action')
      }
    })

    it('waits for the webhook when the token expired', async () => {
      const s = setup()
      const { ref } = await toPayment(s)
      await s.store.put(`t:${ref}`, null, 1)
      const n = s.calls.length
      const step = await s.adapter.status!({ leg, ref }, s.ctx)
      expect(step).toMatchObject({ status: 'requires_action', action: { kind: 'payment', transitions: [{ kind: 'AWAIT' }] } })
      expect(s.calls).toHaveLength(n)
    })

    it('refuses a leg record of another session or user', async () => {
      const s = setup()
      const { ref } = await toPayment(s)
      const other = makeCtx({ fetch: s.ctx.fetch, store: s.store, shared: s.shared, session: { id: 'sess_2', country: 'CA', email: EMAIL } })
      await expect(s.adapter.status!({ leg, ref }, other)).rejects.toMatchObject({ error: { code: 'SESSION_EXPIRED' } })
      await expect(s.adapter.transition!({ leg, ref, name: T.code, inputs: { code: '1234' } }, other)).rejects.toMatchObject({ error: { code: 'SESSION_EXPIRED' } })
    })

    it('cancels the PayTrie order with the user token', async () => {
      const s = setup()
      const { ref } = await toPayment(s)
      await s.adapter.cancel!({ leg, ref }, s.ctx)
      expect(s.calls.at(-1)).toMatchObject({ method: 'PUT' })
      expect(s.calls.at(-1)!.url).toBe(`https://api.paytrie.com/v2/transactions/${TX_ID}/cancel`)
      expect(await s.store.get(`t:${ref}`)).toBeNull()
    })
  })

  describe('webhooks', () => {
    async function withOrder() {
      const s = setup()
      const { ref } = await toPayment(s)
      const wctx = makeWebhookCtx({ shared: s.shared, log: s.log })
      return { ...s, ref, wctx }
    }

    it('verifies the v1 HMAC over the timestamp and the raw body', async () => {
      const a = paytrie(opts)
      const wctx = makeWebhookCtx()
      const body = envelope('complete')
      const now = String(Math.floor(Date.now() / 1000))
      expect(await a.webhook!.verify(hookReq(body), body, wctx)).toBe(true)
      // Our own helper gives the same signature
      expect(`v1=${await paytrieSignature(SECRET, now, body)}`).toBe(sign(body, now))
      // Wrong secret, changed body, no prefix, stale or missing timestamp
      expect(await a.webhook!.verify(hookReq(body, { 'x-paytrie-timestamp': now, 'x-paytrie-signature': sign(body, now, 'whsec_other') }), body, wctx)).toBe(false)
      expect(await a.webhook!.verify(hookReq(body), `${body} `, wctx)).toBe(false)
      expect(await a.webhook!.verify(hookReq(body, { 'x-paytrie-timestamp': now, 'x-paytrie-signature': sign(body, now).slice(3) }), body, wctx)).toBe(false)
      const old = String(Math.floor(Date.now() / 1000) - 600)
      expect(await a.webhook!.verify(hookReq(body, { 'x-paytrie-timestamp': old, 'x-paytrie-signature': sign(body, old) }), body, wctx)).toBe(false)
      expect(await a.webhook!.verify(hookReq(body, { 'x-paytrie-signature': sign(body, now) }), body, wctx)).toBe(false)
    })

    it('rejects every webhook without a secret', async () => {
      const body = envelope('complete')
      const a = paytrie({ apiKey: API_KEY })
      expect(a.webhook!.configured).toBe(false)
      expect(await a.webhook!.verify(hookReq(body), body, makeWebhookCtx())).toBe(false)
      const empty = paytrie({ apiKey: API_KEY, webhookSecret: '' })
      expect(await empty.webhook!.verify(hookReq(body, { 'x-paytrie-timestamp': String(Math.floor(Date.now() / 1000)), 'x-paytrie-signature': sign(body, undefined, '') }), body, makeWebhookCtx())).toBe(false)
    })

    it('finds the leg through our own order index', async () => {
      const s = await withOrder()
      const events = await s.adapter.webhook!.parse(envelope('complete', { externalSessionId: s.ref }), s.wctx)
      expect(events).toEqual([
        {
          ref: s.ref,
          status: 'succeeded',
          providerRef: TX_ID,
          transactions: [{ role: 'destination', hash: HASH, chain: 'eip155:8453' }],
          output: { value: '714.5', asset: { ...BASE_USDC, symbol: 'USDC', decimals: 6 } },
          eventId: 'paytrie:b3f1c2d4-5678-4abc-9012-3456789abcde',
        },
      ])
    })

    it('ignores a transaction that is not in the index, whatever its externalSessionId says', async () => {
      const s = await withOrder()
      // A widget transaction can carry any externalSessionId, for example the ref of another session
      const forged = envelope('complete', { transactionId: '11111111-2222-3333-4444-555555555555', externalSessionId: s.ref })
      expect(await s.adapter.webhook!.parse(forged, s.wctx)).toEqual([])
    })

    it('ignores an event whose externalSessionId, wallet or token disagrees with the index', async () => {
      const s = await withOrder()
      expect(await s.adapter.webhook!.parse(envelope('complete', { externalSessionId: 'ptr_000000000000000000000000' }), s.wctx)).toEqual([])
      expect(await s.adapter.webhook!.parse(envelope('complete', { wallet: '0x000000000000000000000000000000000000dead' }), s.wctx)).toEqual([])
      expect(await s.adapter.webhook!.parse(envelope('complete', { rightSideLabel: 'USDC-ETH' }), s.wctx)).toEqual([])
      // A success must name the wallet and the token
      expect(await s.adapter.webhook!.parse(envelope('complete', { wallet: undefined }), s.wctx)).toEqual([])
      expect(await s.adapter.webhook!.parse(envelope('complete', { rightSideLabel: undefined }), s.wctx)).toEqual([])
    })

    it('gives no event for user updates, other versions, unknown statuses and bad JSON', async () => {
      const s = await withOrder()
      const user = JSON.stringify({ id: 'e1', apiVersion: 'v2', type: 'user.update', payload: { userId: USER_ID, email: EMAIL, status: 'verified' } })
      expect(await s.adapter.webhook!.parse(user, s.wctx)).toEqual([])
      expect(await s.adapter.webhook!.parse(envelope('complete', {}, { apiVersion: 'v1' }), s.wctx)).toEqual([])
      expect(await s.adapter.webhook!.parse(envelope('awaiting-crypto'), s.wctx)).toEqual([])
      expect(await s.adapter.webhook!.parse('not json', s.wctx)).toEqual([])
    })

    it('maps a waiting status to requires_action with no surface', async () => {
      const s = await withOrder()
      const [ev] = await s.adapter.webhook!.parse(envelope('awaiting-fiat'), s.wctx)
      expect(ev).toMatchObject({ ref: s.ref, status: 'requires_action', detail: { code: 'bank_details' } })
      expect(ev!.action).toBeUndefined()
    })

    it('gives a replay key from the event id, then eventId, then the body hash', async () => {
      const a = paytrie(opts)
      const req = hookReq('{}')
      const wctx = makeWebhookCtx()
      expect(await a.webhook!.replayKey!(req, envelope('complete'), wctx)).toBe('paytrie:b3f1c2d4-5678-4abc-9012-3456789abcde')
      const legacy = JSON.stringify({ eventId: 'c4a2d3e5', type: 'transaction.update', payload: {} })
      expect(await a.webhook!.replayKey!(req, legacy, wctx)).toBe('paytrie:c4a2d3e5')
      expect(await a.webhook!.replayKey!(req, 'not json', wctx)).toMatch(/^[0-9a-f]{64}$/)
    })
  })
})
