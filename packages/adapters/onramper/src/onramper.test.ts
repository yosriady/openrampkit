import { createHash, createHmac, createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { checkAdapterShape, checkLegQuote, checkLegStep, webhookBodyKey } from '@openrampkit/adapter'
import { createOpenRamp } from '@openrampkit/server'
import { USDC, isRegionAllowed } from '@openrampkit/core'
import type { PathwayLeg } from '@openrampkit/core'
import { fakeFetch, makeCtx, makeWebhookCtx, memoryKV, runAdapterConformance, silentLog } from '@openrampkit/adapter/testing'
import { canonicalJson, canonicalStringV2, ed25519Sign, importEd25519Key, onramper, onramperMethodId, onramperPaymentType } from './index.js'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const PEM = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
const API_KEY = 'pk_test_onramper'
const WH = 'onramper_webhook_secret'
const opts = { apiKey: API_KEY, secretKey: PEM, webhookSecret: WH, env: 'production' as const }
const BASE_USDC = { kind: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']! }
const money = (amount: string, currency = 'USD') => ({ amount, asset: { kind: 'fiat' as const, currency } })

const leg = (legId: string, currency = 'USD'): PathwayLeg => ({
  adapterId: 'onramper',
  legId,
  from: { asset: { kind: 'fiat', currency }, location: { kind: 'user_account' } },
  to: { asset: BASE_USDC, location: { kind: 'address', address: 'deposit' } },
})

// Shape from https://docs.onramper.com/reference/get_quotes-fiat-crypto
const QUOTES = [
  { rate: 1.04, networkFee: 0.12, transactionFee: 3.99, payout: 92.1, ramp: 'moonpay', paymentMethod: 'creditcard', quoteId: 'q1', recommendations: ['LowKyc'], availablePaymentMethods: [] },
  { rate: 1.02, networkFee: 0.05, transactionFee: 2.5, payout: 95.4, ramp: 'banxa', paymentMethod: 'creditcard', quoteId: 'q2', recommendations: ['BestPrice'] },
  { ramp: 'transak', paymentMethod: 'creditcard', quoteId: 'q3', errors: [{ type: 'NoSupportedPaymentFound', errorId: 6103, message: 'No supported payment found' }] },
]

const HOOK = (status: string, extra: Record<string, unknown> = {}) => ({
  country: 'US', inAmount: 100, onramp: 'banxa', onrampTransactionId: 'b_1', outAmount: 95.4, paymentMethod: 'creditcard', partnerContext: 'ork_abc',
  sourceCurrency: 'usd', status, statusDate: '2026-09-29T10:00:00.000Z', targetCurrency: 'usdc_base', transactionId: 'otx_1', transactionType: 'buy',
  transactionHash: null, walletAddress: '0xabc', ...extra,
})

describe('onramper signing', () => {
  it('Ed25519 matches the RFC 8032 test vectors (raw seed import)', async () => {
    const k1 = await importEd25519Key('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60')
    expect(Buffer.from(await ed25519Sign(k1, ''), 'base64').toString('hex')).toBe(
      'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
    )
    const k2 = await importEd25519Key(Buffer.from('4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb', 'hex').toString('base64'))
    expect(Buffer.from(await ed25519Sign(k2, new Uint8Array([0x72])), 'base64').toString('hex')).toBe(
      '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00',
    )
  })

  it('RFC 8785 canonical JSON and the canonical string', async () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 'x', null], c: true }, e: undefined, 'é': 0.5 })).toBe('{"a":{"c":true,"d":[1,"x",null]},"b":1,"é":0.5}')
    const s = await canonicalStringV2({
      apiKey: 'pk', method: 'post', path: '/checkout/v2/intent', query: new URLSearchParams('b=2&a=1'), body: '{}', timestamp: '2026-09-29T10:00:00.000Z', nonce: 'n-1',
    })
    expect(s).toBe(
      [
        'ONRAMPER-SIG-V2', '2026-09-29T10:00:00.000Z', 'n-1', 'POST', '/checkout/v2/intent', 'a=1&b=2', 'authorization:pk', 'content-type:application/json',
        '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
      ].join('\n'),
    )
    const empty = await canonicalStringV2({ apiKey: 'pk', method: 'GET', path: '/quotes', timestamp: 't', nonce: 'n' })
    expect(empty.split('\n')).toEqual(['ONRAMPER-SIG-V2', 't', 'n', 'GET', '/quotes', '', 'authorization:pk', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'])
  })
})

describe('onramper adapter', () => {
  it('static legs, method id mapping', () => {
    const a = onramper(opts)
    expect(checkAdapterShape(a)).toEqual([])
    expect(a.legs.map((l) => l.id)).toEqual([
      'card', 'apple_pay', 'google_pay', 'sepa', 'ach', 'pix', 'upi',
      'sepa_instant', 'faster_payments', 'open_banking', 'ideal', 'bancontact', 'interac', 'spei', 'bancolombia', 'khipu', 'imps',
    ])
    expect(isRegionAllowed(a.legs.find((l) => l.id === 'pix')!.regions, 'BR')).toBe(true)
    expect(isRegionAllowed(a.legs.find((l) => l.id === 'pix')!.regions, 'US')).toBe(false)
    expect(onramperMethodId('creditcard')).toBe('card')
    expect(onramperMethodId('interacetransfer')).toBe('interac')
    expect(onramperMethodId('ideal')).toBe('ideal')
    expect(onramperPaymentType('card')).toBe('creditcard')
    expect(onramperPaymentType('ideal')).toBe('ideal')
  })

  it('maps the global and regional bank rails both ways', () => {
    const pairs: Array<[string, string]> = [
      ['sepainstant', 'sepa_instant'], ['fasterpaybank', 'faster_payments'], ['openbanking', 'open_banking'], ['fasterpayopen', 'open_banking'],
      ['ideal', 'ideal'], ['bancontact', 'bancontact'], ['spei', 'spei'], ['bancolombia', 'bancolombia'], ['khipu', 'khipu'],
      ['imps', 'imps'], ['mpesa', 'mpesa'], ['iach', 'ach'], ['interacetransfer', 'interac'],
    ]
    for (const [id, method] of pairs) expect(onramperMethodId(id)).toBe(method)
    expect(onramperPaymentType('sepa_instant')).toBe('sepainstant')
    expect(onramperPaymentType('faster_payments')).toBe('fasterpaybank')
    // UK open banking has its own id; elsewhere it is `openbanking`
    expect(onramperPaymentType('open_banking', 'GBP')).toBe('fasterpayopen')
    expect(onramperPaymentType('open_banking', 'EUR')).toBe('openbanking')
    expect(onramperPaymentType('open_banking')).toBe('openbanking')
    const a = onramper(opts)
    const allowed = (id: string, c: string) => isRegionAllowed(a.legs.find((l) => l.id === id)!.regions, c)
    expect(allowed('ideal', 'NL')).toBe(true)
    expect(allowed('ideal', 'DE')).toBe(false)
    expect(allowed('bancontact', 'BE')).toBe(true)
    expect(allowed('faster_payments', 'GB')).toBe(true)
    expect(allowed('spei', 'MX')).toBe(true)
    expect(allowed('khipu', 'CL')).toBe(true)
    expect(allowed('bancolombia', 'CO')).toBe(true)
    expect(a.legs.find((l) => l.id === 'khipu')!.from.asset).toEqual({ kind: 'fiat', currencies: ['CLP'] })
  })

  it('quote and start send the regional payment type (iDEAL, SPEI, UK open banking)', async () => {
    const cases: Array<[string, string, string, string]> = [
      ['ideal', 'EUR', 'NL', 'ideal'],
      ['spei', 'MXN', 'MX', 'spei'],
      ['open_banking', 'GBP', 'GB', 'fasterpayopen'],
      ['sepa_instant', 'EUR', 'DE', 'sepainstant'],
      ['khipu', 'CLP', 'CL', 'khipu'],
    ]
    for (const [legId, cur, country, paymentType] of cases) {
      const { fetch, calls } = fakeFetch([
        { match: '/quotes/', reply: () => QUOTES.map((x) => ({ ...x, paymentMethod: paymentType })) },
        { method: 'POST', match: '/checkout/v2/intent', reply: () => ({ redirectUrl: 'https://buy.onramper.com/checkout?session=s1' }) },
      ])
      const a = onramper(opts)
      const ctx = makeCtx({ fetch, session: { ip: '203.0.113.9', country } })
      const q = await a.quote({ leg: leg(legId, cur), amountIn: money('100', cur) }, ctx)
      const u = new URL(calls[0]!.url)
      expect(u.pathname).toBe(`/quotes/${cur.toLowerCase()}/usdc_base`)
      expect(u.searchParams.get('paymentMethod')).toBe(paymentType)
      expect(u.searchParams.get('country')).toBe(country)
      await a.start({ leg: leg(legId, cur), quote: q, deliverTo: { address: '0xd16e' } }, ctx)
      expect(calls[1]!.body).toMatchObject({ paymentMethod: paymentType, source: cur.toLowerCase(), country })
      // Without the quote data, start still finds the id from the leg and currency
      calls.length = 0
      await a.start({ leg: leg(legId, cur), quote: { ...q, data: { ...q.data, paymentMethod: undefined } }, deliverTo: { address: '0xd16e' } }, ctx)
      expect(calls[0]!.body).toMatchObject({ paymentMethod: paymentType })
    }
  })

  it('catalog: GET /supported/payment-types with aggregated limits, cached', async () => {
    const { fetch, calls } = fakeFetch([
      {
        match: '/supported/payment-types/eur',
        reply: () => ({
          message: [
            { paymentTypeId: 'creditcard', name: 'Credit card', details: { currencyStatus: 'SourceAndDestSupported', limits: { moonpay: { min: 20, max: 10000 }, aggregatedLimit: { min: 15, max: 20000 } } } },
            { paymentTypeId: 'debitcard', details: { limits: { aggregatedLimit: { min: 10, max: 5000 } } } },
            { paymentTypeId: 'sepabanktransfer', details: { limits: { aggregatedLimit: { min: 30, max: 50000 } } } },
            { paymentTypeId: 'ideal' },
          ],
        }),
      },
    ])
    const a = onramper(opts)
    const shared = memoryKV()
    const legs = await a.catalog!({ country: 'NL', currency: 'EUR', direction: 'deposit' }, { fetch, log: silentLog, shared })
    await a.catalog!({ country: 'NL', currency: 'EUR', direction: 'deposit' }, { fetch, log: silentLog, shared })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.onramper.com/supported/payment-types/eur?type=buy&destination=usdc_base&country=NL')
    expect(calls[0]!.headers.get('authorization')).toBe(API_KEY)
    expect(legs.map((l) => [l.id, l.regions.allow, l.limits])).toEqual([
      ['card', ['NL'], { min: '10', max: '20000', currency: 'EUR' }],
      ['sepa', ['NL'], { min: '30', max: '50000', currency: 'EUR' }],
      ['ideal', ['NL'], undefined],
    ])
    for (const l of legs) expect(checkAdapterShape({ ...a, legs: [l] })).toEqual([])
    const bad = fakeFetch([{ match: '/supported/payment-types', reply: () => ({ message: [] }) }])
    await expect(a.catalog!({ currency: 'USD', direction: 'deposit' }, { fetch: bad.fetch, log: silentLog, shared: memoryKV() })).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
  })

  it('quote: GET /quotes/{fiat}/{crypto}; best payout is the leg quote, the list in data.providers', async () => {
    const { fetch, calls } = fakeFetch([{ match: '/quotes/usd/usdc_base', reply: () => QUOTES }])
    const q = await onramper(opts).quote({ leg: leg('card'), amountIn: money('100'), deliverTo: { address: '0xabc' } }, makeCtx({ fetch }))
    expect(checkLegQuote(q)).toEqual([])
    const u = new URL(calls[0]!.url)
    expect(u.origin + u.pathname).toBe('https://api.onramper.com/quotes/usd/usdc_base')
    expect(Object.fromEntries(u.searchParams)).toEqual({ amount: '100.00', paymentMethod: 'creditcard', type: 'buy', country: 'US', platform: 'web', walletAddress: '0xabc' })
    expect(q.output).toEqual({ amount: '95.4', asset: { ...BASE_USDC, symbol: 'USDC', decimals: 6 } })
    expect(q.input).toEqual(money('100.00'))
    expect(q.fees).toEqual([
      { kind: 'provider', label: 'banxa fee', amount: '2.5', currency: 'USD' },
      { kind: 'network', label: 'Network fee', amount: '0.05', currency: 'USD' },
    ])
    expect(q.data!.onramp).toBe('banxa')
    expect((q.data!.providers as Array<{ ramp: string }>).map((p) => p.ramp)).toEqual(['banxa', 'moonpay'])
    // `onramps` filters providers
    const only = await onramper({ ...opts, onramps: ['moonpay'] }).quote({ leg: leg('card'), amountIn: money('100') }, makeCtx({ fetch }))
    expect(only.data!.onramp).toBe('moonpay')
  })

  it('quote: errors map to NO_QUOTES / PROVIDER_UNAVAILABLE / RATE_LIMITED', async () => {
    const run = (status: number, body: unknown) =>
      onramper(opts).quote({ leg: leg('card'), amountIn: money('1') }, makeCtx({ fetch: fakeFetch([{ match: '/quotes/', status, reply: () => body }]).fetch }))
    await expect(run(200, [QUOTES[2]])).rejects.toMatchObject({ error: { code: 'NO_QUOTES', message: 'Onramper: No supported payment found' } })
    await expect(run(200, { message: 'No providers available' })).rejects.toMatchObject({ error: { code: 'NO_QUOTES', message: 'Onramper: No providers available' } })
    await expect(run(400, { message: 'Invalid amount' })).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
    await expect(run(401, {})).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    await expect(run(429, {})).rejects.toMatchObject({ error: { code: 'RATE_LIMITED' } })
    await expect(run(500, {})).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    await expect(onramper(opts).quote({ leg: leg('card'), amountOut: { amount: '1', asset: BASE_USDC } }, makeCtx({ fetch: fakeFetch([]).fetch }))).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
  })

  it('start: POST /checkout/v2/intent with a valid Signature V2 (Ed25519, checked with the public key)', async () => {
    const { fetch, calls } = fakeFetch([
      { match: '/quotes/', reply: () => QUOTES },
      { method: 'POST', match: '/checkout/v2/intent', reply: () => ({ redirectUrl: 'https://buy.onramper.com/checkout?session=s1', sessionId: 's1', resumeToken: 'r' }) },
    ])
    const a = onramper(opts)
    const ctx = makeCtx({ fetch, session: { ip: '203.0.113.9', userId: 'u_42', email: 'a@b.co' } })
    const quote = await a.quote({ leg: leg('card'), amountIn: money('100') }, ctx)
    const step = await a.start({ leg: leg('card'), quote, deliverTo: { address: '0xd16e' } }, ctx)
    expect(checkLegStep(step)).toEqual([])
    expect(step).toMatchObject({ state: 'PAYMENT', status: 'awaiting_user', surface: { kind: 'REDIRECT', url: 'https://buy.onramper.com/checkout?session=s1', popup: true, provider: 'banxa' } })
    const post = calls[1]!
    expect(post.url).toBe('https://api.onramper.com/checkout/v2/intent')
    expect(post.body).toEqual({
      onramp: 'banxa', source: 'usd', destination: 'usdc_base', amount: 100, type: 'buy', paymentMethod: 'creditcard', network: 'base',
      wallet: { address: '0xd16e' }, endUserIpHash: createHash('sha256').update('203.0.113.9').digest('hex'), platform: 'web',
      partnerContext: step.ref, externalCustomerId: 'u_42', country: 'US', email: 'a@b.co',
      supportedParams: { partnerData: { redirectUrl: { success: 'https://app.test/api/openramp/return' } } },
    })
    // The body is sent in canonical form
    expect(post.raw).toBe(canonicalJson(post.body))
    const h = post.headers
    expect(h.get('authorization')).toBe(API_KEY)
    expect(h.get('x-onramper-nonce')).toMatch(/^[0-9a-f-]{36}$/)
    expect(Date.parse(h.get('x-onramper-timestamp')!)).toBeGreaterThan(Date.now() - 60_000)
    const sig = h.get('x-onramper-signature')!
    expect(sig.startsWith('v2:')).toBe(true)
    const content = [
      'ONRAMPER-SIG-V2', h.get('x-onramper-timestamp'), h.get('x-onramper-nonce'), 'POST', '/checkout/v2/intent', '',
      `authorization:${API_KEY}`, 'content-type:application/json', createHash('sha256').update(post.raw!).digest('hex'),
    ].join('\n')
    expect(verify(null, Buffer.from(content), createPublicKey(publicKey.export({ format: 'pem', type: 'spki' })), Buffer.from(sig.slice(3), 'base64'))).toBe(true)
  })

  it('start: needs the user IP, a wallet and a provider; maps HTTP errors', async () => {
    const a = onramper(opts)
    const quote = { adapterId: 'onramper', legId: 'card', input: money('100'), output: { amount: '95', asset: BASE_USDC }, fees: [], eta: { min: 1, max: 2 }, data: { onramp: 'banxa' } }
    const f = (status = 200, body: unknown = { redirectUrl: 'https://x' }) => fakeFetch([{ method: 'POST', match: '/checkout/v2/intent', status, reply: () => body }]).fetch
    await expect(a.start({ leg: leg('card'), quote }, makeCtx({ fetch: f() }))).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    await expect(a.start({ leg: leg('card'), quote: { ...quote, data: {} } }, makeCtx({ fetch: f(), session: { ip: '1.2.3.4' } }))).rejects.toMatchObject({ error: { code: 'QUOTE_EXPIRED' } })
    await expect(a.start({ leg: leg('card'), quote }, makeCtx({ fetch: f(), session: { ip: '1.2.3.4' }, destination: { type: 'merchant', currency: 'USD' } }))).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
    await expect(a.start({ leg: leg('card'), quote }, makeCtx({ fetch: f(401, { errorId: 4011, message: 'Invalid signature' }), session: { ip: '1.2.3.4' } }))).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    await expect(a.start({ leg: leg('card'), quote }, makeCtx({ fetch: f(200, {}), session: { ip: '1.2.3.4' } }))).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    await expect(a.start({ leg: leg('card'), quote }, makeCtx({ fetch: f(), session: { ip: '1.2.3.4' } }))).resolves.toMatchObject({ state: 'PAYMENT' })
  })

  it('webhook: X-Onramper-Webhook-Signature (good, bad, missing, no secret); parse maps statuses and keeps the transaction id', async () => {
    const a = onramper(opts)
    const shared = memoryKV()
    const wctx = makeWebhookCtx({ shared })
    const body = JSON.stringify(HOOK('completed', { transactionHash: '0xhash' }))
    const sig = (b: string) => createHmac('sha256', WH).update(b).digest('hex')
    const req = (h: Record<string, string>) => new Request('https://app.test/h', { method: 'POST', body, headers: h })
    expect(await a.webhook!.verify(req({ 'X-Onramper-Webhook-Signature': sig(body) }), body, wctx)).toBe(true)
    expect(await a.webhook!.verify(req({ 'X-Onramper-Webhook-Signature': sig('x') }), body, wctx)).toBe(false)
    expect(await a.webhook!.verify(req({}), body, wctx)).toBe(false)
    expect(await onramper({ ...opts, webhookSecret: undefined }).webhook!.verify(req({ 'X-Onramper-Webhook-Signature': sig(body) }), body, wctx)).toBe(false)
    // Known vector: HMAC-SHA256(secret, '{}')
    expect(sig('{}')).toBe('1156082a881702dc9edab3dda95d53704f3ee7e9e0a5a899a4646c01fdb7773a')

    expect(await a.webhook!.parse(body, wctx)).toMatchObject([
      { ref: 'ork_abc', status: 'succeeded', txHash: '0xhash', output: { amount: '95.4', asset: { ...BASE_USDC, symbol: 'USDC', decimals: 6 } } },
    ])
    expect(await shared.get('tx:ork_abc')).toBe('otx_1')
    const parse = (o: unknown) => a.webhook!.parse(JSON.stringify(o), wctx)
    expect(await parse(HOOK('new'))).toMatchObject([{ ref: 'ork_abc', status: 'awaiting_user' }])
    expect(await parse(HOOK('pending'))).toMatchObject([{ status: 'processing' }])
    expect(await parse(HOOK('paid'))).toMatchObject([{ status: 'processing' }])
    expect(await parse(HOOK('failed'))).toMatchObject([{ status: 'failed', error: { code: 'PAYMENT_FAILED' } }])
    expect(await parse(HOOK('canceled'))).toMatchObject([{ status: 'failed' }])
    expect(await parse(HOOK('test'))).toEqual([])
    expect(await parse(HOOK('completed', { partnerContext: undefined }))).toEqual([])
    expect(await a.webhook!.parse('{', wctx)).toEqual([])
  })

  it('status: waits until a webhook gives the transaction id, then reads GET /transactions/{id}', async () => {
    const shared = memoryKV()
    const { fetch, calls } = fakeFetch([{ match: '/transactions/otx_1', reply: () => HOOK('completed', { transactionHash: '0xhash' }) }])
    const a = onramper(opts)
    const ctx = makeCtx({ fetch, shared })
    expect(await a.status!({ leg: leg('card'), ref: 'ork_abc' }, ctx)).toMatchObject({ state: 'PAYMENT', status: 'awaiting_user' })
    expect(calls).toHaveLength(0)
    await shared.put('tx:ork_abc', 'otx_1')
    const s = await a.status!({ leg: leg('card'), ref: 'ork_abc' }, ctx)
    expect(checkLegStep(s)).toEqual([])
    expect(s).toMatchObject({ state: 'COMPLETED', txHash: '0xhash', output: { amount: '95.4' } })
    expect(calls[0]!.url).toBe('https://api.onramper.com/transactions/otx_1')
    expect(calls[0]!.headers.get('x-onramper-secret')).toBe(WH)
    const down = fakeFetch([{ match: '/transactions/', status: 503, reply: () => ({}) }])
    await expect(a.status!({ leg: leg('card'), ref: 'ork_abc' }, makeCtx({ fetch: down.fetch, shared }))).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
  })

  it('sandbox env uses the staging API', async () => {
    const { fetch, calls } = fakeFetch([{ match: '/quotes/', reply: () => QUOTES }])
    await onramper({ ...opts, env: 'sandbox' }).quote({ leg: leg('card'), amountIn: money('100') }, makeCtx({ fetch }))
    expect(calls[0]!.url.startsWith('https://api-stg.onramper.com/quotes/usd/usdc_base?')).toBe(true)
  })

  it('passes runAdapterConformance', async () => {
    const shared = memoryKV()
    const { fetch } = fakeFetch([
      { match: '/quotes/', reply: () => QUOTES },
      { method: 'POST', match: '/checkout/v2/intent', reply: () => ({ redirectUrl: 'https://buy.onramper.com/c', sessionId: 's1' }) },
    ])
    const body = JSON.stringify(HOOK('completed'))
    const report = await runAdapterConformance(onramper(opts), {
      ctx: () => makeCtx({ fetch, shared, session: { ip: '203.0.113.9' } }),
      fixtures: [
        { leg: leg('card'), quote: { amountIn: money('100') }, expect: { start: 'PAYMENT', status: 'PAYMENT' } },
        { leg: leg('sepa', 'EUR'), quote: { amountIn: money('100', 'EUR') } },
      ],
      webhookCtx: makeWebhookCtx({ shared }),
      webhooks: [
        { name: 'signed', rawBody: body, request: () => new Request('https://x/h', { method: 'POST', body, headers: { 'x-onramper-webhook-signature': createHmac('sha256', WH).update(body).digest('hex') } }), events: 1 },
        { name: 'unsigned', rawBody: body, request: () => new Request('https://x/h', { method: 'POST', body }), valid: false },
      ],
    })
    expect(report.problems).toEqual([])
  })
})

describe('onramper webhook replay protection', () => {
  const sig = (b: string) => createHmac('sha256', WH).update(b).digest('hex')
  const ramp = () => createOpenRamp({ secret: 's'.repeat(40), baseUrl: 'https://app.test/api', adapters: [onramper(opts)], logger: silentLog })
  const post = (r: ReturnType<typeof ramp>, body: string) =>
    r.handle(new Request('https://app.test/api/webhooks/onramper', { method: 'POST', headers: { 'x-onramper-webhook-signature': sig(body) }, body }))

  it('gives the body hash as the replay key and as the event id', async () => {
    const a = onramper(opts)
    const body = JSON.stringify(HOOK('completed'))
    const key = await a.webhook!.replayKey!(new Request('https://app.test/w', { method: 'POST' }), body, makeWebhookCtx())
    expect(key).toBe(await webhookBodyKey(body))
    expect((await a.webhook!.parse(body, makeWebhookCtx()))[0]!.eventId).toBe(key!.slice(0, 32))
  })

  it('ignores a replayed signed body (200, nothing applied), and lets a retry of an unapplied body through', async () => {
    const r = ramp()
    const body = JSON.stringify(HOOK('test'))
    const first = await post(r, body)
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ received: true })
    const replay = await post(r, body)
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual({ received: true, duplicate: true })

    // The ref is not known yet: 503, and the provider's retry is not taken for a replay.
    const unknown = JSON.stringify(HOOK('completed', { partnerContext: 'ork_unknown' }))
    expect((await post(r, unknown)).status).toBe(503)
    expect((await post(r, unknown)).status).toBe(503)
  })
})
