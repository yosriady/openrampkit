import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildSettlementTxs, checkLegQuote, checkLegStep, hashSettlementCalls } from '@openrampkit/adapter'
import type { LegEvent, RouteContext } from '@openrampkit/adapter'
import { SOLANA_MAINNET, SOLANA_USDC_MINT, USDC, isSolanaAddress, planPathways, stateFor } from '@openrampkit/core'
import type { CryptoAsset, LegQuote, PathwayLeg } from '@openrampkit/core'
import { fakeFetch, makeCtx, memoryKV, runAdapterConformance } from '@openrampkit/adapter/testing'
import { mockAdapter, SIMULATED_DEPOSIT } from './index.js'

const DEST = '0x000000000000000000000000000000000000beef'
const BASE_USDC: CryptoAsset = { kind: 'crypto', chain: 'eip155:8453', token: USDC['eip155:8453']! }
const ARB_USDC: CryptoAsset = { kind: 'crypto', chain: 'eip155:42161', token: USDC['eip155:42161']! }
const fiat = (currency: string, amount: string) => ({ value: amount, asset: { kind: 'fiat' as const, currency } })
const toAddress = { asset: BASE_USDC, location: { kind: 'address' as const, address: DEST } }

const leg = (legId: string, from: PathwayLeg['from'], to: PathwayLeg['to'] = toAddress): PathwayLeg => ({ adapterId: 'mock', legId, from, to })
const cardLeg = leg('card', { asset: { kind: 'fiat', currency: 'USD' }, location: { kind: 'user_account' } })
const localLeg = leg('local', { asset: { kind: 'fiat', currency: 'VND' }, location: { kind: 'user_account' } })
const payinLeg = leg('payin', { asset: { kind: 'fiat', currency: 'IDR' }, location: { kind: 'user_account' } }, { asset: { kind: 'fiat', currency: 'IDR' }, location: { kind: 'merchant_account', merchantId: 'm1' } } as never)
const walletLeg = leg('wallet', { asset: ARB_USDC, location: { kind: 'user_wallet' } })
const transferLeg = leg('transfer', { asset: ARB_USDC, location: { kind: 'user_wallet' } })
const bridgeLeg = leg('bridge', { asset: BASE_USDC, location: { kind: 'address', address: 'deposit' } })

function routeCtx(shared = memoryKV()) {
  const events: LegEvent[] = []
  const ctx: RouteContext = { fetch: fakeFetch([]).fetch, log: makeCtx({ fetch: fakeFetch([]).fetch }).log, shared, baseUrl: 'https://app.test/api/openramp', applyEvent: async (e) => void events.push(e) }
  return { ctx, events, shared }
}

afterEach(() => vi.useRealTimers())

describe('mock adapter', () => {
  it('declares fiat legs by default, crypto and bridge legs on request', () => {
    expect(mockAdapter().legs.map((l) => l.id)).toEqual(['card', 'local', 'payin'])
    const all = mockAdapter({ crypto: true, bridge: true, name: 'Demo' })
    expect(all.legs.map((l) => l.id)).toEqual(['card', 'local', 'payin', 'wallet', 'transfer', 'bridge'])
    expect(all.name).toBe('Demo')
  })

  it('every leg passes runAdapterConformance from start to a terminal state', async () => {
    const report = await runAdapterConformance(mockAdapter({ settleMs: 0, crypto: true, bridge: true }), {
      fixtures: [
        { leg: cardLeg, quote: { amountIn: fiat('USD', '100') }, start: { deliverTo: { address: DEST } }, expect: { start: 'PAYMENT', status: 'PAYMENT' } },
        { leg: localLeg, quote: { amountIn: fiat('VND', '1000000') }, transitions: [{ name: 'simulate_payment' }], expect: { start: 'PAYMENT', status: 'COMPLETED' } },
        { leg: payinLeg, quote: { amountIn: fiat('IDR', '150000') }, transitions: [{ name: 'simulate_payment' }], expect: { status: 'COMPLETED' } },
        { leg: walletLeg, quote: { amountIn: { value: '10', asset: ARB_USDC } }, transitions: [{ name: 'submit_tx', inputs: { txHash: '0xabc' } }], expect: { status: 'COMPLETED' } },
        { leg: transferLeg, quote: { amountIn: { value: '10', asset: ARB_USDC } }, transitions: [{ name: 'simulate_deposit' }], expect: { status: 'COMPLETED' } },
        { leg: bridgeLeg, quote: { amountIn: { value: '10', asset: BASE_USDC } }, expect: { start: 'PROCESSING', status: 'COMPLETED' } },
      ],
    })
    expect(report.problems).toEqual([])
    // The wallet transaction that the user sent is the source of the leg.
    expect(report.steps.find((s) => s.transactions?.some((t) => t.role === 'source' && t.hash === '0xabc'))).toBeDefined()
    // The mock is its own provider: its order id is our ref.
    for (const s of report.steps) expect(s.providerRef).toBe(s.ref)
    // A completed crypto leg reports its (fake) delivery; a fiat payin has no onchain delivery.
    const done = report.steps.filter((s) => s.status === 'succeeded')
    expect(done).toHaveLength(5)
    for (const s of done) {
      if (s.output?.asset.kind === 'crypto') expect(s.transactions).toEqual([{ role: 'destination', chain: s.output.asset.chain, hash: expect.stringMatching(/^0x[0-9a-f]{64}$/) }])
      else expect(s.transactions).toBeUndefined()
    }
  })

  it('refuses live sessions, and escapes the provider name on the checkout page', async () => {
    const a = mockAdapter({ name: '<img src=x onerror=alert(1)>' })
    const live = makeCtx({ fetch: fakeFetch([]).fetch, session: { livemode: true } })
    await expect(a.quote({ leg: cardLeg, amountIn: fiat('USD', '10') }, live)).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    const test = makeCtx({ fetch: fakeFetch([]).fetch })
    const q = await a.quote({ leg: cardLeg, amountIn: fiat('USD', '10') }, test)
    await expect(a.start({ leg: cardLeg, quote: q }, live)).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    const { ctx } = routeCtx()
    const page = await (await a.routes!(new Request('https://app.test/api/openramp/adapters/mock/checkout?ref=r'), 'checkout', ctx))!.text()
    expect(page).not.toContain('<img')
    expect(page).toContain('&lt;img')
  })

  it('quotes fiat onramps with FX and fees, pay-ins in fiat, crypto legs 1:1 minus 5 bps', async () => {
    const a = mockAdapter({ crypto: true, bridge: true })
    const ctx = makeCtx({ fetch: fakeFetch([]).fetch })
    const card = await a.quote({ leg: cardLeg, amountIn: fiat('usd', '100') }, ctx)
    expect(card).toMatchObject({ input: { value: '100' }, output: { value: '97.500000', asset: { symbol: 'USDC', decimals: 6 } }, fees: [{ kind: 'provider', amount: { value: '2.50', asset: { kind: 'fiat', currency: 'USD' } }, included: true }], guarantee: 'firm' })
    expect(card.minOutput).toBeUndefined()
    const local = await a.quote({ leg: localLeg, amountIn: fiat('VND', '1000000') }, ctx)
    expect(local.output.value).toBe('39.105000')
    expect(local.fees[0]).toMatchObject({ amount: { asset: { kind: 'fiat', currency: 'VND' } }, included: true })
    expect(local.guarantee).toBe('firm')
    const payin = await a.quote({ leg: payinLeg, amountIn: fiat('IDR', '150000') }, ctx)
    expect(payin).toMatchObject({ input: { value: '150000' }, output: { value: '148950', asset: { kind: 'fiat', currency: 'IDR' } }, fees: [{ amount: { value: '1050', asset: { kind: 'fiat', currency: 'IDR' } } }], guarantee: 'firm' })
    // no amount: priced at zero with the leg currency
    expect((await a.quote({ leg: cardLeg }, ctx)).output.value).toBe('0.000000')
    const out = await a.quote({ leg: bridgeLeg, amountOut: { value: '20', asset: BASE_USDC } }, ctx)
    expect(out).toMatchObject({ input: { value: '20', asset: { symbol: 'USDC', decimals: 6 } }, output: { value: '19.990000' }, fees: [{ kind: 'bridge', amount: { value: '0.010000', asset: { symbol: 'USDC', decimals: 6 } }, included: true }] })
    // the bridge leg acts like a real bridge: at least output minus 0.5% (50 bps slippage)
    expect(out).toMatchObject({ guarantee: 'min_output', slippageBps: 50, minOutput: { value: '19.890050', asset: out.output.asset } })
    const transfer = await a.quote({ leg: transferLeg, amountIn: { value: '1', asset: { ...ARB_USDC, symbol: 'USDC.e', decimals: 6 } } }, ctx)
    expect(transfer.data).toEqual({ anyAmount: true })
    expect(transfer.input.asset).toMatchObject({ symbol: 'USDC.e' })
    // Arbitrum to Base is a bridge: min_output
    expect(transfer).toMatchObject({ guarantee: 'min_output', slippageBps: 50, fees: [{ kind: 'bridge', amount: { asset: { chain: ARB_USDC.chain, symbol: 'USDC.e' } } }] })
    // the same chain and token is a plain transfer: firm, no minOutput
    const plain = await a.quote({ leg: walletLeg, amountIn: { value: '10', asset: BASE_USDC } }, ctx)
    expect(plain).toMatchObject({ guarantee: 'firm', output: { value: '9.995000' }, fees: [{ kind: 'network' }] })
    expect(plain.minOutput).toBeUndefined()
    expect(plain.slippageBps).toBeUndefined()
    for (const q of [card, local, payin, out, transfer, plain]) expect(checkLegQuote(q)).toEqual([])
    // fiat destination: crypto legs still price in USDC on Base
    const merchant = makeCtx({ fetch: fakeFetch([]).fetch, destination: { type: 'merchant', merchantId: 'm', currency: 'USD' } as never })
    expect((await a.quote({ leg: bridgeLeg, amountIn: { value: '1', asset: BASE_USDC } }, merchant)).output.asset).toMatchObject({ chain: 'eip155:8453', symbol: 'USDC' })
  })

  it('errors: no FX rate is NO_QUOTES; unknown legs are NOT_FOUND', async () => {
    const a = mockAdapter()
    const ctx = makeCtx({ fetch: fakeFetch([]).fetch })
    await expect(a.quote({ leg: cardLeg, amountIn: fiat('XAF', '10') }, ctx)).rejects.toMatchObject({ status: 422, error: { code: 'NO_QUOTES', message: 'Test provider has no rate for XAF.' } })
    await expect(a.quote({ leg: { ...cardLeg, legId: 'nope' } }, ctx)).rejects.toMatchObject({ status: 404, error: { code: 'NOT_FOUND' } })
    const q = await a.quote({ leg: cardLeg, amountIn: fiat('USD', '10') }, ctx)
    await expect(a.start({ leg: { ...cardLeg, legId: 'nope' }, quote: q }, ctx)).rejects.toMatchObject({ status: 404 })
    await expect(a.transition!({ leg: cardLeg, ref: 'missing', name: 'simulate_payment' }, ctx)).rejects.toMatchObject({ status: 404, error: { message: 'Unknown mock order.' } })
    const step = await a.start({ leg: cardLeg, quote: q }, ctx)
    await expect(a.transition!({ leg: cardLeg, ref: step.ref!, name: 'refund' }, ctx)).rejects.toMatchObject({ status: 409, error: { code: 'BAD_REQUEST' } })
  })

  it('surfaces: card redirect URL, QR payload, wallet tx and deposit address', async () => {
    const a = mockAdapter({ crypto: true })
    const ctx = makeCtx({ fetch: fakeFetch([]).fetch, urls: { webhookUrl: 'https://app.test/api/openramp/webhooks/mock' } })
    const card = await a.start({ leg: cardLeg, quote: await a.quote({ leg: cardLeg, amountIn: fiat('USD', '25') }, ctx), deliverTo: { address: DEST } }, ctx)
    expect(card.action?.surface).toMatchObject({ kind: 'REDIRECT', popup: true, provider: 'Test provider' })
    const url = new URL((card.action?.surface as { url: string }).url)
    expect(url.origin + url.pathname).toBe('https://app.test/api/openramp/adapters/mock/checkout')
    expect(Object.fromEntries(url.searchParams)).toEqual({ ref: card.ref, amount: '25', currency: 'USD', to: DEST })

    const qr = await a.start({ leg: localLeg, quote: await a.quote({ leg: localLeg, amountIn: fiat('VND', '500000') }, ctx) }, ctx)
    expect(qr.action?.surface).toMatchObject({ kind: 'QR', payload: `MOCKQR|${qr.ref}|500000|VND`, amount: '500000', currency: 'VND', reference: qr.ref!.slice(-10).toUpperCase() })

    const walletQuote: LegQuote = { adapterId: 'mock', legId: 'wallet', input: fiat('USD', '5'), output: { value: '5', asset: BASE_USDC }, fees: [], guarantee: 'firm', eta: { min: 1, max: 2 }, expiresAt: new Date(Date.now() + 60_000).toISOString() }
    const w = await a.start({ leg: walletLeg, quote: walletQuote }, ctx)
    expect(w.action?.surface).toMatchObject({ kind: 'WALLET_TX', chain: 'eip155:8453', txs: [{ chainId: 8453, value: '0', data: '0x' }] })
    expect((w.action?.surface as { txs: Array<{ to: string }> }).txs[0]!.to).toMatch(/^0x[0-9a-f]{40}$/)
    const w2 = await a.start({ leg: walletLeg, quote: { ...walletQuote, input: { value: '5', asset: ARB_USDC } }, deliverTo: { address: DEST } }, ctx)
    expect(w2.action?.surface).toMatchObject({ chain: 'eip155:42161', txs: [{ to: DEST, chainId: 42161 }] })

    const t = await a.start({ leg: transferLeg, quote: { ...walletQuote, legId: 'transfer' } }, ctx)
    expect(t.action?.surface).toMatchObject({ kind: 'DEPOSIT_ADDRESS', chain: 'eip155:8453', chainName: 'Base', symbol: 'USDC', min: '1' })
    const t2 = await a.start({ leg: transferLeg, quote: { ...walletQuote, legId: 'transfer', input: { value: '1', asset: { ...ARB_USDC, symbol: 'USDT' } } } }, ctx)
    expect(t2.action?.surface).toMatchObject({ chain: 'eip155:42161', symbol: 'USDT', warning: 'Send only USDT on Arbitrum. This is a test address.' })
    // payin with a crypto input falls back to USD
    const p = await a.start({ leg: payinLeg, quote: { ...walletQuote, legId: 'payin' } }, ctx)
    expect(p.action?.surface).toMatchObject({ kind: 'QR', currency: 'USD' })
    const c2 = await a.start({ leg: cardLeg, quote: { ...walletQuote, input: { value: '5', asset: BASE_USDC } } }, ctx)
    expect(new URL((c2.action?.surface as { url: string }).url).searchParams.get('currency')).toBe('')
    for (const s of [card, qr, w, w2, t, t2, p, c2]) expect(checkLegStep(s)).toEqual([])
  })

  it('prepareDeposit gives a stable fake address per session and leg', async () => {
    const a = mockAdapter({ bridge: true })
    const ctx = makeCtx({ fetch: fakeFetch([]).fetch })
    const d1 = await a.prepareDeposit!({ leg: bridgeLeg }, ctx)
    expect(d1.address).toMatch(/^0x[0-9a-f]{40}$/)
    expect(await a.prepareDeposit!({ leg: bridgeLeg }, ctx)).toEqual(d1)
    expect((await a.prepareDeposit!({ leg: bridgeLeg }, makeCtx({ fetch: fakeFetch([]).fetch, session: { id: 'sess_other' } }))).address).not.toBe(d1.address)
  })

  it('status: waits, settles after settleMs, unknown refs wait', async () => {
    vi.useFakeTimers()
    const a = mockAdapter({ settleMs: 1000 })
    const ctx = makeCtx({ fetch: fakeFetch([]).fetch })
    const step = await a.start({ leg: localLeg, quote: await a.quote({ leg: localLeg, amountIn: fiat('VND', '100000') }, ctx) }, ctx)
    expect(step.providerRef).toBe(step.ref)
    // Not paid yet: a status poll keeps the QR (an action without a surface).
    const waiting = await a.status!({ leg: localLeg, ref: step.ref! }, ctx)
    expect(waiting).toMatchObject({ status: 'requires_action', action: { kind: 'payment', transitions: [{ kind: 'AWAIT' }] } })
    expect(waiting.action!.surface).toBeUndefined()
    expect(stateFor(waiting)).toBe('PAYMENT')
    await a.transition!({ leg: localLeg, ref: step.ref!, name: 'simulate_payment' }, ctx)
    const settling = await a.status!({ leg: localLeg, ref: step.ref! }, ctx)
    expect(settling).toMatchObject({ status: 'processing', detail: { code: 'settling' }, poll: { intervalMs: 1500 }, providerRef: step.ref })
    expect(stateFor(settling)).toBe('PROCESSING')
    vi.advanceTimersByTime(1000)
    const done = await a.status!({ leg: localLeg, ref: step.ref! }, ctx)
    expect(done).toMatchObject({ status: 'succeeded', output: { value: '3.910500' }, providerRef: step.ref })
    expect(stateFor(done)).toBe('COMPLETED')
    expect(done.transactions).toEqual([{ role: 'destination', chain: 'eip155:8453', hash: expect.stringMatching(/^0x[0-9a-f]{64}$/) }])
    // An unknown order is not processing: it keeps the current surface and polls.
    const unknown = await a.status!({ leg: localLeg, ref: 'unknown' }, ctx)
    expect(unknown).toMatchObject({ status: 'requires_action', action: { kind: 'payment' } })
    expect(unknown.providerRef).toBeUndefined()
  })

  it('routes: hosted checkout page (escaped), pay success and decline, unknown orders and paths', async () => {
    const a = mockAdapter({ name: 'Mock <Pay>' })
    const shared = memoryKV()
    const ctx = makeCtx({ fetch: fakeFetch([]).fetch, shared })
    const step = await a.start({ leg: cardLeg, quote: await a.quote({ leg: cardLeg, amountIn: fiat('USD', '10') }, ctx) }, ctx)
    const ref = step.ref!
    const r = routeCtx(shared)

    const page = await a.routes!(new Request(`https://app.test/api/openramp/adapters/mock/checkout?ref=${ref}&amount=10&currency=%3Cb%3E`), 'checkout', r.ctx)
    const html = await page!.text()
    expect(page!.headers.get('content-type')).toMatch(/text\/html/)
    expect(html).toContain('&lt;b&gt;')
    expect(html).not.toContain('<b>')
    expect(html).toContain('action="https://app.test/api/openramp/adapters/mock/pay"')
    expect(await (await a.routes!(new Request('https://app.test/x/checkout'), 'checkout', r.ctx))!.text()).toContain('Test mode')

    const post = (form: Record<string, string>) => {
      const body = new FormData()
      for (const [k, v] of Object.entries(form)) body.set(k, v)
      return a.routes!(new Request('https://app.test/api/openramp/adapters/mock/pay', { method: 'POST', body }), 'pay', r.ctx)
    }
    expect((await post({ ref: 'nope' }))!.status).toBe(404)
    expect(await (await post({ ref }))!.text()).toContain('Payment received')
    expect(r.events).toEqual([{ ref, providerRef: ref, status: 'processing', detail: { code: 'settling' } }])
    const declined = await a.start({ leg: cardLeg, quote: await a.quote({ leg: cardLeg, amountIn: fiat('USD', '10') }, ctx) }, ctx)
    expect(await (await post({ ref: declined.ref!, outcome: 'fail' }))!.text()).toContain('Payment declined')
    expect(r.events[1]).toMatchObject({ ref: declined.ref, providerRef: declined.ref, status: 'failed', error: { code: 'PAYMENT_FAILED' } })
    expect(await a.status!({ leg: cardLeg, ref: declined.ref! }, ctx)).toMatchObject({ status: 'failed', providerRef: declined.ref })
    // An unknown checkout outcome is refused: the order is not paid, and no event goes out.
    const other = await a.start({ leg: cardLeg, quote: await a.quote({ leg: cardLeg, amountIn: fiat('USD', '10') }, ctx) }, ctx)
    expect((await post({ ref: other.ref!, outcome: 'chargeback' }))!.status).toBe(400)
    expect(r.events).toHaveLength(2)
    const still = await a.status!({ leg: cardLeg, ref: other.ref! }, ctx)
    expect(still.status).toBe('requires_action')
    expect(still.status).not.toBe('processing')
    expect(await a.routes!(new Request('https://app.test/other'), 'other', r.ctx)).toBeUndefined()
    expect(await a.routes!(new Request('https://app.test/pay'), 'pay', r.ctx)).toBeUndefined()
  })
})

describe('mock offramp (withdraw to cash)', () => {
  const PHP = { asset: { kind: 'fiat' as const, currency: 'PHP' }, location: { kind: 'user_account' as const } }
  const offrampLeg = (method?: string): PathwayLeg => ({ ...leg('offramp', { asset: BASE_USDC, location: { kind: 'user_wallet' } }, PHP), ...(method ? { method } : {}) })
  const TX = `0x${'cd'.repeat(32)}`

  it('is added on request and runs FORM, WALLET_TX, then COMPLETED', async () => {
    const a = mockAdapter({ settleMs: 0, offramp: true })
    expect(a.legs.map((l) => l.id)).toEqual(['card', 'local', 'payin', 'offramp'])
    const report = await runAdapterConformance(a, {
      fixtures: [
        {
          leg: offrampLeg('gcash'),
          quote: { amountIn: { value: '50', asset: BASE_USDC } },
          transitions: [{ name: 'submit_details', inputs: { account_name: 'Juan', phone: '09171234567' } }, { name: 'submit_tx', inputs: { txHash: TX } }],
          expect: { start: 'PAYMENT', status: 'COMPLETED' },
        },
      ],
    })
    expect(report.problems).toEqual([])
    const [start, details, sent, done] = report.steps
    expect(start).toMatchObject({ detail: { code: 'payout_account' }, providerRef: start!.ref, action: { kind: 'payment', surface: { kind: 'FORM', fields: [{ id: 'account_name' }, { id: 'phone', label: 'GCash phone number' }] } } })
    expect(details).toMatchObject({ detail: { code: 'send_crypto' }, action: { kind: 'payment', surface: { kind: 'WALLET_TX', chain: 'eip155:8453', txs: [{ to: BASE_USDC.token, chainId: 8453 }] } } })
    expect(sent).toMatchObject({ status: 'processing', transactions: [{ role: 'source', hash: TX }] })
    expect(done).toMatchObject({ status: 'succeeded', output: { asset: { kind: 'fiat', currency: 'PHP' } } })
    // A fiat payout has no onchain delivery.
    expect(done!.transactions).toBeUndefined()
    expect(report.quotes[0]).toMatchObject({ input: { value: '50' }, output: { value: '2828.57', asset: { currency: 'PHP' } }, fees: [{ amount: { value: '0.500000', asset: { symbol: 'USDC', decimals: 6 } } }], guarantee: 'firm' })
  })

  it('quotes an exact fiat output, rejects unknown currencies, and has fields per payout method', async () => {
    const a = mockAdapter({ offramp: true })
    const ctx = makeCtx({ fetch: fakeFetch([]).fetch, destination: { type: 'fiat', currency: 'PHP' } })
    const out = await a.quote({ leg: offrampLeg(), amountOut: { value: '1000', asset: PHP.asset } }, ctx)
    expect(out.input.value).toBe('17.676768') // 1000 * 0.0175 / 0.99
    const noRate = { ...offrampLeg(), to: { asset: { kind: 'fiat' as const, currency: 'XYZ' }, location: { kind: 'user_account' as const } } }
    await expect(a.quote({ leg: noRate, amountIn: { value: '1', asset: BASE_USDC } }, ctx)).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
    const fields = async (method?: string) => {
      const q = await a.quote({ leg: offrampLeg(method), amountIn: { value: '10', asset: BASE_USDC } }, ctx)
      const s = await a.start({ leg: offrampLeg(method), quote: q }, ctx)
      return (s.action?.surface as { fields: Array<{ id: string; label: string }> }).fields
    }
    expect((await fields()).map((f) => f.id)).toEqual(['account_name', 'bank_name', 'account_number'])
    expect((await fields('promptpay'))[1]!.label).toMatch(/PromptPay/)
    expect((await fields('momo'))[1]!.label).toBe('MoMo phone number')
    expect((await fields('ovo'))[1]!.label).toBe('E-wallet phone number')
  })

  it('checks the payout form, keeps the step on status polls, and refuses a second form', async () => {
    const a = mockAdapter({ offramp: true })
    const ctx = makeCtx({ fetch: fakeFetch([]).fetch })
    const l = offrampLeg('bank_transfer')
    const q = await a.quote({ leg: l, amountIn: { value: '10', asset: BASE_USDC } }, ctx)
    const { ref } = await a.start({ leg: l, quote: q }, ctx)
    const t = (name: string, inputs?: Record<string, unknown>) => a.transition!({ leg: l, ref: ref!, name, ...(inputs ? { inputs } : {}) }, ctx)
    expect((await a.status!({ leg: l, ref: ref! }, ctx)).action?.surface?.kind).toBe('FORM')
    await expect(t('submit_tx', { txHash: TX })).rejects.toMatchObject({ status: 409 })
    await expect(t('submit_details', { account_name: 'A', bank_name: 'B' })).rejects.toMatchObject({ error: { message: 'Enter the account number.' } })
    await expect(t('submit_details', { account_name: 'A', bank_name: 'B', account_number: '1!' })).rejects.toMatchObject({ error: { message: 'Enter a valid account number.' } })
    await t('submit_details', { account_name: 'A', bank_name: 'B', account_number: '12345678' })
    expect((await a.status!({ leg: l, ref: ref! }, ctx)).action?.surface?.kind).toBe('WALLET_TX')
    await expect(t('submit_details', { account_name: 'A', bank_name: 'B', account_number: '12345678' })).resolves.toMatchObject({ action: { surface: { kind: 'WALLET_TX' } } })
    await t('submit_tx', { txHash: TX })
    await expect(t('submit_details', { account_name: 'A', bank_name: 'B', account_number: '12345678' })).rejects.toMatchObject({ status: 409 })
  })

  describe('localChain (onchain leg)', () => {
    const RPC = 'http://127.0.0.1:8545/'
    const TOKEN = '0x5fbdb2315678afecb367f032d93f642f64180aa3'
    const ANVIL_USDC: CryptoAsset = { kind: 'crypto', chain: 'eip155:31337', token: TOKEN, symbol: 'USDC', decimals: 6 }
    const onchainLeg = leg('onchain', { asset: ANVIL_USDC, location: { kind: 'user_wallet' } }, { asset: ANVIL_USDC, location: { kind: 'address', address: DEST } })
    const destination = { type: 'crypto' as const, chain: 'eip155:31337', token: TOKEN, address: DEST }
    const HASH = `0x${'ab'.repeat(32)}`
    const transferLog = (to: string, amount: bigint, token = TOKEN) => ({
      address: token,
      topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', `0x${'00'.repeat(12)}${'11'.repeat(20)}`, `0x${to.slice(2).padStart(64, '0')}`],
      data: `0x${amount.toString(16).padStart(64, '0')}`,
    })

    function setup(receipt: unknown) {
      const rpc = fakeFetch([{ method: 'POST', match: RPC, reply: (c) => ({ jsonrpc: '2.0', id: 1, result: (c.body as { method: string }).method === 'eth_getTransactionReceipt' ? receipt : null }) }])
      const a = mockAdapter({ localChain: { chain: 'eip155:31337', rpcUrl: RPC, token: TOKEN.toUpperCase().replace('0X', '0x') } })
      const ctx = makeCtx({ fetch: rpc.fetch, destination })
      return { a, ctx, rpc }
    }

    it('declares a wallet leg on the local chain and quotes it 1:1 with no fee', async () => {
      const { a, ctx } = setup(null)
      expect(a.legs.map((l) => l.id)).toEqual(['card', 'local', 'payin', 'onchain'])
      expect(a.legs.find((l) => l.id === 'onchain')).toMatchObject({ methods: ['wallet'], surfaces: ['WALLET_TX'], from: { asset: { chains: { 'eip155:31337': [TOKEN] } } } })
      const q = await a.quote({ leg: onchainLeg, amountIn: { value: '25', asset: ANVIL_USDC } }, ctx)
      expect(checkLegQuote(q)).toEqual([])
      expect(q).toMatchObject({ input: { value: '25', asset: ANVIL_USDC }, output: { value: '25', asset: ANVIL_USDC }, fees: [], guarantee: 'firm' })
    })

    it('asks for an ERC-20 transfer to the destination and completes when the receipt pays it', async () => {
      const { a, ctx, rpc } = setup({ status: '0x1', logs: [transferLog(DEST, 25_000_000n)] })
      const q = await a.quote({ leg: onchainLeg, amountIn: { value: '25', asset: ANVIL_USDC } }, ctx)
      const start = await a.start({ leg: onchainLeg, quote: q, deliverTo: { address: DEST } }, ctx)
      expect(checkLegStep(start)).toEqual([])
      // A plain chain transfer: no provider order, so no providerRef.
      expect(start.providerRef).toBeUndefined()
      expect(start.action?.surface).toEqual({
        kind: 'WALLET_TX',
        chain: 'eip155:31337',
        txs: [{ to: TOKEN, data: `0xa9059cbb${DEST.slice(2).padStart(64, '0')}${(25_000_000).toString(16).padStart(64, '0')}`, value: '0', chainId: 31337 }],
      })
      await expect(a.status!({ leg: onchainLeg, ref: start.ref! }, ctx)).resolves.toMatchObject({ status: 'requires_action', action: { kind: 'payment', surface: { kind: 'WALLET_TX' } } })
      await expect(a.transition!({ leg: onchainLeg, ref: start.ref!, name: 'submit_tx', inputs: { txHash: '0xabc' } }, ctx)).rejects.toMatchObject({ status: 400 })
      const done = await a.transition!({ leg: onchainLeg, ref: start.ref!, name: 'submit_tx', inputs: { txHash: HASH } }, ctx)
      // One same-chain transfer pays into the leg and delivers it: both roles, one hash.
      expect(done).toMatchObject({
        status: 'succeeded',
        output: { value: '25' },
        transactions: [{ role: 'source', chain: 'eip155:31337', hash: HASH }, { role: 'destination', chain: 'eip155:31337', hash: HASH }],
      })
      expect(rpc.calls.at(-1)!.body).toMatchObject({ method: 'eth_getTransactionReceipt', params: [HASH] })
      await expect(a.status!({ leg: onchainLeg, ref: start.ref! }, ctx)).resolves.toMatchObject({ status: 'succeeded' })
    })

    it('stays PROCESSING without a receipt and fails a reverted, short, reused or unrelated transaction', async () => {
      const run = async (receipt: unknown, shared = memoryKV(), sessionId = 'sess_1') => {
        const { a, ctx } = setup(receipt)
        const c = { ...ctx, shared, session: { ...ctx.session, id: sessionId } }
        const q = await a.quote({ leg: onchainLeg, amountIn: { value: '25', asset: ANVIL_USDC } }, c)
        const start = await a.start({ leg: onchainLeg, quote: q, deliverTo: { address: DEST } }, c)
        return a.transition!({ leg: onchainLeg, ref: start.ref!, name: 'submit_tx', inputs: { txHash: HASH } }, c)
      }
      await expect(run(null)).resolves.toMatchObject({ status: 'processing', detail: { code: 'confirming' }, transactions: [{ role: 'source', hash: HASH }] })
      await expect(run({ status: '0x0', logs: [] })).resolves.toMatchObject({ status: 'failed', error: { message: 'The transaction failed on chain.' } })
      await expect(run({ status: '0x1', logs: [transferLog(DEST, 24_999_999n)] })).resolves.toMatchObject({ status: 'failed', error: { message: /quoted amount/ } })
      await expect(run({ status: '0x1', logs: [transferLog(DEST, 25_000_000n, `0x${'22'.repeat(20)}`)] })).resolves.toMatchObject({ status: 'failed' })
      const shared = memoryKV()
      const ok = { status: '0x1', logs: [transferLog(DEST, 25_000_000n)] }
      await expect(run(ok, shared)).resolves.toMatchObject({ status: 'succeeded' })
      await expect(run(ok, shared, 'sess_2')).resolves.toMatchObject({ status: 'failed', error: { message: /already used/ } })
    })

    describe('with a destination settlement contract', () => {
      const CONTRACT = '0xbf66696115128b8f9f794780061348b4213a7132'
      const VAULT = '0xa83fe1b79ced7772f5d90d19833b2fdd844c7801'
      const PAYER = `0x${'11'.repeat(20)}`
      const word = (v: string | bigint) => (typeof v === 'bigint' ? v.toString(16) : v.toLowerCase().replace(/^0x/, '')).padStart(64, '0')
      const depositCall = { to: VAULT, data: `0x6e553f65${word(25_000_000n)}${word(DEST)}` }

      /** A fake chain: `settled` gives the stored receipt (amount, recipient, calls hash), `receipt` the tx receipt. */
      function chainSetup(p: { settled?: { amount: bigint; recipient?: string; callsHash?: string }; receipt?: unknown; calls?: Array<{ to: string; data: string }> }) {
        const rpc = fakeFetch([
          {
            method: 'POST',
            match: RPC,
            reply: (c) => {
              const { method } = c.body as { method: string }
              const st = p.settled
              let result: unknown = null
              if (method === 'eth_blockNumber') result = '0x10'
              if (method === 'eth_call') result = `0x${word(st ? PAYER : 0n)}${word(st ? 1_700_000_000n : 0n)}${word(st ? TOKEN : 0n)}${word(st ? (st.recipient ?? DEST) : 0n)}${word(st ? st.amount : 0n)}`
              if (method === 'eth_getLogs') result = st ? [{ data: `0x${word(DEST)}${word(TOKEN)}${word(st.callsHash ?? hashSettlementCalls((p.calls ?? []).map((x) => ({ target: x.to, data: x.data }))))}`, topics: [], transactionHash: HASH, blockNumber: '0x11' }] : []
              if (method === 'eth_getTransactionReceipt') result = p.receipt ?? null
              return { jsonrpc: '2.0', id: 1, result }
            },
          },
        ])
        const a = mockAdapter({ localChain: { chain: 'eip155:31337', rpcUrl: RPC, token: TOKEN } })
        const ctx = makeCtx({ fetch: rpc.fetch, destination: { ...destination, settlement: { contract: CONTRACT }, ...(p.calls ? { calls: p.calls } : {}) } })
        return { a, ctx, rpc }
      }

      async function begin(p: Parameters<typeof chainSetup>[0]) {
        const { a, ctx, rpc } = chainSetup(p)
        const q = await a.quote({ leg: onchainLeg, amountIn: { value: '25', asset: ANVIL_USDC } }, ctx)
        const start = await a.start({ leg: onchainLeg, quote: q, deliverTo: { address: DEST } }, ctx)
        return { a, ctx, rpc, start }
      }

      it('declares the settlement capability on the onchain leg', () => {
        const a = mockAdapter({ localChain: { chain: 'eip155:31337', rpcUrl: RPC, token: TOKEN } })
        expect(a.legs.find((l) => l.id === 'onchain')!.capabilities).toContain('settlement')
      })

      it('asks for approve + settle for the session, with the destination calls', async () => {
        const { ctx, start } = await begin({ calls: [depositCall] })
        expect(checkLegStep(start)).toEqual([])
        const expected = buildSettlementTxs({
          chainId: 31337, contract: CONTRACT, sessionId: ctx.session.id, token: TOKEN, amount: 25_000_000n, recipient: DEST,
          calls: [{ target: VAULT, data: depositCall.data }],
        })
        expect(start.action?.surface).toEqual({ kind: 'WALLET_TX', chain: 'eip155:31337', txs: expected })
        expect(start.action!.transitions.map((t) => t.name)).toEqual(['submit_tx', 'poll'])
      })

      it('completes by session id when the contract has a matching receipt, even before a hash arrives', async () => {
        const { a, ctx, start } = await begin({ settled: { amount: 25_000_000n } })
        // The settle transaction delivers through the contract: role settlement (and it paid in: source).
        const settled = [{ role: 'source', chain: 'eip155:31337', hash: HASH }, { role: 'settlement', chain: 'eip155:31337', hash: HASH }]
        await expect(a.status!({ leg: onchainLeg, ref: start.ref! }, ctx)).resolves.toMatchObject({ status: 'succeeded', transactions: settled, output: { value: '25' } })
        const done = await a.transition!({ leg: onchainLeg, ref: start.ref!, name: 'submit_tx', inputs: { txHash: `0x${'cd'.repeat(32)}` } }, ctx)
        // The hash comes from the Settled log, not from the browser.
        expect(done).toMatchObject({ status: 'succeeded', transactions: settled })
      })

      it('waits without a receipt, and fails a reverted tx, a tx that did not settle, or a wrong settlement', async () => {
        const submit = async (p: Parameters<typeof chainSetup>[0]) => {
          const { a, ctx, start } = await begin(p)
          return a.transition!({ leg: onchainLeg, ref: start.ref!, name: 'submit_tx', inputs: { txHash: HASH } }, ctx)
        }
        await expect(submit({})).resolves.toMatchObject({ status: 'processing', detail: { code: 'confirming' }, transactions: [{ role: 'source', hash: HASH }] })
        await expect(submit({ receipt: { status: '0x0', logs: [] } })).resolves.toMatchObject({ status: 'failed', error: { message: 'The transaction failed on chain.' } })
        await expect(submit({ receipt: { status: '0x1', logs: [] } })).resolves.toMatchObject({ status: 'failed', error: { message: /did not settle this session/ } })
        await expect(submit({ settled: { amount: 24_000_000n } })).resolves.toMatchObject({ status: 'failed', error: { message: /less than the quoted amount/ } })
        await expect(submit({ settled: { amount: 25_000_000n, recipient: `0x${'22'.repeat(20)}` } })).resolves.toMatchObject({ status: 'failed', error: { message: /different recipient/ } })
        await expect(submit({ settled: { amount: 25_000_000n, callsHash: `0x${'33'.repeat(32)}` }, calls: [depositCall] })).resolves.toMatchObject({ status: 'failed', error: { message: /different destination calls/ } })
      })

      it('searches the Settled log from the block at which the leg started', async () => {
        const { a, ctx, rpc, start } = await begin({ settled: { amount: 25_000_000n } })
        await a.status!({ leg: onchainLeg, ref: start.ref! }, ctx)
        const logs = rpc.calls.find((c) => (c.body as { method: string }).method === 'eth_getLogs')!
        expect((logs.body as { params: Array<{ fromBlock: string }> }).params[0]!.fromBlock).toBe('0x10')
      })
    })
  })
})

describe('mock adapter: Solana', () => {
  const SOL = SOLANA_MAINNET
  const SOL_DEST = '7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ'
  const SOL_USDC: CryptoAsset = { kind: 'crypto', chain: SOL, token: SOLANA_USDC_MINT }
  const solDest = { type: 'crypto' as const, chain: SOL, token: SOLANA_USDC_MINT, address: SOL_DEST }

  it('plans a card > bridge pathway to USDC on Solana, and the bridge delivers the Solana mint', async () => {
    const a = mockAdapter({ settleMs: 0, crypto: true, bridge: true })
    const plan = planPathways({ direction: 'deposit', destination: solDest, user: { country: 'ID' }, legs: a.legs.map((spec) => ({ adapterId: 'mock', provider: 'Test provider', spec })) })
    const ids = plan.pathways.map((p) => p.id)
    expect(ids).toContain('card:mock.card>mock.bridge@eip155:8453')
    expect(ids).toContain('qris:mock.local>mock.bridge@eip155:8453')
    const ctx = makeCtx({ fetch: fakeFetch([]).fetch, destination: solDest })
    const bridge = leg('bridge', { asset: BASE_USDC, location: { kind: 'address', address: 'deposit' } }, { asset: SOL_USDC, location: { kind: 'address', address: SOL_DEST } })
    const q = await a.quote({ leg: bridge, amountIn: { value: '10', asset: BASE_USDC } }, ctx)
    expect(q.output.asset).toMatchObject({ chain: SOL, token: SOLANA_USDC_MINT, decimals: 6 })
  })

  it('wallet leg from Solana gives a Solana transfer; transfer leg shows a base58 deposit address', async () => {
    const a = mockAdapter({ settleMs: 0, crypto: true })
    const ctx = makeCtx({ fetch: fakeFetch([]).fetch, destination: solDest })
    const to = { asset: SOL_USDC, location: { kind: 'address' as const, address: SOL_DEST } }
    const solWallet = leg('wallet', { asset: SOL_USDC, location: { kind: 'user_wallet' } }, to)
    const q = await a.quote({ leg: solWallet, amountIn: { value: '2.5', asset: { ...SOL_USDC, decimals: 6 } } }, ctx)
    const w = await a.start({ leg: solWallet, quote: q, deliverTo: { address: SOL_DEST } }, ctx)
    expect(w.action?.surface).toEqual({ kind: 'WALLET_TX', chain: SOL, txs: [{ kind: 'solana', type: 'transfer', to: SOL_DEST, mint: SOLANA_USDC_MINT, amount: '2500000', decimals: 6 }] })
    const native = { kind: 'crypto' as const, chain: SOL, token: 'native' }
    const nq = await a.quote({ leg: solWallet, amountIn: { value: '1', asset: native } }, ctx)
    expect(nq.input.asset).toMatchObject({ symbol: 'SOL', decimals: 9 })
    const t = await a.start({ leg: leg('transfer', { asset: SOL_USDC, location: { kind: 'user_wallet' } }, to), quote: { ...q, legId: 'transfer' } }, ctx)
    expect(t.action?.surface).toMatchObject({ kind: 'DEPOSIT_ADDRESS', chain: SOL, chainName: 'Solana', symbol: 'USDC' })
    expect(isSolanaAddress((t.action?.surface as { address: string }).address)).toBe(true)
    for (const s of [w, t]) expect(checkLegStep(s)).toEqual([])
  })

  it('the mock offramp takes EVM USDC only', () => {
    const off = mockAdapter({ offramp: true }).legs.find((l) => l.id === 'offramp')!
    const chains = Object.keys((off.from.asset as { chains: Record<string, string[]> }).chains)
    expect(chains).not.toContain(SOL)
    expect(chains).toContain('eip155:8453')
  })
})

describe('mock adapter: several instances (demo options)', () => {
  const VN_DEST = { type: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']!, address: DEST }

  it('keeps the defaults when no new option is given', () => {
    const a = mockAdapter({ crypto: true })
    expect(a.id).toBe('mock')
    expect(a.legs.find((l) => l.id === 'card')).toMatchObject({ surfaces: ['REDIRECT'], eta: { min: 60, max: 300 }, regions: { allow: ['*'] } })
    expect(a.legs.find((l) => l.id === 'transfer')!.methods).toEqual(['transfer'])
  })

  it('id, fees, spread and eta: quotes carry the id and differ per instance', async () => {
    const ctx = makeCtx({ fetch: fakeFetch([]).fetch })
    const cheap = mockAdapter({ id: 'mock-b', name: 'Mock B', feeBps: { local: 40, card: 100, offramp: 50, crypto: 0, payin: 0 }, spreadBps: 100, eta: { local: { min: 5, max: 30 } } })
    expect(cheap.id).toBe('mock-b')
    expect(cheap.legs.find((l) => l.id === 'local')!.eta).toEqual({ min: 5, max: 30 })
    const local = await cheap.quote({ leg: { ...localLeg, adapterId: 'mock-b' }, amountIn: fiat('VND', '1000000') }, ctx)
    // 1,000,000 VND x 0.0000395 = 39.5 USD; spread 1% gives 39.105; fee 0.4% gives 38.94858
    expect(local).toMatchObject({ adapterId: 'mock-b', output: { value: '38.948580' }, fees: [{ label: 'Mock B fee' }] })
    const card = await cheap.quote({ leg: { ...cardLeg, adapterId: 'mock-b' }, amountIn: fiat('USD', '100') }, ctx)
    expect(card.output.value).toBe('98.010000')
    const payin = await cheap.quote({ leg: { ...payinLeg, adapterId: 'mock-b' }, amountIn: fiat('IDR', '150000') }, ctx)
    expect(payin.output.value).toBe('150000')
    for (const q of [local, card, payin]) expect(checkLegQuote(q)).toEqual([])
  })

  it('methods and countries narrow the legs; legs with no methods left are dropped', () => {
    const a = mockAdapter({ methods: ['vietqr', 'qris'], countries: ['VN', 'US'] })
    expect(a.legs.map((l) => l.id)).toEqual(['local', 'payin'])
    expect(a.legs[0]).toMatchObject({ methods: ['vietqr', 'qris'], regions: { allow: ['VN'] } })
    expect(a.legs[1]).toMatchObject({ methods: ['qris', 'vietqr'], regions: { allow: ['VN', 'US'] } })
    const cards = mockAdapter({ methods: ['card', 'apple_pay', 'google_pay'], crypto: true })
    expect(cards.legs.map((l) => l.id)).toEqual(['card', 'payin'])
    expect(mockAdapter({ countries: ['FR'] }).legs.map((l) => l.id)).toEqual(['card', 'payin'])
  })

  it('several instances give several VietQR pathways, one per provider', () => {
    const adapters = [
      mockAdapter({ id: 'mock', name: 'Mock Onramp A' }),
      mockAdapter({ id: 'mock-b', name: 'Mock Onramp B', methods: ['card', 'vietqr'] }),
      mockAdapter({ id: 'mock-local', name: 'Mock Local Rails', methods: ['vietqr'], countries: ['VN'] }),
      mockAdapter({ id: 'mock-card', name: 'Mock Card Onramp', methods: ['card'] }),
    ]
    const legs = adapters.flatMap((a) => a.legs.map((spec) => ({ adapterId: a.id, provider: a.name, spec })))
    const plan = planPathways({ direction: 'deposit', destination: VN_DEST, user: { country: 'VN' }, legs })
    expect(plan.methods.find((m) => m.method === 'vietqr')!.providers).toEqual(['Mock Onramp A', 'Mock Onramp B', 'Mock Local Rails'])
    expect(plan.methods.find((m) => m.method === 'card')!.providers).toEqual(['Mock Onramp A', 'Mock Onramp B', 'Mock Card Onramp'])
  })

  it('routes use the instance id: checkout URL and pay form action', async () => {
    const a = mockAdapter({ id: 'mock-b' })
    const ctx = makeCtx({ fetch: fakeFetch([]).fetch, urls: { webhookUrl: 'https://app.test/api/openramp/webhooks/mock-b' } })
    const q = await a.quote({ leg: { ...cardLeg, adapterId: 'mock-b' }, amountIn: fiat('USD', '25') }, ctx)
    const step = await a.start({ leg: { ...cardLeg, adapterId: 'mock-b' }, quote: q }, ctx)
    const url = new URL((step.action?.surface as { url: string }).url)
    expect(url.origin + url.pathname).toBe('https://app.test/api/openramp/adapters/mock-b/checkout')
    const { ctx: rctx } = routeCtx()
    const page = await (await a.routes!(new Request(`https://app.test/api/openramp/adapters/mock-b/checkout?ref=${step.ref}`), 'checkout', rctx))!.text()
    expect(page).toContain('action="https://app.test/api/openramp/adapters/mock-b/pay"')
  })

  it('cardCheckout form: test card fields in the widget, pay, decline and validation', async () => {
    vi.useFakeTimers()
    const a = mockAdapter({ cardCheckout: 'form', settleMs: 1000 })
    expect(a.legs.find((l) => l.id === 'card')!.surfaces).toEqual(['FORM'])
    const ctx = makeCtx({ fetch: fakeFetch([]).fetch })
    const q = await a.quote({ leg: cardLeg, amountIn: fiat('USD', '50') }, ctx)
    const step = await a.start({ leg: cardLeg, quote: q }, ctx)
    expect(step).toMatchObject({ status: 'requires_action', detail: { code: 'card_details' }, providerRef: step.ref, action: { kind: 'payment', surface: { kind: 'FORM' }, transitions: [{ name: 'pay_card', kind: 'SUBMIT', label: 'Pay (test mode)' }] } })
    expect((step.action?.surface as { fields: Array<{ id: string }> }).fields.map((f) => f.id)).toEqual(['card_number', 'expiry', 'cvc'])
    expect(checkLegStep(step)).toEqual([])
    // A status poll keeps the form on screen
    expect(await a.status!({ leg: cardLeg, ref: step.ref! }, ctx)).toMatchObject({ action: { surface: { kind: 'FORM' } } })
    const pay = (inputs: Record<string, string>, ref = step.ref!) => a.transition!({ leg: cardLeg, ref, name: 'pay_card', inputs }, ctx)
    await expect(pay({ card_number: '42', expiry: '12/30', cvc: '123' })).rejects.toMatchObject({ status: 400, error: { message: 'Enter a valid card number.' } })
    await expect(pay({ card_number: '4242 4242 4242 4242', expiry: '13/30', cvc: '123' })).rejects.toMatchObject({ error: { message: 'Enter the expiry as MM/YY.' } })
    await expect(pay({ card_number: '4242 4242 4242 4242', expiry: '12/30', cvc: '1' })).rejects.toMatchObject({ error: { message: 'Enter a valid CVC.' } })
    expect(await pay({ card_number: '4242 4242 4242 4242', expiry: '12/30', cvc: '123' })).toMatchObject({ status: 'processing', detail: { code: 'settling' } })
    await expect(pay({ card_number: '4242 4242 4242 4242', expiry: '12/30', cvc: '123' })).rejects.toMatchObject({ status: 409 })
    vi.advanceTimersByTime(1000)
    expect(await a.status!({ leg: cardLeg, ref: step.ref! }, ctx)).toMatchObject({ status: 'succeeded' })
    // The decline test card fails the payment
    const s2 = await a.start({ leg: cardLeg, quote: q }, ctx)
    expect(await pay({ card_number: '4000 0000 0000 0002', expiry: '12/30', cvc: '123' }, s2.ref!)).toMatchObject({ status: 'failed', error: { code: 'PAYMENT_FAILED' } })
    // Without the form option the transition is refused
    const r = mockAdapter()
    const s3 = await r.start({ leg: cardLeg, quote: q }, ctx)
    await expect(r.transition!({ leg: cardLeg, ref: s3.ref!, name: 'pay_card', inputs: {} }, ctx)).rejects.toMatchObject({ status: 409 })
  })

  it('exchange: the transfer leg also offers exchange_transfer, with exchange copy on the deposit address', async () => {
    const a = mockAdapter({ crypto: true, exchange: true })
    expect(a.legs.find((l) => l.id === 'transfer')!.methods).toEqual(['transfer', 'exchange_transfer'])
    expect(mockAdapter({ exchange: true }).legs.some((l) => l.id === 'transfer')).toBe(false)
    const ctx = makeCtx({ fetch: fakeFetch([]).fetch })
    const q = await a.quote({ leg: transferLeg, amountIn: { value: '1', asset: { ...ARB_USDC, symbol: 'USDC' } } }, ctx)
    const step = await a.start({ leg: { ...transferLeg, method: 'exchange_transfer' }, quote: q }, ctx)
    expect(step.action?.surface).toMatchObject({ kind: 'DEPOSIT_ADDRESS', warning: 'In your exchange, withdraw USDC and choose the Arbitrum network. This is a test address.' })
    expect(await a.transition!({ leg: transferLeg, ref: step.ref!, name: 'simulate_deposit' }, ctx)).toMatchObject({ status: 'processing' })
  })

  it('exchange: a deposit with no amount up front reports the simulated amount that arrived', async () => {
    const a = mockAdapter({ crypto: true, exchange: true, settleMs: 0 })
    const ctx = makeCtx({ fetch: fakeFetch([]).fetch })
    const q = await a.quote({ leg: transferLeg, amountIn: { value: '0', asset: { ...ARB_USDC, symbol: 'USDC' } } }, ctx)
    const step = await a.start({ leg: { ...transferLeg, method: 'exchange_transfer' }, quote: q }, ctx)
    await a.transition!({ leg: transferLeg, ref: step.ref!, name: 'simulate_deposit' }, ctx)
    expect(await a.status!({ leg: transferLeg, ref: step.ref! }, ctx)).toMatchObject({ status: 'succeeded', output: { value: SIMULATED_DEPOSIT } })
    // A quote with an amount keeps that amount.
    const q2 = await a.quote({ leg: transferLeg, amountIn: { value: '10', asset: { ...ARB_USDC, symbol: 'USDC' } } }, ctx)
    const s2 = await a.start({ leg: transferLeg, quote: q2 }, ctx)
    await a.transition!({ leg: transferLeg, ref: s2.ref!, name: 'simulate_deposit' }, ctx)
    expect((await a.status!({ leg: transferLeg, ref: s2.ref! }, ctx)).output?.value).toBe(q2.output.value)
  })
})
