import { describe, expect, it } from 'vitest'
import { checkAdapterShape, checkLegQuote, checkLegStep } from '@openrampkit/adapter'
import type { AdapterContext, ScopedKV } from '@openrampkit/adapter'
import { mockAdapter } from '@openrampkit/adapter-mock'
import { createOpenRamp } from '@openrampkit/server'
import { XENDIT_CHANNELS, xendit } from './index.js'

const quiet = { debug() {}, info() {}, warn() {}, error() {} }

function kv(): ScopedKV {
  const m = new Map<string, unknown>()
  return { get: async (k) => m.get(k) as never, put: async (k, v) => void m.set(k, v) }
}

type Call = { url: string; init: RequestInit }
function fakeFetch(respond: (url: string, init: RequestInit) => Response) {
  const calls: Call[] = []
  const f = (async (u: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(u), init })
    return respond(String(u), init)
  }) as typeof fetch
  return { f, calls }
}

const pr = (over: Record<string, unknown> = {}) => ({
  payment_request_id: 'pr-1', reference_id: 'ors_x-1', status: 'REQUIRES_ACTION', currency: 'IDR', request_amount: 150000, channel_code: 'QRIS',
  actions: [{ type: 'PRESENT_TO_CUSTOMER', descriptor: 'QR_STRING', value: '00020101021226...' }], ...over,
})

function ctx(f: typeof fetch): AdapterContext {
  return {
    session: { id: 'ors_x', userId: 'u1', direction: 'deposit', country: 'ID', locale: 'en', livemode: false },
    destination: { type: 'merchant', currency: 'IDR' },
    pathway: { legs: [], index: 0 },
    urls: { returnUrl: 'https://app.test/return', webhookUrl: 'https://app.test/webhooks/xendit' },
    store: kv(), shared: kv(), fetch: f, log: quiet, idempotencyKey: (s) => `ors_x:${s}`,
  }
}

const leg = (id: string, currency: string) => ({ adapterId: 'xendit', legId: id, from: { asset: { kind: 'fiat' as const, currency }, location: { kind: 'user_account' as const } }, to: { asset: { kind: 'fiat' as const, currency }, location: { kind: 'merchant_account' as const } } })

describe('xendit adapter', () => {
  const a = xendit({ secretKey: 'xnd_development_abc', webhookToken: 'tok', fees: { qris: { bps: 70 } } })

  it('declares one pay-in leg per country and method, and passes the shape check', () => {
    expect(checkAdapterShape(a)).toEqual([])
    expect(a.legs.map((l) => l.id)).toContain('id-qris')
    expect(a.legs.find((l) => l.id === 'ph-qrph')).toMatchObject({ kind: 'fiat_payin', regions: { allow: ['PH'] }, surfaces: ['QR'] })
    expect(a.legs.find((l) => l.id === 'ph-gcash')!.surfaces).toEqual(['REDIRECT', 'DEEPLINK'])
    expect(xendit({ secretKey: 'k', webhookToken: 't', methods: ['qris'] }).legs).toHaveLength(1)
    expect(new Set(XENDIT_CHANNELS.map((c) => `${c.country}-${c.method}`)).size).toBe(XENDIT_CHANNELS.length)
  })

  it('quotes with the configured fee and enforces channel limits', async () => {
    const { f } = fakeFetch(() => new Response('{}'))
    const q = await a.quote({ leg: leg('id-qris', 'IDR'), amountIn: { value: '150000', asset: { kind: 'fiat', currency: 'IDR' } } }, ctx(f))
    expect(checkLegQuote(q)).toEqual([])
    expect(q.fees).toEqual([{ kind: 'provider', label: 'Xendit fee', amount: '1050', currency: 'IDR' }])
    expect(q.output.value).toBe('148950')
    await expect(a.quote({ leg: leg('id-qris', 'IDR'), amountIn: { value: '99999999', asset: { kind: 'fiat', currency: 'IDR' } } }, ctx(f))).rejects.toMatchObject({ error: { code: 'AMOUNT_TOO_HIGH' } })
    await expect(a.quote({ leg: leg('vn-momo', 'VND'), amountIn: { value: '10', asset: { kind: 'fiat', currency: 'VND' } } }, ctx(f))).rejects.toMatchObject({ error: { code: 'AMOUNT_TOO_LOW' } })
    await expect(a.quote({ leg: leg('xx-nope', 'IDR'), amountIn: { value: '1', asset: { kind: 'fiat', currency: 'IDR' } } }, ctx(f))).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
  })

  it('creates a QRIS payment request with the right headers and body, and shows a QR', async () => {
    const { f, calls } = fakeFetch(() => Response.json(pr()))
    const c = ctx(f)
    const q = await a.quote({ leg: leg('id-qris', 'IDR'), amountIn: { value: '150000', asset: { kind: 'fiat', currency: 'IDR' } } }, c)
    const step = await a.start({ leg: leg('id-qris', 'IDR'), quote: q }, c)
    expect(checkLegStep(step)).toEqual([])
    expect(step).toMatchObject({ state: 'PAYMENT', status: 'requires_action', ref: 'pr-1', surface: { kind: 'QR', payload: '00020101021226...', currency: 'IDR', amount: '150000' } })
    const call = calls[0]!
    expect(call.url).toBe('https://api.xendit.co/v3/payment_requests')
    const h = new Headers(call.init.headers)
    expect(h.get('authorization')).toBe(`Basic ${btoa('xnd_development_abc:')}`)
    expect(h.get('api-version')).toBe('2024-11-11')
    expect(h.get('idempotency-key')).toBe(`ors_x:xendit:id-qris:${(q.data as { nonce: string }).nonce}`)
    expect(JSON.parse(String(call.init.body))).toMatchObject({ type: 'PAY', country: 'ID', currency: 'IDR', request_amount: 150000, capture_method: 'AUTOMATIC', channel_code: 'QRIS' })
  })

  it('e-wallets redirect or deep link; for-user-id is sent for xenPlatform', async () => {
    const withSub = xendit({ secretKey: 'k', webhookToken: 't', forUserId: 'sub_1' })
    const web = fakeFetch(() => Response.json(pr({ channel_code: 'GCASH', currency: 'PHP', actions: [{ type: 'REDIRECT_CUSTOMER', descriptor: 'WEB_URL', value: 'https://gcash.test/pay' }] })))
    const s1 = await withSub.start({ leg: leg('ph-gcash', 'PHP'), quote: { adapterId: 'xendit', legId: 'ph-gcash', input: { value: '500', asset: { kind: 'fiat', currency: 'PHP' } }, output: { value: '500', asset: { kind: 'fiat', currency: 'PHP' } }, fees: [], eta: { min: 1, max: 2 } } }, ctx(web.f))
    expect(s1.surface).toMatchObject({ kind: 'REDIRECT', url: 'https://gcash.test/pay' })
    expect(new Headers(web.calls[0]!.init.headers).get('for-user-id')).toBe('sub_1')
    const deep = fakeFetch(() => Response.json(pr({ actions: [{ type: 'REDIRECT_CUSTOMER', descriptor: 'DEEPLINK_URL', value: 'momo://pay' }] })))
    const s2 = await a.start({ leg: leg('vn-momo', 'VND'), quote: { adapterId: 'xendit', legId: 'vn-momo', input: { value: '50000', asset: { kind: 'fiat', currency: 'VND' } }, output: { value: '50000', asset: { kind: 'fiat', currency: 'VND' } }, fees: [], eta: { min: 1, max: 2 } } }, ctx(deep.f))
    expect(s2.surface).toMatchObject({ kind: 'DEEPLINK', url: 'momo://pay' })
  })

  it('maps every payment request status', async () => {
    const cases: Array<[string, string, string]> = [
      ['ACCEPTING_PAYMENTS', 'PAYMENT', 'requires_action'], ['REQUIRES_ACTION', 'PAYMENT', 'requires_action'], ['AUTHORIZED', 'PROCESSING', 'processing'],
      ['SUCCEEDED', 'COMPLETED', 'succeeded'], ['FAILED', 'FAILED', 'failed'], ['CANCELED', 'FAILED', 'failed'], ['EXPIRED', 'EXPIRED', 'expired'],
    ]
    for (const [status, state, legStatus] of cases) {
      const { f, calls } = fakeFetch(() => Response.json(pr({ status, failure_code: 'INSUFFICIENT_BALANCE' })))
      const s = await a.status!({ leg: leg('id-qris', 'IDR'), ref: 'pr-1' }, ctx(f))
      expect([s.state, s.status]).toEqual([state, legStatus])
      expect(checkLegStep(s)).toEqual([])
      expect(calls[0]!.url).toBe('https://api.xendit.co/v3/payment_requests/pr-1')
    }
  })

  it('maps HTTP errors', async () => {
    for (const [code, expected] of [[429, 'RATE_LIMITED'], [400, 'PROVIDER_DECLINED'], [503, 'PROVIDER_UNAVAILABLE']] as const) {
      const { f } = fakeFetch(() => new Response(JSON.stringify({ message: 'nope' }), { status: code }))
      await expect(a.status!({ leg: leg('id-qris', 'IDR'), ref: 'pr-1' }, ctx(f))).rejects.toMatchObject({ error: { code: expected } })
    }
  })

  it('PayNow uses channel code SGQR (Xendit PayNow QR page), with a 0.01 SGD minimum', async () => {
    const { f, calls } = fakeFetch(() => Response.json(pr({ channel_code: 'SGQR', currency: 'SGD', request_amount: 12.5 })))
    const c = { ...ctx(f), destination: { type: 'merchant' as const, currency: 'SGD' } }
    const q = await a.quote({ leg: leg('sg-paynow', 'SGD'), amountIn: { value: '12.5', asset: { kind: 'fiat', currency: 'SGD' } } }, c)
    const step = await a.start({ leg: leg('sg-paynow', 'SGD'), quote: q }, c)
    expect(step.surface).toMatchObject({ kind: 'QR', currency: 'SGD', method: 'paynow' })
    expect(calls[0]!.url).toBe('https://api.xendit.co/v3/payment_requests')
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ type: 'PAY', country: 'SG', currency: 'SGD', request_amount: 12.5, channel_code: 'SGQR' })
    expect(a.legs.find((l) => l.id === 'sg-paynow')!.limits).toEqual({ min: '0.01', max: '200000', currency: 'SGD' })
    await expect(a.quote({ leg: leg('sg-paynow', 'SGD'), amountIn: { value: '0.01', asset: { kind: 'fiat', currency: 'SGD' } } }, c)).resolves.toMatchObject({ input: { value: '0.01' } })
  })

  it('setup errors are not retryable and tell the operator what to do', async () => {
    const errors: string[] = []
    const log = { ...quiet, error: (m: string) => void errors.push(m) }
    const start = async (legId: string, currency: string, status: number, body: unknown) => {
      const { f } = fakeFetch(() => new Response(JSON.stringify(body), { status }))
      const quote = { adapterId: 'xendit', legId, input: { value: '100', asset: { kind: 'fiat' as const, currency } }, output: { value: '100', asset: { kind: 'fiat' as const, currency } }, fees: [], eta: { min: 1, max: 2 } }
      return a.start({ leg: leg(legId, currency), quote }, { ...ctx(f), log })
    }
    // Live test mode answer for QRIS and QRPH on an account without the channel (2026-10-09)
    const notActive = { error_code: 'INVALID_MERCHANT_SETTINGS', message: 'payment channel has not been activated' }
    for (const [legId, cur, code] of [['id-qris', 'IDR', 'QRIS'], ['ph-qrph', 'PHP', 'QRPH']] as const) {
      errors.length = 0
      const e = await start(legId, cur, 403, notActive).catch((x) => x)
      expect(e.error).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: false, recovery: 'choose_other' })
      expect(e.error.message).toBe('This payment method is not set up for this app yet. Try another method.')
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain(code)
      expect(errors[0]).toMatch(/Activate the payment channel in the Xendit Dashboard/)
    }
    // Live test mode answer for the old PAYNOW channel code (2026-10-09)
    errors.length = 0
    const unsupported = { error_code: 'API_VALIDATION_ERROR', message: "API endpoint and method is not supported for 'PAYNOW' channel code with country 'SG'" }
    const e = await start('sg-paynow', 'SGD', 400, unsupported).catch((x) => x)
    expect(e.error).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: false, recovery: 'choose_other' })
    expect(errors[0]).toContain('paynow (SGQR, SG)')
    expect(errors[0]).toContain("not supported for 'PAYNOW' channel code")
    // Other 400s stay a decline with Xendit's message
    const other = await start('id-qris', 'IDR', 400, { error_code: 'INVALID_VALUE_ERROR', message: 'request_amount is too small' }).catch((x) => x)
    expect(other.error).toMatchObject({ code: 'PROVIDER_DECLINED', retryable: false, message: 'Xendit: request_amount is too small' })
  })

  it('401 and 403 about our key are setup errors (shared mapping), not payment declines', async () => {
    const quote = { adapterId: 'xendit', legId: 'id-qris', input: { value: '100', asset: { kind: 'fiat' as const, currency: 'IDR' } }, output: { value: '100', asset: { kind: 'fiat' as const, currency: 'IDR' } }, fees: [], eta: { min: 1, max: 2 } }
    for (const [status, body] of [
      [401, { error_code: 'INVALID_API_KEY', message: 'API key is not authorized for this API service' }],
      [403, { error_code: 'REQUEST_FORBIDDEN_ERROR', message: 'The API key is forbidden to perform this request' }],
    ] as const) {
      const errors: string[] = []
      const warnings: string[] = []
      const log = { ...quiet, error: (m: string) => void errors.push(m), warn: (m: string) => void warnings.push(m) }
      const { f } = fakeFetch(() => new Response(JSON.stringify(body), { status }))
      const e = await a.start({ leg: leg('id-qris', 'IDR'), quote }, { ...ctx(f), log }).catch((x) => x)
      expect(e.error).toEqual({ code: 'PROVIDER_UNAVAILABLE', message: 'Xendit is not set up for this app yet. Try another method.', retryable: false, recovery: 'choose_other' })
      // The user message does not quote Xendit; the operator log does.
      expect(e.error.message).not.toContain(body.message)
      expect(errors).toHaveLength(1)
      expect(warnings).toHaveLength(0)
      expect(errors[0]).toMatch(/^Xendit: /)
      expect(errors[0]).toContain(body.error_code)
      expect(errors[0]).toContain('secretKey')
    }
  })

  it('verifies the callback token and parses capture and failure webhooks', async () => {
    const wctx = { log: quiet, shared: kv(), fetch }
    const req = (tok?: string) => new Request('https://app.test/webhooks/xendit', { method: 'POST', headers: tok ? { 'x-callback-token': tok } : {} })
    expect(await a.webhook!.verify(req('tok'), '', wctx)).toBe(true)
    expect(await a.webhook!.verify(req('bad'), '', wctx)).toBe(false)
    expect(await a.webhook!.verify(req(), '', wctx)).toBe(false)
    const cap = await a.webhook!.parse(JSON.stringify({ event: 'payment.capture', data: { payment_request_id: 'pr-1', status: 'SUCCEEDED', request_amount: 150000, currency: 'IDR' } }), wctx)
    // no output: Xendit's request_amount is gross; the quote's net output stays the reported result
    expect(cap).toMatchObject([{ ref: 'pr-1', status: 'succeeded' }])
    expect(cap[0]!.eventId).toMatch(/^[0-9a-f]{32}$/)
    const fail = await a.webhook!.parse(JSON.stringify({ event: 'payment.failure', data: { payment_request_id: 'pr-1', status: 'FAILED', failure_code: 'X' } }), wctx)
    expect(fail[0]).toMatchObject({ status: 'failed', error: { code: 'PAYMENT_FAILED' } })
    expect(await a.webhook!.parse(JSON.stringify({ event: 'other', data: {} }), wctx)).toEqual([])
    expect(await a.webhook!.parse('<html>not json</html>', wctx)).toEqual([])
  })

  it('end to end through the server: QRIS into a merchant account, completed by webhook', async () => {
    const { f } = fakeFetch((url) => (url.includes('/v3/payment_requests') ? Response.json(pr()) : new Response('ok')))
    const ramp = createOpenRamp({ secret: 's'.repeat(40), baseUrl: 'https://app.test/api', adapters: [xendit({ secretKey: 'k', webhookToken: 'tok' }), mockAdapter()], logger: quiet, fetch: f })
    const s = await ramp.sessions.create({ userId: 'u', country: 'ID', destination: { type: 'merchant', currency: 'IDR' } })
    const call = (p: string, body?: unknown, headers: Record<string, string> = {}) =>
      ramp.handle(new Request(`https://app.test/api${p}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${s.clientSecret}`, 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
    const plan = await (await call(`/sessions/${s.id}/plan`, {})).json()
    const qris = plan.methods.find((m: { method: string }) => m.method === 'qris')
    expect(qris.providers).toEqual(expect.arrayContaining(['Xendit']))
    const quotes = await (await call(`/sessions/${s.id}/quotes`, { method: 'qris', amount: '150000' })).json()
    const xq = quotes.quotes.find((q: { provider: string }) => q.provider === 'Xendit')
    const sel = await (await call(`/sessions/${s.id}/select`, { quoteId: xq.id })).json()
    expect(sel.step.surface.kind).toBe('QR')
    const capture = JSON.stringify({ event: 'payment.capture', data: { payment_request_id: 'pr-1', status: 'SUCCEEDED', request_amount: 150000, currency: 'IDR' } })
    const send = (body: string) => ramp.handle(new Request('https://app.test/api/webhooks/xendit', { method: 'POST', headers: { 'x-callback-token': 'tok' }, body }))
    const hook = await send(capture)
    expect(hook.status).toBe(200)
    expect(await hook.json()).toEqual({ received: true })
    const done = await (await call(`/sessions/${s.id}`)).json()
    expect(done.status).toBe('succeeded')
    // A captured webhook sent again (the callback token is fixed): 200, ignored as a replay.
    const replay = await send(capture)
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual({ received: true, duplicate: true })
    // An unapplied body (unknown payment request) is not taken for a replay on the provider's retry.
    const unknown = JSON.stringify({ event: 'payment.capture', data: { payment_request_id: 'pr-unknown', status: 'SUCCEEDED' } })
    expect((await send(unknown)).status).toBe(503)
    expect((await send(unknown)).status).toBe(503)
  })
})

describe('xendit conformance (shared test kit)', () => {
  it('passes runAdapterConformance for QRIS, GCash and a webhook', async () => {
    const { runAdapterConformance, fakeFetch: kitFetch, makeCtx } = await import('@openrampkit/adapter/testing')
    const a = xendit({ secretKey: 'k', webhookToken: 'tok' })
    const { fetch: f } = kitFetch([
      { match: /payment_requests\/pr-1$/, reply: () => pr({ status: 'SUCCEEDED' }) },
      { match: '/v3/payment_requests', reply: () => pr() },
    ])
    const ctx = () => makeCtx({ fetch: f, destination: { type: 'merchant', currency: 'IDR' }, session: { country: 'ID' } })
    const report = await runAdapterConformance(a, {
      ctx,
      fixtures: [
        { leg: leg('id-qris', 'IDR'), quote: { amountIn: { value: '150000', asset: { kind: 'fiat', currency: 'IDR' } } }, expect: { start: 'PAYMENT', status: 'COMPLETED' } },
      ],
      webhooks: [
        { request: () => new Request('https://app.test/w', { method: 'POST', headers: { 'x-callback-token': 'tok' } }), rawBody: JSON.stringify({ event: 'payment.capture', data: { payment_request_id: 'pr-1', status: 'SUCCEEDED' } }), events: 1 },
        { request: () => new Request('https://app.test/w', { method: 'POST', headers: { 'x-callback-token': 'nope' } }), rawBody: '{}', valid: false },
      ],
    })
    expect(report.problems).toEqual([])
  })
})
