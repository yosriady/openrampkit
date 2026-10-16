// Flashnet payouts (withdraw): USDC to a Cash App `$cashtag` or a Lightning address through
// POST /v1/orchestration/offramp. Shapes from the offramp page and the OpenAPI spec (read on 2026-10-16).
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { checkAdapterShape, erc20TransferData } from '@openrampkit/adapter'
import { LIGHTNING, LIGHTNING_BTC, USDC, isRegionAllowed, stateFor } from '@openrampkit/core'
import type { Destination, LegQuote, PathwayLeg } from '@openrampkit/core'
import { fakeFetch, makeCtx, makeWebhookCtx, memoryKV, recordingLog, runAdapterConformance } from '@openrampkit/adapter/testing'
import type { FakeRoute, MemoryKV } from '@openrampkit/adapter/testing'
import { flashnet } from './index.js'

const API_KEY = 'fn_test_server_key'
const SECRET = 'whsec_flashnet'
const WALLET = '0x1111111111111111111111111111111111111111'
const DEPOSIT = '0x7777777777777777777777777777777777777777'
const QID = 'q_7e450ab4-935b-4f8d-a6c4-4987a3cd2831'
const OID = 'ord_b91bbf90-42dc-4fe3-9b15-1d2c7e19cce6'
const TX = `0x${'ab'.repeat(32)}`
const TX2 = `0x${'cd'.repeat(32)}`
const BASE_USDC = { kind: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']!, symbol: 'USDC', decimals: 6 }
const ALICE: Destination = { type: 'lightning', address: 'alice@cash.app', cashtag: '$alice' }
const BOB: Destination = { type: 'lightning', address: 'bob@wallet.example.org' }
const usdc = (v: string) => ({ value: v, asset: BASE_USDC })
const SOURCE = { chain: 'eip155:8453', token: USDC['eip155:8453']!, address: WALLET }

const payoutLeg = (legId: 'cash_app_payout' | 'lightning_payout', d: Destination = legId === 'cash_app_payout' ? ALICE : BOB): PathwayLeg => ({
  adapterId: 'flashnet',
  legId,
  method: legId === 'cash_app_payout' ? 'cash_app' : 'lightning',
  from: { asset: BASE_USDC, location: { kind: 'user_wallet' } },
  to: { asset: LIGHTNING_BTC, location: { kind: legId === 'cash_app_payout' ? 'cash_app' : 'lightning_address', address: (d as { address: string }).address } },
})

const ESTIMATE = { estimatedOut: '49500', feeAmount: '250000', totalFeeAmount: '250000', feeAsset: 'USDC', feeBps: 50, totalFeeAmountUsd: '0.25', destination: { chain: 'lightning', asset: 'BTC', decimals: 8 } }
const OFFRAMP = (over: Record<string, unknown> = {}) => ({
  amountMode: 'exact_in',
  estimatedOut: '49500',
  feeAmount: '250000',
  totalFeeAmount: '250000',
  feeBps: 50,
  feeAsset: 'USDC',
  route: ['USDC', 'USDB', 'BTC'],
  quoteId: QID,
  depositAddress: DEPOSIT,
  amountIn: '50000000',
  expiresAt: new Date(Date.now() + 120_000).toISOString(),
  source: { chain: 'base', asset: 'USDC', decimals: 6, contractAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  destination: { chain: 'lightning', asset: 'BTC', decimals: 8, contractAddress: null },
  ...over,
})
const ORDER = (status: string, over: Record<string, unknown> = {}) => ({
  id: OID,
  type: 'order',
  quoteId: QID,
  status,
  sourceChain: 'base',
  sourceAsset: 'USDC',
  destinationChain: 'lightning',
  destinationAsset: 'BTC',
  depositAddress: DEPOSIT,
  recipientAddress: 'alice@cash.app',
  sourceTxHash: TX,
  amountIn: '50000000',
  amountOut: status === 'completed' ? '49400' : null,
  updatedAt: '2026-10-16T00:00:05Z',
  ...over,
})

const routes = (over: FakeRoute[] = []): FakeRoute[] => [
  ...over,
  { match: '/v1/orchestration/estimate', reply: () => ESTIMATE },
  { method: 'POST', match: '/v1/orchestration/offramp', reply: () => OFFRAMP() },
  { method: 'POST', match: '/v1/orchestration/submit', reply: () => ({ orderId: OID, status: 'processing' }) },
  { match: '/v1/orchestration/status', reply: () => ({ order: ORDER('completed') }) },
]

// A fake chain RPC: receipts by hash, and the head block
const RPC = { rpcUrls: { 'eip155:8453': 'https://rpc.test/base' } }
const topic = (a: string) => `0x${a.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`
const receipt = (from: string, to: string, amount: string, o: { token?: string; status?: string } = {}) => ({
  status: o.status ?? '0x1',
  blockNumber: '0x10',
  logs: [{ address: o.token ?? USDC['eip155:8453']!, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', topic(from), topic(to)], data: `0x${BigInt(amount).toString(16).padStart(64, '0')}` }],
})
function chain() {
  const state = { receipts: {} as Record<string, unknown>, head: '0x11', route: undefined as unknown as FakeRoute }
  state.route = {
    method: 'POST',
    match: 'rpc.test',
    reply: (c) => {
      const b = c.body as { method: string; params: string[] }
      const result = b.method === 'eth_blockNumber' ? state.head : (state.receipts[b.params[0]!] ?? null)
      return { jsonrpc: '2.0', id: 1, result }
    },
  }
  return state
}

const ctxFor = (fetch: typeof globalThis.fetch, o: { shared?: MemoryKV; destination?: Destination; id?: string; index?: number; log?: ReturnType<typeof recordingLog> } = {}) =>
  makeCtx({
    fetch,
    shared: o.shared ?? memoryKV(),
    store: memoryKV(),
    destination: o.destination ?? ALICE,
    pathway: { legs: [], index: o.index ?? 0 },
    ...(o.log ? { log: o.log } : {}),
    session: { id: o.id ?? 'sess_1', direction: 'withdraw', livemode: true },
  })

async function quoted(over: FakeRoute[] = [], o: { legId?: 'cash_app_payout' | 'lightning_payout'; destination?: Destination; shared?: MemoryKV; id?: string; adapterOpts?: Record<string, unknown> } = {}) {
  const legId = o.legId ?? 'cash_app_payout'
  const { fetch, calls } = fakeFetch(routes(over))
  const a = flashnet({ apiKey: API_KEY, webhookSecret: SECRET, ...o.adapterOpts })
  const shared = o.shared ?? memoryKV()
  const ctx = ctxFor(fetch, { shared, ...(o.destination ? { destination: o.destination } : {}), ...(o.id ? { id: o.id } : {}) })
  const leg = payoutLeg(legId, o.destination)
  const q = await a.quote({ leg, amountIn: usdc('50'), source: SOURCE }, ctx)
  return { a, q, ctx, calls, shared, fetch, leg, start: (quote: LegQuote = q, source: { chain: string; token: string; address?: string } = SOURCE) => a.start({ leg, quote, source }, ctx) }
}

describe('flashnet payouts: legs', () => {
  it('declares cash_app_payout and lightning_payout: USDC on five EVM chains to Lightning, with WALLET_TX', () => {
    const a = flashnet({ apiKey: API_KEY })
    expect(checkAdapterShape(a)).toEqual([])
    const cash = a.legs.find((l) => l.id === 'cash_app_payout')!
    const ln = a.legs.find((l) => l.id === 'lightning_payout')!
    expect(cash).toMatchObject({ kind: 'crypto_offramp', methods: ['cash_app'], surfaces: ['WALLET_TX'] })
    expect(ln).toMatchObject({ kind: 'crypto_offramp', methods: ['lightning'], surfaces: ['WALLET_TX'] })
    expect(cash.from.location).toEqual(['user_wallet', 'address'])
    expect(Object.keys((cash.from.asset as { chains: Record<string, string[]> }).chains).sort()).toEqual(['eip155:1', 'eip155:10', 'eip155:137', 'eip155:42161', 'eip155:8453'])
    expect(cash.to).toEqual({ asset: { kind: 'crypto', chains: { [LIGHTNING]: ['native'] } }, location: ['cash_app'] })
    expect(ln.to.location).toEqual(['lightning_address'])
    expect(isRegionAllowed(cash.regions, 'US', 'US-CA')).toBe(true)
    expect(isRegionAllowed(cash.regions, 'PH')).toBe(false)
    expect(isRegionAllowed(ln.regions, 'PH')).toBe(true)
    expect(flashnet({ apiKey: API_KEY, legs: ['cash_app_payout'] }).legs.map((l) => l.id)).toEqual(['cash_app_payout'])
  })
})

describe('flashnet payouts: conformance', () => {
  it('passes the conformance kit (Cash App payout: WALLET_TX, submit_tx, then completed)', async () => {
    const shared = memoryKV()
    const { fetch } = fakeFetch(routes())
    const a = flashnet({ apiKey: API_KEY, webhookSecret: SECRET })
    const body = JSON.stringify({ event: 'order.processing', timestamp: '2026-10-16T00:00:06.000Z', data: { id: OID, quoteId: 'q_unknown', status: 'processing', updatedAt: 'x' } })
    const sig = (ts = String(Date.now())) => ({ 'x-flashnet-timestamp': ts, 'x-flashnet-signature': createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex') })
    const report = await runAdapterConformance(a, {
      ctx: () => ctxFor(fetch, { shared }),
      webhookCtx: makeWebhookCtx({ shared }),
      fixtures: [
        {
          leg: payoutLeg('cash_app_payout'),
          quote: { amountIn: usdc('50'), source: SOURCE },
          start: { source: SOURCE },
          transitions: [{ name: 'submit_tx', inputs: { txHash: TX } }],
          expect: { start: 'PAYMENT', status: 'COMPLETED' },
        },
      ],
      errorPaths: [{ leg: payoutLeg('cash_app_payout'), quote: { amountIn: usdc('50'), source: SOURCE }, ctx: (f) => ctxFor(f) }],
      webhooks: [{ name: 'signed, unknown quote', request: () => new Request('https://app.test/hook', { method: 'POST', body, headers: sig() }), rawBody: body, events: 0 }],
    })
    expect(report.problems).toEqual([])
  })
})

describe('flashnet payouts: quote', () => {
  it('prices the exact USDC amount to lightning:BTC and returns BTC out (an estimate)', async () => {
    const { q, calls } = await quoted()
    const est = new URL(calls.find((c) => c.url.includes('/estimate'))!.url).searchParams
    expect(Object.fromEntries(est)).toEqual({ sourceChain: 'base', sourceAsset: 'USDC', destinationChain: 'lightning', destinationAsset: 'BTC', amount: '50000000' })
    expect(q.input).toEqual(usdc('50'))
    expect(q.output).toEqual({ value: '0.000495', asset: LIGHTNING_BTC })
    expect(q.guarantee).toBe('estimate')
    expect(q.fees.map((f) => f.label)).toEqual(['Flashnet fee', 'Cash App bitcoin to USD rate'])
    expect(q.data).toEqual({ amount: '50000000' })
    // A Lightning address has no Cash App rate line
    const ln = await quoted([], { legId: 'lightning_payout', destination: BOB })
    expect(ln.q.fees.map((f) => f.label)).toEqual(['Flashnet fee'])
  })

  it('quotes only the exact amount sent, from a supported source, with a refund address', async () => {
    const { fetch } = fakeFetch(routes())
    const a = flashnet({ apiKey: API_KEY })
    const ctx = ctxFor(fetch)
    const leg = payoutLeg('cash_app_payout')
    // An amount out is not supported (variable delivery)
    await expect(a.quote({ leg, amountOut: { value: '0.0005', asset: LIGHTNING_BTC }, source: SOURCE }, ctx)).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
    // USDT is not a payout source here
    await expect(a.quote({ leg, amountIn: { value: '50', asset: { kind: 'crypto', chain: 'eip155:8453', token: '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2' } }, source: SOURCE }, ctx)).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
    // The amount must be in the session source
    await expect(a.quote({ leg, amountIn: { value: '50', asset: { kind: 'crypto', chain: 'eip155:42161', token: USDC['eip155:42161']! } }, source: SOURCE }, ctx)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
    // No sender and no refundAddresses.evm: no refund address, no quote
    await expect(a.quote({ leg, amountIn: usdc('50'), source: { chain: SOURCE.chain, token: SOURCE.token } }, ctx)).rejects.toMatchObject({ error: { code: 'NO_QUOTES', message: expect.stringMatching(/refund/) } })
    const withRefund = flashnet({ apiKey: API_KEY, refundAddresses: { evm: WALLET } })
    await expect(withRefund.quote({ leg, amountIn: usdc('50'), source: { chain: SOURCE.chain, token: SOURCE.token } }, ctx)).resolves.toMatchObject({ legId: 'cash_app_payout' })
    // A zero amount
    await expect(a.quote({ leg, amountIn: usdc('0'), source: SOURCE }, ctx)).rejects.toMatchObject({ error: { code: 'AMOUNT_TOO_LOW' } })
  })

  it('quotes only for the session Lightning target, and each leg for its own kind of target', async () => {
    const { fetch } = fakeFetch(routes())
    const a = flashnet({ apiKey: API_KEY })
    const q = (legId: 'cash_app_payout' | 'lightning_payout', destination: Destination) => a.quote({ leg: payoutLeg(legId, destination), amountIn: usdc('50'), source: SOURCE }, ctxFor(fetch, { destination }))
    await expect(q('cash_app_payout', { type: 'crypto', chain: 'eip155:8453', token: USDC['eip155:8453']!, address: WALLET })).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
    await expect(q('cash_app_payout', BOB)).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
    await expect(q('lightning_payout', ALICE)).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
    // A destination that does not parse (it never came from the server's parser) is refused
    await expect(q('lightning_payout', { type: 'lightning', address: 'lnbc1qqqq@x.com' } as Destination)).resolves.toBeTruthy()
    await expect(q('lightning_payout', { type: 'lightning', address: 'https://evil.example/pay' })).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
    await expect(q('cash_app_payout', { type: 'lightning', address: 'mallory@cash.app', cashtag: '$alice' })).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
  })
})

describe('flashnet payouts: start', () => {
  it('creates the offramp quote for the session target and asks for an ERC-20 transfer to the deposit address', async () => {
    const { start, calls } = await quoted()
    const step = await start()
    const post = calls.find((c) => c.method === 'POST')!
    expect(post.url).toBe('https://orchestration.flashnet.xyz/v1/orchestration/offramp')
    expect(post.body).toEqual({ sourceChain: 'base', sourceAsset: 'USDC', amount: '50000000', recipientAddress: '$alice', refundAddress: WALLET, tag: 'ork:sess_1' })
    expect(post.headers.get('x-idempotency-key')).toMatch(/^sess_1:flashnet:offramp:[0-9a-f]{64}$/)
    expect(stateFor(step)).toBe('PAYMENT')
    expect(step.ref).toBe(QID)
    expect(step.action!.surface).toEqual({ kind: 'WALLET_TX', chain: 'eip155:8453', txs: [{ to: USDC['eip155:8453'], data: erc20TransferData(DEPOSIT, '50000000'), value: '0', chainId: 8453 }] })
    expect(step.action!.transitions).toEqual([{ name: 'submit_tx', kind: 'SURFACE_RESULT', expects: 'tx_hash' }])
  })

  it('sends a Lightning address as is', async () => {
    const { start, calls } = await quoted([], { legId: 'lightning_payout', destination: BOB })
    await start()
    expect((calls.find((c) => c.method === 'POST')!.body as { recipientAddress: string }).recipientAddress).toBe('bob@wallet.example.org')
  })

  it('the target comes only from the session: a hop address, another target or a tampered quote is refused', async () => {
    const { a, q, leg, fetch, calls } = await quoted()
    const ctx = ctxFor(fetch)
    await expect(a.start({ leg, quote: q, source: SOURCE, deliverTo: { address: 'mallory@cash.app' } }, ctx)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
    // The session target changed to a Lightning address: the Cash App leg refuses it
    await expect(a.start({ leg, quote: q, source: SOURCE }, ctxFor(fetch, { destination: BOB }))).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
    // A quote whose amount does not match its data, another source asset, another output, or another leg
    await expect(a.start({ leg, quote: { ...q, input: usdc('500') }, source: SOURCE }, ctx)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
    await expect(a.start({ leg, quote: { ...q, data: { amount: '500000000' } }, source: SOURCE }, ctx)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
    await expect(a.start({ leg, quote: q, source: { ...SOURCE, chain: 'eip155:42161', token: USDC['eip155:42161']! } }, ctx)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
    await expect(a.start({ leg, quote: { ...q, output: usdc('1') }, source: SOURCE }, ctx)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
    await expect(a.start({ leg, quote: { ...q, legId: 'lightning_payout' }, source: SOURCE }, ctx)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
    // None of them called Orchestra
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
  })

  it('fails closed on an answer that does not match: amount, mode, source, recipient, memo, deposit address, asset', async () => {
    const bad: Array<Record<string, unknown>> = [
      { amountIn: '50000001' },
      { amountIn: undefined },
      { amountMode: 'exact_out' },
      { source: { chain: 'arbitrum', asset: 'USDC', decimals: 6 } },
      { source: { chain: 'base', asset: 'USDC', decimals: 6, contractAddress: '0x' + '9'.repeat(40) } },
      { recipientAddress: 'mallory@cash.app' },
      { depositMemo: '12345' },
      { depositAddress: '0x' + '0'.repeat(40) },
      { depositAddress: '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV' },
      { destination: { chain: 'base', asset: 'USDC', decimals: 6 } },
      { quoteId: '../q' },
    ]
    for (const over of bad) {
      const { start } = await quoted([{ method: 'POST', match: '/offramp', reply: () => OFFRAMP(over) }])
      await expect(start(), JSON.stringify(over)).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    }
    // The recipient may come back as the Lightning address of the cashtag
    const ok = await quoted([{ method: 'POST', match: '/offramp', reply: () => OFFRAMP({ recipientAddress: 'Alice@Cash.App' }) }])
    await expect(ok.start()).resolves.toMatchObject({ ref: QID })
  })

  it('maps Orchestra errors: screening is a decline, a low amount asks for a new quote', async () => {
    const screened = await quoted([{ method: 'POST', match: '/offramp', status: 403, reply: () => ({ error: { code: 'sanctioned_address', message: 'blocked' } }) }])
    await expect(screened.start()).rejects.toMatchObject({ error: { code: 'PROVIDER_DECLINED' } })
    const low = await quoted([{ method: 'POST', match: '/offramp', status: 400, reply: () => ({ error: { code: 'amount_too_small', message: 'too small' } }) }])
    await expect(low.start()).rejects.toMatchObject({ error: { code: 'AMOUNT_TOO_LOW', recovery: 'requote' } })
  })

  it('one Orchestra quote pays one leg, and one deposit address takes one payout (claimOnce)', async () => {
    const shared = memoryKV()
    const first = await quoted([], { shared })
    await expect(first.start()).resolves.toMatchObject({ ref: QID })
    // A retry of the same start (same session, same quote) is fine
    await expect(first.start()).resolves.toMatchObject({ ref: QID })
    // Another session gets the same quote id back: refused
    const other = await quoted([], { shared, id: 'sess_2' })
    await expect(other.start()).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE', message: expect.stringMatching(/in use/) } })
    // Another quote with the same deposit address: refused
    const reuse = await quoted([{ method: 'POST', match: '/offramp', reply: () => OFFRAMP({ quoteId: 'q_other' }) }], { shared, id: 'sess_3' })
    await expect(reuse.start()).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE', message: expect.stringMatching(/in use/) } })
  })
})

describe('flashnet payouts: funding transaction and status', () => {
  it('submit_tx without an RPC URL trusts no hash: no claim, no record, no /submit; the leg waits for Orchestra', async () => {
    const { a, start, leg, ctx, calls, shared } = await quoted([{ match: '/v1/orchestration/status', status: 404, reply: () => ({ error: { code: 'not_found' } }) }])
    await start()
    await expect(a.transition!({ leg, ref: QID, name: 'submit_tx', inputs: { txHash: 'nope' } }, ctx)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
    await expect(a.transition!({ leg, ref: QID, name: 'simulate_payment' }, ctx)).rejects.toMatchObject({ status: 409 })
    await expect(a.transition!({ leg, ref: 'q_unknown', name: 'submit_tx', inputs: { txHash: TX } }, ctx)).rejects.toMatchObject({ status: 404 })
    const step = await a.transition!({ leg, ref: QID, name: 'submit_tx', inputs: { txHash: TX } }, ctx)
    expect(step).toMatchObject({ status: 'processing', ref: QID })
    expect(step.transactions).toBeUndefined()
    expect(await shared.get(`src:${TX}`)).toBeUndefined()
    expect(await shared.get(`fund:${QID}`)).toBeUndefined()
    expect(calls.some((c) => c.url.endsWith('/submit'))).toBe(false)
    // No order yet: the leg stays processing (it never shows the wallet step again)
    await expect(a.status!({ leg, ref: QID }, ctx)).resolves.toMatchObject({ status: 'processing', ref: QID })
  })

  it('with an RPC URL, binds a confirmed transfer of the quoted amount from the sender to this deposit address', async () => {
    const ch = chain()
    ch.receipts[TX] = receipt(WALLET, DEPOSIT, '50000000')
    const { a, start, leg, ctx, calls, shared } = await quoted([ch.route, { match: '/v1/orchestration/status', status: 404, reply: () => ({}) }], { adapterOpts: RPC })
    await start()
    const step = await a.transition!({ leg, ref: QID, name: 'submit_tx', inputs: { txHash: TX } }, ctx)
    expect(step).toMatchObject({ status: 'processing', transactions: [{ role: 'source', chain: 'eip155:8453', hash: TX }] })
    expect(await shared.get(`src:${TX}`)).toBe(QID)
    expect(calls.find((c) => c.url.endsWith('/submit'))!.body).toEqual({ quoteId: QID, txHash: TX })
    // The same hash again is fine (the same leg owns it); another hash is a conflict
    await expect(a.transition!({ leg, ref: QID, name: 'submit_tx', inputs: { txHash: TX } }, ctx)).resolves.toMatchObject({ status: 'processing' })
    await expect(a.transition!({ leg, ref: QID, name: 'submit_tx', inputs: { txHash: TX2 } }, ctx)).rejects.toMatchObject({ status: 409 })
  })

  it('a transaction that fails verification leaves no claim and no record', async () => {
    const OTHER_DEPOSIT = '0x' + '8'.repeat(40)
    const cases: Array<[string, Record<string, unknown>]> = [
      ['another deposit address', receipt(WALLET, OTHER_DEPOSIT, '50000000')],
      ['another amount', receipt(WALLET, DEPOSIT, '49999999')],
      ['another sender', receipt('0x' + '5'.repeat(40), DEPOSIT, '50000000')],
      ['another token', receipt(WALLET, DEPOSIT, '50000000', { token: USDC['eip155:1']! })],
      ['a reverted transaction', receipt(WALLET, DEPOSIT, '50000000', { status: '0x0' })],
    ]
    for (const [name, r] of cases) {
      const ch = chain()
      ch.receipts[TX] = r
      const { a, start, leg, ctx, shared, calls } = await quoted([ch.route], { adapterOpts: RPC })
      await start()
      await expect(a.transition!({ leg, ref: QID, name: 'submit_tx', inputs: { txHash: TX } }, ctx), name).rejects.toMatchObject({ status: 400 })
      expect(await shared.get(`src:${TX}`), name).toBeUndefined()
      expect((await shared.get<{ payout: { fundTx?: string } }>(`rec:${QID}`))!.payout.fundTx, name).toBeUndefined()
      expect(calls.some((c) => c.url.endsWith('/submit')), name).toBe(false)
    }
  })

  it('waits for confirmations before it binds; the status check binds it later', async () => {
    const ch = chain()
    ch.receipts[TX] = receipt(WALLET, DEPOSIT, '50000000')
    ch.head = '0x10' // 1 confirmation, 2 needed
    const { a, start, leg, ctx, shared } = await quoted([ch.route, { match: '/v1/orchestration/status', status: 404, reply: () => ({}) }], { adapterOpts: RPC })
    await start()
    await expect(a.transition!({ leg, ref: QID, name: 'submit_tx', inputs: { txHash: TX } }, ctx)).resolves.toMatchObject({ status: 'processing' })
    expect(await shared.get(`src:${TX}`)).toBeUndefined()
    ch.head = '0x11'
    await expect(a.status!({ leg, ref: QID }, ctx)).resolves.toMatchObject({ status: 'processing' })
    expect(await shared.get(`src:${TX}`)).toBe(QID)
  })

  it("squatting: session B reports session A's funding hash first; B fails, A still completes", async () => {
    const shared = memoryKV()
    const ch = chain()
    ch.receipts[TX] = receipt(WALLET, DEPOSIT, '50000000') // A's real transfer
    let funded = false
    const status: FakeRoute = { match: '/v1/orchestration/status', reply: (c) => (funded && c.url.includes(QID) ? { order: ORDER('completed') } : new Response('{}', { status: 404 })) }
    const A = await quoted([ch.route, status], { shared, adapterOpts: RPC })
    await A.start()
    const B = await quoted([ch.route, status, { method: 'POST', match: '/offramp', reply: () => OFFRAMP({ quoteId: 'q_b', depositAddress: '0x' + '8'.repeat(40) }) }], { shared, id: 'sess_b', adapterOpts: RPC })
    await B.start()
    // B (even with the same sender wallet) reports A's hash before A does: the receipt pays A's deposit, not B's
    await expect(B.a.transition!({ leg: B.leg, ref: 'q_b', name: 'submit_tx', inputs: { txHash: TX } }, B.ctx)).rejects.toMatchObject({ status: 400 })
    expect(await shared.get(`src:${TX}`)).toBeUndefined()
    // A reports its own hash and completes
    await expect(A.a.transition!({ leg: A.leg, ref: QID, name: 'submit_tx', inputs: { txHash: TX } }, A.ctx)).resolves.toMatchObject({ transactions: [{ hash: TX }] })
    funded = true
    expect((await A.a.status!({ leg: A.leg, ref: QID }, A.ctx)).status).toBe('succeeded')
    expect((await B.a.status!({ leg: B.leg, ref: 'q_b' }, B.ctx)).status).not.toBe('succeeded')
  })

  it("squatting without an RPC URL: B reports A's hash first; nothing is claimed, A still completes", async () => {
    const shared = memoryKV()
    let funded = false
    const status: FakeRoute = { match: '/v1/orchestration/status', reply: (c) => (funded && c.url.includes(QID) ? { order: ORDER('completed') } : new Response('{}', { status: 404 })) }
    const A = await quoted([status], { shared })
    await A.start()
    const B = await quoted([status, { method: 'POST', match: '/offramp', reply: () => OFFRAMP({ quoteId: 'q_b', depositAddress: '0x' + '8'.repeat(40) }) }], { shared, id: 'sess_b' })
    await B.start()
    await expect(B.a.transition!({ leg: B.leg, ref: 'q_b', name: 'submit_tx', inputs: { txHash: TX } }, B.ctx)).resolves.toMatchObject({ status: 'processing' })
    expect(await shared.get(`src:${TX}`)).toBeUndefined()
    await A.a.transition!({ leg: A.leg, ref: QID, name: 'submit_tx', inputs: { txHash: TX } }, A.ctx)
    funded = true
    // Completion claims the hash that Orchestra reports (sourceTxHash), owned by A's leg
    expect((await A.a.status!({ leg: A.leg, ref: QID }, A.ctx)).status).toBe('succeeded')
    expect(await shared.get(`src:${TX}`)).toBe(QID)
  })

  it('a failed /submit is not fatal: Orchestra detects EVM deposits by itself', async () => {
    const log = recordingLog()
    const ch = chain()
    ch.receipts[TX] = receipt(WALLET, DEPOSIT, '50000000')
    const { a, start, leg, fetch, shared } = await quoted([ch.route, { method: 'POST', match: '/submit', status: 500, reply: () => ({ error: { code: 'internal' } }) }], { adapterOpts: RPC })
    await start()
    const ctx = ctxFor(fetch, { shared, log })
    await expect(a.transition!({ leg, ref: QID, name: 'submit_tx', inputs: { txHash: TX } }, ctx)).resolves.toMatchObject({ status: 'processing' })
    expect(log.warnings.some((m) => /submit failed/.test(m))).toBe(true)
  })

  it('completes on a delivered order to the session target, with BTC out', async () => {
    const { a, start, leg, ctx } = await quoted()
    await start()
    const step = await a.status!({ leg, ref: QID }, ctx)
    expect(step.status).toBe('succeeded')
    expect(step.output).toEqual({ value: '0.000494', asset: { ...LIGHTNING_BTC, decimals: 8 } })
    expect(step.providerRef).toBe(OID)
    // A Lightning payment has no chain transaction; the funding transaction is the source
    expect(step.transactions).toEqual([{ role: 'source', chain: 'eip155:8453', hash: TX }])
  })

  it('holds a completed order that does not match the payout (fail closed)', async () => {
    const cases: Array<Record<string, unknown>> = [
      { recipientAddress: 'mallory@cash.app', destinationAddress: 'mallory@cash.app' },
      { recipientAddress: null, destinationAddress: null },
      { amountIn: '1000000' },
      { sourceAsset: 'USDT' },
      { sourceChain: 'arbitrum' },
      { destinationChain: 'base', destinationAsset: 'USDC' },
      { quoteId: 'q_other' },
      { amountOut: '0' },
    ]
    for (const over of cases) {
      const log = recordingLog()
      const { a, start, leg, fetch, shared } = await quoted([{ match: '/v1/orchestration/status', reply: () => ({ order: ORDER('completed', over) }) }])
      await start()
      const step = await a.status!({ leg, ref: QID }, ctxFor(fetch, { shared, log }))
      expect(step.status, JSON.stringify(over)).toBe('processing')
      expect(step.detail?.code).toBe('delayed')
      expect(log.errors.length).toBeGreaterThan(0)
    }
  })

  it('one order completes one payout', async () => {
    const shared = memoryKV()
    const first = await quoted([], { shared })
    await first.start()
    expect((await first.a.status!({ leg: first.leg, ref: QID }, first.ctx)).status).toBe('succeeded')
    // A second payout whose status names the same order id
    const second = await quoted(
      [
        { method: 'POST', match: '/offramp', reply: () => OFFRAMP({ quoteId: 'q_two', depositAddress: '0x' + '8'.repeat(40) }) },
        { match: '/v1/orchestration/status', reply: () => ({ order: ORDER('completed', { quoteId: 'q_two', sourceTxHash: TX2 }) }) },
      ],
      { shared, id: 'sess_2' },
    )
    await second.start()
    expect((await second.a.status!({ leg: second.leg, ref: 'q_two' }, second.ctx)).status).toBe('processing')
  })

  it('an expired quote with no deposit expires the leg; with a funding transaction it stays processing', async () => {
    const none = await quoted([{ match: '/v1/orchestration/status', reply: () => ({ order: ORDER('expired', { sourceTxHash: null, amountIn: null }) }) }])
    await none.start()
    expect((await none.a.status!({ leg: none.leg, ref: QID }, none.ctx)).status).toBe('expired')
    const sent = await quoted([{ match: '/v1/orchestration/status', reply: () => ({ order: ORDER('expired', { sourceTxHash: null, amountIn: null }) }) }])
    await sent.start()
    await sent.a.transition!({ leg: sent.leg, ref: QID, name: 'submit_tx', inputs: { txHash: TX } }, sent.ctx)
    expect((await sent.a.status!({ leg: sent.leg, ref: QID }, sent.ctx)).status).toBe('processing')
  })

  it('a refund to the sender is a refunded leg', async () => {
    const { a, start, leg, ctx } = await quoted([{ match: '/v1/orchestration/status', reply: () => ({ order: ORDER('refunded', { refundTxHash: TX2 }) }) }])
    await start()
    const step = await a.status!({ leg, ref: QID }, ctx)
    expect(step.status).toBe('refunded')
    expect(step.transactions).toContainEqual({ role: 'refund', chain: 'eip155:8453', hash: TX2 })
  })

  it('a signed webhook completes the payout through the record of the quote', async () => {
    const shared = memoryKV()
    const { a, start } = await quoted([], { shared })
    await start()
    const body = JSON.stringify({
      event: 'order.completed',
      timestamp: '2026-10-16T00:00:06.000Z',
      data: {
        id: OID,
        status: 'completed',
        quoteId: QID,
        amountIn: '50000000',
        amountOut: '49400',
        recipientAddress: 'alice@cash.app',
        source: { chain: 'base', asset: 'USDC', txHash: TX },
        destination: { chain: 'lightning', asset: 'BTC', address: 'alice@cash.app', txHash: null },
        updatedAt: '2026-10-16T00:00:06Z',
      },
    })
    const ts = String(Date.now())
    const req = new Request('https://app.test/hook', { method: 'POST', body, headers: { 'x-flashnet-timestamp': ts, 'x-flashnet-signature': createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex') } })
    const wctx = makeWebhookCtx({ shared })
    expect(await a.webhook!.verify(req, body, wctx)).toBe(true)
    const events = await a.webhook!.parse(body, wctx)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ ref: QID, status: 'succeeded', output: { value: '0.000494' } })
  })
})
