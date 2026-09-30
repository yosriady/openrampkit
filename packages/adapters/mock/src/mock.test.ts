import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkLegQuote, checkLegStep } from '@openrampkit/adapter'
import type { LegEvent, RouteContext } from '@openrampkit/adapter'
import { SOLANA_MAINNET, SOLANA_USDC_MINT, USDC, isSolanaAddress, planPathways } from '@openrampkit/core'
import type { CryptoAsset, LegQuote, PathwayLeg } from '@openrampkit/core'
import { fakeFetch, makeCtx, memoryKV, runAdapterConformance } from '@openrampkit/adapter/testing'
import { mockAdapter } from './index.js'

const DEST = '0x000000000000000000000000000000000000beef'
const BASE_USDC: CryptoAsset = { kind: 'crypto', chain: 'eip155:8453', token: USDC['eip155:8453']! }
const ARB_USDC: CryptoAsset = { kind: 'crypto', chain: 'eip155:42161', token: USDC['eip155:42161']! }
const fiat = (currency: string, amount: string) => ({ amount, asset: { kind: 'fiat' as const, currency } })
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
        { leg: walletLeg, quote: { amountIn: { amount: '10', asset: ARB_USDC } }, transitions: [{ name: 'submit_tx', inputs: { txHash: '0xabc' } }], expect: { status: 'COMPLETED' } },
        { leg: transferLeg, quote: { amountIn: { amount: '10', asset: ARB_USDC } }, transitions: [{ name: 'simulate_deposit' }], expect: { status: 'COMPLETED' } },
        { leg: bridgeLeg, quote: { amountIn: { amount: '10', asset: BASE_USDC } }, expect: { start: 'PROCESSING', status: 'COMPLETED' } },
      ],
    })
    expect(report.problems).toEqual([])
    expect(report.steps.find((s) => s.txHash === '0xabc')).toBeDefined()
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
    expect(card).toMatchObject({ input: { amount: '100' }, output: { amount: '97.500000', asset: { symbol: 'USDC', decimals: 6 } }, fees: [{ amount: '2.50', currency: 'USD' }] })
    const local = await a.quote({ leg: localLeg, amountIn: fiat('VND', '1000000') }, ctx)
    expect(local.output.amount).toBe('39.105000')
    expect(local.fees[0]).toMatchObject({ currency: 'VND' })
    const payin = await a.quote({ leg: payinLeg, amountIn: fiat('IDR', '150000') }, ctx)
    expect(payin).toMatchObject({ input: { amount: '150000' }, output: { amount: '148950', asset: { kind: 'fiat', currency: 'IDR' } }, fees: [{ amount: '1050' }] })
    // no amount: priced at zero with the leg currency
    expect((await a.quote({ leg: cardLeg }, ctx)).output.amount).toBe('0.000000')
    const out = await a.quote({ leg: bridgeLeg, amountOut: { amount: '20', asset: BASE_USDC } }, ctx)
    expect(out).toMatchObject({ input: { amount: '20', asset: { symbol: 'USDC', decimals: 6 } }, output: { amount: '19.990000' }, fees: [{ amount: '0.010000' }] })
    const transfer = await a.quote({ leg: transferLeg, amountIn: { amount: '1', asset: { ...ARB_USDC, symbol: 'USDC.e', decimals: 6 } } }, ctx)
    expect(transfer.data).toEqual({ anyAmount: true })
    expect(transfer.input.asset).toMatchObject({ symbol: 'USDC.e' })
    for (const q of [card, local, payin, out, transfer]) expect(checkLegQuote(q)).toEqual([])
    // fiat destination: crypto legs still price in USDC on Base
    const merchant = makeCtx({ fetch: fakeFetch([]).fetch, destination: { type: 'merchant', merchantId: 'm', currency: 'USD' } as never })
    expect((await a.quote({ leg: bridgeLeg, amountIn: { amount: '1', asset: BASE_USDC } }, merchant)).output.asset).toMatchObject({ chain: 'eip155:8453', symbol: 'USDC' })
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
    expect(card.surface).toMatchObject({ kind: 'REDIRECT', popup: true, provider: 'Test provider' })
    const url = new URL((card.surface as { url: string }).url)
    expect(url.origin + url.pathname).toBe('https://app.test/api/openramp/adapters/mock/checkout')
    expect(Object.fromEntries(url.searchParams)).toEqual({ ref: card.ref, amount: '25', currency: 'USD', to: DEST })

    const qr = await a.start({ leg: localLeg, quote: await a.quote({ leg: localLeg, amountIn: fiat('VND', '500000') }, ctx) }, ctx)
    expect(qr.surface).toMatchObject({ kind: 'QR', payload: `MOCKQR|${qr.ref}|500000|VND`, amount: '500000', currency: 'VND', reference: qr.ref!.slice(-10).toUpperCase() })

    const walletQuote: LegQuote = { adapterId: 'mock', legId: 'wallet', input: fiat('USD', '5'), output: { amount: '5', asset: BASE_USDC }, fees: [], eta: { min: 1, max: 2 } }
    const w = await a.start({ leg: walletLeg, quote: walletQuote }, ctx)
    expect(w.surface).toMatchObject({ kind: 'WALLET_TX', chain: 'eip155:8453', txs: [{ chainId: 8453, value: '0', data: '0x' }] })
    expect((w.surface as { txs: Array<{ to: string }> }).txs[0]!.to).toMatch(/^0x[0-9a-f]{40}$/)
    const w2 = await a.start({ leg: walletLeg, quote: { ...walletQuote, input: { amount: '5', asset: ARB_USDC } }, deliverTo: { address: DEST } }, ctx)
    expect(w2.surface).toMatchObject({ chain: 'eip155:42161', txs: [{ to: DEST, chainId: 42161 }] })

    const t = await a.start({ leg: transferLeg, quote: { ...walletQuote, legId: 'transfer' } }, ctx)
    expect(t.surface).toMatchObject({ kind: 'DEPOSIT_ADDRESS', chain: 'eip155:8453', chainName: 'Base', symbol: 'USDC', min: '1' })
    const t2 = await a.start({ leg: transferLeg, quote: { ...walletQuote, legId: 'transfer', input: { amount: '1', asset: { ...ARB_USDC, symbol: 'USDT' } } } }, ctx)
    expect(t2.surface).toMatchObject({ chain: 'eip155:42161', symbol: 'USDT', warning: 'Send only USDT on Arbitrum. This is a test address.' })
    // payin with a crypto input falls back to USD
    const p = await a.start({ leg: payinLeg, quote: { ...walletQuote, legId: 'payin' } }, ctx)
    expect(p.surface).toMatchObject({ kind: 'QR', currency: 'USD' })
    const c2 = await a.start({ leg: cardLeg, quote: { ...walletQuote, input: { amount: '5', asset: BASE_USDC } } }, ctx)
    expect(new URL((c2.surface as { url: string }).url).searchParams.get('currency')).toBe('')
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
    expect(await a.status!({ leg: localLeg, ref: step.ref! }, ctx)).toMatchObject({ state: 'PAYMENT', status: 'awaiting_user' })
    await a.transition!({ leg: localLeg, ref: step.ref!, name: 'simulate_payment' }, ctx)
    expect(await a.status!({ leg: localLeg, ref: step.ref! }, ctx)).toMatchObject({ state: 'PROCESSING', sub: 'SETTLING' })
    vi.advanceTimersByTime(1000)
    const done = await a.status!({ leg: localLeg, ref: step.ref! }, ctx)
    expect(done).toMatchObject({ state: 'COMPLETED', status: 'succeeded', output: { amount: '3.910500' } })
    expect(done.txHash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(await a.status!({ leg: localLeg, ref: 'unknown' }, ctx)).toMatchObject({ state: 'PAYMENT' })
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
    expect(r.events).toEqual([{ ref, status: 'processing' }])
    const declined = await a.start({ leg: cardLeg, quote: await a.quote({ leg: cardLeg, amountIn: fiat('USD', '10') }, ctx) }, ctx)
    expect(await (await post({ ref: declined.ref!, outcome: 'fail' }))!.text()).toContain('Payment declined')
    expect(r.events[1]).toMatchObject({ ref: declined.ref, status: 'failed', error: { code: 'PAYMENT_FAILED' } })
    expect(await a.status!({ leg: cardLeg, ref: declined.ref! }, ctx)).toMatchObject({ state: 'FAILED', status: 'failed' })
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
          quote: { amountIn: { amount: '50', asset: BASE_USDC } },
          transitions: [{ name: 'submit_details', inputs: { account_name: 'Juan', phone: '09171234567' } }, { name: 'submit_tx', inputs: { txHash: TX } }],
          expect: { start: 'PAYMENT', status: 'COMPLETED' },
        },
      ],
    })
    expect(report.problems).toEqual([])
    const [start, details, sent, done] = report.steps
    expect(start).toMatchObject({ sub: 'PAYOUT_ACCOUNT', surface: { kind: 'FORM', fields: [{ id: 'account_name' }, { id: 'phone', label: 'GCash phone number' }] } })
    expect(details).toMatchObject({ sub: 'SEND_CRYPTO', surface: { kind: 'WALLET_TX', chain: 'eip155:8453', txs: [{ to: BASE_USDC.token, chainId: 8453 }] } })
    expect(sent).toMatchObject({ state: 'PROCESSING', txHash: TX })
    expect(done).toMatchObject({ state: 'COMPLETED', output: { asset: { kind: 'fiat', currency: 'PHP' } } })
    expect(report.quotes[0]).toMatchObject({ input: { amount: '50' }, output: { amount: '2828.57', asset: { currency: 'PHP' } }, fees: [{ amount: '0.500000', currency: 'USDC' }] })
  })

  it('quotes an exact fiat output, rejects unknown currencies, and has fields per payout method', async () => {
    const a = mockAdapter({ offramp: true })
    const ctx = makeCtx({ fetch: fakeFetch([]).fetch, destination: { type: 'fiat', currency: 'PHP' } })
    const out = await a.quote({ leg: offrampLeg(), amountOut: { amount: '1000', asset: PHP.asset } }, ctx)
    expect(out.input.amount).toBe('17.676768') // 1000 * 0.0175 / 0.99
    const noRate = { ...offrampLeg(), to: { asset: { kind: 'fiat' as const, currency: 'XYZ' }, location: { kind: 'user_account' as const } } }
    await expect(a.quote({ leg: noRate, amountIn: { amount: '1', asset: BASE_USDC } }, ctx)).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
    const fields = async (method?: string) => {
      const q = await a.quote({ leg: offrampLeg(method), amountIn: { amount: '10', asset: BASE_USDC } }, ctx)
      const s = await a.start({ leg: offrampLeg(method), quote: q }, ctx)
      return (s.surface as { fields: Array<{ id: string; label: string }> }).fields
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
    const q = await a.quote({ leg: l, amountIn: { amount: '10', asset: BASE_USDC } }, ctx)
    const { ref } = await a.start({ leg: l, quote: q }, ctx)
    const t = (name: string, inputs?: Record<string, unknown>) => a.transition!({ leg: l, ref: ref!, name, ...(inputs ? { inputs } : {}) }, ctx)
    expect((await a.status!({ leg: l, ref: ref! }, ctx)).surface?.kind).toBe('FORM')
    await expect(t('submit_tx', { txHash: TX })).rejects.toMatchObject({ status: 409 })
    await expect(t('submit_details', { account_name: 'A', bank_name: 'B' })).rejects.toMatchObject({ error: { message: 'Enter the account number.' } })
    await expect(t('submit_details', { account_name: 'A', bank_name: 'B', account_number: '1!' })).rejects.toMatchObject({ error: { message: 'Enter a valid account number.' } })
    await t('submit_details', { account_name: 'A', bank_name: 'B', account_number: '12345678' })
    expect((await a.status!({ leg: l, ref: ref! }, ctx)).surface?.kind).toBe('WALLET_TX')
    await expect(t('submit_details', { account_name: 'A', bank_name: 'B', account_number: '12345678' })).resolves.toMatchObject({ surface: { kind: 'WALLET_TX' } })
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
      const q = await a.quote({ leg: onchainLeg, amountIn: { amount: '25', asset: ANVIL_USDC } }, ctx)
      expect(checkLegQuote(q)).toEqual([])
      expect(q).toMatchObject({ input: { amount: '25', asset: ANVIL_USDC }, output: { amount: '25', asset: ANVIL_USDC }, fees: [] })
    })

    it('asks for an ERC-20 transfer to the destination and completes when the receipt pays it', async () => {
      const { a, ctx, rpc } = setup({ status: '0x1', logs: [transferLog(DEST, 25_000_000n)] })
      const q = await a.quote({ leg: onchainLeg, amountIn: { amount: '25', asset: ANVIL_USDC } }, ctx)
      const start = await a.start({ leg: onchainLeg, quote: q, deliverTo: { address: DEST } }, ctx)
      expect(checkLegStep(start)).toEqual([])
      expect(start.surface).toEqual({
        kind: 'WALLET_TX',
        chain: 'eip155:31337',
        txs: [{ to: TOKEN, data: `0xa9059cbb${DEST.slice(2).padStart(64, '0')}${(25_000_000).toString(16).padStart(64, '0')}`, value: '0', chainId: 31337 }],
      })
      await expect(a.status!({ leg: onchainLeg, ref: start.ref! }, ctx)).resolves.toMatchObject({ state: 'PAYMENT', surface: { kind: 'WALLET_TX' } })
      await expect(a.transition!({ leg: onchainLeg, ref: start.ref!, name: 'submit_tx', inputs: { txHash: '0xabc' } }, ctx)).rejects.toMatchObject({ status: 400 })
      const done = await a.transition!({ leg: onchainLeg, ref: start.ref!, name: 'submit_tx', inputs: { txHash: HASH } }, ctx)
      expect(done).toMatchObject({ state: 'COMPLETED', txHash: HASH, output: { amount: '25' } })
      expect(rpc.calls.at(-1)!.body).toMatchObject({ method: 'eth_getTransactionReceipt', params: [HASH] })
      await expect(a.status!({ leg: onchainLeg, ref: start.ref! }, ctx)).resolves.toMatchObject({ state: 'COMPLETED' })
    })

    it('stays PROCESSING without a receipt and fails a reverted, short, reused or unrelated transaction', async () => {
      const run = async (receipt: unknown, shared = memoryKV(), sessionId = 'sess_1') => {
        const { a, ctx } = setup(receipt)
        const c = { ...ctx, shared, session: { ...ctx.session, id: sessionId } }
        const q = await a.quote({ leg: onchainLeg, amountIn: { amount: '25', asset: ANVIL_USDC } }, c)
        const start = await a.start({ leg: onchainLeg, quote: q, deliverTo: { address: DEST } }, c)
        return a.transition!({ leg: onchainLeg, ref: start.ref!, name: 'submit_tx', inputs: { txHash: HASH } }, c)
      }
      await expect(run(null)).resolves.toMatchObject({ state: 'PROCESSING', txHash: HASH })
      await expect(run({ status: '0x0', logs: [] })).resolves.toMatchObject({ state: 'FAILED', error: { message: 'The transaction failed on chain.' } })
      await expect(run({ status: '0x1', logs: [transferLog(DEST, 24_999_999n)] })).resolves.toMatchObject({ state: 'FAILED', error: { message: /quoted amount/ } })
      await expect(run({ status: '0x1', logs: [transferLog(DEST, 25_000_000n, `0x${'22'.repeat(20)}`)] })).resolves.toMatchObject({ state: 'FAILED' })
      const shared = memoryKV()
      const ok = { status: '0x1', logs: [transferLog(DEST, 25_000_000n)] }
      await expect(run(ok, shared)).resolves.toMatchObject({ state: 'COMPLETED' })
      await expect(run(ok, shared, 'sess_2')).resolves.toMatchObject({ state: 'FAILED', error: { message: /already used/ } })
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
    const q = await a.quote({ leg: bridge, amountIn: { amount: '10', asset: BASE_USDC } }, ctx)
    expect(q.output.asset).toMatchObject({ chain: SOL, token: SOLANA_USDC_MINT, decimals: 6 })
  })

  it('wallet leg from Solana gives a Solana transfer; transfer leg shows a base58 deposit address', async () => {
    const a = mockAdapter({ settleMs: 0, crypto: true })
    const ctx = makeCtx({ fetch: fakeFetch([]).fetch, destination: solDest })
    const to = { asset: SOL_USDC, location: { kind: 'address' as const, address: SOL_DEST } }
    const solWallet = leg('wallet', { asset: SOL_USDC, location: { kind: 'user_wallet' } }, to)
    const q = await a.quote({ leg: solWallet, amountIn: { amount: '2.5', asset: { ...SOL_USDC, decimals: 6 } } }, ctx)
    const w = await a.start({ leg: solWallet, quote: q, deliverTo: { address: SOL_DEST } }, ctx)
    expect(w.surface).toEqual({ kind: 'WALLET_TX', chain: SOL, txs: [{ kind: 'solana', type: 'transfer', to: SOL_DEST, mint: SOLANA_USDC_MINT, amount: '2500000', decimals: 6 }] })
    const native = { kind: 'crypto' as const, chain: SOL, token: 'native' }
    const nq = await a.quote({ leg: solWallet, amountIn: { amount: '1', asset: native } }, ctx)
    expect(nq.input.asset).toMatchObject({ symbol: 'SOL', decimals: 9 })
    const t = await a.start({ leg: leg('transfer', { asset: SOL_USDC, location: { kind: 'user_wallet' } }, to), quote: { ...q, legId: 'transfer' } }, ctx)
    expect(t.surface).toMatchObject({ kind: 'DEPOSIT_ADDRESS', chain: SOL, chainName: 'Solana', symbol: 'USDC' })
    expect(isSolanaAddress((t.surface as { address: string }).address)).toBe(true)
    for (const s of [w, t]) expect(checkLegStep(s)).toEqual([])
  })

  it('the mock offramp takes EVM USDC only', () => {
    const off = mockAdapter({ offramp: true }).legs.find((l) => l.id === 'offramp')!
    const chains = Object.keys((off.from.asset as { chains: Record<string, string[]> }).chains)
    expect(chains).not.toContain(SOL)
    expect(chains).toContain('eip155:8453')
  })
})
