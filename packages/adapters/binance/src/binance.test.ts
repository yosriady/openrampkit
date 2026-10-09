import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { USDC, isRegionAllowed } from '@openrampkit/core'
import type { PathwayLeg } from '@openrampkit/core'
import { fakeFetch, makeCtx, makeWebhookCtx, recordingLog, runAdapterConformance } from '@openrampkit/adapter/testing'
import type { FakeRoute } from '@openrampkit/adapter/testing'
import { BINANCE_REGIONS, binance } from './index.js'
import { importRsaPrivateKey, importRsaPublicKey, keyDer, rsaSign, rsaVerify } from './rsa.js'

function rsaPair(bits = 2048) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: bits })
  return {
    privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    privatePkcs1: privateKey.export({ format: 'pem', type: 'pkcs1' }).toString(),
    publicPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    publicB64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey,
    publicKey,
  }
}

// The partner key signs requests; the "Binance" key signs webhooks.
const partner = rsaPair(1024) // the docs use 1024-bit keys
const bnb = rsaPair(2048)

/** Sign a webhook the way the docs say Binance does: base64(SHA256withRSA(body + timestamp)) */
const bnbSign = (body: string, ts: string) => nodeSign('sha256', Buffer.from(body + ts), bnb.privateKey).toString('base64')

const API = 'https://binance.partner.test'
const DEST = '0x000000000000000000000000000000000000beef'
const BASE_USDC = { kind: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']! }
const leg: PathwayLeg = {
  adapterId: 'binance',
  legId: 'account',
  method: 'exchange',
  from: { asset: { kind: 'fiat', currency: 'EUR' }, location: { kind: 'user_account' } },
  to: { asset: BASE_USDC, location: { kind: 'address', address: DEST } },
}

const ok = <T>(data: T) => ({ success: true, code: '000000', message: 'success', data })
const QUOTE = { totalAmount: '98.5', quotePrice: '1.0', feeAmount: '1', feeCurrency: 'EUR', networkFee: '0.5', payMethodCode: 'BUY_WALLET', payMethodSubCode: 'Wallet' }
const order = (ref: string, status: number, extra: Record<string, unknown> = {}) => ({
  externalOrderId: ref, type: 1, status, fiatCurrency: 'EUR', cryptoCurrency: 'USDC', fiatAmount: '100', cryptoAmount: '98.5',
  withdrawWalletAddress: DEST, withdrawNetwork: 'BASE', withdrawTxHash: status === 20 ? '0xabc' : null, ...extra,
})

function routes(statusCode = 20, over: Partial<Record<'quote' | 'preorder' | 'order', FakeRoute['reply']>> = {}): FakeRoute[] {
  return [
    { method: 'POST', match: '/buy/estimated-quote', reply: over.quote ?? (() => ok(QUOTE)) },
    { method: 'POST', match: '/buy/pre-order', reply: over.preorder ?? (() => ok({ link: 'https://www.binance.com/en/connect/abc', linkExpireTime: 1_900_000_000_000 })) },
    { method: 'POST', match: '/ramp/connect/order', reply: over.order ?? ((c) => ok(order((c.body as { externalOrderId: string }).externalOrderId, statusCode))) },
    { method: 'POST', match: '/buy/trading-pairs', reply: () => ok({ fiatCurrencies: ['EUR'], cryptoCurrencies: ['USDC'] }) },
  ]
}

const opts = (extra: Partial<Parameters<typeof binance>[0]> = {}) => ({
  apiUrl: `${API}/`,
  clientId: 'client-1',
  accessToken: 'token-1',
  privateKey: partner.privatePem,
  binancePublicKey: bnb.publicPem,
  ...extra,
})

const eur = (amount: string) => ({ value: amount, asset: { kind: 'fiat' as const, currency: 'EUR' } })

function webhookReq(body: string, headers: Record<string, string>) {
  return new Request('https://app.test/api/openramp/webhooks/binance', { method: 'POST', headers, body })
}

describe('binance adapter: conformance', () => {
  it('passes the conformance kit (quote, start, status, webhooks)', async () => {
    const { fetch } = fakeFetch(routes(20))
    const adapter = binance(opts({ webhookPartnerCode: 'client-1' }))
    const body = JSON.stringify({ webhookEventType: 'connect_order_event', ...order('ork1', 20) })
    const ts = '1759650000000'
    const sig = bnbSign(body, ts)
    const report = await runAdapterConformance(adapter, {
      ctx: () => makeCtx({ fetch, session: { country: 'DE' } }),
      fixtures: [{ leg, quote: { amountIn: eur('100') }, expect: { start: 'PAYMENT', status: 'COMPLETED' } }],
      webhooks: [
        { name: 'signed', request: () => webhookReq(body, { 'x-bn-connect-signature': sig, 'x-bn-connect-timestamp': ts, 'x-bn-connect-for': 'client-1' }), rawBody: body, events: 1 },
        { name: 'bad signature', request: () => webhookReq(body, { 'x-bn-connect-signature': bnbSign(body, '1'), 'x-bn-connect-timestamp': ts, 'x-bn-connect-for': 'client-1' }), rawBody: body, valid: false },
        { name: 'other partner', request: () => webhookReq(body, { 'x-bn-connect-signature': sig, 'x-bn-connect-timestamp': ts, 'x-bn-connect-for': 'someone-else' }), rawBody: body, valid: false },
        { name: 'no headers', request: () => webhookReq(body, {}), rawBody: body, valid: false },
      ],
    })
    expect(report.problems).toEqual([])
    expect(report.steps[0]).toMatchObject({ state: 'PAYMENT', status: 'awaiting_user', surface: { kind: 'REDIRECT', url: 'https://www.binance.com/en/connect/abc', popup: true, provider: 'Binance' } })
    expect(report.steps[1]).toMatchObject({ state: 'COMPLETED', status: 'succeeded', txHash: '0xabc' })
    expect(report.events[0]).toEqual([{ ref: 'ork1', status: 'succeeded', txHash: '0xabc', output: { value: '98.5', asset: { ...BASE_USDC, symbol: 'USDC', decimals: 6 } } }])
  })

  it('declares one exchange leg, REDIRECT, with Binance regions', () => {
    const a = binance(opts())
    expect(a.id).toBe('binance')
    expect(a.legs).toHaveLength(1)
    expect(a.legs[0]).toMatchObject({ id: 'account', kind: 'fiat_onramp', methods: ['exchange'], surfaces: ['REDIRECT'], requires: ['provider_account', 'provider_kyc'] })
    const chains = Object.keys((a.legs[0]!.to.asset as { chains: Record<string, string[]> }).chains)
    expect(chains).toEqual(['eip155:8453', 'eip155:42161', 'eip155:1', 'eip155:10', 'eip155:56', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'])
    expect(binance(opts({ method: 'binance_pay' })).legs[0]!.methods).toEqual(['binance_pay'])
  })
})

describe('binance adapter: request signing', () => {
  it('signs every request with SHA256withRSA(body + timestamp) and sends the X-Tesla headers', async () => {
    const { fetch, calls } = fakeFetch(routes())
    const a = binance(opts())
    await a.quote({ leg, amountIn: eur('100') }, makeCtx({ fetch }))
    const c = calls[0]!
    expect(c.url).toBe(`${API}/papi/v1/ramp/connect/buy/estimated-quote`)
    expect(c.headers.get('x-tesla-clientid')).toBe('client-1')
    expect(c.headers.get('x-tesla-signaccesstoken')).toBe('token-1')
    expect(c.headers.get('content-type')).toBe('application/json')
    const ts = c.headers.get('x-tesla-timestamp')!
    expect(ts).toMatch(/^\d{13}$/)
    const valid = nodeVerify('sha256', Buffer.from(c.raw! + ts), partner.publicKey, Buffer.from(c.headers.get('x-tesla-signature')!, 'base64'))
    expect(valid).toBe(true)
  })

  it('accepts a base64 PKCS#8 key and a PEM with escaped newlines', async () => {
    const der = partner.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
    for (const privateKey of [der, partner.privatePem.replace(/\n/g, '\\n')]) {
      const { fetch, calls } = fakeFetch(routes())
      await binance(opts({ privateKey })).quote({ leg, amountIn: eur('100') }, makeCtx({ fetch }))
      const c = calls[0]!
      expect(nodeVerify('sha256', Buffer.from(c.raw! + c.headers.get('x-tesla-timestamp')), partner.publicKey, Buffer.from(c.headers.get('x-tesla-signature')!, 'base64'))).toBe(true)
    }
  })

  it('refuses a PKCS#1 key with a clear message', async () => {
    expect(() => keyDer(partner.privatePkcs1, 'private')).toThrow(/PKCS#8/)
    const { fetch } = fakeFetch(routes())
    await expect(binance(opts({ privateKey: partner.privatePkcs1 })).quote({ leg, amountIn: eur('100') }, makeCtx({ fetch }))).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
  })

  it('rsa helpers round-trip and reject a bad signature', async () => {
    const priv = await importRsaPrivateKey(partner.privatePem)
    const pub = await importRsaPublicKey(partner.publicPem)
    const sig = await rsaSign(priv, 'hello')
    expect(await rsaVerify(pub, 'hello', sig)).toBe(true)
    expect(await rsaVerify(pub, 'hellO', sig)).toBe(false)
    expect(await rsaVerify(pub, 'hello', '%%%not base64')).toBe(false)
  })
})

describe('binance adapter: quote', () => {
  it('prices a fiat amount from the Binance balance (BUY_WALLET) and maps fees', async () => {
    const { fetch, calls } = fakeFetch(routes())
    const q = await binance(opts()).quote({ leg, amountIn: eur('100') }, makeCtx({ fetch }))
    expect(calls[0]!.body).toEqual({ fiatCurrency: 'EUR', cryptoCurrency: 'USDC', requestedAmount: '100', amountType: 1, network: 'BASE', payMethodCode: 'BUY_WALLET' })
    expect(q).toMatchObject({
      adapterId: 'binance',
      legId: 'account',
      input: eur('100'),
      output: { value: '98.5', asset: { ...BASE_USDC, symbol: 'USDC', decimals: 6 } },
      fees: [
        { kind: 'provider', label: 'Binance fee', amount: '1', currency: 'EUR' },
        { kind: 'network', label: 'Network fee', amount: '0.5', currency: 'USDC' },
      ],
      data: { amountType: 1, network: 'BASE', payMethodCode: 'BUY_WALLET', estimate: true },
    })
    expect(Date.parse(q.expiresAt!)).toBeGreaterThan(Date.now())
  })

  it('prices a crypto amount (amountType 2) and picks the deliver asset by chain', async () => {
    const { fetch, calls } = fakeFetch(routes(20, { quote: () => ok({ ...QUOTE, totalAmount: '50.75', feeAmount: '0', networkFee: null }) }))
    const arb = { kind: 'crypto' as const, chain: 'eip155:42161', token: USDC['eip155:42161']! }
    const l: PathwayLeg = { ...leg, to: { asset: arb, location: { kind: 'address', address: DEST } } }
    const q = await binance(opts()).quote({ leg: l, amountOut: { value: '50.123456789', asset: arb } }, makeCtx({ fetch }))
    expect(calls[0]!.body).toMatchObject({ amountType: 2, requestedAmount: '50.12345678', network: 'ARBITRUM' })
    expect(q.input).toEqual(eur('50.75'))
    expect(q.output.value).toBe('50.12345678')
    expect(q.fees).toEqual([])
  })

  it('omits payMethodCode when the app sets null', async () => {
    const { fetch, calls } = fakeFetch(routes(20, { quote: () => ok({ ...QUOTE, payMethodCode: undefined }) }))
    const q = await binance(opts({ payMethodCode: null })).quote({ leg, amountIn: eur('100') }, makeCtx({ fetch }))
    expect(calls[0]!.body).not.toHaveProperty('payMethodCode')
    expect(q.data).not.toHaveProperty('payMethodCode')
  })

  it('maps a refused envelope to NO_QUOTES with the Binance message', async () => {
    const { fetch } = fakeFetch(routes(20, { quote: () => ({ success: false, code: '345001', message: 'Fiat currency not supported' }) }))
    await expect(binance(opts()).quote({ leg, amountIn: eur('100') }, makeCtx({ fetch }))).rejects.toMatchObject({ error: { code: 'NO_QUOTES', message: 'Binance: Fiat currency not supported' } })
  })

  it('maps HTTP 429 to RATE_LIMITED and 500 to PROVIDER_UNAVAILABLE', async () => {
    const r429 = fakeFetch([{ match: '/estimated-quote', status: 429, reply: () => ({ message: 'slow down' }) }])
    await expect(binance(opts()).quote({ leg, amountIn: eur('100') }, makeCtx({ fetch: r429.fetch }))).rejects.toMatchObject({ error: { code: 'RATE_LIMITED' } })
    const r500 = fakeFetch([{ match: '/estimated-quote', status: 500, reply: () => ({}) }])
    await expect(binance(opts()).quote({ leg, amountIn: eur('100') }, makeCtx({ fetch: r500.fetch }))).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
  })

  it('maps a timeout to PROVIDER_UNAVAILABLE', async () => {
    const { fetch } = fakeFetch([{ match: '/estimated-quote', hang: true }])
    await expect(binance(opts({ timeoutMs: 20 })).quote({ leg, amountIn: eur('100') }, makeCtx({ fetch }))).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
  })

  it('refuses a missing amount, a zero amount and a missing price', async () => {
    const { fetch } = fakeFetch(routes(20, { quote: () => ok({ feeAmount: '1' }) }))
    const a = binance(opts())
    await expect(a.quote({ leg }, makeCtx({ fetch }))).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
    await expect(a.quote({ leg, amountIn: eur('0') }, makeCtx({ fetch }))).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
    await expect(a.quote({ leg, amountIn: eur('10') }, makeCtx({ fetch }))).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
  })
})

describe('binance adapter: start', () => {
  it('creates the order with the address, return URLs and client IP, and a letters-and-digits ref', async () => {
    const { fetch, calls } = fakeFetch(routes())
    const a = binance(opts())
    const ctx = makeCtx({ fetch, session: { ip: '203.0.113.7' } })
    const q = await a.quote({ leg, amountIn: eur('100') }, ctx)
    const step = await a.start({ leg, quote: q }, ctx)
    const body = calls.find((c) => c.url.endsWith('/buy/pre-order'))!.body as Record<string, unknown>
    expect(body).toEqual({
      externalOrderId: step.ref,
      fiatCurrency: 'EUR',
      cryptoCurrency: 'USDC',
      amountType: 1,
      requestedAmount: '100',
      payMethodCode: 'BUY_WALLET',
      network: 'BASE',
      address: DEST,
      redirectUrl: 'https://app.test/api/openramp/return',
      failRedirectUrl: 'https://app.test/api/openramp/return',
      clientIp: '203.0.113.7',
    })
    expect(step.ref).toMatch(/^ork[0-9a-f]{24}$/)
    expect(step.transitions).toEqual([expect.objectContaining({ kind: 'AWAIT' })])
  })

  it('delivers to deliverTo when the leg is the first of two', async () => {
    const { fetch, calls } = fakeFetch(routes())
    const a = binance(opts())
    const ctx = makeCtx({ fetch })
    const q = await a.quote({ leg, amountIn: eur('100') }, ctx)
    await a.start({ leg, quote: q, deliverTo: { address: '0x00000000000000000000000000000000000000aa' } }, ctx)
    expect(calls.find((c) => c.url.endsWith('/buy/pre-order'))!.body).toMatchObject({ address: '0x00000000000000000000000000000000000000aa' })
  })

  it('fails with PROVIDER_UNAVAILABLE for an unsafe or missing link', async () => {
    for (const link of ['javascript:alert(1)', undefined, 'http://insecure.test/x']) {
      const { fetch } = fakeFetch(routes(20, { preorder: () => ok({ link }) }))
      const a = binance(opts())
      const ctx = makeCtx({ fetch, session: { livemode: true } })
      const q = await a.quote({ leg, amountIn: eur('100') }, ctx)
      await expect(a.start({ leg, quote: q }, ctx)).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    }
  })

  it('fails with BAD_REQUEST without an address', async () => {
    const { fetch } = fakeFetch(routes())
    const a = binance(opts())
    const ctx = makeCtx({ fetch, destination: { type: 'merchant', merchantId: 'm1' } as never })
    const q = await a.quote({ leg, amountIn: eur('100') }, ctx)
    await expect(a.start({ leg, quote: q }, ctx)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
  })

  it('maps a refused pre-order to an error', async () => {
    const { fetch } = fakeFetch(routes(20, { preorder: () => ({ success: false, code: '100001', message: 'address invalid' }) }))
    const a = binance(opts())
    const ctx = makeCtx({ fetch })
    const q = await a.quote({ leg, amountIn: eur('100') }, ctx)
    await expect(a.start({ leg, quote: q }, ctx)).rejects.toMatchObject({ error: { message: 'Binance: address invalid' } })
  })
})

describe('binance adapter: status', () => {
  const cases: Array<[number, string, string, string?]> = [
    [0, 'PAYMENT', 'awaiting_user'],
    [1, 'PROCESSING', 'processing'],
    [2, 'PROCESSING', 'processing'],
    [4, 'PROCESSING', 'processing'],
    [10, 'PROCESSING', 'processing'],
    [11, 'PROCESSING', 'processing'],
    [15, 'PROCESSING', 'processing'],
    [20, 'COMPLETED', 'succeeded'],
    [93, 'FAILED', 'failed', 'PAYMENT_FAILED'],
    [94, 'FAILED', 'failed', 'PAYMENT_FAILED'],
    [96, 'FAILED', 'failed', 'PAYMENT_FAILED'],
    [97, 'FAILED', 'failed', 'PAYMENT_FAILED'],
    [98, 'FAILED', 'failed', 'DELIVERY_FAILED'],
    [99, 'FAILED', 'failed', 'PAYMENT_FAILED'],
    [42, 'PAYMENT', 'awaiting_user'],
  ]
  it.each(cases)('status %i -> %s', async (code, state, status, errorCode) => {
    const { fetch, calls } = fakeFetch(routes(code))
    const step = await binance(opts()).status!({ leg, ref: 'ork1' }, makeCtx({ fetch }))
    expect(calls[0]!.body).toEqual({ externalOrderId: 'ork1' })
    expect(step).toMatchObject({ state, status, ref: 'ork1' })
    if (errorCode) expect(step.error?.code).toBe(errorCode)
    if (code === 20) expect(step).toMatchObject({ txHash: '0xabc', output: { value: '98.5' } })
  })

  it('leaves out the output when the network is not a deliver asset', async () => {
    const { fetch } = fakeFetch(routes(20, { order: () => ok(order('ork1', 20, { withdrawNetwork: 'TRX' })) }))
    const step = await binance(opts()).status!({ leg, ref: 'ork1' }, makeCtx({ fetch }))
    expect(step.state).toBe('COMPLETED')
    expect(step).not.toHaveProperty('output')
  })
})

describe('binance adapter: webhook', () => {
  const body = JSON.stringify({ webhookEventType: 'connect_order_event', ...order('ork9', 11) })
  const ts = '1759650000000'

  it('verifies with a base64 SPKI key too, and without a partner code check', async () => {
    const a = binance(opts({ binancePublicKey: bnb.publicB64 }))
    const req = webhookReq(body, { 'x-bn-connect-signature': bnbSign(body, ts), 'x-bn-connect-timestamp': ts })
    expect(await a.webhook!.verify(req, body, makeWebhookCtx())).toBe(true)
  })

  it('rejects a changed body, a changed timestamp, a signature from another key, and garbage', async () => {
    const a = binance(opts())
    const w = makeWebhookCtx()
    const sig = bnbSign(body, ts)
    expect(await a.webhook!.verify(webhookReq(body, { 'x-bn-connect-signature': sig, 'x-bn-connect-timestamp': ts }), body.replace('ork9', 'ork8'), w)).toBe(false)
    expect(await a.webhook!.verify(webhookReq(body, { 'x-bn-connect-signature': sig, 'x-bn-connect-timestamp': '1759650000001' }), body, w)).toBe(false)
    const other = nodeSign('sha256', Buffer.from(body + ts), partner.privateKey).toString('base64')
    expect(await a.webhook!.verify(webhookReq(body, { 'x-bn-connect-signature': other, 'x-bn-connect-timestamp': ts }), body, w)).toBe(false)
    expect(await a.webhook!.verify(webhookReq(body, { 'x-bn-connect-signature': '!!!', 'x-bn-connect-timestamp': ts }), body, w)).toBe(false)
    expect(await a.webhook!.verify(webhookReq(body, { 'x-bn-connect-timestamp': ts }), body, w)).toBe(false)
    expect(await a.webhook!.verify(webhookReq(body, { 'x-bn-connect-signature': sig }), body, w)).toBe(false)
  })

  it('rejects every webhook when the public key is missing or invalid, and logs why', async () => {
    const log = recordingLog()
    const sig = bnbSign(body, ts)
    const req = () => webhookReq(body, { 'x-bn-connect-signature': sig, 'x-bn-connect-timestamp': ts })
    expect(await binance(opts({ binancePublicKey: '' })).webhook!.verify(req(), body, makeWebhookCtx({ log }))).toBe(false)
    expect(await binance(opts({ binancePublicKey: 'bm90IGEga2V5' })).webhook!.verify(req(), body, makeWebhookCtx({ log }))).toBe(false)
    expect(log.warnings.join(' ')).toContain('binancePublicKey is not set')
    expect(log.errors.join(' ')).toContain('cannot import binancePublicKey')
  })

  it('parses a processing event, and ignores other event types, bad JSON and INIT', async () => {
    const a = binance(opts())
    const w = makeWebhookCtx({ log: recordingLog() })
    expect(await a.webhook!.parse(body, w)).toEqual([{ ref: 'ork9', status: 'processing' }])
    expect(await a.webhook!.parse(JSON.stringify({ webhookEventType: 'other_event', ...order('ork9', 20) }), w)).toEqual([])
    expect(await a.webhook!.parse('not json', w)).toEqual([])
    expect(await a.webhook!.parse(JSON.stringify(order('ork9', 0)), w)).toEqual([])
    expect(await a.webhook!.parse(JSON.stringify({ status: 20 }), w)).toEqual([])
  })

  it('parses failures with a safe message', async () => {
    const a = binance(opts())
    const [ev] = await a.webhook!.parse(JSON.stringify(order('ork9', 98)), makeWebhookCtx())
    expect(ev).toMatchObject({ ref: 'ork9', status: 'failed', error: { code: 'DELIVERY_FAILED', recovery: 'contact_support' } })
    const [ab] = await a.webhook!.parse(JSON.stringify(order('ork9', 96)), makeWebhookCtx())
    expect(ab).toMatchObject({ status: 'failed', error: { code: 'PAYMENT_FAILED', recovery: 'retry_payment' } })
  })
})

describe('binance adapter: regions and health', () => {
  it('denies the US, Canada, the Netherlands, sanctioned countries and Crimea; allows Germany and Brazil', () => {
    for (const c of ['US', 'CA', 'NL', 'SG', 'MY', 'IR', 'KP', 'CU', 'SY']) expect(isRegionAllowed(BINANCE_REGIONS, c)).toBe(false)
    expect(isRegionAllowed(BINANCE_REGIONS, 'UA', 'UA-43')).toBe(false)
    expect(isRegionAllowed(BINANCE_REGIONS, 'UA', 'UA-30')).toBe(true)
    for (const c of ['DE', 'BR', 'VN', 'TR', 'NG']) expect(isRegionAllowed(BINANCE_REGIONS, c)).toBe(true)
    expect(binance(opts({ regions: { allow: ['BR'], deny: [] } })).legs[0]!.regions).toEqual({ allow: ['BR'], deny: [] })
  })

  it('health is ok when trading pairs answer, and not ok on an error', async () => {
    const good = fakeFetch(routes())
    expect(await binance(opts()).health!(makeCtx({ fetch: good.fetch }))).toEqual({ ok: true })
    const bad = fakeFetch([{ match: '/trading-pairs', reply: () => ({ success: false, code: '1', message: 'no access' }) }])
    const h = await binance(opts()).health!(makeCtx({ fetch: bad.fetch }))
    expect(h.ok).toBe(false)
    expect(h.detail).toContain('no access')
  })
})
