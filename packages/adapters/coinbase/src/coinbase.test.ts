import { createHmac, generateKeyPairSync, verify as nodeVerify } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkAdapterShape, checkLegQuote, checkLegStep } from '@openrampkit/adapter'
import { USDC, isRegionAllowed } from '@openrampkit/core'
import type { PathwayLeg } from '@openrampkit/core'
import { COINBASE_NETWORKS, coinbase } from './index.js'
import { base64ToBytes, cdpJwt, importCdpKey } from './jwt.js'
import { fakeFetch, makeCtx, makeWebhookCtx, memoryKV, recordingLog, runAdapterConformance, silentLog } from '@openrampkit/adapter/testing'

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u))
const fromB64url = (s: string) => base64ToBytes(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
const decodePart = (s: string) => JSON.parse(new TextDecoder().decode(fromB64url(s)))

/** A CDP-style Ed25519 secret: base64(seed || publicKey), plus the public key for verification */
async function ed25519Secret() {
  const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey)
  const seed = fromB64url(jwk.d!)
  const pub = fromB64url(jwk.x!)
  return { secret: b64(new Uint8Array([...seed, ...pub])), publicKey: kp.publicKey }
}

const DEST = '0x000000000000000000000000000000000000beef'
const BASE_USDC = { kind: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']! }
const cardLeg: PathwayLeg = {
  adapterId: 'coinbase',
  legId: 'card',
  from: { asset: { kind: 'fiat', currency: 'USD' }, location: { kind: 'user_account' } },
  to: { asset: BASE_USDC, location: { kind: 'address', address: DEST } },
}

const SESSION_RES = {
  session: { onrampUrl: 'https://pay.coinbase.com/buy?sessionToken=abc123' },
  quote: {
    paymentTotal: '100.00', paymentSubtotal: '98.52', paymentCurrency: 'USD', purchaseAmount: '98.520000', purchaseCurrency: 'USDC',
    destinationNetwork: 'base', exchangeRate: '1',
    fees: [{ type: 'FEE_TYPE_EXCHANGE', amount: '1.48', currency: 'USD' }, { type: 'FEE_TYPE_NETWORK', amount: '0', currency: 'USD' }],
  },
}

describe('CDP JWT (WebCrypto)', () => {
  it('signs EdDSA JWTs with a base64 Ed25519 key, with the CDP claims', async () => {
    const { secret, publicKey } = await ed25519Secret()
    const key = await importCdpKey(secret)
    const jwt = await cdpJwt({ apiKeyId: 'key-id', key, method: 'POST', host: 'api.cdp.coinbase.com', path: '/platform/v2/onramp/sessions', now: 1_700_000_000_000 })
    const [h, c, s] = jwt.split('.')
    expect(decodePart(h!)).toMatchObject({ alg: 'EdDSA', kid: 'key-id', typ: 'JWT' })
    expect(decodePart(h!).nonce).toMatch(/^[0-9a-f]{32}$/)
    expect(decodePart(c!)).toEqual({ sub: 'key-id', iss: 'cdp', uris: ['POST api.cdp.coinbase.com/platform/v2/onramp/sessions'], iat: 1_700_000_000, nbf: 1_700_000_000, exp: 1_700_000_120 })
    const ok = await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, fromB64url(s!), new TextEncoder().encode(`${h}.${c}`))
    expect(ok).toBe(true)
  })

  it('signs ES256 JWTs with SEC1 ("EC PRIVATE KEY") and PKCS#8 PEM keys, including escaped newlines', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const sec1 = privateKey.export({ format: 'pem', type: 'sec1' }).toString()
    const pkcs8 = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    for (const pem of [sec1, pkcs8, sec1.replace(/\n/g, '\\n')]) {
      const key = await importCdpKey(pem)
      expect(key.alg).toBe('ES256')
      const jwt = await cdpJwt({ apiKeyId: 'organizations/o/apiKeys/k', key, method: 'GET', host: 'api.developer.coinbase.com', path: '/onramp/v1/buy/config' })
      const [h, c, s] = jwt.split('.')
      expect(decodePart(h!).alg).toBe('ES256')
      const ok = nodeVerify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(fromB64url(s!)))
      expect(ok).toBe(true)
    }
  })

  it('rejects keys that are neither PEM nor 64-byte base64', async () => {
    await expect(importCdpKey(btoa('short'))).rejects.toThrow(/Invalid CDP key/)
  })
})

describe('coinbase adapter', () => {
  it('passes the shape check; one leg per method (card, Apple Pay, Google Pay, ACH, Coinbase account), REDIRECT', () => {
    const a = coinbase({ apiKeyId: 'k', apiKeySecret: 'x' })
    expect(checkAdapterShape(a)).toEqual([])
    expect(a.legs.map((l) => l.id)).toEqual(['card', 'apple_pay', 'google_pay', 'ach', 'coinbase_account'])
    const ach = a.legs.find((l) => l.id === 'ach')!
    expect(ach.regions.allow).toEqual(['US'])
    expect(ach.from.asset).toEqual({ kind: 'fiat', currencies: ['USD'] })
    expect(a.legs[0]!.surfaces).toEqual(['REDIRECT'])
    expect(a.legs[0]!.regions.deny).toContain('JP')
  })

  it('quote: creates an onramp session with a quote (JWT auth), start reuses the fresh URL', async () => {
    const { secret } = await ed25519Secret()
    const { fetch, calls } = fakeFetch([{ method: 'POST', match: '/platform/v2/onramp/sessions', reply: () => SESSION_RES }])
    const a = coinbase({ apiKeyId: 'key-id', apiKeySecret: secret })
    const ctx = makeCtx({ fetch, session: { country: 'US', livemode: false } })
    const q = await a.quote({ leg: cardLeg, amountIn: { amount: '100', asset: { kind: 'fiat', currency: 'USD' } }, deliverTo: { address: DEST } }, ctx)
    expect(checkLegQuote(q)).toEqual([])
    expect(q.input).toEqual({ amount: '100.00', asset: { kind: 'fiat', currency: 'USD' } })
    expect(q.output).toEqual({ amount: '98.520000', asset: { ...BASE_USDC, symbol: 'USDC', decimals: 6 } })
    expect(q.fees).toEqual([
      { kind: 'provider', label: 'Coinbase fee', amount: '1.48', currency: 'USD' },
      { kind: 'network', label: 'Network fee', amount: '0', currency: 'USD' },
    ])
    const call = calls[0]!
    expect(call.url).toBe('https://api.cdp.coinbase.com/platform/v2/onramp/sessions')
    const jwt = call.headers.get('authorization')!.replace(/^Bearer /, '')
    expect(decodePart(jwt.split('.')[1]!).uris).toEqual(['POST api.cdp.coinbase.com/platform/v2/onramp/sessions'])
    expect(call.body).toMatchObject({
      purchaseCurrency: 'USDC', destinationNetwork: 'base', destinationAddress: DEST, paymentAmount: '100.00', paymentCurrency: 'USD',
      paymentMethod: 'CARD', country: 'US', redirectUrl: 'https://app.test/api/openramp/return',
    })
    expect((call.body as { partnerUserRef: string }).partnerUserRef).toMatch(/^sandbox-ork-[0-9a-f]{20}$/)

    const step = await a.start({ leg: cardLeg, quote: q, deliverTo: { address: DEST } }, ctx)
    expect(checkLegStep(step)).toEqual([])
    expect(step).toMatchObject({ state: 'PAYMENT', status: 'awaiting_user', surface: { kind: 'REDIRECT', url: SESSION_RES.session.onrampUrl, popup: true, provider: 'Coinbase' } })
    expect(step.ref).toBe((call.body as { partnerUserRef: string }).partnerUserRef)
    expect(calls).toHaveLength(1)

    // stale quote: a new single-use session is created
    const stale = { ...q, data: { ...q.data, createdAt: Date.now() - 10 * 60_000 } }
    const step2 = await a.start({ leg: cardLeg, quote: stale, deliverTo: { address: DEST } }, ctx)
    expect(calls).toHaveLength(2)
    expect(step2.ref).not.toBe(step.ref)
  })

  it('quote: ACH sends paymentMethod ACH and has the bank ETA', async () => {
    const { secret } = await ed25519Secret()
    const { fetch, calls } = fakeFetch([{ method: 'POST', match: '/platform/v2/onramp/sessions', reply: () => SESSION_RES }])
    const a = coinbase({ apiKeyId: 'key-id', apiKeySecret: secret })
    const ctx = makeCtx({ fetch, session: { country: 'US', region: 'US-CA' } as never })
    const q = await a.quote({ leg: { ...cardLeg, legId: 'ach' }, amountIn: { amount: '100', asset: { kind: 'fiat', currency: 'USD' } }, deliverTo: { address: DEST } }, ctx)
    expect(calls[0]!.body).toMatchObject({ paymentMethod: 'ACH', country: 'US', subdivision: 'CA' })
    expect(q.eta).toEqual({ min: 300, max: 5 * 86400 })
    const step = await a.start({ leg: { ...cardLeg, legId: 'ach' }, quote: { ...q, data: { ...q.data, createdAt: 0 } }, deliverTo: { address: DEST } }, ctx)
    expect(calls[1]!.body).toMatchObject({ paymentMethod: 'ACH' })
    expect(step.state).toBe('PAYMENT')
  })

  it('quote: passes the US state when the session region is known, maps 400 to NO_QUOTES', async () => {
    const { secret } = await ed25519Secret()
    const { fetch, calls } = fakeFetch([{ method: 'POST', match: '/onramp/sessions', status: 400, reply: () => ({ errorType: 'invalid_request', errorMessage: 'Amount below minimum' }) }])
    const a = coinbase({ apiKeyId: 'k', apiKeySecret: secret })
    const ctx = makeCtx({ fetch, session: { country: 'US', region: 'US-NY' } as never })
    await expect(a.quote({ leg: { ...cardLeg, legId: 'apple_pay' }, amountIn: { amount: '1', asset: { kind: 'fiat', currency: 'USD' } } }, ctx)).rejects.toMatchObject({
      error: { code: 'NO_QUOTES', message: 'Coinbase: Amount below minimum' },
    })
    expect(calls[0]!.body).toMatchObject({ subdivision: 'NY', paymentMethod: 'APPLE_PAY' })
  })

  it('status: maps the transactions API by partnerUserRef', async () => {
    const { secret } = await ed25519Secret()
    let txs: unknown[] = []
    const { fetch, calls } = fakeFetch([{ method: 'GET', match: '/onramp/v1/buy/user/', reply: () => ({ transactions: txs }) }])
    const a = coinbase({ apiKeyId: 'k', apiKeySecret: secret })
    const ctx = makeCtx({ fetch })
    expect(await a.status!({ leg: cardLeg, ref: 'sandbox-ork-1' }, ctx)).toMatchObject({ state: 'PAYMENT', status: 'awaiting_user' })
    expect(calls[0]!.url).toBe('https://api.developer.coinbase.com/onramp/v1/buy/user/sandbox-ork-1/transactions?pageSize=1')
    const jwt = calls[0]!.headers.get('authorization')!.replace(/^Bearer /, '')
    expect(decodePart(jwt.split('.')[1]!).uris).toEqual(['GET api.developer.coinbase.com/onramp/v1/buy/user/sandbox-ork-1/transactions'])
    txs = [{ status: 'ONRAMP_TRANSACTION_STATUS_IN_PROGRESS', tx_hash: '0x' }]
    expect(await a.status!({ leg: cardLeg, ref: 'sandbox-ork-1' }, ctx)).toMatchObject({ state: 'PROCESSING', status: 'processing' })
    txs = [{ status: 'ONRAMP_TRANSACTION_STATUS_SUCCESS', tx_hash: '0xabc', purchase_amount: { value: '5', currency: 'USDC' }, purchase_network: 'base' }]
    const done = await a.status!({ leg: cardLeg, ref: 'sandbox-ork-1' }, ctx)
    expect(checkLegStep(done)).toEqual([])
    expect(done).toMatchObject({ state: 'COMPLETED', status: 'succeeded', txHash: '0xabc', output: { amount: '5', asset: { chain: 'eip155:8453' } } })
    txs = [{ status: 'ONRAMP_TRANSACTION_STATUS_FAILED', failure_reason: 'FAILURE_REASON_BUY_FAILED' }]
    expect(await a.status!({ leg: cardLeg, ref: 'sandbox-ork-1' }, ctx)).toMatchObject({ state: 'FAILED', status: 'failed' })
  })

  it('webhook: verifies X-Hook0-Signature (v0 over "t.body") and maps events', async () => {
    const a = coinbase({ apiKeyId: 'k', apiKeySecret: 'x', webhookSecret: 'whsec' })
    const body = JSON.stringify({
      eventType: 'onramp.transaction.success', status: 'ONRAMP_TRANSACTION_STATUS_SUCCESS', partnerUserRef: 'ork-1',
      purchaseAmount: { currency: 'USDC', value: '4.81' }, purchaseNetwork: 'base', txHash: '0xfeed',
    })
    const t = Math.floor(Date.now() / 1000)
    const v0 = createHmac('sha256', 'whsec').update(`${t}.${body}`).digest('hex')
    const req = (h: string) => new Request('https://x/webhooks/coinbase', { method: 'POST', body, headers: { 'x-hook0-signature': h } })
    expect(await a.webhook!.verify(req(`t=${t},v0=${v0},h=content-type,v1=zz`), body, { log: silentLog, shared: memoryKV(), fetch })).toBe(true)
    expect(await a.webhook!.verify(req(`t=${t},v0=${'0'.repeat(64)}`), body, { log: silentLog, shared: memoryKV(), fetch })).toBe(false)
    const old = t - 3600
    const v0old = createHmac('sha256', 'whsec').update(`${old}.${body}`).digest('hex')
    expect(await a.webhook!.verify(req(`t=${old},v0=${v0old}`), body, { log: silentLog, shared: memoryKV(), fetch })).toBe(false)
    expect(await coinbase({ apiKeyId: 'k', apiKeySecret: 'x' }).webhook!.verify(req(`t=${t},v0=${v0}`), body, { log: silentLog, shared: memoryKV(), fetch })).toBe(false)

    expect(await a.webhook!.parse(body, { log: silentLog, shared: memoryKV(), fetch })).toEqual([
      { ref: 'ork-1', status: 'succeeded', txHash: '0xfeed', output: { amount: '4.81', asset: { ...BASE_USDC, symbol: 'USDC', decimals: 6 } } },
    ])
    // headless order event shape
    const headless = JSON.stringify({ eventType: 'onramp.transaction.failed', status: 'ONRAMP_ORDER_STATUS_FAILED', partnerUserRef: 'ork-2' })
    expect(await a.webhook!.parse(headless, { log: silentLog, shared: memoryKV(), fetch })).toMatchObject([{ ref: 'ork-2', status: 'failed' }])
    expect(await a.webhook!.parse(JSON.stringify({ eventType: 'offramp.transaction.success', partnerUserRef: 'x' }), { log: silentLog, shared: memoryKV(), fetch })).toEqual([])
  })

  it('catalog: regions from the Buy Config API (cached)', async () => {
    const { secret } = await ed25519Secret()
    const { fetch, calls } = fakeFetch([
      {
        method: 'GET',
        match: '/onramp/v1/buy/config',
        reply: () => ({ countries: [{ id: 'US', payment_methods: [{ id: 'CARD' }, { id: 'APPLE_PAY' }, { id: 'ACH_BANK_ACCOUNT' }] }, { id: 'GB', payment_methods: [{ id: 'CARD' }, { id: 'ACH_BANK_ACCOUNT' }] }] }),
      },
    ])
    const a = coinbase({ apiKeyId: 'k', apiKeySecret: secret })
    const shared = memoryKV()
    const legs = await a.catalog!({ country: 'US', currency: 'USD', direction: 'deposit' }, { fetch, log: silentLog, shared })
    expect(legs.find((l) => l.id === 'card')!.regions.allow).toEqual(['US', 'GB'])
    expect(legs.find((l) => l.id === 'apple_pay')!.regions.allow).toEqual(['US'])
    // ACH is `ACH_BANK_ACCOUNT` in the config and stays in the US
    expect(legs.find((l) => l.id === 'ach')!.regions.allow).toEqual(['US'])
    await a.catalog!({ country: 'US', currency: 'USD', direction: 'deposit' }, { fetch, log: silentLog, shared })
    expect(calls).toHaveLength(1)
    expect(await a.health!({ fetch, log: silentLog })).toEqual({ ok: true })
  })
})


const usd = (amount: string) => ({ amount, asset: { kind: 'fiat' as const, currency: 'USD' } })
const hook0 = (secret: string, body: string, t = Math.floor(Date.now() / 1000)) => `t=${t},v0=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`
const hookReq = (body: string, header?: string) => new Request('https://x/webhooks/coinbase', { method: 'POST', body, headers: header ? { 'x-hook0-signature': header } : {} })

describe('coinbase conformance', () => {
  it('card leg, status and webhooks pass runAdapterConformance', async () => {
    const { secret } = await ed25519Secret()
    const { fetch } = fakeFetch([
      { method: 'POST', match: '/onramp/sessions', reply: () => SESSION_RES },
      { method: 'GET', match: '/onramp/v1/buy/user/', reply: () => ({ transactions: [] }) },
    ])
    const body = JSON.stringify({ eventType: 'onramp.transaction.success', status: 'ONRAMP_TRANSACTION_STATUS_SUCCESS', partnerUserRef: 'ork-1' })
    const report = await runAdapterConformance(coinbase({ apiKeyId: 'k', apiKeySecret: secret, webhookSecret: 'whsec' }), {
      fetch,
      fixtures: [{ leg: cardLeg, quote: { amountIn: usd('100') }, expect: { start: 'PAYMENT', status: 'PAYMENT' } }],
      webhooks: [
        { name: 'signed', rawBody: body, request: () => hookReq(body, hook0('whsec', body)), events: 1 },
        { name: 'bad signature', rawBody: body, request: () => hookReq(body, hook0('other', body)), valid: false },
        { name: 'stale', rawBody: body, request: () => hookReq(body, hook0('whsec', body, Math.floor(Date.now() / 1000) - 301)), valid: false },
        { name: 'missing header', rawBody: body, request: () => hookReq(body), valid: false },
      ],
    })
    expect(report.problems).toEqual([])
  })
})

describe('coinbase errors and edge cases', () => {
  afterEach(() => vi.useRealTimers())

  it('regions: Japan is denied', () => {
    const a = coinbase({ apiKeyId: 'k', apiKeySecret: 'x' })
    for (const l of a.legs) {
      expect(isRegionAllowed(l.regions, 'JP')).toBe(false)
      expect(isRegionAllowed(l.regions, 'US', 'US-NY')).toBe(true)
    }
  })

  it('quote: maps 429, 401/403 (setup errors), 404, 5xx; a missing quote is NO_QUOTES', async () => {
    const { secret } = await ed25519Secret()
    const a = coinbase({ apiKeyId: 'k', apiKeySecret: secret })
    const q = (routes: Parameters<typeof fakeFetch>[0], log = recordingLog()) => a.quote({ leg: cardLeg, amountIn: usd('10') }, makeCtx({ fetch: fakeFetch(routes).fetch, log }))
    await expect(q([{ method: 'POST', match: '/onramp/sessions', status: 429, reply: () => ({}) }])).rejects.toMatchObject({ status: 429, error: { code: 'RATE_LIMITED' } })
    // 401 and 403: our key is wrong. Not retryable, the user chooses another method, the operator gets one error log.
    for (const status of [401, 403]) {
      const log = recordingLog()
      await expect(q([{ method: 'POST', match: '/onramp/sessions', status, reply: () => ({ errorMessage: 'Unauthorized key' }) }], log)).rejects.toMatchObject({
        status: 502,
        error: { code: 'PROVIDER_UNAVAILABLE', message: 'Coinbase is not set up for this app yet. Try another method.', retryable: false, recovery: 'choose_other' },
      })
      expect(log.warnings).toEqual([])
      expect(log.errors).toHaveLength(1)
      expect(log.errors[0]).toMatch(/^Coinbase: cannot price this amount: .*HTTP 40[13]/)
    }
    for (const status of [404, 500]) {
      const log = recordingLog()
      await expect(q([{ method: 'POST', match: '/onramp/sessions', status, reply: () => ({ errorMessage: 'Unauthorized key' }) }], log)).rejects.toMatchObject({
        status: 502,
        error: { code: 'PROVIDER_UNAVAILABLE', message: 'Coinbase is not available right now.' },
      })
      expect(log.warnings).toEqual(['Coinbase: request failed'])
    }
    await expect(q([{ method: 'POST', match: '/onramp/sessions', status: 422, reply: () => ({}) }])).rejects.toMatchObject({ error: { code: 'NO_QUOTES', message: 'Coinbase could not price this amount.' } })
    await expect(q([{ method: 'POST', match: '/onramp/sessions', reply: () => ({ session: SESSION_RES.session }) }])).rejects.toMatchObject({ status: 422, error: { code: 'NO_QUOTES' } })
  })

  it('quote: needs fiat and a wallet address', async () => {
    const a = coinbase({ apiKeyId: 'k', apiKeySecret: 'x' })
    await expect(a.quote({ leg: { ...cardLeg, from: { asset: BASE_USDC, location: { kind: 'user_wallet' } } }, amountIn: { amount: '1', asset: BASE_USDC } }, makeCtx({ fetch: fakeFetch([]).fetch }))).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
    const { secret } = await ed25519Secret()
    const b = coinbase({ apiKeyId: 'k', apiKeySecret: secret })
    const merchant = makeCtx({ fetch: fakeFetch([]).fetch, destination: { type: 'merchant', merchantId: 'm', currency: 'USD' } as never })
    await expect(b.quote({ leg: cardLeg, amountIn: usd('10') }, merchant)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST', message: 'Coinbase needs a wallet address to deliver to.' } })
  })

  it('quote: exact output, default subdivision, other networks, non-US countries, live refs', async () => {
    const { secret } = await ed25519Secret()
    const { fetch, calls } = fakeFetch([{ method: 'POST', match: '/onramp/sessions', reply: () => SESSION_RES }])
    const a = coinbase({ apiKeyId: 'k', apiKeySecret: secret, defaultSubdivision: 'CA', defaultCountry: 'us' })
    const arb: PathwayLeg = { ...cardLeg, to: { asset: { kind: 'crypto', chain: 'eip155:42161', token: USDC['eip155:42161']! }, location: { kind: 'address', address: DEST } } }
    const q = await a.quote({ leg: arb, amountOut: { amount: '25', asset: BASE_USDC } }, makeCtx({ fetch, session: { country: undefined, livemode: true } }))
    expect(calls[0]!.body).toMatchObject({ purchaseAmount: '25', destinationNetwork: 'arbitrum', country: 'US', subdivision: 'CA', paymentCurrency: 'USD' })
    expect((calls[0]!.body as Record<string, unknown>).paymentAmount).toBeUndefined()
    expect((calls[0]!.body as { partnerUserRef: string }).partnerUserRef).toMatch(/^ork-[0-9a-f]{20}$/)
    expect(q.output.asset).toMatchObject({ chain: 'eip155:42161' })
    // a region in another country does not count; non-US countries need no subdivision
    await a.quote({ leg: cardLeg, amountIn: usd('10') }, makeCtx({ fetch, session: { country: 'GB', region: 'US-NY' } }))
    expect((calls[1]!.body as Record<string, unknown>).subdivision).toBeUndefined()
    expect(calls[1]!.body).toMatchObject({ country: 'GB' })
    // unknown chain: Base; google_pay maps to CARD; sandbox forced on
    const b = coinbase({ apiKeyId: 'k', apiKeySecret: secret, sandbox: true })
    await b.quote({ leg: { ...cardLeg, legId: 'google_pay', to: { asset: { kind: 'crypto', chain: 'eip155:143', token: '0x1' }, location: { kind: 'address', address: DEST } } }, amountIn: usd('10') }, makeCtx({ fetch, session: { livemode: true } }))
    expect(calls[2]!.body).toMatchObject({ destinationNetwork: 'base', paymentMethod: 'CARD' })
    expect((calls[2]!.body as { partnerUserRef: string }).partnerUserRef).toMatch(/^sandbox-ork-/)
    expect(COINBASE_NETWORKS['eip155:8453']).toBe('base')
  })

  it('start: a stale quote gets a new session with the quoted method and location (was lost)', async () => {
    const { secret } = await ed25519Secret()
    const { fetch, calls } = fakeFetch([{ method: 'POST', match: '/onramp/sessions', reply: () => SESSION_RES }])
    const a = coinbase({ apiKeyId: 'k', apiKeySecret: secret })
    const ctx = makeCtx({ fetch, session: { country: 'US', region: 'US-NY' } })
    const q = await a.quote({ leg: { ...cardLeg, legId: 'apple_pay' }, amountIn: usd('50') }, ctx)
    vi.useFakeTimers({ now: Date.now() + 5 * 60_000 })
    const step = await a.start({ leg: { ...cardLeg, legId: 'apple_pay' }, quote: q }, ctx)
    expect(calls[1]!.body).toMatchObject({ paymentMethod: 'APPLE_PAY', country: 'US', subdivision: 'NY', paymentAmount: '100.00', destinationNetwork: 'base' })
    expect(step.ref).toBe((calls[1]!.body as { partnerUserRef: string }).partnerUserRef)
  })

  it('start: new session without quote data, and its errors', async () => {
    const { secret } = await ed25519Secret()
    const a = coinbase({ apiKeyId: 'k', apiKeySecret: secret })
    const quote = { adapterId: 'coinbase', legId: 'card', input: { amount: '10', asset: BASE_USDC }, output: { amount: '10', asset: BASE_USDC }, fees: [], eta: { min: 1, max: 2 } }
    const ok = fakeFetch([{ method: 'POST', match: '/onramp/sessions', reply: () => SESSION_RES }])
    const step = await a.start({ leg: cardLeg, quote }, makeCtx({ fetch: ok.fetch }))
    expect(step.surface).toMatchObject({ kind: 'REDIRECT', url: SESSION_RES.session.onrampUrl })
    expect(ok.calls[0]!.body).toMatchObject({ paymentCurrency: 'USD', destinationNetwork: 'base' })
    expect((ok.calls[0]!.body as Record<string, unknown>).paymentMethod).toBeUndefined()
    const noUrl = fakeFetch([{ method: 'POST', match: '/onramp/sessions', reply: () => ({ session: {} }) }])
    await expect(a.start({ leg: cardLeg, quote }, makeCtx({ fetch: noUrl.fetch }))).rejects.toMatchObject({ status: 502, error: { message: 'Coinbase did not return a checkout URL.' } })
    const bad = fakeFetch([{ method: 'POST', match: '/onramp/sessions', status: 400, reply: () => ({ message: 'Address invalid' }) }])
    await expect(a.start({ leg: cardLeg, quote }, makeCtx({ fetch: bad.fetch }))).rejects.toMatchObject({ error: { code: 'NO_QUOTES', message: 'Coinbase: Address invalid' } })
  })

  it('status: HTTP errors and every transaction shape', async () => {
    const { secret } = await ed25519Secret()
    const a = coinbase({ apiKeyId: 'k', apiKeySecret: secret })
    const failing = fakeFetch([{ method: 'GET', match: '/buy/user/', status: 503, reply: () => ({}) }])
    await expect(a.status!({ leg: cardLeg, ref: 'r' }, makeCtx({ fetch: failing.fetch }))).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    let tx: unknown
    const { fetch } = fakeFetch([{ method: 'GET', match: '/buy/user/', reply: () => (tx === undefined ? {} : { transactions: [tx] }) }])
    const ctx = makeCtx({ fetch })
    const st = () => a.status!({ leg: cardLeg, ref: 'r' }, ctx)
    expect(await st()).toMatchObject({ state: 'PAYMENT' })
    tx = { status: 'ONRAMP_ORDER_STATUS_COMPLETED', txHash: '0x9', purchaseAmount: '3.5', purchaseNetwork: 'polygon' }
    expect(await st()).toMatchObject({ state: 'COMPLETED', txHash: '0x9', output: { amount: '3.5', asset: { chain: 'eip155:137' } } })
    tx = { status: 'ONRAMP_TRANSACTION_STATUS_SUCCESS', purchase_amount: { amount: '2', currency: 'USDC' }, destinationNetwork: 'unknown-net' }
    const s = await st()
    expect(s).toMatchObject({ state: 'COMPLETED' })
    expect(s.output).toBeUndefined()
    tx = { status: 'ONRAMP_TRANSACTION_STATUS_SUCCESS', purchaseAmount: { value: 'lots', currency: 'USDC' }, purchaseNetwork: 'base' }
    expect((await st()).output).toBeUndefined()
    tx = {}
    expect(await st()).toMatchObject({ state: 'PROCESSING', status: 'processing' })
  })

  it('webhook: malformed headers, no secret (logged), and parse edge cases', async () => {
    const a = coinbase({ apiKeyId: 'k', apiKeySecret: 'x', webhookSecret: 'whsec' })
    const body = '{}'
    const ctx = makeWebhookCtx()
    for (const h of ['garbage', 't=abc,v0=00', `v0=${'0'.repeat(64)}`, `t=${Math.floor(Date.now() / 1000)}`]) {
      expect(await a.webhook!.verify(hookReq(body, h), body, ctx)).toBe(false)
    }
    // the signature is compared case-insensitively
    const t = Math.floor(Date.now() / 1000)
    const upper = `t=${t}, v0=${createHmac('sha256', 'whsec').update(`${t}.${body}`).digest('hex').toUpperCase()}`
    expect(await a.webhook!.verify(hookReq(body, upper), body, ctx)).toBe(true)
    const log = recordingLog()
    expect(await coinbase({ apiKeyId: 'k', apiKeySecret: 'x' }).webhook!.verify(hookReq(body, upper), body, makeWebhookCtx({ log }))).toBe(false)
    expect(log.warnings).toEqual(['coinbase: webhookSecret is not set; rejecting webhook'])

    const plog = recordingLog()
    const pctx = makeWebhookCtx({ log: plog })
    expect(await a.webhook!.parse('nope', pctx)).toEqual([])
    expect(plog.warnings).toEqual(['coinbase: webhook body is not JSON'])
    expect(await a.webhook!.parse(JSON.stringify({ status: 'ONRAMP_TRANSACTION_STATUS_SUCCESS' }), pctx)).toEqual([])
    expect(await a.webhook!.parse(JSON.stringify({ eventType: 'onramp.transaction.created', partner_user_ref: 'ork-3' }), pctx)).toEqual([{ ref: 'ork-3', status: 'processing' }])
    expect(await a.webhook!.parse(JSON.stringify({ eventType: 'onramp.transaction.success', partnerUserRef: 'ork-4', txHash: '0x' }), pctx)).toEqual([{ ref: 'ork-4', status: 'succeeded' }])
  })

  it('catalog: data wrapper, static fallback, unsupported methods dropped, errors throw', async () => {
    const { secret } = await ed25519Secret()
    const a = coinbase({ apiKeyId: 'k', apiKeySecret: secret })
    const cat = (reply: () => unknown, status?: number) =>
      a.catalog!({ currency: 'USD', direction: 'deposit' }, { fetch: fakeFetch([{ method: 'GET', match: '/buy/config', reply, ...(status ? { status } : {}) }]).fetch, log: silentLog, shared: memoryKV() })
    // { data: { countries } } shape; nobody lists Apple Pay, so it is not offered (was: allowed everywhere)
    const wrapped = await cat(() => ({ data: { countries: [{ id: 'us', payment_methods: [{ id: 'card' }] }, { id: 'DE' }] } }))
    expect(wrapped.map((l) => [l.id, l.regions.allow])).toEqual([
      ['card', ['US']],
      ['google_pay', ['US']],
    ])
    expect(wrapped[0]!.regions.deny).toEqual(['JP'])
    // no countries, or no country lists any method we know: keep the static legs
    expect(await cat(() => ({ countries: [] }))).toEqual(a.legs)
    expect(await cat(() => ({}))).toEqual(a.legs)
    expect(await cat(() => ({ countries: [{ id: 'US', payment_methods: [{ id: 'PAYPAL' }] }] }))).toEqual(a.legs)
    await expect(cat(() => ({}), 500)).rejects.toMatchObject({ status: 500 })
  })

  it('health: an invalid key is reported', async () => {
    const res = await coinbase({ apiKeyId: 'k', apiKeySecret: btoa('short') }).health!({ fetch: fakeFetch([]).fetch, log: silentLog })
    expect(res).toEqual({ ok: false, detail: expect.stringMatching(/^Invalid CDP key/) })
  })
})
