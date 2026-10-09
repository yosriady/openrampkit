import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { checkAdapterShape, checkLegQuote, checkLegStep } from '@openrampkit/adapter'
import { USDC, isRegionAllowed, stateFor } from '@openrampkit/core'
import type { PathwayLeg } from '@openrampkit/core'
import { fakeFetch, makeCtx, makeWebhookCtx, memoryKV, recordingLog, runAdapterConformance, silentLog } from '@openrampkit/adapter/testing'
import { meld, meldCode, meldMethodId } from './index.js'

const KEY = 'W9kZTT7332okCEc1A9aqAq:3sYKoXQv6oHVHSts7G2agw9vTCXz'
const SECRET = 'meld_webhook_secret'
const HOOK_URL = 'https://app.test/api/openramp/webhooks/meld'
const opts = { apiKey: KEY, env: 'sandbox' as const, webhookSecret: SECRET }
const BASE_USDC = { kind: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']! }
const money = (amount: string, currency = 'USD') => ({ value: amount, asset: { kind: 'fiat' as const, currency } })

const leg = (legId: string, currency = 'USD'): PathwayLeg => ({
  adapterId: 'meld',
  legId,
  from: { asset: { kind: 'fiat', currency }, location: { kind: 'user_account' } },
  to: { asset: BASE_USDC, location: { kind: 'address', address: 'deposit' } },
})

const q = (serviceProvider: string, destinationAmount: number, extra: Record<string, unknown> = {}) => ({
  transactionType: 'CRYPTO_PURCHASE', sourceAmount: 100, sourceAmountWithoutFees: 96.5, destinationAmount, destinationCurrencyCode: 'USDC_BASE',
  sourceCurrencyCode: 'USD', exchangeRate: 1.03, transactionFee: 3, networkFee: 0.5, partnerFee: 0, totalFee: 3.5, serviceProvider,
  paymentMethodType: 'CREDIT_DEBIT_CARD', rampIntelligence: { rampScore: 80, lowKyc: false, previouslyUsed: false }, ...extra,
})
const QUOTES = { quotes: [q('TRANSAK', 95.1), q('BANXA', 96.25, { transactionFee: 2.5, partnerFee: 0.25 }), q('BROKEN', 0)] }

const TX = (status: string, extra: Record<string, unknown> = {}) => ({
  id: 'mtx_1', status, destinationAmount: 96.25, destinationCurrencyCode: 'USDC_BASE', externalSessionId: 'ork_abc', serviceProvider: 'BANXA',
  cryptoDetails: { blockchainTransactionId: '0xhash', chainId: '8453' }, ...extra,
})

describe('meld adapter', () => {
  it('static legs: card, wallets and local methods with country rules', () => {
    const a = meld(opts)
    expect(checkAdapterShape(a)).toEqual([])
    expect(a.legs.map((l) => l.id)).toEqual([
      'card', 'apple_pay', 'google_pay', 'upi', 'pix', 'binance_pay', 'sepa', 'ach',
      'sepa_instant', 'faster_payments', 'open_banking', 'ideal', 'bancontact', 'blik', 'payid', 'interac', 'spei', 'pse', 'khipu', 'imps', 'mpesa', 'mobile_money',
    ])
    expect(a.legs.every((l) => l.surfaces.join() === 'REDIRECT')).toBe(true)
    const upi = a.legs.find((l) => l.id === 'upi')!
    expect(isRegionAllowed(upi.regions, 'IN')).toBe(true)
    expect(isRegionAllowed(upi.regions, 'US')).toBe(false)
    expect(upi.from.asset).toEqual({ kind: 'fiat', currencies: ['INR'] })
    expect(meldMethodId('CREDIT_DEBIT_CARD')).toBe('card')
    expect(meldMethodId('SOME_LOCAL_THING')).toBe('some_local_thing')
    expect(meldCode('card')).toBe('CREDIT_DEBIT_CARD')
    expect(meldCode('some_local_thing')).toBe('SOME_LOCAL_THING')
  })

  it('maps the global and regional codes both ways, with country rules', () => {
    const pairs: Array<[string, string]> = [
      ['SEPA_INSTANT', 'sepa_instant'], ['UK_FASTER_PAYMENTS', 'faster_payments'], ['FPS', 'faster_payments'], ['OPEN_BANKING', 'open_banking'],
      ['IDEAL', 'ideal'], ['BANCONTACT', 'bancontact'], ['BLIK', 'blik'], ['PAYID', 'payid'], ['SPEI', 'spei'], ['STP', 'spei'],
      ['PSE', 'pse'], ['KHIPU', 'khipu'], ['MPESA', 'mpesa'], ['MOBILE_MONEY', 'mobile_money'], ['IMPS', 'imps'], ['ASTROPAY', 'astropay'],
      ['MERCADOPAGO', 'mercadopago'], ['MERCADO_PAGO', 'mercadopago'], ['CASH_APP', 'cash_app'], ['ZELLE', 'zelle'],
    ]
    for (const [code, id] of pairs) expect(meldMethodId(code)).toBe(id)
    expect(meldCode('faster_payments')).toBe('UK_FASTER_PAYMENTS')
    expect(meldCode('spei')).toBe('SPEI')
    expect(meldCode('mercadopago')).toBe('MERCADOPAGO')
    expect(meldCode('mobile_money')).toBe('MOBILE_MONEY')
    const a = meld(opts)
    const allowed = (id: string, c: string) => isRegionAllowed(a.legs.find((l) => l.id === id)!.regions, c)
    expect(allowed('blik', 'PL')).toBe(true)
    expect(allowed('blik', 'DE')).toBe(false)
    expect(allowed('payid', 'AU')).toBe(true)
    expect(allowed('pse', 'CO')).toBe(true)
    expect(allowed('mpesa', 'KE')).toBe(true)
    expect(allowed('mobile_money', 'GH')).toBe(true)
    expect(allowed('mobile_money', 'US')).toBe(false)
    expect(a.legs.find((l) => l.id === 'blik')!.from.asset).toEqual({ kind: 'fiat', currencies: ['PLN'] })
  })

  it('quote and start send the regional code (BLIK, PayID, M-Pesa, Faster Payments)', async () => {
    const cases: Array<[string, string, string, string]> = [
      ['blik', 'PLN', 'PL', 'BLIK'],
      ['payid', 'AUD', 'AU', 'PAYID'],
      ['mpesa', 'KES', 'KE', 'MPESA'],
      ['faster_payments', 'GBP', 'GB', 'UK_FASTER_PAYMENTS'],
      ['mobile_money', 'GHS', 'GH', 'MOBILE_MONEY'],
    ]
    for (const [legId, cur, country, code] of cases) {
      const { fetch, calls } = fakeFetch([
        { method: 'POST', match: '/payments/crypto/quote', reply: () => QUOTES },
        { method: 'POST', match: '/crypto/session/widget', reply: () => ({ widgetUrl: 'https://meldcrypto.com/?token=t' }) },
      ])
      const a = meld(opts)
      const ctx = makeCtx({ fetch, session: { country } })
      const q = await a.quote({ leg: leg(legId, cur), amountIn: money('100', cur) }, ctx)
      expect(calls[0]!.body).toMatchObject({ countryCode: country, sourceCurrencyCode: cur, paymentMethodType: code })
      await a.start({ leg: leg(legId, cur), quote: q, deliverTo: { address: '0xd16e' } }, ctx)
      expect((calls[1]!.body as { sessionData: Record<string, unknown> }).sessionData).toMatchObject({ paymentMethodType: code, sourceCurrencyCode: cur, countryCode: country })
    }
  })

  it('catalog: one leg per Meld payment method for the country and currency, cached', async () => {
    const { fetch, calls } = fakeFetch([
      {
        match: '/service-providers/properties/payment-methods',
        reply: () => [
          { paymentMethod: 'UPI', name: 'UPI', paymentType: 'LOCAL' },
          { paymentMethod: 'CREDIT_DEBIT_CARD', name: 'Card', paymentType: 'CARD' },
          { paymentMethod: 'IMPS', name: 'IMPS', paymentType: 'LOCAL' },
        ],
      },
    ])
    const a = meld({ ...opts, serviceProviders: ['TRANSAK', 'ONMETA'] })
    const shared = memoryKV()
    const legs = await a.catalog!({ country: 'IN', currency: 'INR', direction: 'deposit' }, { fetch, log: silentLog, shared })
    await a.catalog!({ country: 'IN', currency: 'INR', direction: 'deposit' }, { fetch, log: silentLog, shared })
    expect(calls).toHaveLength(1)
    const u = new URL(calls[0]!.url)
    expect(u.origin).toBe('https://api-sb.meld.io')
    expect(Object.fromEntries(u.searchParams)).toEqual({ categories: 'CRYPTO_ONRAMP', fiatCurrencies: 'INR', countries: 'IN', serviceProviders: 'TRANSAK,ONMETA' })
    expect(calls[0]!.headers.get('authorization')).toBe(`BASIC ${KEY}`)
    expect(calls[0]!.headers.get('meld-version')).toBe('2026-02-03')
    expect(legs.map((l) => [l.id, l.regions.allow, l.from.asset])).toEqual([
      ['upi', ['IN'], { kind: 'fiat', currencies: ['INR'] }],
      ['card', ['IN'], { kind: 'fiat', currencies: ['INR'] }],
      ['imps', ['IN'], { kind: 'fiat', currencies: ['INR'] }],
    ])
    for (const l of legs) expect(checkAdapterShape({ ...a, legs: [l] })).toEqual([])
  })

  it('catalog: failures and empty answers throw (the server keeps the static legs)', async () => {
    const a = meld(opts)
    for (const route of [{ status: 500, reply: () => ({}) }, { reply: () => [] }, { reply: () => ({ message: 'odd' }) }]) {
      const { fetch } = fakeFetch([{ match: '/payment-methods', ...route }])
      await expect(a.catalog!({ country: 'US', currency: 'USD', direction: 'deposit' }, { fetch, log: silentLog, shared: memoryKV() })).rejects.toBeTruthy()
    }
  })

  it('quote: POST /payments/crypto/quote, the best provider is the leg quote, the rest in data.providers', async () => {
    const { fetch, calls } = fakeFetch([{ method: 'POST', match: '/payments/crypto/quote', reply: () => QUOTES }])
    const a = meld({ ...opts, env: 'production', serviceProviders: ['TRANSAK', 'BANXA'] })
    const ctx = makeCtx({ fetch, session: { country: 'US', region: 'US-CA' } })
    const quote = await a.quote({ leg: leg('card'), amountIn: money('100'), deliverTo: { address: '0xabc' } }, ctx)
    expect(checkLegQuote(quote)).toEqual([])
    expect(calls[0]!.url).toBe('https://api.meld.io/payments/crypto/quote')
    expect(calls[0]!.body).toEqual({
      countryCode: 'US', sourceCurrencyCode: 'USD', sourceAmount: 100, destinationCurrencyCode: 'USDC_BASE', paymentMethodType: 'CREDIT_DEBIT_CARD',
      walletAddress: '0xabc', serviceProviders: ['TRANSAK', 'BANXA'], subdivision: 'US-CA',
    })
    expect(quote.output).toEqual({ value: '96.25', asset: { ...BASE_USDC, symbol: 'USDC', decimals: 6 } })
    expect(quote.input).toEqual(money('100'))
    expect(quote.fees).toEqual([
      { kind: 'provider', label: 'BANXA fee', amount: money('2.5'), included: true },
      { kind: 'network', label: 'Network fee', amount: money('0.5'), included: true },
      { kind: 'app', label: 'App fee', amount: money('0.25'), included: true },
    ])
    expect(quote.guarantee).toBe('estimate')
    expect(quote.minOutput).toBeUndefined()
    expect(quote.data!.serviceProvider).toBe('BANXA')
    expect(quote.data!.providers).toEqual([
      { serviceProvider: 'BANXA', destinationAmount: '96.25', sourceAmount: '100', totalFee: '3.5', rampScore: 80 },
      { serviceProvider: 'TRANSAK', destinationAmount: '95.1', sourceAmount: '100', totalFee: '3.5', rampScore: 80 },
    ])
  })

  it('quote: no usable quotes, exact output and HTTP errors', async () => {
    const run = (status: number, body: unknown) =>
      meld(opts).quote({ leg: leg('upi', 'INR'), amountIn: money('1000', 'INR') }, makeCtx({ fetch: fakeFetch([{ match: '/quote', status, reply: () => body }]).fetch, session: { country: 'IN' } }))
    await expect(run(200, { quotes: [] })).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
    await expect(run(200, { quotes: [q('X', 0)], message: 'Amount below minimum' })).rejects.toMatchObject({ error: { code: 'NO_QUOTES', message: 'Meld: Amount below minimum' } })
    await expect(run(400, { message: 'Invalid country' })).rejects.toMatchObject({ error: { code: 'NO_QUOTES', message: 'Meld: Invalid country' } })
    await expect(run(401, {})).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    await expect(run(429, {})).rejects.toMatchObject({ error: { code: 'RATE_LIMITED' } })
    await expect(run(502, {})).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    await expect(meld(opts).quote({ leg: leg('card'), amountOut: { value: '5', asset: BASE_USDC } }, makeCtx({ fetch: fakeFetch([]).fetch }))).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
  })

  it('start: widget session with the chosen provider; REDIRECT to serviceProviderWidgetUrl (or widgetUrl)', async () => {
    const { fetch, calls } = fakeFetch([
      { method: 'POST', match: '/payments/crypto/quote', reply: () => QUOTES },
      { method: 'POST', match: '/crypto/session/widget', reply: () => ({ id: 'ws_1', externalSessionId: 'x', widgetUrl: 'https://meldcrypto.com/?token=t', serviceProviderWidgetUrl: 'https://banxa.com/checkout?x=1', token: 't' }) },
    ])
    const a = meld(opts)
    const ctx = makeCtx({ fetch, session: { userId: 'u_42', ip: '203.0.113.9' } })
    const quote = await a.quote({ leg: leg('card'), amountIn: money('100') }, ctx)
    const step = await a.start({ leg: leg('card'), quote, deliverTo: { address: '0xd16e' } }, ctx)
    expect(checkLegStep(step)).toEqual([])
    expect(stateFor(step)).toBe('PAYMENT')
    expect(step).toMatchObject({ status: 'requires_action', action: { kind: 'payment' } })
    expect(step.ref).toMatch(/^ork_[0-9a-f]{24}$/)
    // The widget session id is not the Meld transaction id: no providerRef yet
    expect(step.providerRef).toBeUndefined()
    expect(step.action?.surface).toEqual({ kind: 'REDIRECT', url: 'https://banxa.com/checkout?x=1', popup: true, provider: 'BANXA' })
    expect(calls[1]!.url).toBe('https://api-sb.meld.io/crypto/session/widget')
    expect(calls[1]!.body).toEqual({
      sessionType: 'BUY',
      sessionData: {
        walletAddress: '0xd16e', countryCode: 'US', sourceCurrencyCode: 'USD', sourceAmount: '100.00', destinationCurrencyCode: 'USDC_BASE',
        serviceProvider: 'BANXA', paymentMethodType: 'CREDIT_DEBIT_CARD', redirectUrl: 'https://app.test/api/openramp/return', clientIpAddress: '203.0.113.9',
      },
      externalCustomerId: 'u_42',
      externalSessionId: step.ref,
    })

    const only = fakeFetch([{ method: 'POST', match: '/crypto/session/widget', reply: () => ({ widgetUrl: 'https://meldcrypto.com/?token=t' }) }])
    const s2 = await a.start({ leg: leg('card'), quote }, makeCtx({ fetch: only.fetch }))
    expect(s2.action?.surface).toMatchObject({ kind: 'REDIRECT', url: 'https://meldcrypto.com/?token=t' })
    const none = fakeFetch([{ method: 'POST', match: '/crypto/session/widget', reply: () => ({}) }])
    await expect(a.start({ leg: leg('card'), quote }, makeCtx({ fetch: none.fetch }))).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    await expect(a.start({ leg: leg('card'), quote: { ...quote, data: {} } }, makeCtx({ fetch: none.fetch }))).rejects.toMatchObject({ error: { code: 'QUOTE_EXPIRED' } })
  })

  it('status: search by externalSessionIds and map Meld statuses', async () => {
    const run = async (transactions: unknown[], log = recordingLog()) => {
      const { fetch, calls } = fakeFetch([{ match: '/payments/transactions', reply: () => ({ transactions, count: transactions.length }) }])
      const s = await meld(opts).status!({ leg: leg('card'), ref: 'ork_abc' }, makeCtx({ fetch, log }))
      expect(calls[0]!.url).toBe('https://api-sb.meld.io/payments/transactions?externalSessionIds=ork_abc')
      expect(checkLegStep(s)).toEqual([])
      return s
    }
    const done = await run([TX('SETTLED')])
    expect(stateFor(done)).toBe('COMPLETED')
    expect(done).toMatchObject({ status: 'succeeded', providerRef: 'mtx_1', transactions: [{ role: 'destination', chain: 'eip155:8453', hash: '0xhash' }], output: { value: '96.25' } })
    for (const [st, code] of [['PENDING', 'processing'], ['SETTLING', 'settling'], ['ERROR', 'delayed'], ['AUTHORIZED', 'processing']] as const) {
      const s = await run([TX(st)])
      expect(stateFor(s)).toBe('PROCESSING')
      expect(s).toMatchObject({ status: 'processing', providerRef: 'mtx_1', detail: { code, providerStatus: st } })
      expect(s.transactions).toBeUndefined()
    }
    for (const st of ['PENDING_CREATED', 'TWO_FA_REQUIRED']) {
      const s = await run([TX(st)])
      expect(stateFor(s)).toBe('PAYMENT')
      expect(s).toMatchObject({ status: 'requires_action', action: { kind: 'payment' } })
      expect(s.action?.surface).toBeUndefined()
    }
    for (const st of ['FAILED', 'DECLINED', 'CANCELLED', 'AUTHORIZATION_EXPIRED']) {
      const s = await run([TX(st)])
      expect(stateFor(s)).toBe('FAILED')
      expect(s).toMatchObject({ error: { code: 'PAYMENT_FAILED' } })
    }
    expect(stateFor(await run([TX('REFUNDED')]))).toBe('REFUNDED')
    const none = await run([])
    expect(stateFor(none)).toBe('PAYMENT')
    expect(none).toMatchObject({ ref: 'ork_abc' })
    // An unknown status is logged and is not processing: a payment poll (the server never moves a leg back)
    const log = recordingLog()
    const unknown = await run([TX('SOMETHING_NEW')], log)
    expect(unknown.status).toBe('requires_action')
    expect(unknown.status).not.toBe('processing')
    expect(log.warnings.join(' ')).toContain('unknown provider status')
  })

  it('webhook: base64url signature over timestamp.url.body (good, bad, missing, stale, proxy URL)', async () => {
    const a = meld(opts)
    const wctx = makeWebhookCtx()
    const body = JSON.stringify({ eventType: 'TRANSACTION_CRYPTO_PENDING', eventId: 'e1', payload: { externalSessionId: 'ork_abc', paymentTransactionId: 'mtx_1', paymentTransactionStatus: 'PENDING' } })
    const ts = new Date().toISOString()
    const sign = (t: string, url = HOOK_URL, b = body) => createHmac('sha256', SECRET).update(`${t}.${url}.${b}`).digest('base64').replace(/\+/g, '-').replace(/\//g, '_')
    const req = (h: Record<string, string>, url = HOOK_URL) => new Request(url, { method: 'POST', body, headers: h })
    expect(await a.webhook!.verify(req({ 'meld-signature': sign(ts), 'meld-signature-timestamp': ts }), body, wctx)).toBe(true)
    expect(await a.webhook!.verify(req({ 'Meld-Signature': sign(ts, HOOK_URL, 'x'), 'Meld-Signature-Timestamp': ts }), body, wctx)).toBe(false)
    expect(await a.webhook!.verify(req({ 'meld-signature': sign(ts) }), body, wctx)).toBe(false)
    expect(await a.webhook!.verify(req({}), body, wctx)).toBe(false)
    const old = new Date(Date.now() - 3600_000).toISOString()
    expect(await a.webhook!.verify(req({ 'meld-signature': sign(old), 'meld-signature-timestamp': old }), body, wctx)).toBe(false)
    // Behind a proxy the request URL differs: pass the registered URL
    const proxied = req({ 'meld-signature': sign(ts), 'meld-signature-timestamp': ts }, 'http://internal:8787/webhooks/meld')
    expect(await a.webhook!.verify(proxied, body, wctx)).toBe(false)
    expect(await meld({ ...opts, webhookUrl: HOOK_URL }).webhook!.verify(proxied, body, wctx)).toBe(true)
    expect(await meld({ ...opts, webhookSecret: undefined }).webhook!.verify(req({ 'meld-signature': sign(ts), 'meld-signature-timestamp': ts }), body, wctx)).toBe(false)
    // Known vector from the Meld docs format: base64url with padding
    expect(sign('2022-05-26T20:25:17.682818Z', 'https://x.test/h', '{}')).toBe('nbq4tdEm8itDKaaODf-Dx_v7lxkndVeSRXMS2NhMajg=')
  })

  it('webhook: parse maps events and reads the settled transaction for output and hash', async () => {
    const { fetch, calls } = fakeFetch([{ match: '/payments/transactions/mtx_1', reply: () => ({ transaction: TX('SETTLED') }) }])
    const a = meld(opts)
    const wctx = makeWebhookCtx({ fetch })
    const parse = (o: unknown) => a.webhook!.parse(JSON.stringify(o), wctx)
    const ev = (eventType: string, status?: string, extra: Record<string, unknown> = {}) => ({ eventType, payload: { externalSessionId: 'ork_abc', paymentTransactionId: 'mtx_1', ...(status ? { paymentTransactionStatus: status } : {}), ...extra } })
    expect(await parse(ev('TRANSACTION_CRYPTO_COMPLETE', 'SETTLED'))).toEqual([
      {
        ref: 'ork_abc',
        providerRef: 'mtx_1',
        status: 'succeeded',
        transactions: [{ role: 'destination', chain: 'eip155:8453', hash: '0xhash' }],
        output: { value: '96.25', asset: { ...BASE_USDC, symbol: 'USDC', decimals: 6 } },
      },
    ])
    expect(calls[0]!.url).toBe('https://api-sb.meld.io/payments/transactions/mtx_1')
    expect(await parse(ev('TRANSACTION_CRYPTO_PENDING', 'PENDING'))).toEqual([{ ref: 'ork_abc', providerRef: 'mtx_1', status: 'processing', detail: { code: 'processing', providerStatus: 'PENDING' } }])
    expect(await parse(ev('TRANSACTION_CRYPTO_TRANSFERRING', 'SETTLING'))).toEqual([{ ref: 'ork_abc', providerRef: 'mtx_1', status: 'processing', detail: { code: 'settling', providerStatus: 'SETTLING' } }])
    expect(await parse(ev('TRANSACTION_CRYPTO_TRANSFERRING'))).toMatchObject([{ status: 'processing', detail: { code: 'settling' } }])
    expect(await parse(ev('TRANSACTION_CRYPTO_FAILED'))).toMatchObject([{ status: 'failed' }])
    const [created] = await parse(ev('TRANSACTION_CRYPTO_PENDING', 'TWO_FA_REQUIRED'))
    expect(created).toMatchObject({ ref: 'ork_abc', status: 'requires_action', action: { kind: 'payment' } })
    expect(checkLegStep(created!)).toEqual([])
    // Unknown statuses and unknown event types without a status give no event (never processing)
    expect(await parse(ev('TRANSACTION_CRYPTO_PENDING', 'BRAND_NEW_STATUS'))).toEqual([])
    expect(await parse(ev('TRANSACTION_CRYPTO_SOMETHING'))).toEqual([])
    expect(await parse({ eventType: 'TRANSACTION_CRYPTO_PENDING', payload: { paymentTransactionStatus: 'PENDING_CREATED' } })).toEqual([])
    expect(await parse({ eventType: 'CUSTOMER_KYC_STATUS_CHANGE', payload: {} })).toEqual([])
    expect(await a.webhook!.parse('nope', wctx)).toEqual([])
    // The transaction read fails: still succeeded, without output
    const down = makeWebhookCtx({ fetch: fakeFetch([{ match: '/payments/transactions/', status: 500, reply: () => ({}) }]).fetch })
    expect(await a.webhook!.parse(JSON.stringify(ev('TRANSACTION_CRYPTO_COMPLETE', 'SETTLED')), down)).toEqual([{ ref: 'ork_abc', providerRef: 'mtx_1', status: 'succeeded' }])
  })

  it('passes runAdapterConformance', async () => {
    const { fetch } = fakeFetch([
      { method: 'POST', match: '/payments/crypto/quote', reply: () => QUOTES },
      { method: 'POST', match: '/crypto/session/widget', reply: () => ({ widgetUrl: 'https://meldcrypto.com/?token=t' }) },
      { match: '/payments/transactions/mtx_1', reply: () => ({ transaction: TX('SETTLED') }) },
      { match: '/payments/transactions?', reply: () => ({ transactions: [TX('SETTLED')] }) },
    ])
    const body = JSON.stringify({ eventType: 'TRANSACTION_CRYPTO_COMPLETE', payload: { externalSessionId: 'ork_abc', paymentTransactionId: 'mtx_1', paymentTransactionStatus: 'SETTLED' } })
    const ts = new Date().toISOString()
    const sig = Buffer.from(createHmac('sha256', SECRET).update(`${ts}.${HOOK_URL}.${body}`).digest()).toString('base64').replace(/\+/g, '-').replace(/\//g, '_')
    const report = await runAdapterConformance(meld(opts), {
      fetch,
      fixtures: [
        { leg: leg('card'), quote: { amountIn: money('100') }, expect: { start: 'PAYMENT', status: 'COMPLETED' } },
        { leg: leg('upi', 'INR'), quote: { amountIn: money('5000', 'INR') }, ctx: makeCtx({ fetch, session: { country: 'IN' } }) },
      ],
      errorPaths: [{ leg: leg('card'), quote: { amountIn: money('100') } }],
      webhooks: [
        { name: 'signed', rawBody: body, request: () => new Request(HOOK_URL, { method: 'POST', body, headers: { 'meld-signature': sig, 'meld-signature-timestamp': ts } }), events: 1 },
        { name: 'bad', rawBody: body, request: () => new Request(HOOK_URL, { method: 'POST', body, headers: { 'meld-signature': 'x', 'meld-signature-timestamp': ts } }), valid: false },
      ],
    })
    expect(report.problems).toEqual([])
  })
})
