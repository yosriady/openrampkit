import { createHmac, generateKeyPairSync, verify as nodeVerify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { checkAdapterShape, checkLegQuote, checkLegStep } from '@openrampkit/adapter'
import { USDC } from '@openrampkit/core'
import type { PathwayLeg } from '@openrampkit/core'
import { coinbase } from './index.js'
import { base64ToBytes, cdpJwt, importCdpKey } from './jwt.js'
import { fakeFetch, makeCtx, memoryKV, silentLog } from './testctx.js'

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
  it('passes the shape check; one leg per method (card, Apple Pay, Google Pay), REDIRECT', () => {
    const a = coinbase({ apiKeyId: 'k', apiKeySecret: 'x' })
    expect(checkAdapterShape(a)).toEqual([])
    expect(a.legs.map((l) => l.id)).toEqual(['card', 'apple_pay', 'google_pay'])
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
      { method: 'GET', match: '/onramp/v1/buy/config', reply: () => ({ countries: [{ id: 'US', payment_methods: [{ id: 'CARD' }, { id: 'APPLE_PAY' }] }, { id: 'GB', payment_methods: [{ id: 'CARD' }] }] }) },
    ])
    const a = coinbase({ apiKeyId: 'k', apiKeySecret: secret })
    const shared = memoryKV()
    const legs = await a.catalog!({ country: 'US', currency: 'USD', direction: 'deposit' }, { fetch, log: silentLog, shared })
    expect(legs.find((l) => l.id === 'card')!.regions.allow).toEqual(['US', 'GB'])
    expect(legs.find((l) => l.id === 'apple_pay')!.regions.allow).toEqual(['US'])
    await a.catalog!({ country: 'US', currency: 'USD', direction: 'deposit' }, { fetch, log: silentLog, shared })
    expect(calls).toHaveLength(1)
    expect(await a.health!({ fetch, log: silentLog })).toEqual({ ok: true })
  })
})
