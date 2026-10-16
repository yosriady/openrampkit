import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { checkAdapterShape, resultChannels } from '@openrampkit/adapter'
import { BITCOIN_MAINNET, TRON_MAINNET, TRON_USDT, USDC, isRegionAllowed, stateFor } from '@openrampkit/core'
import type { Destination, PathwayLeg } from '@openrampkit/core'
import { fakeFetch, makeCtx, makeWebhookCtx, memoryKV, recordingLog, runAdapterConformance } from '@openrampkit/adapter/testing'
import type { FakeRoute, MemoryKV } from '@openrampkit/adapter/testing'
import { flashnet } from './index.js'
import { makeInvoice } from './test-invoice.js'

const API_KEY = 'fn_test_server_key'
const SECRET = 'whsec_flashnet'
const DEST = '0x000000000000000000000000000000000000beef'
const OTHER = '0x000000000000000000000000000000000000dead'
const BASE_USDC = { kind: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']! }
const usd = (v: string) => ({ value: v, asset: { kind: 'fiat' as const, currency: 'USD' } })
const BTC_DEPOSIT = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'
const TRON_DEPOSIT = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf'
const TRON_REFUND = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'

const lnLeg = (legId: 'cash_app' | 'lightning'): PathwayLeg => ({
  adapterId: 'flashnet',
  legId,
  method: legId,
  from: { asset: { kind: 'fiat', currency: 'USD' }, location: { kind: 'user_account' } },
  to: { asset: BASE_USDC, location: { kind: 'address', address: DEST } },
})
const transferLeg = (chain = BITCOIN_MAINNET, token = 'native'): PathwayLeg => ({
  adapterId: 'flashnet',
  legId: 'transfer',
  method: 'transfer',
  from: { asset: { kind: 'crypto', chain, token }, location: { kind: 'user_wallet' } },
  to: { asset: BASE_USDC, location: { kind: 'address', address: DEST } },
})

const opts = { apiKey: API_KEY, webhookSecret: SECRET }
const nowSec = () => Math.floor(Date.now() / 1000)
const HASH = 'ab'.repeat(32)
const invoice = (o: { sats?: bigint; hash?: string; ts?: number; expirySec?: number; prefix?: string } = {}) =>
  makeInvoice({ sats: o.sats ?? 44210n, hash: o.hash ?? HASH, timestamp: o.ts ?? nowSec(), expirySec: o.expirySec ?? 86400, ...(o.prefix ? { prefix: o.prefix } : {}) })

// Shapes from the docs (estimate, limits, onramp, quote, status, webhook events)
const ESTIMATE = (out: string) => ({
  estimatedOut: out,
  feeAmount: '250000',
  totalFeeAmount: '255751',
  feeAsset: 'USDC',
  feeBps: 50,
  feeAmountUsd: '0.25',
  totalFeeAmountUsd: '0.255751',
  route: ['BTC', 'USDB', 'USDC'],
  destination: { chain: 'base', asset: 'USDC', decimals: 6, chainId: '8453' },
})
const LIMITS = { generatedAt: '2026-10-16T00:00:00Z', routes: [{ sourceChain: 'lightning', sourceAsset: 'BTC', destinationChain: 'base', destinationAsset: 'USDC', limits: { fiatUsd: { supported: true, min: '1.00', max: '50000.00', surfaces: ['onramp', 'pay_link'] } } }] }
const ONRAMP = (over: Record<string, unknown> = {}) => ({
  orderId: 'ord_01J9Q0X3K8M2N7P4R6S8T0V2W4',
  quoteId: 'q_01J9Q0X3K8M2N7P4R6S8T0V2W3',
  depositAddress: invoice(),
  paymentLinks: { cashApp: 'https://cash.app/launch/lightning/lnbc...', shortUrl: 'https://orchestration.flashnet.xyz/pay/8fQ2kL' },
  amountIn: '44210',
  estimatedOut: '49750000',
  feeAmount: '250000',
  feeAsset: 'USDC',
  expiresAt: new Date(Date.now() + 86400_000).toISOString(),
  destination: { chain: 'base', asset: 'USDC', decimals: 6 },
  ...over,
})
const QUOTE = (over: Record<string, unknown> = {}) => ({
  quoteId: 'q_7e450ab4-935b-4f8d-a6c4-4987a3cd2831',
  depositAddress: BTC_DEPOSIT,
  amountIn: '100000',
  estimatedOut: '99000000',
  feeAmount: '500000',
  totalFeeAmount: '500000',
  feeAsset: 'USDC',
  feeBps: 50,
  route: ['BTC', 'USDB', 'USDC'],
  expiresAt: new Date(Date.now() + 120_000).toISOString(),
  ...over,
})
const ORDER = (status: string, over: Record<string, unknown> = {}) => ({
  id: 'ord_01J9Q0X3K8M2N7P4R6S8T0V2W4',
  type: 'order',
  status,
  quoteId: 'q_01J9Q0X3K8M2N7P4R6S8T0V2W3',
  sourceChain: 'lightning',
  sourceAsset: 'BTC',
  sourceTxHash: 'c0ffee'.repeat(10) + 'c0ff',
  destinationChain: 'base',
  destinationAsset: 'USDC',
  destinationAddress: DEST,
  recipientAddress: DEST,
  destinationTxHash: `0x${'ab'.repeat(32)}`,
  amountIn: '44210',
  amountOut: status === 'completed' ? '49750000' : null,
  errorCode: null,
  createdAt: '2026-10-16T00:00:00Z',
  updatedAt: '2026-10-16T00:00:05Z',
  ...over,
})
const HOOK = (event: string, status: string, over: Record<string, unknown> = {}) => ({
  event,
  timestamp: '2026-10-16T00:00:06.000Z',
  data: {
    id: 'ord_01J9Q0X3K8M2N7P4R6S8T0V2W4',
    type: 'order',
    status,
    quoteId: 'q_01J9Q0X3K8M2N7P4R6S8T0V2W3',
    amountIn: '44210',
    amountOut: status === 'completed' ? '49750000' : null,
    source: { chain: 'lightning', asset: 'BTC', txHash: 'c0ffee'.repeat(10) + 'c0ff' },
    destination: { chain: 'base', asset: 'USDC', address: DEST, txHash: `0x${'ab'.repeat(32)}` },
    recipientAddress: DEST,
    refund: { asset: null, amount: null, txHash: null },
    error: null,
    createdAt: '2026-10-16T00:00:00Z',
    updatedAt: `2026-10-16T00:00:0${status.length % 10}Z`,
    ...over,
  },
})

const routes = (over: FakeRoute[] = []): FakeRoute[] => [
  ...over,
  { match: '/v1/orchestration/limits', reply: () => LIMITS },
  { match: /\/estimate\?.*amount=100000(&|$)/, reply: () => ESTIMATE('80000000') },
  { match: '/v1/orchestration/estimate', reply: () => ESTIMATE('49750000') },
  { method: 'POST', match: '/v1/orchestration/onramp', reply: () => ONRAMP() },
  { method: 'POST', match: '/v1/orchestration/quote', reply: () => QUOTE() },
  { match: '/v1/orchestration/status', reply: () => ({ order: ORDER('completed') }) },
]

const sign = (body: string, ts = String(Date.now()), secret = SECRET) => ({
  'x-flashnet-timestamp': ts,
  'x-flashnet-signature': createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex'),
})
const hookReq = (body: string, headers: Record<string, string> = sign(body)) => new Request('https://app.test/api/openramp/webhooks/flashnet', { method: 'POST', body, headers })

/** A context for one session, with a shared store that the test can keep across calls */
const ctxFor = (fetch: typeof globalThis.fetch, o: { shared?: MemoryKV; store?: MemoryKV; destination?: Destination; id?: string; log?: ReturnType<typeof recordingLog> } = {}) =>
  makeCtx({
    fetch,
    shared: o.shared ?? memoryKV(),
    store: o.store ?? memoryKV(),
    ...(o.destination ? { destination: o.destination } : {}),
    ...(o.log ? { log: o.log } : {}),
    session: { id: o.id ?? 'sess_1', livemode: true },
  })

async function startCashApp(over: FakeRoute[] = [], o: { shared?: MemoryKV; adapterOpts?: Record<string, unknown>; id?: string } = {}) {
  const { fetch, calls } = fakeFetch(routes(over))
  const a = flashnet({ ...opts, ...o.adapterOpts })
  const shared = o.shared ?? memoryKV()
  const store = memoryKV()
  const ctx = ctxFor(fetch, { shared, store, ...(o.id ? { id: o.id } : {}) })
  const q = await a.quote({ leg: lnLeg('cash_app'), amountIn: usd('50') }, ctx)
  return { a, q, ctx, calls, shared, store, fetch, run: () => a.start({ leg: lnLeg('cash_app'), quote: q }, ctx) }
}

describe('flashnet adapter: setup', () => {
  it('declares cash_app, lightning and transfer legs', () => {
    const a = flashnet(opts)
    expect(checkAdapterShape(a)).toEqual([])
    expect(a.env).toBe('production')
    expect(a.legs.map((l) => l.id)).toEqual(['cash_app', 'lightning', 'transfer'])
    const cash = a.legs[0]!
    expect(cash.methods).toEqual(['cash_app'])
    expect(cash.surfaces).toEqual(['QR', 'DEEPLINK'])
    expect(isRegionAllowed(cash.regions, 'US', 'US-CA')).toBe(true)
    expect(isRegionAllowed(cash.regions, 'US', 'US-NY')).toBe(false)
    expect(isRegionAllowed(cash.regions, 'GB')).toBe(false)
    const transfer = a.legs[2]!
    expect(transfer.from.asset).toEqual({ kind: 'crypto', chains: { [BITCOIN_MAINNET]: ['native'], [TRON_MAINNET]: [TRON_USDT] } })
    expect(resultChannels(a)).toEqual({ polling: true, webhooks: true })
    expect(resultChannels(flashnet({ apiKey: API_KEY }))).toEqual({ polling: true, webhooks: false })
    expect(flashnet({ ...opts, legs: ['transfer'] }).legs.map((l) => l.id)).toEqual(['transfer'])
  })

  it('refuses a client key, a missing key and the sandbox (Orchestra has none)', () => {
    expect(() => flashnet({ apiKey: 'fnp_client' })).toThrow(/server key/)
    expect(() => flashnet({ apiKey: '' })).toThrow(/server key/)
    expect(() => flashnet({ ...opts, env: 'sandbox' })).toThrow(/no sandbox/)
    expect(() => flashnet({ ...opts, legs: [] })).toThrow(/no leg/)
  })

  it('lists BTC on Bitcoin and USDT on Tron for the transfer picker', async () => {
    const a = flashnet(opts)
    const list = await a.sourceTokens!({ chains: [], method: 'transfer' }, makeWebhookCtx())
    expect(list.map((t) => `${t.chain}:${t.token}:${t.decimals}`)).toEqual([`${BITCOIN_MAINNET}:native:8`, `${TRON_MAINNET}:${TRON_USDT}:6`])
    expect(await a.sourceTokens!({ chains: [], method: 'wallet' }, makeWebhookCtx())).toEqual([])
  })
})

describe('flashnet adapter: conformance', () => {
  it('passes the conformance kit (cash_app, lightning, Bitcoin and Tron deposits, webhooks, errors)', async () => {
    const shared = memoryKV()
    const { fetch } = fakeFetch(
      routes([
        // The Tron quote and its order
        { method: 'POST', match: /\/quote$/, reply: (c) => ((c.body as { sourceChain?: string }).sourceChain === 'tron' ? QUOTE({ quoteId: 'q_tron', depositAddress: TRON_DEPOSIT, amountIn: '25000000' }) : QUOTE()) },
        {
          match: '/v1/orchestration/status',
          reply: (c) => {
            const q = new URL(c.url).searchParams.get('quoteId')!
            const extra = q.startsWith('q_7e') || q === 'q_tron' ? { quoteId: q, id: `ord_${q.slice(2, 10)}`, sourceTxHash: `${q.slice(2, 6)}${'0'.repeat(60)}` } : { quoteId: q }
            return { order: ORDER('completed', extra) }
          },
        },
      ]),
    )
    const a = flashnet({ ...opts, refundAddresses: { tron: TRON_REFUND } })
    const body = JSON.stringify(HOOK('order.completed', 'completed'))
    const report = await runAdapterConformance(a, {
      ctx: () => ctxFor(fetch, { shared }),
      webhookCtx: makeWebhookCtx({ shared }),
      fixtures: [
        { leg: lnLeg('cash_app'), quote: { amountIn: usd('50') }, expect: { start: 'PAYMENT', status: 'COMPLETED' } },
        { leg: transferLeg(), quote: { amountIn: { value: '0.001', asset: { kind: 'crypto', chain: BITCOIN_MAINNET, token: 'native' } }, source: { chain: BITCOIN_MAINNET, token: 'native' } }, expect: { start: 'PAYMENT', status: 'COMPLETED' } },
        { leg: transferLeg(TRON_MAINNET, TRON_USDT), quote: { amountIn: { value: '25', asset: { kind: 'crypto', chain: TRON_MAINNET, token: TRON_USDT } }, source: { chain: TRON_MAINNET, token: TRON_USDT } }, expect: { start: 'PAYMENT', status: 'COMPLETED' } },
      ],
      errorPaths: [
        { leg: lnLeg('cash_app'), quote: { amountIn: usd('50') } },
        { leg: transferLeg(), quote: { amountIn: { value: '0.001', asset: { kind: 'crypto', chain: BITCOIN_MAINNET, token: 'native' } }, source: { chain: BITCOIN_MAINNET, token: 'native' } } },
      ],
      webhooks: [
        { name: 'signed', request: () => hookReq(body), rawBody: body, events: 1 },
        { name: 'bad signature', request: () => hookReq(body, sign(body, String(Date.now()), 'wrong')), rawBody: body, valid: false },
      ],
    })
    expect(report.problems).toEqual([])
    expect(report.steps[0]?.action?.surface?.kind).toBe('QR')
    const done = report.steps.find((s) => s.status === 'succeeded')!
    expect(done.output).toEqual({ value: '49.75', asset: { ...BASE_USDC, symbol: 'USDC', decimals: 6 } })
  })
})

describe('flashnet adapter: Cash App and Lightning', () => {
  it('quotes USD with the route rate: one nominal estimate, then the sats for the amount', async () => {
    const { q, calls } = await startCashApp()
    const est = calls.filter((c) => c.url.includes('/estimate'))
    expect(est).toHaveLength(2)
    expect(new URL(est[0]!.url).searchParams.get('amount')).toBe('100000')
    // 100000 sats -> 80 USDC + 0.255751 USD of fees: 50 USD = 62302 sats
    const sats = new URL(est[1]!.url).searchParams.get('amount')
    expect(sats).toBe(String(Math.ceil((50 * 100000) / 80.255751)))
    expect(new URL(est[1]!.url).searchParams.get('sourceChain')).toBe('lightning')
    expect(q.input).toEqual(usd('50.00'))
    expect(q.output.value).toBe('49.75')
    expect(q.guarantee).toBe('estimate')
    expect(q.fees.map((f) => f.label)).toEqual(['Flashnet fee', 'Cash App USD to bitcoin rate'])
    expect(q.fees[0]!.amount).toEqual({ value: '0.26', asset: { kind: 'fiat', currency: 'USD' } })
    expect(calls.every((c) => c.headers.get('authorization') === `Bearer ${API_KEY}`)).toBe(true)
  })

  it('checks the USD limits of the route', async () => {
    const { fetch } = fakeFetch(routes())
    const a = flashnet(opts)
    await expect(a.quote({ leg: lnLeg('cash_app'), amountIn: usd('0.50') }, ctxFor(fetch))).rejects.toMatchObject({ error: { code: 'AMOUNT_TOO_LOW' } })
    await expect(a.quote({ leg: lnLeg('cash_app'), amountIn: usd('50001') }, ctxFor(fetch))).rejects.toMatchObject({ error: { code: 'AMOUNT_TOO_HIGH' } })
    // Orchestra error codes on a 400
    const tooSmall = fakeFetch(routes([{ match: '/estimate', status: 400, reply: () => ({ error: { code: 'amount_too_small', message: 'Amount below minimum' } }) }]))
    await expect(a.quote({ leg: lnLeg('cash_app'), amountIn: usd('5') }, ctxFor(tooSmall.fetch))).rejects.toMatchObject({ error: { code: 'AMOUNT_TOO_LOW' } })
    // Not supported for this asset
    const off = fakeFetch(routes([{ match: '/limits', reply: () => ({ routes: [{ limits: { fiatUsd: { supported: false } } }] }) }]))
    await expect(a.quote({ leg: lnLeg('cash_app'), amountIn: usd('5') }, ctxFor(off.fetch))).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
  })

  it('starts the onramp to the session destination and shows the invoice as a Cash App QR code', async () => {
    const { run, calls } = await startCashApp()
    const step = await run()
    const post = calls.find((c) => c.method === 'POST')!
    expect(post.url).toBe('https://orchestration.flashnet.xyz/v1/orchestration/onramp')
    expect(post.body).toEqual({ destinationChain: 'base', destinationAsset: 'USDC', recipientAddress: DEST, amountFiatUsd: '50.00', tag: 'ork:sess_1' })
    expect(post.headers.get('x-idempotency-key')).toMatch(/^sess_1:flashnet:onramp:[0-9a-f]{64}$/)
    expect(stateFor(step)).toBe('PAYMENT')
    expect(step.ref).toBe('q_01J9Q0X3K8M2N7P4R6S8T0V2W3')
    expect(step.providerRef).toBe('ord_01J9Q0X3K8M2N7P4R6S8T0V2W4')
    const s = step.action!.surface as { kind: string; payload: string; amount: string; currency: string; expiresAt: string }
    expect(s.kind).toBe('QR')
    expect(s.payload).toBe(`https://cash.app/launch/lightning/${ONRAMP().depositAddress}`)
    expect(s).toMatchObject({ amount: '50.00', currency: 'USD' })
    expect(Date.parse(s.expiresAt)).toBeGreaterThan(Date.now())
  })

  it('offers a deep link, and a lightning: URI for the lightning leg', async () => {
    const { run } = await startCashApp([], { adapterOpts: { invoiceSurface: 'deeplink' } })
    const s = (await run()).action!.surface!
    expect(s).toEqual({ kind: 'DEEPLINK', url: `https://cash.app/launch/lightning/${ONRAMP().depositAddress}`, appName: 'Cash App' })
    const { fetch } = fakeFetch(routes())
    const a = flashnet(opts)
    const ctx = ctxFor(fetch)
    const q = await a.quote({ leg: lnLeg('lightning'), amountIn: usd('20') }, ctx)
    const step = await a.start({ leg: lnLeg('lightning'), quote: q }, ctx)
    expect((step.action!.surface as { payload: string }).payload).toBe(`lightning:${ONRAMP().depositAddress}`)
  })

  it('a screening review (202, paused, no invoice) is a decline before any payment', async () => {
    const { run } = await startCashApp([{ method: 'POST', match: '/onramp', status: 202, reply: () => ({ orderId: 'ord_x', status: 'paused' }) }])
    await expect(run()).rejects.toMatchObject({ error: { code: 'PROVIDER_DECLINED', recovery: 'choose_other' } })
  })
})

describe('flashnet adapter: security checks', () => {
  it('delivers only to the server-set destination', async () => {
    const { a, q, fetch } = await startCashApp()
    // A session whose destination is another asset: the quote's asset is not the session destination.
    const ctx = ctxFor(fetch, { destination: { type: 'crypto', chain: 'eip155:1', token: USDC['eip155:1']!, address: DEST } })
    await expect(a.start({ leg: lnLeg('cash_app'), quote: q }, ctx)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
    // The answer names another recipient
    const other = await startCashApp([{ method: 'POST', match: '/onramp', reply: () => ONRAMP({ recipientAddress: OTHER }) }])
    await expect(other.run()).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    // The answer uses other decimals than we expect
    const decimals = await startCashApp([{ method: 'POST', match: '/onramp', reply: () => ONRAMP({ destination: { chain: 'base', asset: 'USDC', decimals: 18 } }) }])
    await expect(decimals.run()).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    // The answer is for another asset
    const asset = await startCashApp([{ method: 'POST', match: '/onramp', reply: () => ONRAMP({ destination: { chain: 'base', asset: 'USDT', decimals: 6 } }) }])
    await expect(asset.run()).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
  })

  it('refuses an invoice for another amount, a testnet invoice, an amountless invoice and junk', async () => {
    for (const depositAddress of [invoice({ sats: 44211n }), invoice({ prefix: 'lntb' }), makeInvoice({ hash: HASH, timestamp: nowSec(), expirySec: 86400 }), 'lnbc1junk', BTC_DEPOSIT]) {
      const { run } = await startCashApp([{ method: 'POST', match: '/onramp', reply: () => ONRAMP({ depositAddress }) }])
      await expect(run()).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    }
  })

  it('refuses an invoice that expires within a minute, and uses the earlier of the two expiries', async () => {
    const soon = await startCashApp([{ method: 'POST', match: '/onramp', reply: () => ONRAMP({ depositAddress: invoice({ ts: nowSec() - 3600, expirySec: 3630 }) }) }])
    await expect(soon.run()).rejects.toMatchObject({ error: { code: 'QUOTE_EXPIRED', recovery: 'requote' } })
    const providerSooner = new Date(Date.now() + 600_000).toISOString()
    const ok = await startCashApp([{ method: 'POST', match: '/onramp', reply: () => ONRAMP({ expiresAt: providerSooner }) }])
    expect(((await ok.run()).action!.surface as { expiresAt: string }).expiresAt).toBe(providerSooner)
  })

  it('one payment hash pays one leg (claimOnce across sessions)', async () => {
    const shared = memoryKV()
    const first = await startCashApp([], { shared })
    await first.run()
    // The same invoice again for the same quote (an idempotent replay): fine
    await expect(first.run()).resolves.toMatchObject({ status: 'requires_action' })
    // The same invoice under another quote id: refused
    const second = await startCashApp([{ method: 'POST', match: '/onramp', reply: () => ONRAMP({ quoteId: 'q_other' }) }], { shared, id: 'sess_2' })
    await expect(second.run()).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
  })

  it('an unpaid invoice expires the leg with QUOTE_EXPIRED and requote; before that it waits', async () => {
    const { a, run, ctx, shared, store } = await startCashApp([
      { method: 'POST', match: '/onramp', reply: () => ONRAMP({ depositAddress: invoice({ expirySec: 120 }), expiresAt: undefined }) },
      { match: '/status', status: 404, reply: () => ({ error: { code: 'not_found', message: 'not found' } }) },
    ])
    const step = await run()
    const waiting = await a.status!({ leg: lnLeg('cash_app'), ref: step.ref! }, ctx)
    expect(waiting.status).toBe('requires_action')
    const rec = (await store.get<{ invoiceExpiresAt: number }>(`rec:${step.ref}`))!
    rec.invoiceExpiresAt = Date.now() - 61_000
    await store.put(`rec:${step.ref}`, rec)
    await shared.put(`rec:${step.ref}`, rec)
    const expired = await a.status!({ leg: lnLeg('cash_app'), ref: step.ref! }, ctx)
    expect(expired).toMatchObject({ status: 'expired', error: { code: 'QUOTE_EXPIRED', recovery: 'requote' } })
  })

  it('completion checks: asset, recipient, amount, and one order per leg; a miss stays processing', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['another asset', { destinationAsset: 'USDT' }],
      ['another chain', { destinationChain: 'ethereum' }],
      ['another address', { destinationAddress: OTHER, recipientAddress: OTHER }],
      ['no amount', { amountOut: '0' }],
      ['another quote', { quoteId: 'q_other' }],
    ]
    for (const [name, over] of cases) {
      const log = recordingLog()
      const { fetch } = fakeFetch(routes([{ match: '/status', reply: () => ({ order: ORDER('completed', over) }) }]))
      const a = flashnet(opts)
      const ctx = ctxFor(fetch, { log })
      const q = await a.quote({ leg: lnLeg('cash_app'), amountIn: usd('50') }, ctx)
      const step = await a.start({ leg: lnLeg('cash_app'), quote: q }, ctx)
      const s = await a.status!({ leg: lnLeg('cash_app'), ref: step.ref! }, ctx)
      expect(s.status, name).toBe('processing')
      expect(s.detail?.code, name).toBe('delayed')
      expect(s.output, name).toBeUndefined()
      expect(log.errors.length, name).toBeGreaterThan(0)
    }
  })

  it('an order or deposit that completed one leg cannot complete another (claimOnce)', async () => {
    const shared = memoryKV()
    const first = await startCashApp([], { shared })
    const s1 = await first.run()
    expect((await first.a.status!({ leg: lnLeg('cash_app'), ref: s1.ref! }, first.ctx)).status).toBe('succeeded')
    // Repeat for the same leg: still succeeded
    expect((await first.a.status!({ leg: lnLeg('cash_app'), ref: s1.ref! }, first.ctx)).status).toBe('succeeded')
    // Another leg whose status answer shows the same order (another deposit hash), or the same deposit (another order id)
    const cases: Array<[string, Record<string, unknown>]> = [
      ['same order', { sourceTxHash: 'e'.repeat(64) }],
      ['same deposit', { id: 'ord_other' }],
    ]
    for (const [i, [name, over]] of cases.entries()) {
      const quoteId = `q_two_${i}`
      const second = await startCashApp(
        [
          { method: 'POST', match: '/onramp', reply: () => ONRAMP({ quoteId, depositAddress: invoice({ hash: `${i}d`.repeat(32) }) }) },
          { match: '/status', reply: () => ({ order: ORDER('completed', { quoteId, ...over }) }) },
        ],
        { shared, id: `sess_2_${i}` },
      )
      const s2 = await second.run()
      const after = await second.a.status!({ leg: lnLeg('cash_app'), ref: s2.ref! }, second.ctx)
      expect(after, name).toMatchObject({ status: 'processing', detail: { code: 'delayed' } })
    }
  })

  it('a failed or fallback order after payment never shows as failed', async () => {
    for (const status of ['failed', 'fallback_delivered']) {
      const log = recordingLog()
      const { fetch } = fakeFetch(routes([{ match: '/status', reply: () => ({ order: ORDER(status, { errorCode: 'slippage_exceeded' }) }) }]))
      const a = flashnet(opts)
      const ctx = ctxFor(fetch, { log })
      const q = await a.quote({ leg: lnLeg('cash_app'), amountIn: usd('50') }, ctx)
      const step = await a.start({ leg: lnLeg('cash_app'), quote: q }, ctx)
      const s = await a.status!({ leg: lnLeg('cash_app'), ref: step.ref! }, ctx)
      expect(s.status).toBe('processing')
      expect(s.error).toBeUndefined()
      expect(log.errors.join(' ')).toMatch(/Flashnet dashboard/)
    }
  })

  it('maps the in-flight statuses, refunds, and leaves an unknown status as no change', async () => {
    const step = async (order: unknown) => {
      const { fetch } = fakeFetch(routes([{ match: '/status', reply: () => ({ order }) }]))
      const a = flashnet(opts)
      const ctx = ctxFor(fetch)
      const q = await a.quote({ leg: lnLeg('cash_app'), amountIn: usd('50') }, ctx)
      const s = await a.start({ leg: lnLeg('cash_app'), quote: q }, ctx)
      return a.status!({ leg: lnLeg('cash_app'), ref: s.ref! }, ctx)
    }
    expect(await step(ORDER('swapping'))).toMatchObject({ status: 'processing', detail: { code: 'settling', providerStatus: 'swapping' } })
    expect(await step(ORDER('confirming'))).toMatchObject({ status: 'processing', detail: { code: 'confirming' } })
    expect(await step(ORDER('refunded'))).toMatchObject({ status: 'refunded' })
    expect((await step(ORDER('brand_new_status'))).status).toBe('requires_action')
  })
})

describe('flashnet adapter: webhooks', () => {
  it('verifies the timestamped HMAC (ms timestamp, 5 minute window, constant-time compare)', async () => {
    const a = flashnet(opts)
    const body = JSON.stringify(HOOK('order.completed', 'completed'))
    const ctx = makeWebhookCtx()
    expect(await a.webhook!.verify(hookReq(body), body, ctx)).toBe(true)
    expect(await a.webhook!.verify(hookReq(body, sign(body, String(Date.now() - 6 * 60_000))), body, ctx)).toBe(false)
    expect(await a.webhook!.verify(hookReq(body, sign(body, String(Math.floor(Date.now() / 1000)))), body, ctx)).toBe(false)
    expect(await a.webhook!.verify(hookReq(body, {}), body, ctx)).toBe(false)
    expect(await a.webhook!.verify(hookReq(body), `${body} `, ctx)).toBe(false)
    expect(await flashnet({ apiKey: API_KEY }).webhook!.verify(hookReq(body), body, ctx)).toBe(false)
  })

  it('binds an event to the leg by quote id, and only for a quote this server started', async () => {
    const shared = memoryKV()
    const { run } = await startCashApp([], { shared })
    await run()
    const a = flashnet(opts)
    const ctx = makeWebhookCtx({ shared })
    const done = HOOK('order.completed', 'completed')
    const [ev] = await a.webhook!.parse(JSON.stringify(done), ctx)
    expect(ev).toMatchObject({ ref: 'q_01J9Q0X3K8M2N7P4R6S8T0V2W3', status: 'succeeded', output: { value: '49.75' }, eventId: `flashnet:ord_01J9Q0X3K8M2N7P4R6S8T0V2W4:order.completed:${done.data.updatedAt}` })
    expect(ev!.transactions).toEqual([{ role: 'destination', chain: 'eip155:8453', hash: `0x${'ab'.repeat(32)}` }])
    // Same body, same events (idempotent)
    expect(await a.webhook!.parse(JSON.stringify(done), ctx)).toEqual([ev])
    // A quote this server did not start: ignored
    expect(await a.webhook!.parse(JSON.stringify(HOOK('order.completed', 'completed', { quoteId: 'q_unknown' })), ctx)).toEqual([])
    // Wrong recipient in the webhook: no success
    const wrong = await a.webhook!.parse(JSON.stringify(HOOK('order.completed', 'completed', { destination: { chain: 'base', asset: 'USDC', address: OTHER, txHash: null } })), ctx)
    expect(wrong[0]).toMatchObject({ status: 'processing', detail: { code: 'delayed' } })
    // Superseded and non-order events: nothing
    expect(await a.webhook!.parse(JSON.stringify(HOOK('order.superseded', 'processing')), ctx)).toEqual([])
    expect(await a.webhook!.parse('not json', ctx)).toEqual([])
    // Recovery required: held, never failed
    expect((await a.webhook!.parse(JSON.stringify(HOOK('order.recovery_required', 'refunding')), ctx))[0]).toMatchObject({ status: 'processing', detail: { code: 'delayed' } })
  })

  it('gives a replay key per (order, event, updatedAt)', async () => {
    const a = flashnet(opts)
    const body = JSON.stringify(HOOK('order.swapping', 'swapping'))
    const key = await a.webhook!.replayKey!(hookReq(body), body, makeWebhookCtx())
    expect(key).toBe(`flashnet:ord_01J9Q0X3K8M2N7P4R6S8T0V2W4:order.swapping:${JSON.parse(body).data.updatedAt}`)
    expect(await a.webhook!.replayKey!(hookReq('x'), 'x', makeWebhookCtx())).toMatch(/^flashnet:body:[0-9a-f]{64}$/)
  })
})

describe('flashnet adapter: Bitcoin and Tron deposits', () => {
  const btcIn = { value: '0.001', asset: { kind: 'crypto' as const, chain: BITCOIN_MAINNET, token: 'native' } }
  const usdtIn = { value: '25', asset: { kind: 'crypto' as const, chain: TRON_MAINNET, token: TRON_USDT } }

  it('quotes in sats and shows the Bitcoin deposit address', async () => {
    const { fetch, calls } = fakeFetch(routes())
    const a = flashnet(opts)
    const ctx = ctxFor(fetch)
    const q = await a.quote({ leg: transferLeg(), amountIn: btcIn, source: { chain: BITCOIN_MAINNET, token: 'native' } }, ctx)
    expect(new URL(calls[0]!.url).searchParams.get('amount')).toBe('100000')
    expect(q.output.value).toBe('80')
    const step = await a.start({ leg: transferLeg(), quote: q }, ctx)
    const post = calls.find((c) => c.method === 'POST')!
    expect(post.body).toMatchObject({ sourceChain: 'bitcoin', sourceAsset: 'BTC', destinationChain: 'base', destinationAsset: 'USDC', amount: '100000', recipientAddress: DEST })
    expect(step.action!.surface).toMatchObject({ kind: 'DEPOSIT_ADDRESS', chain: BITCOIN_MAINNET, chainName: 'Bitcoin', token: 'native', symbol: 'BTC', address: BTC_DEPOSIT })
  })

  it('Tron needs a refund address: the user\'s own, else the configured one', async () => {
    const { fetch, calls } = fakeFetch(routes([{ method: 'POST', match: '/quote', reply: () => QUOTE({ depositAddress: TRON_DEPOSIT, amountIn: '25000000', quoteId: 'q_tron' }) }]))
    await expect(flashnet(opts).quote({ leg: transferLeg(TRON_MAINNET, TRON_USDT), amountIn: usdtIn, source: { chain: TRON_MAINNET, token: TRON_USDT } }, ctxFor(fetch))).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
    const a = flashnet({ ...opts, refundAddresses: { tron: TRON_REFUND } })
    const ctx = ctxFor(fetch)
    const q = await a.quote({ leg: transferLeg(TRON_MAINNET, TRON_USDT), amountIn: usdtIn, source: { chain: TRON_MAINNET, token: TRON_USDT } }, ctx)
    await a.start({ leg: transferLeg(TRON_MAINNET, TRON_USDT), quote: q }, ctx)
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ sourceChain: 'tron', sourceAsset: 'USDT', amount: '25000000', refundAddress: TRON_REFUND })
  })

  it('refuses a deposit address of the wrong format, another amount, and an address that another leg has', async () => {
    const shared = memoryKV()
    const go = async (reply: Record<string, unknown>, id = 'sess_1') => {
      const { fetch } = fakeFetch(routes([{ method: 'POST', match: '/quote', reply: () => QUOTE(reply) }]))
      const a = flashnet(opts)
      const ctx = ctxFor(fetch, { shared, id })
      const q = await a.quote({ leg: transferLeg(), amountIn: btcIn, source: { chain: BITCOIN_MAINNET, token: 'native' } }, ctx)
      return a.start({ leg: transferLeg(), quote: q }, ctx)
    }
    await expect(go({ depositAddress: DEST })).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    await expect(go({ depositAddress: TRON_DEPOSIT })).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    await expect(go({ amountIn: '99999' })).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    await expect(go({ recipientAddress: OTHER })).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    await go({})
    await expect(go({ quoteId: 'q_second' }, 'sess_2')).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
  })

  it('reports the deposit as source and the fill as destination on completion', async () => {
    const order = ORDER('completed', { quoteId: 'q_7e450ab4-935b-4f8d-a6c4-4987a3cd2831', id: 'ord_btc', sourceChain: 'bitcoin', sourceTxHash: 'f'.repeat(64), amountOut: '99000000' })
    const { fetch } = fakeFetch(routes([{ match: '/status', reply: () => ({ order }) }]))
    const a = flashnet(opts)
    const ctx = ctxFor(fetch)
    const q = await a.quote({ leg: transferLeg(), amountIn: btcIn, source: { chain: BITCOIN_MAINNET, token: 'native' } }, ctx)
    const step = await a.start({ leg: transferLeg(), quote: q }, ctx)
    const s = await a.status!({ leg: transferLeg(), ref: step.ref! }, ctx)
    expect(s.status).toBe('succeeded')
    expect(s.output?.value).toBe('99')
    expect(s.transactions).toEqual([
      { role: 'source', chain: BITCOIN_MAINNET, hash: 'f'.repeat(64) },
      { role: 'destination', chain: 'eip155:8453', hash: `0x${'ab'.repeat(32)}` },
    ])
  })

  it('refuses a source Flashnet does not take here', async () => {
    const { fetch } = fakeFetch(routes())
    await expect(
      flashnet(opts).quote({ leg: transferLeg(TRON_MAINNET, 'native'), amountIn: { value: '10', asset: { kind: 'crypto', chain: TRON_MAINNET, token: 'native' } }, source: { chain: TRON_MAINNET, token: 'native' } }, ctxFor(fetch)),
    ).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
  })
})
