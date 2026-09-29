import { describe, expect, it } from 'vitest'
import { checkAdapterShape, checkLegQuote, checkLegStep } from '@openrampkit/adapter'
import { USDC, planPathways } from '@openrampkit/core'
import type { CryptoAsset, LegQuote, PathwayLeg } from '@openrampkit/core'
import { erc20TransferData, relay } from './index.js'
import type { RelayQuoteResponse } from './index.js'
import { fakeFetch, makeCtx, memoryKV, silentLog } from './testctx.js'

const USER = '0x03508bB71268BBA25ECaCC8F620e01866650532c'
const DEST = '0x000000000000000000000000000000000000beef'
const DEPOSIT = '0xd16e0c839b6f652970c5d4d035d9cfcff5c185af'
const BASE_USDC: CryptoAsset = { kind: 'crypto', chain: 'eip155:8453', token: USDC['eip155:8453']! }
const ARB_USDC: CryptoAsset = { kind: 'crypto', chain: 'eip155:42161', token: USDC['eip155:42161']! }
const MONAD_TOKEN = '0x00000000000000000000000000000000000000c0'

const usdc = (chainId: number, address: string) => ({ chainId, address, symbol: 'USDC', name: 'USD Coin', decimals: 6 })
const eth = (chainId: number) => ({ chainId, address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', name: 'Ether', decimals: 18 })

function relayQuote(opts: { deposit?: boolean; signature?: boolean; amountIn?: string } = {}): RelayQuoteResponse {
  const amountIn = opts.amountIn ?? '10000000'
  const out = String(BigInt(amountIn) - 39555n)
  return {
    requestId: '0xreq1',
    steps: [
      ...(opts.signature ? [{ id: 'authorize', kind: 'signature', items: [] }] : []),
      {
        id: 'deposit',
        kind: 'transaction',
        requestId: '0xreq1',
        ...(opts.deposit ? { depositAddress: DEPOSIT } : {}),
        items: [{ status: 'incomplete', data: { from: USER, to: ARB_USDC.token, data: erc20TransferData(DEPOSIT, amountIn), value: '0', chainId: 42161 } }],
      },
    ],
    fees: {
      gas: { currency: eth(42161), amount: '484000000000' },
      relayer: { currency: usdc(42161, ARB_USDC.token), amount: '38336' },
      app: { currency: usdc(42161, ARB_USDC.token), amount: '0' },
    },
    details: {
      currencyIn: { currency: usdc(42161, ARB_USDC.token), amount: amountIn },
      currencyOut: { currency: usdc(8453, BASE_USDC.token), amount: out },
      timeEstimate: 2,
    },
  } as RelayQuoteResponse
}

const walletLeg: PathwayLeg = {
  adapterId: 'relay',
  legId: 'wallet',
  from: { asset: { kind: 'crypto', chain: '*', token: '*' }, location: { kind: 'user_wallet' } },
  to: { asset: BASE_USDC, location: { kind: 'address', address: DEST } },
}
const transferLeg: PathwayLeg = { ...walletLeg, legId: 'transfer' }
const bridgeLeg: PathwayLeg = {
  adapterId: 'relay',
  legId: 'bridge',
  from: { asset: BASE_USDC, location: { kind: 'address', address: 'deposit' } },
  to: { asset: { kind: 'crypto', chain: 'eip155:143', token: MONAD_TOKEN }, location: { kind: 'address', address: DEST } },
}

function expectConformant(q: LegQuote) {
  expect(checkLegQuote(q)).toEqual([])
}

describe('relay adapter', () => {
  it('passes the shape check and plans wallet, transfer and hop pathways', () => {
    const a = relay()
    expect(checkAdapterShape(a)).toEqual([])
    const plan = planPathways({
      direction: 'deposit',
      destination: { type: 'crypto', chain: 'eip155:143', token: MONAD_TOKEN, address: DEST },
      user: { country: 'VN', walletConnected: true },
      legs: [
        ...a.legs.map((spec) => ({ adapterId: 'relay', provider: 'Relay', spec })),
        {
          adapterId: 'x',
          provider: 'X',
          spec: {
            id: 'card', kind: 'fiat_onramp', methods: ['card'],
            from: { asset: { kind: 'fiat', currencies: '*' }, location: ['user_account'] },
            to: { asset: { kind: 'crypto', chains: { 'eip155:8453': [BASE_USDC.token] } }, location: ['address'] },
            regions: { allow: ['*'], deny: [] }, eta: { min: 1, max: 2 }, surfaces: ['REDIRECT'],
          },
        },
      ],
    })
    const ids = plan.pathways.map((p) => p.id)
    expect(ids).toContain('wallet:relay.wallet')
    expect(ids).toContain('transfer:relay.transfer')
    expect(ids).toContain('card:x.card>relay.bridge@eip155:8453')
  })

  it('wallet: quotes, starts with WALLET_TX, takes the tx hash, then maps intent status', async () => {
    const { fetch, calls } = fakeFetch([
      { method: 'POST', match: '/quote/v2', reply: () => relayQuote() },
      { method: 'GET', match: '/intents/status/v3', reply: () => ({ status: 'success', txHashes: ['0xdest'] }) },
    ])
    const a = relay({ apiKey: 'k', appFee: { bps: 25, recipient: DEST }, referrer: 'myapp' })
    const ctx = makeCtx({ fetch })
    const q = await a.quote({ leg: walletLeg, amountIn: { amount: '10', asset: ARB_USDC }, source: { chain: ARB_USDC.chain, token: ARB_USDC.token, address: USER }, deliverTo: { address: DEST } }, ctx)
    expectConformant(q)
    expect(q.input.amount).toBe('10')
    expect(q.output.amount).toBe('9.960445')
    expect(q.fees).toEqual([
      { kind: 'network', label: 'Network fee', amount: '0.000000484', currency: 'ETH' },
      { kind: 'provider', label: 'Relay fee', amount: '0.038336', currency: 'USDC' },
    ])
    const body = calls[0]!.body as Record<string, unknown>
    expect(body).toMatchObject({ user: USER, recipient: DEST, originChainId: 42161, destinationChainId: 8453, amount: '10000000', tradeType: 'EXACT_INPUT', referrer: 'myapp', appFees: [{ recipient: DEST, fee: '25' }] })
    expect(calls[0]!.headers.get('x-api-key')).toBe('k')

    const step = await a.start({ leg: walletLeg, quote: q, source: { chain: ARB_USDC.chain, token: ARB_USDC.token, address: USER } }, ctx)
    expect(checkLegStep(step)).toEqual([])
    expect(step).toMatchObject({ state: 'PAYMENT', status: 'awaiting_user', ref: '0xreq1', surface: { kind: 'WALLET_TX', chain: 'eip155:42161' } })
    expect(calls).toHaveLength(1) // fresh quote reused, no re-quote

    const hash = `0x${'ab'.repeat(32)}`
    const t = await a.transition!({ leg: walletLeg, ref: step.ref!, name: 'submit_tx', inputs: { txHash: hash } }, ctx)
    expect(t).toMatchObject({ state: 'PROCESSING', status: 'processing', txHash: hash })
    expect(t.transitions[0]).toMatchObject({ kind: 'AWAIT', poll: { intervalMs: 2500, backoff: 1.2, maxIntervalMs: 10000, giveUpAfterMs: 1800000 } })
    const s = await a.status!({ leg: walletLeg, ref: step.ref! }, ctx)
    expect(checkLegStep(s)).toEqual([])
    expect(s).toMatchObject({ state: 'COMPLETED', status: 'succeeded', txHash: '0xdest' })
  })

  it('wallet: maps failure, refund and pending statuses', async () => {
    let status = 'failure'
    const { fetch } = fakeFetch([{ method: 'GET', match: '/intents/status/v3', reply: () => ({ status, inTxHashes: ['0x1'] }) }])
    const a = relay()
    const ctx = makeCtx({ fetch })
    expect(await a.status!({ leg: walletLeg, ref: '0xr' }, ctx)).toMatchObject({ state: 'FAILED', status: 'failed' })
    status = 'refund'
    expect(await a.status!({ leg: walletLeg, ref: '0xr' }, ctx)).toMatchObject({ state: 'REFUNDED', status: 'refunded' })
    for (status of ['pending', 'waiting', 'submitted', 'delayed', 'depositing']) {
      const s = await a.status!({ leg: walletLeg, ref: '0xr' }, ctx)
      expect(s).toMatchObject({ state: 'PROCESSING', status: 'processing' })
      expect(checkLegStep(s)).toEqual([])
    }
  })

  it('wallet: a signature step gives a FAILED leg step', async () => {
    const { fetch } = fakeFetch([{ method: 'POST', match: '/quote/v2', reply: () => relayQuote({ signature: true }) }])
    const a = relay()
    const ctx = makeCtx({ fetch })
    const q = await a.quote({ leg: walletLeg, amountIn: { amount: '10', asset: ARB_USDC }, source: { chain: ARB_USDC.chain, token: ARB_USDC.token, address: USER } }, ctx)
    const step = await a.start({ leg: walletLeg, quote: q, source: { chain: ARB_USDC.chain, token: ARB_USDC.token, address: USER } }, ctx)
    expect(checkLegStep(step)).toEqual([])
    expect(step.state).toBe('FAILED')
    expect(step.error?.message).toMatch(/signature/)
  })

  it('wallet: same chain and token builds a direct ERC-20 transfer without calling Relay', async () => {
    const { fetch, calls } = fakeFetch([])
    const a = relay()
    const ctx = makeCtx({ fetch })
    const q = await a.quote({ leg: walletLeg, amountIn: { amount: '12.5', asset: BASE_USDC }, source: { chain: BASE_USDC.chain, token: BASE_USDC.token, address: USER }, deliverTo: { address: DEST } }, ctx)
    expectConformant(q)
    expect(q.output.amount).toBe('12.5')
    expect(q.fees).toEqual([])
    const step = await a.start({ leg: walletLeg, quote: q }, ctx)
    expect(step.surface).toEqual({
      kind: 'WALLET_TX',
      chain: 'eip155:8453',
      txs: [{ to: BASE_USDC.token, data: erc20TransferData(DEST, '12500000'), chainId: 8453 }],
    })
    expect(erc20TransferData(DEST, '12500000')).toBe(`0xa9059cbb${'0'.repeat(24)}000000000000000000000000000000000000beef${'0'.repeat(58)}bebc20`)
    // not verified on chain: succeeds once the wallet reports a hash
    expect(await a.status!({ leg: walletLeg, ref: step.ref! }, ctx)).toMatchObject({ status: 'awaiting_user' })
    await a.transition!({ leg: walletLeg, ref: step.ref!, name: 'submit_tx', inputs: { txHash: `0x${'cd'.repeat(32)}` } }, ctx)
    expect(await a.status!({ leg: walletLeg, ref: step.ref! }, ctx)).toMatchObject({ state: 'COMPLETED', status: 'succeeded' })
    expect(calls).toHaveLength(0)

    // native token: value transfer
    const nativeLeg: PathwayLeg = { ...walletLeg, to: { asset: { kind: 'crypto', chain: 'eip155:8453', token: 'native' }, location: { kind: 'address', address: DEST } } }
    const qn = await a.quote({ leg: nativeLeg, amountIn: { amount: '0.01', asset: { kind: 'crypto', chain: 'eip155:8453', token: 'native' } }, source: { chain: 'eip155:8453', token: 'native' } }, makeCtx({ fetch, destination: { type: 'crypto', chain: 'eip155:8453', token: 'native', address: DEST } }))
    const sn = await a.start({ leg: nativeLeg, quote: qn }, ctx)
    expect(sn.surface).toMatchObject({ txs: [{ to: DEST, value: '10000000000000000', chainId: 8453 }] })
  })

  it('transfer: open deposit address (not strict), cached per route and reused', async () => {
    let n = 0
    const { fetch, calls } = fakeFetch([{ method: 'POST', match: '/quote/v2', reply: () => (n++, relayQuote({ deposit: true })) }])
    const a = relay()
    const shared = memoryKV()
    const ctx = makeCtx({ fetch, shared })
    const q = await a.quote({ leg: transferLeg, amountIn: { amount: '0', asset: ARB_USDC }, source: { chain: ARB_USDC.chain, token: ARB_USDC.token } }, ctx)
    expectConformant(q)
    expect(q.data).toMatchObject({ depositAddress: DEPOSIT, anyAmount: true, nominal: true })
    const body = calls[0]!.body as Record<string, unknown>
    expect(body).toMatchObject({ useDepositAddress: true, user: DEST, recipient: DEST, refundTo: '0x0000000000000000000000000000000000000000', tradeType: 'EXACT_INPUT', amount: '10000000' })
    expect(body.strict).toBeUndefined()
    expect([...shared.data.keys()].some((k) => k.startsWith('da:'))).toBe(true)

    const step = await a.start({ leg: transferLeg, quote: q }, ctx)
    expect(checkLegStep(step)).toEqual([])
    expect(step).toMatchObject({
      state: 'PAYMENT',
      status: 'awaiting_user',
      ref: DEPOSIT,
      surface: { kind: 'DEPOSIT_ADDRESS', chain: 'eip155:42161', chainName: 'Arbitrum', address: DEPOSIT, symbol: 'USDC', warning: 'Send only USDC on Arbitrum. Other tokens or chains may be lost.' },
    })
    expect(step.transitions[0]!.kind).toBe('AWAIT')
  })

  it('transfer: status uses /requests/v2 without a key (warns once) and only counts requests after start', async () => {
    silentLog.warnings.length = 0
    const old = new Date(Date.now() - 3_600_000).toISOString()
    let requests: unknown[] = [{ id: 'old', status: 'success', createdAt: old }]
    const { fetch, calls } = fakeFetch([
      { method: 'POST', match: '/quote/v2', reply: () => relayQuote({ deposit: true }) },
      { method: 'GET', match: '/requests/v2', reply: () => ({ requests }) },
    ])
    const a = relay()
    const ctx = makeCtx({ fetch })
    const q = await a.quote({ leg: transferLeg, amountIn: { amount: '25', asset: ARB_USDC }, source: { chain: ARB_USDC.chain, token: ARB_USDC.token } }, ctx)
    const step = await a.start({ leg: transferLeg, quote: q }, ctx)
    expect(await a.status!({ leg: transferLeg, ref: step.ref! }, ctx)).toMatchObject({ state: 'PAYMENT', status: 'awaiting_user' })
    requests = [
      { id: 'new', status: 'pending', createdAt: new Date().toISOString() },
      ...requests,
    ]
    expect(await a.status!({ leg: transferLeg, ref: step.ref! }, ctx)).toMatchObject({ state: 'PROCESSING', status: 'processing' })
    requests = [
      {
        id: 'new',
        status: 'success',
        createdAt: new Date().toISOString(),
        data: { outTxs: [{ hash: '0xout', chainId: 8453 }], metadata: { currencyOut: { currency: usdc(8453, BASE_USDC.token), amount: '24950000' } } },
      },
    ]
    const done = await a.status!({ leg: transferLeg, ref: step.ref! }, ctx)
    expect(checkLegStep(done)).toEqual([])
    expect(done).toMatchObject({ state: 'COMPLETED', status: 'succeeded', txHash: '0xout', output: { amount: '24.95' } })
    expect(calls.filter((c) => c.url.includes('/requests/v2')).every((c) => c.url.includes(`depositAddress=${DEPOSIT}`) && c.url.includes('limit='))).toBe(true)
    expect(silentLog.warnings.filter((w) => w.includes('/requests/v2'))).toHaveLength(1)
  })

  it('transfer: status uses /requests/v3 with x-api-key when an API key is set (v3 txHash shape)', async () => {
    const { fetch, calls } = fakeFetch([
      { method: 'POST', match: '/quote/v2', reply: () => relayQuote({ deposit: true }) },
      {
        method: 'GET',
        match: '/requests/v3',
        reply: () => ({
          requests: [{ id: 'r', status: 'refund', createdAt: new Date().toISOString(), data: { outTxs: [{ txHash: '0xrefund' }] } }],
        }),
      },
    ])
    const a = relay({ apiKey: 'secret' })
    const ctx = makeCtx({ fetch })
    const q = await a.quote({ leg: transferLeg, amountIn: { amount: '5', asset: ARB_USDC }, source: { chain: ARB_USDC.chain, token: ARB_USDC.token } }, ctx)
    const step = await a.start({ leg: transferLeg, quote: q }, ctx)
    const s = await a.status!({ leg: transferLeg, ref: step.ref! }, ctx)
    expect(s).toMatchObject({ state: 'REFUNDED', status: 'refunded', txHash: '0xrefund' })
    const v3 = calls.find((c) => c.url.includes('/requests/v3'))!
    expect(v3.headers.get('x-api-key')).toBe('secret')
  })

  it('transfer: same chain and token shows the destination address, no Relay call', async () => {
    const { fetch, calls } = fakeFetch([])
    const a = relay()
    const ctx = makeCtx({ fetch })
    const q = await a.quote({ leg: transferLeg, amountIn: { amount: '0', asset: BASE_USDC }, source: { chain: BASE_USDC.chain, token: BASE_USDC.token } }, ctx)
    const step = await a.start({ leg: transferLeg, quote: q }, ctx)
    expect(step.surface).toMatchObject({ kind: 'DEPOSIT_ADDRESS', address: DEST, chain: 'eip155:8453' })
    expect(calls).toHaveLength(0)
  })

  it('bridge: prepareDeposit returns a cached open address, quote estimates, start waits in PROCESSING', async () => {
    const { fetch, calls } = fakeFetch([
      { method: 'POST', match: '/quote/v2', reply: (c) => relayQuote({ deposit: true, amountIn: String((c.body as { amount: string }).amount) }) },
      { method: 'GET', match: '/requests/v2', reply: () => ({ requests: [] }) },
    ])
    const a = relay()
    const shared = memoryKV()
    const dest = { type: 'crypto' as const, chain: 'eip155:143', token: MONAD_TOKEN, address: DEST }
    const ctx = makeCtx({ fetch, shared, destination: dest })
    const d1 = await a.prepareDeposit!({ leg: bridgeLeg }, ctx)
    const d2 = await a.prepareDeposit!({ leg: bridgeLeg }, makeCtx({ fetch, shared, destination: dest }))
    expect(d1.address).toBe(DEPOSIT)
    expect(d2.address).toBe(DEPOSIT)
    expect(calls.filter((c) => c.url.includes('/quote/v2'))).toHaveLength(1) // second call served from the cache

    const q = await a.quote({ leg: bridgeLeg, amountIn: { amount: '100', asset: BASE_USDC }, deliverTo: { address: DEST } }, ctx)
    expectConformant(q)
    expect(q.input.amount).toBe('100')
    expect(q.data).toMatchObject({ depositAddress: DEPOSIT, anyAmount: false })
    const step = await a.start({ leg: bridgeLeg, quote: q, deliverTo: { address: DEST } }, ctx)
    expect(checkLegStep(step)).toEqual([])
    expect(step).toMatchObject({ state: 'PROCESSING', status: 'processing', ref: DEPOSIT })
    expect(step.surface).toBeUndefined()
    expect(await a.status!({ leg: bridgeLeg, ref: DEPOSIT }, ctx)).toMatchObject({ state: 'PROCESSING', status: 'processing' })
  })

  it('maps Relay 4xx to NO_QUOTES and health() calls /chains', async () => {
    const { fetch } = fakeFetch([
      { method: 'POST', match: '/quote/v2', status: 400, reply: () => ({ message: 'Amount too low' }) },
      { method: 'GET', match: '/chains', reply: () => ({ chains: [{ id: 1 }] }) },
    ])
    const a = relay()
    const ctx = makeCtx({ fetch })
    await expect(a.quote({ leg: walletLeg, amountIn: { amount: '0.01', asset: ARB_USDC }, source: { chain: ARB_USDC.chain, token: ARB_USDC.token } }, ctx)).rejects.toMatchObject({
      error: { code: 'NO_QUOTES', message: 'Relay: Amount too low' },
    })
    expect(await a.health!({ fetch, log: silentLog })).toEqual({ ok: true })
  })
})

// ---------------- live (LIVE=1) ----------------

describe('relay live API', () => {
  it.runIf(process.env.LIVE === '1')('open deposit address quote: USDC Arbitrum -> USDC Base, and a wallet quote', async () => {
    const a = relay()
    const ctx = makeCtx({ fetch: globalThis.fetch })
    const q = await a.quote({ leg: transferLeg, amountIn: { amount: '10', asset: ARB_USDC }, source: { chain: ARB_USDC.chain, token: ARB_USDC.token } }, ctx)
    expectConformant(q)
    expect(q.data?.depositAddress).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(Number(q.output.amount)).toBeGreaterThan(9)
    const step = await a.start({ leg: transferLeg, quote: q }, ctx)
    expect(step.surface).toMatchObject({ kind: 'DEPOSIT_ADDRESS', address: q.data!.depositAddress })
    const s = await a.status!({ leg: transferLeg, ref: step.ref! }, ctx)
    expect(s.status).toBe('awaiting_user')

    const w = await a.quote({ leg: walletLeg, amountIn: { amount: '10', asset: ARB_USDC }, source: { chain: ARB_USDC.chain, token: ARB_USDC.token, address: USER }, deliverTo: { address: DEST } }, ctx)
    expectConformant(w)
    const ws = await a.start({ leg: walletLeg, quote: w, source: { chain: ARB_USDC.chain, token: ARB_USDC.token, address: USER } }, ctx)
    expect(ws.surface?.kind).toBe('WALLET_TX')
    expect(await a.health!({ fetch: globalThis.fetch, log: silentLog })).toEqual({ ok: true })
  }, 30_000)
})
