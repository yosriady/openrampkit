// Coinbase account balance (coinbase_account) and guest Apple Pay (Headless Onramp API) tests.
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { checkAdapterShape, checkLegQuote, checkLegStep } from '@openrampkit/adapter'
import { METHODS, USDC, isRegionAllowed } from '@openrampkit/core'
import type { PathwayLeg, Surface } from '@openrampkit/core'
import { coinbase } from './index.js'
import type { CoinbaseOptions } from './index.js'
import { fakeFetch, makeCtx, makeWebhookCtx, memoryKV, runAdapterConformance } from '@openrampkit/adapter/testing'

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u))
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0))

/** A CDP-style Ed25519 secret: base64(seed || publicKey) */
async function ed25519Secret(): Promise<string> {
  const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey)
  return b64(new Uint8Array([...fromB64url(jwk.d!), ...fromB64url(jwk.x!)]))
}

const DEST = '0x000000000000000000000000000000000000beef'
const BASE_USDC = { kind: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']! }
const usd = (amount: string) => ({ value: amount, asset: { kind: 'fiat' as const, currency: 'USD' } })
const legOf = (legId: string): PathwayLeg => ({
  adapterId: 'coinbase',
  legId,
  from: { asset: { kind: 'fiat', currency: 'USD' }, location: { kind: 'user_account' } },
  to: { asset: BASE_USDC, location: { kind: 'address', address: DEST } },
})
const guestLeg = legOf('guest_apple_pay')
const accountLeg = legOf('coinbase_account')

const SESSION_RES = {
  session: { onrampUrl: 'https://pay.coinbase.com/buy?sessionToken=acc123' },
  quote: {
    paymentTotal: '50.00', paymentSubtotal: '50.00', paymentCurrency: 'USD', purchaseAmount: '50.000000', purchaseCurrency: 'USDC',
    destinationNetwork: 'base', exchangeRate: '1', fees: [{ type: 'FEE_TYPE_EXCHANGE', amount: '0', currency: 'USD' }],
  },
}

/** Shapes from the Create Onramp Order API reference */
const ORDER = {
  orderId: '123e4567-e89b-12d3-a456-426614174000',
  paymentTotal: '100.75', paymentSubtotal: '100', paymentCurrency: 'USD', paymentMethod: 'GUEST_CHECKOUT_APPLE_PAY',
  purchaseAmount: '100.000000', purchaseCurrency: 'USDC',
  fees: [{ type: 'FEE_TYPE_EXCHANGE', amount: '0.5', currency: 'USD' }, { type: 'FEE_TYPE_NETWORK', amount: '0.25', currency: 'USD' }],
  exchangeRate: '1', destinationAddress: DEST, destinationNetwork: 'base', status: 'ONRAMP_ORDER_STATUS_PENDING_PAYMENT',
  createdAt: '2026-10-05T00:00:00Z', updatedAt: '2026-10-05T00:00:00Z',
}
const PAY_URL = 'https://pay.coinbase.com/v2/api-onramp/apple-pay?sessionToken=MWYw'

const GUEST: CoinbaseOptions['guestCheckout'] = { domain: 'app.example.com' }

describe('coinbase account balance (coinbase_account)', () => {
  it('is an exchange-kind method, global except Japan, Coinbase account required', () => {
    expect(METHODS.coinbase_account).toEqual({ id: 'coinbase_account', name: 'Coinbase account', kind: 'exchange' })
    const leg = coinbase({ apiKeyId: 'k', apiKeySecret: 'x' }).legs.find((l) => l.id === 'coinbase_account')!
    expect(leg.methods).toEqual(['coinbase_account'])
    expect(leg.surfaces).toEqual(['REDIRECT'])
    expect(leg.requires).toEqual(['provider_account', 'provider_kyc'])
    expect(isRegionAllowed(leg.regions, 'JP')).toBe(false)
    expect(isRegionAllowed(leg.regions, 'DE')).toBe(true)
  })

  it('quote and start: session API with paymentMethod FIAT_WALLET (default) or CRYPTO_WALLET', async () => {
    const secret = await ed25519Secret()
    const { fetch, calls } = fakeFetch([{ method: 'POST', match: '/platform/v2/onramp/sessions', reply: () => SESSION_RES }])
    const ctx = makeCtx({ fetch, session: { country: 'US', region: 'US-CA' } })
    const a = coinbase({ apiKeyId: 'k', apiKeySecret: secret })
    const q = await a.quote({ leg: accountLeg, amountIn: usd('50'), deliverTo: { address: DEST } }, ctx)
    expect(checkLegQuote(q)).toEqual([])
    expect(calls[0]!.body).toMatchObject({ paymentMethod: 'FIAT_WALLET', paymentAmount: '50.00', country: 'US', subdivision: 'CA' })
    expect(q.fees).toEqual([{ kind: 'provider', label: 'Coinbase fee', amount: '0', currency: 'USD' }])
    const step = await a.start({ leg: accountLeg, quote: { ...q, data: { ...q.data, createdAt: 0 } } }, ctx)
    expect(calls[1]!.body).toMatchObject({ paymentMethod: 'FIAT_WALLET' })
    expect(step.surface).toMatchObject({ kind: 'REDIRECT', url: SESSION_RES.session.onrampUrl })

    const b = coinbase({ apiKeyId: 'k', apiKeySecret: secret, accountBalance: 'CRYPTO_WALLET' })
    await b.quote({ leg: accountLeg, amountIn: usd('50') }, ctx)
    expect(calls[2]!.body).toMatchObject({ paymentMethod: 'CRYPTO_WALLET' })
  })

  it('catalog: countries that list FIAT_WALLET or CRYPTO_ACCOUNT in the Buy Config API', async () => {
    const secret = await ed25519Secret()
    const { fetch } = fakeFetch([
      {
        method: 'GET',
        match: '/onramp/v1/buy/config',
        reply: () => ({
          countries: [
            { id: 'US', payment_methods: [{ id: 'CARD' }, { id: 'FIAT_WALLET' }, { id: 'GUEST_CHECKOUT_APPLE_PAY' }] },
            { id: 'GB', payment_methods: [{ id: 'CARD' }, { id: 'CRYPTO_ACCOUNT' }] },
            { id: 'CA', payment_methods: [{ id: 'CARD' }] },
          ],
        }),
      },
    ])
    const a = coinbase({ apiKeyId: 'k', apiKeySecret: secret, guestCheckout: GUEST })
    const legs = await a.catalog!({ country: 'US', currency: 'USD', direction: 'deposit' }, { fetch, log: makeWebhookCtx().log, shared: memoryKV() })
    expect(legs.find((l) => l.id === 'coinbase_account')!.regions.allow).toEqual(['US', 'GB'])
    // Guest Apple Pay is not refined by the hosted config: it keeps its static US region
    expect(legs.find((l) => l.id === 'guest_apple_pay')!.regions).toEqual({ allow: ['US'], deny: [] })
  })
})

describe('coinbase guest Apple Pay (Headless Onramp API)', () => {
  it('is off by default; with guestCheckout it adds a US-only IFRAME leg for apple_pay without a Coinbase account', () => {
    expect(coinbase({ apiKeyId: 'k', apiKeySecret: 'x' }).legs.some((l) => l.id === 'guest_apple_pay')).toBe(false)
    const a = coinbase({ apiKeyId: 'k', apiKeySecret: 'x', guestCheckout: GUEST })
    expect(checkAdapterShape(a)).toEqual([])
    const leg = a.legs.find((l) => l.id === 'guest_apple_pay')!
    expect(leg).toMatchObject({ methods: ['apple_pay'], surfaces: ['IFRAME'], regions: { allow: ['US'], deny: [] }, limits: { min: '5', max: '2500', currency: 'USD' } })
    expect(leg.from.asset).toEqual({ kind: 'fiat', currencies: ['USD'] })
    expect(leg.requires).toBeUndefined()
    for (const c of ['GB', 'CA', 'JP']) expect(isRegionAllowed(leg.regions, c)).toBe(false)
    expect(isRegionAllowed(leg.regions, 'US', 'US-NY')).toBe(true)
  })

  it('quote: Create Onramp Order with isQuote, embedded order (no contact), fees and limits', async () => {
    const secret = await ed25519Secret()
    const { fetch, calls } = fakeFetch([{ method: 'POST', match: '/platform/v2/onramp/orders', status: 201, reply: () => ({ order: ORDER }) }])
    const a = coinbase({ apiKeyId: 'k', apiKeySecret: secret, guestCheckout: GUEST })
    const ctx = makeCtx({ fetch, session: { ip: '203.0.113.7', locale: 'en-US' } })
    const q = await a.quote({ leg: guestLeg, amountIn: usd('100.75'), deliverTo: { address: DEST } }, ctx)
    expect(checkLegQuote(q)).toEqual([])
    expect(calls[0]!.url).toBe('https://api.cdp.coinbase.com/platform/v2/onramp/orders')
    expect(calls[0]!.body).toEqual({
      paymentCurrency: 'USD', purchaseCurrency: 'USDC', paymentMethod: 'GUEST_CHECKOUT_APPLE_PAY', destinationAddress: DEST, destinationNetwork: 'base',
      partnerUserRef: expect.stringMatching(/^sandbox-ork-[0-9a-f]{20}$/), paymentAmount: '100.75', isQuote: true, domain: 'app.example.com',
      clientIp: '203.0.113.7', locale: 'en-US',
    })
    expect(q).toMatchObject({
      legId: 'guest_apple_pay',
      input: usd('100.75'),
      output: { value: '100.000000', asset: { ...BASE_USDC, symbol: 'USDC', decimals: 6 } },
      limits: { min: '5', max: '2500', currency: 'USD' },
    })
    expect(q.fees).toEqual([
      { kind: 'provider', label: 'Coinbase fee', amount: '0.5', currency: 'USD' },
      { kind: 'network', label: 'Network fee', amount: '0.25', currency: 'USD' },
    ])
    // exact output
    await a.quote({ leg: guestLeg, amountOut: { value: '20', asset: BASE_USDC } }, ctx)
    expect(calls[1]!.body).toMatchObject({ purchaseAmount: '20', isQuote: true })
    expect((calls[1]!.body as Record<string, unknown>).paymentAmount).toBeUndefined()
  })

  it('quote: standard mode sends the contact that the app verified', async () => {
    const secret = await ed25519Secret()
    const { fetch, calls } = fakeFetch([{ method: 'POST', match: '/onramp/orders', reply: () => ({ order: ORDER }) }])
    const contact = { email: 'a@b.test', phoneNumber: '+12345678901', agreementAcceptedAt: '2026-10-01T00:00:00Z', phoneNumberVerifiedAt: '2026-10-01T00:00:00Z' }
    const a = coinbase({ apiKeyId: 'k', apiKeySecret: secret, guestCheckout: { domain: 'app.example.com', verifiedContact: async () => contact } })
    await a.quote({ leg: guestLeg, amountIn: usd('10') }, makeCtx({ fetch, session: { locale: 'not a locale!' } }))
    expect(calls[0]!.body).toMatchObject(contact)
    expect((calls[0]!.body as Record<string, unknown>).locale).toBeUndefined()
  })

  it('quote: USD only; guest errors map to user-facing codes; other errors as usual', async () => {
    const secret = await ed25519Secret()
    const a = coinbase({ apiKeyId: 'k', apiKeySecret: secret, guestCheckout: GUEST })
    const eur = { value: '10', asset: { kind: 'fiat' as const, currency: 'EUR' } }
    await expect(a.quote({ leg: guestLeg, amountIn: eur }, makeCtx({ fetch: fakeFetch([]).fetch }))).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
    const q = (status: number, body: unknown) => a.quote({ leg: guestLeg, amountIn: usd('10') }, makeCtx({ fetch: fakeFetch([{ method: 'POST', match: '/onramp/orders', status, reply: () => body }]).fetch }))
    await expect(q(429, { errorType: 'guest_transaction_limit', errorMessage: 'weekly' })).rejects.toMatchObject({ status: 422, error: { code: 'AMOUNT_TOO_HIGH' } })
    await expect(q(429, { errorType: 'guest_transaction_count', errorMessage: 'count' })).rejects.toMatchObject({ error: { code: 'PROVIDER_DECLINED' } })
    await expect(q(400, { errorType: 'guest_region_forbidden', errorMessage: 'region' })).rejects.toMatchObject({ error: { code: 'REGION_UNSUPPORTED' } })
    await expect(q(400, { errorType: 'guest_permission_denied', errorMessage: 'no' })).rejects.toMatchObject({ error: { code: 'PROVIDER_DECLINED' } })
    await expect(q(429, { errorType: 'rate_limit_exceeded', errorMessage: 'slow down' })).rejects.toMatchObject({ status: 429, error: { code: 'RATE_LIMITED' } })
    await expect(q(400, { errorType: 'network_not_tradable', errorMessage: 'Not on this network' })).rejects.toMatchObject({ error: { code: 'NO_QUOTES', message: 'Coinbase: Not on this network' } })
    await expect(q(401, 'nope')).rejects.toMatchObject({ status: 502, error: { code: 'PROVIDER_UNAVAILABLE' } })
    await expect(q(201, {})).rejects.toMatchObject({ status: 422, error: { code: 'NO_QUOTES' } })
  })

  it('start: creates the order, returns an IFRAME with the Coinbase post message events, saves and reuses userAuthToken', async () => {
    const secret = await ed25519Secret()
    let n = 0
    const { fetch, calls } = fakeFetch([
      {
        method: 'POST',
        match: '/onramp/orders',
        // A quote (isQuote) has no paymentLink and no userAuthToken
        reply: (c) =>
          (c.body as { isQuote: boolean }).isQuote
            ? { order: ORDER }
            : { order: ORDER, paymentLink: { url: PAY_URL, paymentLinkType: 'PAYMENT_LINK_TYPE_EMBEDDED_ORDER' }, userAuthToken: `uat-${++n}` },
      },
    ])
    const a = coinbase({ apiKeyId: 'k', apiKeySecret: secret, guestCheckout: GUEST })
    const shared = memoryKV()
    const ctx = makeCtx({ fetch, shared })
    const q = await a.quote({ leg: guestLeg, amountIn: usd('100.75') }, ctx)
    const step = await a.start({ leg: guestLeg, quote: q }, ctx)
    expect(checkLegStep(step)).toEqual([])
    const body = calls[1]!.body as Record<string, unknown>
    expect(body).toMatchObject({ isQuote: false, paymentAmount: '100.75', destinationNetwork: 'base', domain: 'app.example.com' })
    expect(body.userAuthToken).toBeUndefined()
    expect(step.ref).toBe(body.partnerUserRef)
    expect(step).toMatchObject({ state: 'PAYMENT', status: 'requires_action', transitions: [{ kind: 'AWAIT' }] })
    expect(step.surface).toEqual({
      kind: 'IFRAME',
      url: `${PAY_URL}&useApplePaySandbox=true`,
      origin: 'https://pay.coinbase.com',
      allow: 'payment',
      referrerPolicy: 'no-referrer',
      height: 600,
      provider: 'Coinbase',
      messages: {
        typeField: 'eventName',
        completed: ['onramp_api.commit_success', 'onramp_api.polling_success'],
        failed: ['onramp_api.commit_error', 'onramp_api.polling_error', 'onramp_api.session_error'],
        closed: ['onramp_api.cancel'],
      },
    } satisfies Surface)
    // the next order of the same user and wallet passes the saved token
    await a.start({ leg: guestLeg, quote: q }, ctx)
    expect((calls[2]!.body as Record<string, unknown>).userAuthToken).toBe('uat-1')
    // another user does not get it
    await a.start({ leg: guestLeg, quote: q }, makeCtx({ fetch, shared, session: { userId: 'user_2' } }))
    expect((calls[3]!.body as Record<string, unknown>).userAuthToken).toBeUndefined()
  })

  it('start: live orders keep the link as is; no link is an error; guest errors are mapped', async () => {
    const secret = await ed25519Secret()
    const a = coinbase({ apiKeyId: 'k', apiKeySecret: secret, guestCheckout: GUEST })
    const quote = { adapterId: 'coinbase', legId: 'guest_apple_pay', input: usd('10'), output: { value: '9.8', asset: BASE_USDC }, fees: [], eta: { min: 1, max: 2 } }
    const live = fakeFetch([{ method: 'POST', match: '/onramp/orders', reply: () => ({ order: ORDER, paymentLink: { url: PAY_URL } }) }])
    const step = await a.start({ leg: guestLeg, quote }, makeCtx({ fetch: live.fetch, session: { livemode: true } }))
    expect(step.surface).toMatchObject({ kind: 'IFRAME', url: PAY_URL })
    expect(step.ref).toMatch(/^ork-/)
    const noLink = fakeFetch([{ method: 'POST', match: '/onramp/orders', reply: () => ({ order: ORDER }) }])
    await expect(a.start({ leg: guestLeg, quote }, makeCtx({ fetch: noLink.fetch }))).rejects.toMatchObject({ status: 502, error: { message: 'Coinbase did not return a payment link.' } })
    const limit = fakeFetch([{ method: 'POST', match: '/onramp/orders', status: 429, reply: () => ({ errorType: 'guest_transaction_limit', errorMessage: 'x' }) }])
    await expect(a.start({ leg: guestLeg, quote }, makeCtx({ fetch: limit.fetch }))).rejects.toMatchObject({ error: { code: 'AMOUNT_TOO_HIGH' } })
  })

  it('status: Get Onramp Order by the order id saved at start', async () => {
    const secret = await ed25519Secret()
    let order: Record<string, unknown> = ORDER
    const { fetch, calls } = fakeFetch([
      { method: 'POST', match: '/onramp/orders', reply: () => ({ order: ORDER, paymentLink: { url: PAY_URL } }) },
      { method: 'GET', match: `/platform/v2/onramp/orders/${ORDER.orderId}`, reply: () => ({ order }) },
    ])
    const a = coinbase({ apiKeyId: 'k', apiKeySecret: secret, guestCheckout: GUEST })
    const ctx = makeCtx({ fetch })
    const q = await a.quote({ leg: guestLeg, amountIn: usd('100.75') }, ctx)
    const { ref } = await a.start({ leg: guestLeg, quote: q }, ctx)
    const st = () => a.status!({ leg: guestLeg, ref: ref! }, ctx)
    expect(await st()).toMatchObject({ state: 'PAYMENT', status: 'requires_action' })
    expect(calls[2]!.url).toBe(`https://api.cdp.coinbase.com/platform/v2/onramp/orders/${ORDER.orderId}`)
    order = { ...ORDER, status: 'ONRAMP_ORDER_STATUS_PENDING_VERIFICATION' }
    expect(await st()).toMatchObject({ state: 'PAYMENT', status: 'requires_action' })
    order = { ...ORDER, status: 'ONRAMP_ORDER_STATUS_PROCESSING' }
    expect(await st()).toMatchObject({ state: 'PROCESSING', status: 'processing' })
    order = { ...ORDER, status: 'ONRAMP_ORDER_STATUS_COMPLETED', txHash: '0xabc' }
    const done = await st()
    expect(checkLegStep(done)).toEqual([])
    expect(done).toMatchObject({ state: 'COMPLETED', status: 'succeeded', txHash: '0xabc', output: { value: '100.000000', asset: { chain: 'eip155:8453' } } })
    order = { ...ORDER, status: 'ONRAMP_ORDER_STATUS_FAILED' }
    expect(await st()).toMatchObject({ state: 'FAILED', status: 'failed', error: { code: 'PAYMENT_FAILED' } })

    const failing = fakeFetch([{ method: 'GET', match: '/onramp/orders/', status: 503, reply: () => ({}) }])
    const store = memoryKV()
    await store.put('order:ork-x', ORDER.orderId)
    await expect(a.status!({ leg: guestLeg, ref: 'ork-x' }, makeCtx({ fetch: failing.fetch, store }))).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    const empty = fakeFetch([{ method: 'GET', match: '/onramp/orders/', reply: () => ({}) }])
    expect(await a.status!({ leg: guestLeg, ref: 'ork-x' }, makeCtx({ fetch: empty.fetch, store }))).toMatchObject({ state: 'PAYMENT' })
  })

  it('webhook: headless order events (docs sample) map by partnerUserRef', async () => {
    const a = coinbase({ apiKeyId: 'k', apiKeySecret: 'x', webhookSecret: 'whsec', guestCheckout: GUEST })
    const ctx = makeWebhookCtx()
    const success = { ...ORDER, eventType: 'onramp.transaction.success', status: 'ONRAMP_ORDER_STATUS_COMPLETED', txHash: '0xfeed', partnerUserRef: 'ork-9' }
    expect(await a.webhook!.parse(JSON.stringify(success), ctx)).toEqual([
      { ref: 'ork-9', status: 'succeeded', txHash: '0xfeed', output: { value: '100.000000', asset: { ...BASE_USDC, symbol: 'USDC', decimals: 6 } } },
    ])
    const created = { ...ORDER, eventType: 'onramp.transaction.created', partnerUserRef: 'ork-9' }
    expect(await a.webhook!.parse(JSON.stringify(created), ctx)).toEqual([{ ref: 'ork-9', status: 'requires_action' }])
    const updated = { ...ORDER, eventType: 'onramp.transaction.updated', status: 'ONRAMP_ORDER_STATUS_PROCESSING', partnerUserRef: 'ork-9' }
    expect(await a.webhook!.parse(JSON.stringify(updated), ctx)).toEqual([{ ref: 'ork-9', status: 'processing' }])
  })
})

const hook0 = (secret: string, body: string, t = Math.floor(Date.now() / 1000)) => `t=${t},v0=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`
const hookReq = (body: string, header?: string) => new Request('https://x/webhooks/coinbase', { method: 'POST', body, headers: header ? { 'x-hook0-signature': header } : {} })

describe('coinbase guest and account conformance', () => {
  it('guest_apple_pay and coinbase_account pass runAdapterConformance', async () => {
    const secret = await ed25519Secret()
    const { fetch } = fakeFetch([
      { method: 'POST', match: '/platform/v2/onramp/orders', reply: (c) => ((c.body as { isQuote: boolean }).isQuote ? { order: ORDER } : { order: ORDER, paymentLink: { url: PAY_URL } }) },
      { method: 'GET', match: '/platform/v2/onramp/orders/', reply: () => ({ order: { ...ORDER, status: 'ONRAMP_ORDER_STATUS_PROCESSING' } }) },
      { method: 'POST', match: '/platform/v2/onramp/sessions', reply: () => SESSION_RES },
      { method: 'GET', match: '/onramp/v1/buy/user/', reply: () => ({ transactions: [] }) },
    ])
    const body = JSON.stringify({ ...ORDER, eventType: 'onramp.transaction.success', status: 'ONRAMP_ORDER_STATUS_COMPLETED', partnerUserRef: 'ork-1' })
    const report = await runAdapterConformance(coinbase({ apiKeyId: 'k', apiKeySecret: secret, webhookSecret: 'whsec', guestCheckout: GUEST }), {
      fetch,
      fixtures: [
        { leg: guestLeg, quote: { amountIn: usd('100.75') }, expect: { start: 'PAYMENT', status: 'PROCESSING' } },
        { leg: accountLeg, quote: { amountIn: usd('50') }, expect: { start: 'PAYMENT', status: 'PAYMENT' } },
      ],
      webhooks: [
        { name: 'order signed', rawBody: body, request: () => hookReq(body, hook0('whsec', body)), events: 1 },
        { name: 'order bad signature', rawBody: body, request: () => hookReq(body, hook0('other', body)), valid: false },
      ],
    })
    expect(report.problems).toEqual([])
  })
})
