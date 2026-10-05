import { describe, expect, it } from 'vitest'
import { checkAdapterShape, checkLegQuote, checkLegStep, hmacSha256 } from '@openrampkit/adapter'
import { fakeFetch, makeCtx, makeWebhookCtx, memoryKV, runAdapterConformance } from '@openrampkit/adapter/testing'
import type { FakeRoute } from '@openrampkit/adapter/testing'
import { createOpenRamp } from '@openrampkit/server'
import { SOLANA_MAINNET, USDC } from '@openrampkit/core'
import type { Destination, LegQuote, PathwayLeg, PlanResult, PublicSession, Quote } from '@openrampkit/core'
import { KOTANI_ASSETS, KOTANI_CHANNELS, KOTANI_SANDBOX_API, kotani, offrampEvent, onrampEvent } from './index.js'

const API = 'https://api.kotanipay.io'
const WALLET = '0x000000000000000000000000000000000000beef'
const ESCROW = '0x9999999999999999999999999999999999999999'
const BASE_USDC = USDC['eip155:8453']!
const DEST: Destination = { type: 'crypto', chain: 'eip155:8453', token: BASE_USDC, address: WALLET }
const SECRET = 'whsec_kotani_test'

const ok = <T>(data: T) => ({ success: true, message: 'ok', data })

function depositLeg(legId: string, currency: string, chain = 'eip155:8453', token = BASE_USDC): PathwayLeg {
  return {
    adapterId: 'kotani', legId, method: legId.split('-').slice(1).join('_'),
    from: { asset: { kind: 'fiat', currency }, location: { kind: 'user_account' } },
    to: { asset: { kind: 'crypto', chain, token }, location: { kind: 'address', address: WALLET } },
  }
}

function sellLeg(legId: string, currency: string, chain = 'eip155:8453', token = BASE_USDC): PathwayLeg {
  return {
    adapterId: 'kotani', legId,
    from: { asset: { kind: 'crypto', chain, token }, location: { kind: 'user_wallet' } },
    to: { asset: { kind: 'fiat', currency }, location: { kind: 'user_account' } },
  }
}

const fiatIn = (amount: string, currency: string) => ({ amount, asset: { kind: 'fiat' as const, currency } })

/** A signed webhook: the signature covers JSON.stringify of the body without its `signature` field. */
async function signed(body: { event: string; data: Record<string, unknown> }, secret = SECRET) {
  const sig = `sha256=${await hmacSha256(secret, JSON.stringify(body), 'hex')}`
  return { raw: JSON.stringify({ ...body, signature: sig }), sig }
}

const hookReq = (sig?: string) => new Request('https://app.test/api/openramp/webhooks/kotani', { method: 'POST', headers: sig ? { 'x-kotani-signature': sig } : {} })

const onrampStatus = (over: Record<string, unknown> = {}) => ({
  referenceId: 'r', depositStatus: 'SUCCESSFUL', onchainStatus: 'SUCCESSFUL', transactionHash: '0xabc', rate: {}, fiatAmount: 1000, fiatFee: 25, fiatAmountToSend: 1025, cryptoAmount: 7.65, ...over,
})

describe('kotani adapter: legs', () => {
  const a = kotani({ apiKey: 'k', webhookSecret: SECRET })

  it('declares one deposit leg per corridor and a sell leg per mobile money corridor, and passes the shape check', () => {
    expect(checkAdapterShape(a)).toEqual([])
    const ids = a.legs.map((l) => l.id)
    expect(ids).toEqual(expect.arrayContaining(['ke-mpesa', 'ke-mobile-money', 'gh-mobile-money', 'ug-mobile-money', 'tz-mobile-money', 'za-bank-transfer', 'ng-bank-transfer', 'sell-ke-mpesa', 'sell-gh-mobile-money']))
    expect(ids).not.toContain('sell-za-bank-transfer')
    expect(a.legs.find((l) => l.id === 'ke-mpesa')).toMatchObject({
      kind: 'fiat_onramp', methods: ['mpesa'], regions: { allow: ['KE'] }, surfaces: ['FORM'], limits: { max: '250000', currency: 'KES' },
      from: { asset: { kind: 'fiat', currencies: ['KES'] } },
    })
    expect(a.legs.find((l) => l.id === 'za-bank-transfer')!.surfaces).toEqual(['FORM', 'REDIRECT'])
    const to = a.legs.find((l) => l.id === 'gh-mobile-money')!.to.asset as { chains: Record<string, string[]> }
    expect(to.chains['eip155:8453']).toEqual([BASE_USDC])
    expect(to.chains['eip155:137']).toHaveLength(2)
    expect(to.chains[SOLANA_MAINNET]).toEqual([USDC[SOLANA_MAINNET], 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'])
    expect(a.legs.find((l) => l.id === 'sell-ke-mpesa')).toMatchObject({ kind: 'crypto_offramp', surfaces: ['FORM', 'WALLET_TX'], from: { location: ['user_wallet', 'address'] }, to: { asset: { currencies: ['KES'] } } })
    expect(new Set(KOTANI_CHANNELS.map((c) => `${c.country}-${c.method}`)).size).toBe(KOTANI_CHANNELS.length)
  })

  it('options narrow countries, methods and withdraw legs', () => {
    expect(kotani({ apiKey: 'k', countries: ['ke'] }).legs.map((l) => l.id)).toEqual(['ke-mpesa', 'ke-mobile-money', 'sell-ke-mpesa', 'sell-ke-mobile-money'])
    expect(kotani({ apiKey: 'k', methods: ['mpesa'], offramp: false }).legs.map((l) => l.id)).toEqual(['ke-mpesa'])
    const onlyBase = kotani({ apiKey: 'k', countries: ['GH'], assets: [KOTANI_ASSETS[0]!] })
    expect((onlyBase.legs[0]!.to.asset as { chains: Record<string, string[]> }).chains).toEqual({ 'eip155:8453': [BASE_USDC] })
  })
})

describe('kotani adapter: quotes', () => {
  it('deposit: adds the fee on top, so it asks again for amount minus fee; the user pays the amount', async () => {
    const { fetch, calls } = fakeFetch([
      { method: 'POST', match: '/api/v3/rate/onramp', reply: (c) => {
        const amt = (c.body as { fiatAmount: number }).fiatAmount
        return ok({ from: 'KES', to: 'USDC', value: '0.00765', id: `rate-${amt}`, fiatAmount: amt, cryptoAmount: Math.round(amt * 0.00765 * 1e6) / 1e6, transactionAmount: amt + 25, fee: 25 })
      } },
    ])
    const a = kotani({ apiKey: 'key_1', webhookSecret: SECRET })
    const q = await a.quote({ leg: depositLeg('ke-mpesa', 'KES'), amountIn: fiatIn('1000', 'KES') }, makeCtx({ fetch, destination: DEST, session: { country: 'KE' } }))
    expect(checkLegQuote(q)).toEqual([])
    expect(calls.map((c) => c.body)).toEqual([{ from: 'KES', to: 'USDC', fiatAmount: 1000 }, { from: 'KES', to: 'USDC', fiatAmount: 975 }])
    expect(calls[0]!.url).toBe(`${API}/api/v3/rate/onramp`)
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer key_1')
    expect(calls[0]!.headers.get('x-signature')).toBeNull()
    expect(q).toMatchObject({
      adapterId: 'kotani', legId: 'ke-mpesa',
      input: { amount: '1000', asset: { kind: 'fiat', currency: 'KES' } },
      output: { amount: '7.45875', asset: { kind: 'crypto', chain: 'eip155:8453', token: BASE_USDC, symbol: 'USDC', decimals: 6 } },
      fees: [{ kind: 'provider', label: 'Kotani Pay fee', amount: '25', currency: 'KES' }],
      limits: { max: '250000', currency: 'KES' },
      data: { fiatAmount: '975', rateId: 'rate-975' },
    })
  })

  it('deposit: with feeBearer integrator, one call and no fee for the user; exact output asks with source crypto', async () => {
    const { fetch, calls } = fakeFetch([{ method: 'POST', match: '/rate/onramp', reply: () => ok({ id: 'r1', fiatAmount: 1307.19, cryptoAmount: 10, fee: 30 }) }])
    const a = kotani({ apiKey: 'k', feeBearer: 'integrator' })
    const ctx = makeCtx({ fetch, destination: DEST })
    const q = await a.quote({ leg: depositLeg('gh-mobile-money', 'GHS'), amountIn: fiatIn('1307.19', 'GHS') }, ctx)
    expect(calls).toHaveLength(1)
    expect(q.input.amount).toBe('1307.19')
    expect(q.fees).toEqual([])
    const c2 = kotani({ apiKey: 'k' })
    const q2 = await c2.quote({ leg: depositLeg('gh-mobile-money', 'GHS'), amountOut: { amount: '10', asset: { kind: 'crypto', chain: 'eip155:8453', token: BASE_USDC } } }, ctx)
    expect(calls[1]!.body).toEqual({ from: 'GHS', to: 'USDC', fiatAmount: 10, source: 'crypto' })
    expect(q2.input.amount).toBe('1337.19')
    expect(q2.output.amount).toBe('10')
  })

  it('deposit: limits, unknown legs, unsupported tokens and provider errors', async () => {
    const { fetch } = fakeFetch([{ match: '/rate/onramp', reply: () => ok({ fiatAmount: 1, cryptoAmount: 0, fee: 5 }) }])
    const a = kotani({ apiKey: 'k' })
    const ctx = makeCtx({ fetch, destination: DEST })
    await expect(a.quote({ leg: depositLeg('ke-mpesa', 'KES'), amountIn: fiatIn('300000', 'KES') }, ctx)).rejects.toMatchObject({ error: { code: 'AMOUNT_TOO_HIGH' } })
    await expect(a.quote({ leg: depositLeg('ke-mpesa', 'KES'), amountIn: fiatIn('0', 'KES') }, ctx)).rejects.toMatchObject({ error: { code: 'AMOUNT_TOO_LOW' } })
    await expect(a.quote({ leg: depositLeg('ke-mpesa', 'KES'), amountIn: fiatIn('3', 'KES') }, ctx)).rejects.toMatchObject({ error: { code: 'AMOUNT_TOO_LOW', message: /fee/ } })
    await expect(a.quote({ leg: depositLeg('xx-nope', 'KES'), amountIn: fiatIn('10', 'KES') }, ctx)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
    await expect(a.quote({ leg: depositLeg('ke-mpesa', 'KES', 'eip155:42161', USDC['eip155:42161']!), amountIn: fiatIn('10', 'KES') }, ctx)).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
    const sellOff = kotani({ apiKey: 'k', offramp: false })
    await expect(sellOff.quote({ leg: sellLeg('sell-ke-mpesa', 'KES'), amountIn: { amount: '5', asset: { kind: 'crypto', chain: 'eip155:8453', token: BASE_USDC } } }, ctx)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })

    const cases: Array<[FakeRoute, string]> = [
      [{ match: '/rate/onramp', status: 400, reply: () => ({ success: false, message: 'Amount below minimum', error_code: 400, data: {} }) }, 'NO_QUOTES'],
      [{ match: '/rate/onramp', reply: () => ({ success: false, message: 'Corridor not enabled', data: {} }) }, 'NO_QUOTES'],
      [{ match: '/rate/onramp', status: 429, reply: () => ({ success: false, data: { retryAfter: 60 } }) }, 'RATE_LIMITED'],
      [{ match: '/rate/onramp', status: 500, reply: () => ({}) }, 'PROVIDER_UNAVAILABLE'],
      [{ match: '/rate/onramp', status: 401, reply: () => ({ success: false, message: 'Invalid API Key' }) }, 'PROVIDER_UNAVAILABLE'],
    ]
    for (const [route, code] of cases) {
      const f = fakeFetch([route]).fetch
      await expect(a.quote({ leg: depositLeg('gh-mobile-money', 'GHS'), amountIn: fiatIn('100', 'GHS') }, makeCtx({ fetch: f, destination: DEST }))).rejects.toMatchObject({ error: { code } })
    }
    const msg = fakeFetch([cases[0]![0]]).fetch
    await expect(a.quote({ leg: depositLeg('gh-mobile-money', 'GHS'), amountIn: fiatIn('100', 'GHS') }, makeCtx({ fetch: msg, destination: DEST }))).rejects.toMatchObject({ error: { message: 'Kotani Pay: Amount below minimum' } })
  })

  it('withdraw: quotes the offramp rate; the output is what the recipient receives', async () => {
    const { fetch, calls } = fakeFetch([{ method: 'POST', match: '/api/v3/rate/offramp', reply: () => ok({ id: 'o1', fiatAmount: 1305, cryptoAmount: 10, transactionAmount: 1279, fee: 26 }) }])
    const a = kotani({ apiKey: 'k' })
    const ctx = makeCtx({ fetch, destination: { type: 'fiat', currency: 'KES' }, session: { direction: 'withdraw', country: 'KE' } })
    const q = await a.quote({ leg: sellLeg('sell-ke-mpesa', 'KES'), amountIn: { amount: '10', asset: { kind: 'crypto', chain: 'eip155:8453', token: BASE_USDC } } }, ctx)
    expect(checkLegQuote(q)).toEqual([])
    expect(calls[0]!.body).toEqual({ from: 'USDC', to: 'KES', cryptoAmount: 10 })
    expect(q).toMatchObject({ input: { amount: '10', asset: { symbol: 'USDC' } }, output: { amount: '1279', asset: { kind: 'fiat', currency: 'KES' } }, fees: [{ amount: '26', currency: 'KES' }] })
    const q2 = await a.quote({ leg: sellLeg('sell-ke-mpesa', 'KES'), amountOut: fiatIn('1279', 'KES') }, ctx)
    expect(calls[1]!.body).toEqual({ from: 'USDC', to: 'KES', cryptoAmount: 1279, source: 'fiat' })
    expect(q2.input.amount).toBe('10')
    await expect(a.quote({ leg: sellLeg('sell-ke-mpesa', 'KES', 'eip155:10', USDC['eip155:10']!), amountIn: { amount: '1', asset: { kind: 'crypto', chain: 'eip155:10', token: USDC['eip155:10']! } } }, ctx)).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
  })
})

describe('kotani adapter: deposit flow', () => {
  const quoteFor = (legId: string, currency: string, fiatAmount: string, pays: string, chain = 'eip155:8453', token = BASE_USDC, symbol = 'USDC'): LegQuote => ({
    adapterId: 'kotani', legId,
    input: { amount: pays, asset: { kind: 'fiat', currency } },
    output: { amount: '7', asset: { kind: 'crypto', chain, token, symbol, decimals: 6 } },
    fees: [], eta: { min: 1, max: 2 }, data: { fiatAmount },
  })

  it('M-Pesa: FORM without a network choice, then the STK push; a second submit sends nothing', async () => {
    const { fetch, calls } = fakeFetch([{ method: 'POST', match: '/api/v3/onramp', reply: () => ok({ id: 'x', referenceId: 'r', referenceNumber: 1, message: 'ok', customerKey: 'c' }) }])
    const a = kotani({ apiKey: 'k' })
    const ctx = makeCtx({ fetch, destination: DEST, session: { id: 'ors_1', country: 'KE' } })
    const leg = depositLeg('ke-mpesa', 'KES')
    const step = await a.start({ leg, quote: quoteFor('ke-mpesa', 'KES', '975', '1000') }, ctx)
    expect(checkLegStep(step)).toEqual([])
    expect(step).toMatchObject({
      state: 'PAYMENT', status: 'awaiting_user', sub: 'PAYMENT_DETAILS',
      surface: { kind: 'FORM', fields: [{ id: 'account_name', type: 'text' }, { id: 'phone', type: 'tel', label: 'M-Pesa phone number' }] },
      transitions: [{ name: 'submit_details', kind: 'SUBMIT', label: 'Send payment request' }],
    })
    expect(step.ref).toMatch(/^ors_1-[0-9a-f]{12}$/)
    const ref = step.ref!
    // A status check before the form is sent shows the form again and calls nothing.
    expect((await a.status!({ leg, ref }, ctx)).surface?.kind).toBe('FORM')
    expect(calls).toHaveLength(0)

    const tr = (inputs: Record<string, unknown>) => a.transition!({ leg, ref, name: 'submit_details', inputs }, ctx)
    await expect(tr({ phone: '0712345678' })).rejects.toMatchObject({ error: { code: 'BAD_REQUEST', message: 'Enter the name on the mobile money account.' } })
    await expect(tr({ account_name: 'Jane', phone: 'call me' })).rejects.toMatchObject({ error: { message: 'Enter a valid phone number.' } })
    await expect(a.transition!({ leg, ref, name: 'submit_tx', inputs: {} }, ctx)).rejects.toMatchObject({ status: 409 })
    await expect(a.transition!({ leg, ref, name: 'nope' }, ctx)).rejects.toMatchObject({ status: 409 })
    await expect(a.transition!({ leg, ref: 'missing', name: 'submit_details' }, ctx)).rejects.toMatchObject({ status: 404 })

    const sent = await tr({ account_name: 'Jane Doe', phone: '0712 345 678' })
    expect(checkLegStep(sent)).toEqual([])
    expect(sent).toMatchObject({ state: 'PAYMENT', sub: 'CONFIRM_ON_YOUR_PHONE', status: 'awaiting_user', ref, transitions: [{ kind: 'AWAIT' }] })
    expect(sent.surface).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${API}/api/v3/onramp`)
    expect(calls[0]!.body).toEqual({
      mobileMoney: { phoneNumber: '+254712345678', accountName: 'Jane Doe', providerNetwork: 'MPESA' },
      fiatAmount: 975, currency: 'KES', chain: 'BASE', token: 'USDC', receiverAddress: WALLET, referenceId: ref,
      callbackUrl: 'https://app.test/api/openramp/webhooks/test',
    })
    expect((await tr({ account_name: 'Jane Doe', phone: '0712345678' })).sub).toBe('CONFIRM_ON_YOUR_PHONE')
    expect(calls).toHaveLength(1)
  })

  it('Ghana: asks for the network; checks it; phone numbers in local and international form', async () => {
    const { fetch, calls } = fakeFetch([{ method: 'POST', match: '/api/v3/onramp', reply: () => ok({ id: 'x' }) }])
    const a = kotani({ apiKey: 'k' })
    const ctx = makeCtx({ fetch, destination: { type: 'crypto', chain: 'eip155:137', token: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', address: WALLET }, session: { country: 'GH' } })
    const leg = depositLeg('gh-mobile-money', 'GHS', 'eip155:137', '0xc2132d05d31c914a87c6611c10748aeb04b58e8f')
    const step = await a.start({ leg, quote: quoteFor('gh-mobile-money', 'GHS', '100', '102', 'eip155:137', '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', 'USDT') }, ctx)
    const fields = (step.surface as { fields: Array<{ id: string; options?: Array<{ value: string; label: string }> }> }).fields
    expect(fields.map((f) => f.id)).toEqual(['account_name', 'phone', 'network'])
    expect(fields[2]!.options).toEqual([{ value: 'MTN', label: 'MTN MoMo' }, { value: 'VODAFONE', label: 'Telecel Cash (Vodafone)' }, { value: 'AIRTEL', label: 'Airtel Money' }])
    await expect(a.transition!({ leg, ref: step.ref!, name: 'submit_details', inputs: { account_name: 'Kofi', phone: '0241234567', network: 'ORANGE' } }, ctx)).rejects.toMatchObject({ error: { message: 'Choose a mobile money network.' } })
    await a.transition!({ leg, ref: step.ref!, name: 'submit_details', inputs: { account_name: 'Kofi', phone: '233241234567', network: 'mtn' } }, ctx)
    expect(calls[0]!.body).toMatchObject({ mobileMoney: { phoneNumber: '+233241234567', providerNetwork: 'MTN' }, chain: 'POLYGON', token: 'USDT', currency: 'GHS', fiatAmount: 100 })
  })

  it('South Africa bank checkout: FORM, then a REDIRECT to the bank page; no redirectUrl fails clearly', async () => {
    const { fetch, calls } = fakeFetch([{ method: 'POST', match: '/api/v3/onramp', reply: () => ok({ id: 'x', redirectUrl: 'https://checkout.kotanipay.test/pay/1' }) }])
    const a = kotani({ apiKey: 'k' })
    const ctx = makeCtx({ fetch, destination: DEST, session: { country: 'ZA' } })
    const leg = depositLeg('za-bank-transfer', 'ZAR')
    const step = await a.start({ leg, quote: quoteFor('za-bank-transfer', 'ZAR', '500', '510') }, ctx)
    expect((step.surface as { fields: Array<{ id: string }> }).fields.map((f) => f.id)).toEqual(['full_name', 'phone'])
    expect(step.transitions[0]).toMatchObject({ label: 'Continue to your bank' })
    const sent = await a.transition!({ leg, ref: step.ref!, name: 'submit_details', inputs: { full_name: 'Thabo M', phone: '+27 82 123 4567' } }, ctx)
    expect(sent).toMatchObject({ state: 'PAYMENT', surface: { kind: 'REDIRECT', url: 'https://checkout.kotanipay.test/pay/1', popup: true, provider: 'Kotani Pay' } })
    expect(calls[0]!.body).toMatchObject({ bankCheckout: { fullName: 'Thabo M', phoneNumber: '+27821234567', paymentMethod: 'PAYBYBANK' }, currency: 'ZAR' })
    expect(calls[0]!.body).not.toHaveProperty('mobileMoney')
    // While the bank payment is pending, a status check keeps the bank page.
    const poll = fakeFetch([{ match: /\/api\/v3\/onramp\/.+$/, reply: () => ok(onrampStatus({ depositStatus: 'PENDING', onchainStatus: 'PENDING' })) }])
    const s = await a.status!({ leg, ref: step.ref! }, { ...ctx, fetch: poll.fetch })
    expect(s.surface).toMatchObject({ kind: 'REDIRECT' })

    const none = fakeFetch([{ method: 'POST', match: '/api/v3/onramp', reply: () => ok({ id: 'x' }) }])
    const ctx2 = makeCtx({ fetch: none.fetch, destination: DEST, session: { country: 'ZA' } })
    const step2 = await a.start({ leg, quote: quoteFor('za-bank-transfer', 'ZAR', '500', '510') }, ctx2)
    await expect(a.transition!({ leg, ref: step2.ref!, name: 'submit_details', inputs: { full_name: 'T', phone: '0821234567' } }, ctx2)).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
  })

  it('maps create errors: 4xx gives PROVIDER_DECLINED with the message; 429; 5xx', async () => {
    const a = kotani({ apiKey: 'k' })
    for (const [status, code] of [[400, 'PROVIDER_DECLINED'], [403, 'PROVIDER_UNAVAILABLE'], [429, 'RATE_LIMITED'], [502, 'PROVIDER_UNAVAILABLE']] as const) {
      const { fetch } = fakeFetch([{ method: 'POST', match: '/api/v3/onramp', status, reply: () => ({ success: false, message: 'Invalid phone number for network', error_code: status }) }])
      const ctx = makeCtx({ fetch, destination: DEST, session: { country: 'KE' } })
      const leg = depositLeg('ke-mpesa', 'KES')
      const step = await a.start({ leg, quote: quoteFor('ke-mpesa', 'KES', '100', '100') }, ctx)
      const p = a.transition!({ leg, ref: step.ref!, name: 'submit_details', inputs: { account_name: 'J', phone: '0712345678' } }, ctx)
      await expect(p).rejects.toMatchObject({ error: { code } })
      if (status === 400) await expect(p).rejects.toMatchObject({ error: { message: 'Kotani Pay: Invalid phone number for network' } })
    }
  })

  it('start needs a delivery address and a known asset', async () => {
    const a = kotani({ apiKey: 'k' })
    const ctx = makeCtx({ fetch: fakeFetch([]).fetch, destination: { type: 'merchant', currency: 'KES' } })
    await expect(a.start({ leg: depositLeg('ke-mpesa', 'KES'), quote: quoteFor('ke-mpesa', 'KES', '1', '1') }, ctx)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
    const step = await a.start({ leg: depositLeg('ke-mpesa', 'KES'), quote: quoteFor('ke-mpesa', 'KES', '1', '1'), deliverTo: { address: WALLET } }, ctx)
    expect(step.surface?.kind).toBe('FORM')
  })

  it('maps every onramp status pair', async () => {
    const cases: Array<[string, string, string, string]> = [
      ['PENDING', 'PENDING', 'PAYMENT', 'awaiting_user'],
      ['INITIATED', 'PENDING', 'PAYMENT', 'awaiting_user'],
      ['IN_PROGRESS', 'PENDING', 'PAYMENT', 'awaiting_user'],
      ['SUCCESSFUL', 'PENDING', 'PROCESSING', 'processing'],
      ['SUCCESSFUL', 'IN_PROGRESS', 'PROCESSING', 'processing'],
      ['SUCCESS', 'SUCCESS', 'COMPLETED', 'succeeded'],
      ['SUCCESSFUL', 'SUCCESSFUL', 'COMPLETED', 'succeeded'],
      ['SUCCESSFUL', 'FAILED', 'FAILED', 'failed'],
      ['FAILED', 'CANCELLED', 'FAILED', 'failed'],
      ['DECLINED', 'PENDING', 'FAILED', 'failed'],
      ['CANCELLED', 'CANCELLED', 'FAILED', 'failed'],
      ['EXPIRED', 'CANCELLED', 'EXPIRED', 'expired'],
      ['REQUIRE_REVIEW', 'PENDING', 'PROCESSING', 'processing'],
      ['ERROR_OCCURRED', 'PENDING', 'PROCESSING', 'processing'],
    ]
    const a = kotani({ apiKey: 'k' })
    for (const [dep, chain, state, legStatus] of cases) {
      const { fetch, calls } = fakeFetch([{ match: '/api/v3/onramp/', reply: () => ok(onrampStatus({ depositStatus: dep, onchainStatus: chain, error: { message: 'Insufficient funds', code: 'X' } })) }])
      const ctx = makeCtx({ fetch, destination: DEST })
      // A status for an order this session no longer knows (e.g. after a store reset) still works.
      const s = await a.status!({ leg: depositLeg('ke-mpesa', 'KES'), ref: 'ref-1' }, ctx)
      expect([dep, chain, s.state, s.status]).toEqual([dep, chain, state, legStatus])
      expect(checkLegStep(s)).toEqual([])
      expect(calls[0]!.url).toBe(`${API}/api/v3/onramp/ref-1`)
    }
    expect(onrampEvent(onrampStatus({ referenceId: 'r1' }), { kind: 'crypto', chain: 'eip155:8453', token: BASE_USDC, decimals: 6 })).toMatchObject({ ref: 'r1', status: 'succeeded', txHash: '0xabc', output: { amount: '7.65' } })
    expect(onrampEvent(onrampStatus({ depositStatus: 'SUCCESSFUL', onchainStatus: 'FAILED' }))).toMatchObject({ status: 'failed', error: { code: 'DELIVERY_FAILED', recovery: 'contact_support' } })
    expect(onrampEvent(onrampStatus({ depositStatus: 'FAILED', onchainStatus: 'CANCELLED', error: { message: 'Insufficient funds' } }))).toMatchObject({ error: { code: 'PAYMENT_FAILED', message: 'The payment did not go through. (Insufficient funds)' } })
  })
})

describe('kotani adapter: withdraw flow', () => {
  const sellQuote = (chain = 'eip155:8453', token = BASE_USDC): LegQuote => ({
    adapterId: 'kotani', legId: 'sell-ke-mpesa',
    input: { amount: '10.5', asset: { kind: 'crypto', chain, token, symbol: 'USDC', decimals: 6 } },
    output: { amount: '1300', asset: { kind: 'fiat', currency: 'KES' } }, fees: [], eta: { min: 1, max: 2 },
  })

  it('payout account FORM, then the offramp order, then a USDC transfer to the escrow address, then PROCESSING', async () => {
    const { fetch, calls } = fakeFetch([
      { method: 'POST', match: '/api/v3/offramp', reply: () => ok({ referenceId: 'r', escrowAddress: ESCROW, status: 'PENDING', onchainStatus: 'PENDING' }) },
      { method: 'GET', match: '/api/v3/offramp/', reply: () => ok({ status: 'PENDING', onchainStatus: 'PENDING' }) },
    ])
    const a = kotani({ apiKey: 'k' })
    const ctx = makeCtx({ fetch, destination: { type: 'fiat', currency: 'KES' }, session: { direction: 'withdraw', country: 'KE' } })
    const leg = sellLeg('sell-ke-mpesa', 'KES')
    const step = await a.start({ leg, quote: sellQuote(), source: { chain: 'eip155:8453', token: BASE_USDC, address: WALLET } }, ctx)
    expect(step).toMatchObject({ sub: 'PAYOUT_ACCOUNT', surface: { kind: 'FORM' }, transitions: [{ name: 'submit_details', label: 'Continue' }] })
    const ref = step.ref!
    const pay = await a.transition!({ leg, ref, name: 'submit_details', inputs: { account_name: 'Jane', phone: '+254712345678' } }, ctx)
    expect(checkLegStep(pay)).toEqual([])
    expect(calls[0]!.body).toEqual({
      mobileMoneyReceiver: { phoneNumber: '+254712345678', accountName: 'Jane', networkProvider: 'MPESA' },
      cryptoAmount: 10.5, currency: 'KES', chain: 'BASE', token: 'USDC', referenceId: ref,
      callbackUrl: 'https://app.test/api/openramp/webhooks/test', senderAddress: WALLET, refund_config: { address: WALLET },
    })
    expect(pay).toMatchObject({ state: 'PAYMENT', sub: 'SEND_CRYPTO', surface: { kind: 'WALLET_TX', chain: 'eip155:8453', txs: [{ to: BASE_USDC, chainId: 8453, value: '0' }] } })
    const tx = (pay.surface as { txs: Array<{ data: string }> }).txs[0]!
    expect(tx.data.startsWith('0xa9059cbb')).toBe(true)
    expect(tx.data.slice(10, 74)).toBe(ESCROW.slice(2).padStart(64, '0'))
    expect(BigInt(`0x${tx.data.slice(-64)}`)).toBe(10_500_000n)
    // A status check before the transfer keeps the WALLET_TX step.
    expect((await a.status!({ leg, ref }, ctx)).surface?.kind).toBe('WALLET_TX')
    await expect(a.transition!({ leg, ref, name: 'submit_tx', inputs: {} }, ctx)).rejects.toMatchObject({ status: 400 })
    const sent = await a.transition!({ leg, ref, name: 'submit_tx', inputs: { txHash: `0x${'ab'.repeat(32)}` } }, ctx)
    expect(sent).toMatchObject({ state: 'PROCESSING', status: 'processing', txHash: `0x${'ab'.repeat(32)}` })
    expect((await a.status!({ leg, ref }, ctx)).state).toBe('PROCESSING')
  })

  it('Solana: a token transfer to the escrow; treasury custody sends no sender address; no escrow fails clearly', async () => {
    const sol = USDC[SOLANA_MAINNET]!
    const { fetch, calls } = fakeFetch([{ method: 'POST', match: '/api/v3/offramp', reply: () => ok({ escrowAddress: 'EscrowSo1anaAddress1111111111111111111111111' }) }])
    const a = kotani({ apiKey: 'k' })
    const ctx = makeCtx({ fetch, destination: { type: 'fiat', currency: 'KES' }, session: { direction: 'withdraw', country: 'KE' } })
    const leg = sellLeg('sell-ke-mpesa', 'KES', SOLANA_MAINNET, sol)
    const step = await a.start({ leg, quote: sellQuote(SOLANA_MAINNET, sol), source: { chain: SOLANA_MAINNET, token: sol, address: 'app' } }, ctx)
    const pay = await a.transition!({ leg, ref: step.ref!, name: 'submit_details', inputs: { account_name: 'Jane', phone: '0712345678' } }, ctx)
    expect(pay.surface).toEqual({ kind: 'WALLET_TX', chain: SOLANA_MAINNET, txs: [{ kind: 'solana', type: 'transfer', to: 'EscrowSo1anaAddress1111111111111111111111111', mint: sol, amount: '10500000', decimals: 6 }] })
    expect(calls[0]!.body).toMatchObject({ chain: 'SOLANA' })
    expect(calls[0]!.body).not.toHaveProperty('senderAddress')

    const none = fakeFetch([{ method: 'POST', match: '/api/v3/offramp', reply: () => ok({ status: 'PENDING' }) }])
    const ctx2 = makeCtx({ fetch: none.fetch, destination: { type: 'fiat', currency: 'KES' }, session: { direction: 'withdraw', country: 'KE' } })
    const s2 = await a.start({ leg: sellLeg('sell-ke-mpesa', 'KES'), quote: sellQuote() }, ctx2)
    await expect(a.transition!({ leg: sellLeg('sell-ke-mpesa', 'KES'), ref: s2.ref!, name: 'submit_details', inputs: { account_name: 'J', phone: '0712345678' } }, ctx2)).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
  })

  it('maps every offramp status', async () => {
    const cases: Array<[string, string, string, string]> = [
      ['PENDING', 'PENDING', 'PAYMENT', 'awaiting_user'], // no local order: still waiting for the crypto
      ['CRYPTO_RECEIVED', 'SUCCESSFUL', 'PROCESSING', 'processing'],
      ['IN_PROGRESS', 'SUCCESSFUL', 'PROCESSING', 'processing'],
      ['SUCCESSFUL', 'SUCCESSFUL', 'COMPLETED', 'succeeded'],
      ['FAILED', 'SUCCESSFUL', 'PROCESSING', 'processing'], // refund follows
      ['REFUND_PENDING', 'SUCCESSFUL', 'PROCESSING', 'processing'],
      ['REFUNDED', 'SUCCESSFUL', 'REFUNDED', 'refunded'],
      ['REFUND_FAILED', 'SUCCESSFUL', 'FAILED', 'failed'],
      ['FAILED', 'FAILED', 'FAILED', 'failed'],
      ['CANCELLED', 'PENDING', 'FAILED', 'failed'],
      ['EXPIRED', 'PENDING', 'EXPIRED', 'expired'],
    ]
    const a = kotani({ apiKey: 'k' })
    for (const [st, chain, state, legStatus] of cases) {
      const { fetch, calls } = fakeFetch([{ match: '/api/v3/offramp/', reply: () => ok({ status: st, onchainStatus: chain, fiatTransactionAmount: 1279, fiatCurrency: 'KES', transactionHash: '0xdef' }) }])
      const s = await a.status!({ leg: sellLeg('sell-ke-mpesa', 'KES'), ref: 'ref-2' }, makeCtx({ fetch }))
      expect([st, chain, s.state, s.status]).toEqual([st, chain, state, legStatus])
      expect(checkLegStep(s)).toEqual([])
      expect(calls[0]!.url).toBe(`${API}/api/v3/offramp/ref-2`)
    }
    expect(offrampEvent({ referenceId: 'r', status: 'SUCCESSFUL', fiatTransactionAmount: 4850, fiatCurrency: 'KES', transactionHash: '0xdef' })).toEqual({ ref: 'r', status: 'succeeded', txHash: '0xdef', output: { amount: '4850', asset: { kind: 'fiat', currency: 'KES' } } })
  })
})

describe('kotani adapter: webhooks', () => {
  const a = kotani({ apiKey: 'k', webhookSecret: SECRET })
  const wctx = makeWebhookCtx()
  const onramp = { event: 'transaction.onramp.status.updated', data: { referenceId: 'onramp-001', status: 'SUCCESSFUL', depositStatus: 'SUCCESSFUL', onchainStatus: 'SUCCESSFUL', chain: 'BASE', token: 'USDC', cryptoAmount: 38.5, cryptoAmountReceived: 38.5, fiatAmount: 5000, fiatFee: 100, fiatAmountToSend: 5100, receiverAddress: WALLET, transactionHash: '0xabc123', rate: { from: 'KES', to: 'USDC', cryptoAmount: 38.5 } } }

  it('verifies X-Kotani-Signature over the body without its signature field', async () => {
    const { raw, sig } = await signed(onramp)
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/)
    expect(await a.webhook!.verify(hookReq(sig), raw, wctx)).toBe(true)
    expect(await a.webhook!.verify(hookReq(` ${sig} `), raw, wctx)).toBe(true)
    // A changed body, a wrong secret, a missing header, a body that is not JSON: rejected.
    expect(await a.webhook!.verify(hookReq(sig), raw.replace('38.5', '99.5'), wctx)).toBe(false)
    expect(await a.webhook!.verify(hookReq((await signed(onramp, 'other')).sig), raw, wctx)).toBe(false)
    expect(await a.webhook!.verify(hookReq(), raw, wctx)).toBe(false)
    expect(await a.webhook!.verify(hookReq(sig), 'not json', wctx)).toBe(false)
    expect(await a.webhook!.verify(hookReq(sig), '[1]', wctx)).toBe(false)
    // Without a webhook secret, every callback is rejected.
    expect(await kotani({ apiKey: 'k' }).webhook!.verify(hookReq(sig), raw, wctx)).toBe(false)
  })

  it('parses onramp, offramp and refund events; ignores others', async () => {
    expect(await a.webhook!.parse(JSON.stringify(onramp), wctx)).toEqual([{
      ref: 'onramp-001', status: 'succeeded', txHash: '0xabc123',
      output: { amount: '38.5', asset: { kind: 'crypto', chain: 'eip155:8453', token: BASE_USDC, symbol: 'USDC', decimals: 6 } },
    }])
    const failed = { event: 'transaction.onramp.status.updated', data: { referenceId: 'onramp-002', status: 'FAILED', depositStatus: 'SUCCESSFUL', onchainStatus: 'FAILED', chain: 'POLYGON', token: 'USDT', transactionHash: null, error: { message: 'Crypto transfer failed after retries', code: 'CRYPTO_TRANSFER_FAILED' } } }
    expect(await a.webhook!.parse(JSON.stringify(failed), wctx)).toEqual([expect.objectContaining({ ref: 'onramp-002', status: 'failed', error: expect.objectContaining({ code: 'DELIVERY_FAILED' }) })])
    const pending = { event: 'transaction.onramp.status.updated', data: { referenceId: 'p', depositStatus: 'INITIATED', onchainStatus: 'PENDING' } }
    expect(await a.webhook!.parse(JSON.stringify(pending), wctx)).toEqual([])
    const off = { event: 'transaction.offramp.status.updated', data: { referenceId: 'offramp-001', status: 'SUCCESSFUL', onchainStatus: 'SUCCESSFUL', fiatAmount: 5000, fiatTransactionAmount: 4850, cryptoAmount: 38.5, fiatCurrency: 'KES', transactionHash: '0xdef456' } }
    expect(await a.webhook!.parse(JSON.stringify(off), wctx)).toEqual([{ ref: 'offramp-001', status: 'succeeded', txHash: '0xdef456', output: { amount: '4850', asset: { kind: 'fiat', currency: 'KES' } } }])
    expect(await a.webhook!.parse(JSON.stringify({ event: 'refund.completed', data: { referenceId: 'offramp-001', status: 'REVERSED', refundStatus: 'SUCCESSFUL', refundTransactionHash: '0xrefund' } }), wctx)).toEqual([{ ref: 'offramp-001', status: 'refunded', txHash: '0xrefund' }])
    expect(await a.webhook!.parse(JSON.stringify({ event: 'refund.failed', data: { referenceId: 'offramp-001', refundStatus: 'FAILED' } }), wctx)).toEqual([expect.objectContaining({ status: 'failed', error: expect.objectContaining({ recovery: 'contact_support' }) })])
    expect(await a.webhook!.parse(JSON.stringify({ event: 'transaction.deposit.status.updated', data: { reference_id: 'x', status: 'SUCCESSFUL' } }), wctx)).toEqual([])
    expect(await a.webhook!.parse(JSON.stringify({ event: 'settlement.processed', data: { referenceId: 'SET-1' } }), wctx)).toEqual([])
    expect(await a.webhook!.parse('<html>', wctx)).toEqual([])
  })
})

describe('kotani adapter: request signing, catalog, health, sandbox', () => {
  it('signs POST bodies and GET path segments with the API secret when secure mode is on', async () => {
    const { fetch, calls } = fakeFetch([
      { method: 'POST', match: '/rate/onramp', reply: () => ok({ fiatAmount: 100, cryptoAmount: 1, fee: 0 }) },
      { method: 'GET', match: '/api/v3/onramp/', reply: () => ok(onrampStatus()) },
    ])
    const a = kotani({ apiKey: 'k', apiSecret: 'api_secret', sandbox: true })
    const ctx = makeCtx({ fetch, destination: DEST })
    await a.quote({ leg: depositLeg('ke-mpesa', 'KES'), amountIn: fiatIn('100', 'KES') }, ctx)
    await a.status!({ leg: depositLeg('ke-mpesa', 'KES'), ref: 'ref-9' }, ctx)
    expect(calls[0]!.url).toBe(`${KOTANI_SANDBOX_API}/api/v3/rate/onramp`)
    for (const [i, last] of [[0, calls[0]!.raw!], [1, 'ref-9']] as const) {
      const h = calls[i]!.headers
      expect(h.get('x-timestamp')).toMatch(/^[0-9]{10}$/)
      expect(h.get('x-nonce')).toMatch(/^[0-9a-f-]{36}$/)
      expect(h.get('x-signature')).toBe(await hmacSha256('api_secret', `${h.get('x-timestamp')}.${h.get('x-nonce')}.${last}`, 'hex'))
    }
    expect(calls[0]!.headers.get('x-nonce')).not.toBe(calls[1]!.headers.get('x-nonce'))
    expect(kotani({ apiKey: 'k', apiUrl: 'https://kotani.proxy.test/' }).legs.length).toBeGreaterThan(0)
  })

  it('catalog keeps the corridors Kotani enables, per direction, caches them and uses the live networks', async () => {
    const { fetch, calls } = fakeFetch([{
      match: '/api/v3/customer/support/countries',
      reply: (c) => ok(c.url.includes('serviceType=WITHDRAW')
        ? [{ countryCode: 'KE', currency: 'KES', serviceType: 'WITHDRAW', isActive: true, isEnabled: true }]
        : [
            { countryCode: 'GH', currency: 'GHS', serviceType: 'DEPOSIT', isActive: true, isEnabled: true, availableNetworks: ['MTN', 'AIRTEL'] },
            { countryCode: 'KE', currency: 'KES', serviceType: 'DEPOSIT', isActive: true, isEnabled: true, availableNetworks: ['MPESA', 'AIRTEL'] },
            { countryCode: 'UG', currency: 'UGX', serviceType: 'DEPOSIT', isActive: true, isEnabled: false },
            { countryCode: 'TZ', currency: 'TZS', serviceType: 'DEPOSIT', isActive: false, isEnabled: true },
          ]),
    }])
    const a = kotani({ apiKey: 'k' })
    const shared = memoryKV()
    const wctx = makeWebhookCtx({ fetch, shared })
    const dep = await a.catalog!({ country: 'GH', currency: 'GHS', direction: 'deposit' }, wctx)
    expect(dep.map((l) => l.id)).toEqual(['ke-mpesa', 'ke-mobile-money', 'gh-mobile-money'])
    await a.catalog!({ currency: 'GHS', direction: 'deposit' }, wctx)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${API}/api/v3/customer/support/countries?serviceType=DEPOSIT`)
    expect((await a.catalog!({ currency: 'KES', direction: 'withdraw' }, wctx)).map((l) => l.id)).toEqual(['sell-ke-mpesa', 'sell-ke-mobile-money'])

    const ctx = makeCtx({ fetch, shared, destination: DEST, session: { country: 'GH' } })
    const q: LegQuote = { adapterId: 'kotani', legId: 'gh-mobile-money', input: fiatIn('10', 'GHS'), output: { amount: '1', asset: { kind: 'crypto', chain: 'eip155:8453', token: BASE_USDC } }, fees: [], eta: { min: 1, max: 2 } }
    const gh = await a.start({ leg: depositLeg('gh-mobile-money', 'GHS'), quote: q }, ctx)
    expect((gh.surface as { fields: Array<{ id: string; options?: Array<{ value: string }> }> }).fields[2]!.options!.map((o) => o.value)).toEqual(['MTN', 'AIRTEL'])
    const ke = await a.start({ leg: depositLeg('ke-mobile-money', 'KES'), quote: { ...q, legId: 'ke-mobile-money', input: fiatIn('10', 'KES') } }, ctx)
    expect((ke.surface as { fields: Array<{ id: string; label: string }> }).fields.map((f) => f.label)).toEqual(['Name on the mobile money account', 'Airtel Money phone number'])

    const empty = kotani({ apiKey: 'k' })
    const emptyShared = memoryKV()
    await emptyShared.put('countries:DEPOSIT', [{ countryCode: 'GH', currency: 'GHS', availableNetworks: [] }])
    const ghStatic = await empty.start({ leg: depositLeg('gh-mobile-money', 'GHS'), quote: q }, makeCtx({ fetch, shared: emptyShared, destination: DEST }))
    expect((ghStatic.surface as { fields: unknown[] }).fields).toHaveLength(3)
    await expect(kotani({ apiKey: 'k' }).catalog!({ currency: 'KES', direction: 'deposit' }, makeWebhookCtx({ fetch: fakeFetch([{ match: '/countries', status: 500, reply: () => ({}) }]).fetch }))).rejects.toBeDefined()
    // A response that is not a list is an error (the server then uses the static legs), and is not cached.
    const odd = memoryKV()
    await expect(kotani({ apiKey: 'k' }).catalog!({ currency: 'KES', direction: 'deposit' }, makeWebhookCtx({ fetch: fakeFetch([{ match: '/countries', reply: () => ok({}) }]).fetch, shared: odd }))).rejects.toThrow(/unexpected/)
    expect(await odd.get('countries:DEPOSIT')).toBeUndefined()
  })

  it('health calls /health', async () => {
    const a = kotani({ apiKey: 'k' })
    expect(await a.health!({ fetch: fakeFetch([{ match: '/health', reply: () => ({ success: true, data: { status: 'ok' } }) }]).fetch, log: makeWebhookCtx().log })).toEqual({ ok: true })
    expect((await a.health!({ fetch: fakeFetch([]).fetch, log: makeWebhookCtx().log })).ok).toBe(false)
  })
})

describe('kotani conformance (shared test kit)', () => {
  it('passes runAdapterConformance for M-Pesa, bank checkout and a mobile money payout, and signed webhooks', async () => {
    const { fetch } = fakeFetch([
      { method: 'POST', match: '/rate/onramp', reply: () => ok({ id: 'r', fiatAmount: 975, cryptoAmount: 7.45, fee: 25 }) },
      { method: 'POST', match: '/rate/offramp', reply: () => ok({ id: 'o', fiatAmount: 1305, cryptoAmount: 10, transactionAmount: 1279, fee: 26 }) },
      { method: 'POST', match: /\/api\/v3\/onramp$/, reply: () => ok({ id: 'x', redirectUrl: 'https://checkout.kotanipay.test/1' }) },
      { method: 'POST', match: /\/api\/v3\/offramp$/, reply: () => ok({ escrowAddress: ESCROW }) },
      { method: 'GET', match: '/api/v3/onramp/', reply: () => ok(onrampStatus()) },
      { method: 'GET', match: '/api/v3/offramp/', reply: () => ok({ status: 'SUCCESSFUL', onchainStatus: 'SUCCESSFUL', fiatTransactionAmount: 1279, fiatCurrency: 'KES' }) },
    ])
    const a = kotani({ apiKey: 'k', webhookSecret: SECRET })
    const ok1 = await signed({ event: 'transaction.onramp.status.updated', data: { referenceId: 'sess_1-1', depositStatus: 'SUCCESSFUL', onchainStatus: 'SUCCESSFUL', chain: 'BASE', token: 'USDC', cryptoAmount: 7.45 } })
    const report = await runAdapterConformance(a, {
      ctx: () => makeCtx({ fetch, destination: DEST, session: { country: 'KE' } }),
      fixtures: [
        { name: 'mpesa', leg: depositLeg('ke-mpesa', 'KES'), quote: { amountIn: fiatIn('1000', 'KES') }, transitions: [{ name: 'submit_details', inputs: { account_name: 'Jane', phone: '0712345678' } }], expect: { start: 'PAYMENT', status: 'COMPLETED' } },
        { name: 'bank', leg: depositLeg('za-bank-transfer', 'ZAR'), quote: { amountIn: fiatIn('500', 'ZAR') }, transitions: [{ name: 'submit_details', inputs: { full_name: 'T', phone: '0821234567' } }], expect: { start: 'PAYMENT', status: 'COMPLETED' } },
        {
          name: 'payout', leg: sellLeg('sell-ke-mpesa', 'KES'), quote: { amountIn: { amount: '10', asset: { kind: 'crypto', chain: 'eip155:8453', token: BASE_USDC } } },
          start: { source: { chain: 'eip155:8453', token: BASE_USDC, address: WALLET } },
          transitions: [{ name: 'submit_details', inputs: { account_name: 'Jane', phone: '0712345678' } }, { name: 'submit_tx', inputs: { txHash: `0x${'cd'.repeat(32)}` } }],
          expect: { start: 'PAYMENT', status: 'COMPLETED' },
        },
      ],
      webhooks: [
        { name: 'signed', request: () => hookReq(ok1.sig), rawBody: ok1.raw, events: 1 },
        { name: 'bad signature', request: () => hookReq('sha256=00'), rawBody: ok1.raw, valid: false },
        { name: 'unsigned', request: () => hookReq(), rawBody: JSON.stringify({ referenceId: 'x', status: 'SUCCESSFUL' }), valid: false },
      ],
    })
    expect(report.problems).toEqual([])
    expect(report.steps.map((s) => s.surface?.kind ?? s.sub)).toEqual(['FORM', 'CONFIRM_ON_YOUR_PHONE', undefined, 'FORM', 'REDIRECT', undefined, 'FORM', 'WALLET_TX', 'PAYING_OUT', undefined])
  })
})

describe('kotani end to end through the server', () => {
  const quiet = { debug() {}, info() {}, warn() {}, error() {} }
  const BASE = 'https://app.test/api'

  function server() {
    const created: Array<Record<string, unknown>> = []
    const f: typeof fetch = async (input, init) => {
      const url = String(input)
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      if (url.includes('/api/v3/customer/support/countries')) return Response.json(ok([{ countryCode: 'KE', currency: 'KES', isActive: true, isEnabled: true, availableNetworks: ['MPESA', 'AIRTEL'] }]))
      if (url.endsWith('/api/v3/rate/onramp')) return Response.json(ok({ id: 'r', fiatAmount: body.fiatAmount, cryptoAmount: body.fiatAmount / 130, fee: 0 }))
      if (url.endsWith('/api/v3/rate/offramp')) return Response.json(ok({ id: 'o', fiatAmount: body.cryptoAmount * 130, cryptoAmount: body.cryptoAmount, transactionAmount: body.cryptoAmount * 128, fee: body.cryptoAmount * 2 }))
      if (url.endsWith('/api/v3/onramp')) return created.push(body), Response.json(ok({ id: 'x', referenceId: body.referenceId }))
      if (url.endsWith('/api/v3/offramp')) return created.push(body), Response.json(ok({ referenceId: body.referenceId, escrowAddress: ESCROW }))
      if (url.includes('/api/v3/onramp/')) return Response.json(ok(onrampStatus({ depositStatus: 'INITIATED', onchainStatus: 'PENDING' })))
      if (url.includes('/api/v3/offramp/')) return Response.json(ok({ status: 'PENDING', onchainStatus: 'PENDING' }))
      return new Response('{}')
    }
    const ramp = createOpenRamp({ secret: 's'.repeat(40), baseUrl: BASE, adapters: [kotani({ apiKey: 'k', webhookSecret: SECRET })], logger: quiet, fetch: f })
    return { ramp, created }
  }

  it('M-Pesa to USDC on Base: plan, quote, FORM, STK push, signed webhook completes the session', async () => {
    const { ramp, created } = server()
    const s = await ramp.sessions.create({ userId: 'u', country: 'KE', destination: DEST })
    const call = (p: string, body?: unknown) =>
      ramp.handle(new Request(`${BASE}${p}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${s.clientSecret}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
    const plan = (await (await call(`/sessions/${s.id}/plan`, {})).json()) as PlanResult
    expect(plan.methods.find((m) => m.method === 'mpesa')?.providers).toEqual(['Kotani Pay'])
    const quotes = (await (await call(`/sessions/${s.id}/quotes`, { method: 'mpesa', amount: '1300' })).json()) as { quotes: Quote[] }
    expect(quotes.quotes[0]).toMatchObject({ provider: 'Kotani Pay', input: { amount: '1300' }, output: { amount: '10' } })
    const sel = (await (await call(`/sessions/${s.id}/select`, { quoteId: quotes.quotes[0]!.id })).json()) as PublicSession
    expect(sel.step.surface?.kind).toBe('FORM')
    const sent = (await (await call(`/sessions/${s.id}/transitions/submit_details`, { inputs: { account_name: 'Jane', phone: '0712345678' } })).json()) as PublicSession
    expect(sent.step).toMatchObject({ state: 'PAYMENT', sub: 'CONFIRM_ON_YOUR_PHONE' })
    const ref = created[0]!.referenceId as string
    expect(created[0]).toMatchObject({ receiverAddress: WALLET, chain: 'BASE', callbackUrl: `${BASE}/webhooks/kotani` })

    const bad = await ramp.handle(new Request(`${BASE}/webhooks/kotani`, { method: 'POST', headers: { 'x-kotani-signature': 'sha256=00' }, body: '{}' }))
    expect(bad.status).toBe(401)
    const { raw, sig } = await signed({ event: 'transaction.onramp.status.updated', data: { referenceId: ref, status: 'SUCCESSFUL', depositStatus: 'SUCCESSFUL', onchainStatus: 'SUCCESSFUL', chain: 'BASE', token: 'USDC', cryptoAmount: 10, transactionHash: '0xfeed' } })
    const hook = await ramp.handle(new Request(`${BASE}/webhooks/kotani`, { method: 'POST', headers: { 'x-kotani-signature': sig, 'content-type': 'application/json' }, body: raw }))
    expect(hook.status).toBe(200)
    const done = (await (await call(`/sessions/${s.id}`)).json()) as PublicSession
    expect(done.status).toBe('completed')
  })

  it('withdraw USDC on Base to M-Pesa: FORM, WALLET_TX to the escrow, signed webhook completes the session', async () => {
    const { ramp, created } = server()
    const s = await ramp.sessions.create({ userId: 'u', direction: 'withdraw', country: 'KE', source: { chain: 'eip155:8453', token: BASE_USDC, custody: 'user_wallet' } })
    const call = (p: string, body?: unknown) =>
      ramp.handle(new Request(`${BASE}${p}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${s.clientSecret}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
    const plan = (await (await call(`/sessions/${s.id}/target`, { type: 'fiat', currency: 'KES', walletConnected: true, walletAddress: WALLET })).json()) as PlanResult
    expect(plan.methods.map((m) => m.method)).toEqual(expect.arrayContaining(['mpesa', 'mobile_money']))
    const quotes = (await (await call(`/sessions/${s.id}/quotes`, { method: 'mpesa', amount: '10' })).json()) as { quotes: Quote[] }
    expect(quotes.quotes[0]).toMatchObject({ input: { amount: '10' }, output: { amount: '1280', asset: { currency: 'KES' } } })
    await call(`/sessions/${s.id}/select`, { quoteId: quotes.quotes[0]!.id })
    const pay = (await (await call(`/sessions/${s.id}/transitions/submit_details`, { inputs: { account_name: 'Jane', phone: '0712345678' } })).json()) as PublicSession
    expect(pay.step.surface).toMatchObject({ kind: 'WALLET_TX', chain: 'eip155:8453' })
    expect(created[0]).toMatchObject({ senderAddress: WALLET, mobileMoneyReceiver: { networkProvider: 'MPESA' } })
    await call(`/sessions/${s.id}/transitions/submit_tx`, { inputs: { txHash: `0x${'ef'.repeat(32)}` } })
    const { raw, sig } = await signed({ event: 'transaction.offramp.status.updated', data: { referenceId: created[0]!.referenceId as string, status: 'SUCCESSFUL', onchainStatus: 'SUCCESSFUL', fiatTransactionAmount: 1280, fiatCurrency: 'KES' } })
    expect((await ramp.handle(new Request(`${BASE}/webhooks/kotani`, { method: 'POST', headers: { 'x-kotani-signature': sig }, body: raw }))).status).toBe(200)
    expect(((await (await call(`/sessions/${s.id}`)).json()) as PublicSession).status).toBe('completed')
  })
})
