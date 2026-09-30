import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildSettlementTxs, checkAdapterShape, checkLegQuote, checkLegStep, encodeSettle, hashSettlementCalls } from '@openrampkit/adapter'
import type { SettlementIntentTypedData } from '@openrampkit/adapter'
import { USDC, planPathways } from '@openrampkit/core'
import type { CryptoAsset, LegQuote, PathwayLeg } from '@openrampkit/core'
import { RELAY_POLL, RELAY_SOLANA_CHAIN_ID, caip2FromRelay, erc20TransferData, relay, relayChainId, relayCurrency } from './index.js'
import type { RelayQuoteResponse } from './index.js'
import { fakeFetch, makeCtx, memoryKV, recordingLog, runAdapterConformance, silentLog } from '@openrampkit/adapter/testing'

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

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

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
    // no Relay call; the leg waits for the wallet's tx hash
    expect(await a.status!({ leg: walletLeg, ref: step.ref! }, ctx)).toMatchObject({ status: 'awaiting_user' })
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

  it('wallet same chain: the tx hash is verified on chain (receipt status, recipient and amount)', async () => {
    const TX = `0x${'cd'.repeat(32)}`
    const transferLog = (to: string, amount: bigint) => ({ address: BASE_USDC.token, topics: [TRANSFER, `0x${'0'.repeat(24)}${'11'.repeat(20)}`, `0x${'0'.repeat(24)}${to.slice(2).toLowerCase()}`], data: `0x${amount.toString(16).padStart(64, '0')}` })
    const run = async (receipt: unknown) => {
      const { fetch, calls } = fakeFetch([{ method: 'POST', match: 'mainnet.base.org', reply: (c) => ({ jsonrpc: '2.0', id: 1, result: (c.body as { method: string }).method === 'eth_getTransactionReceipt' ? receipt : null }) }])
      const a = relay()
      const ctx = makeCtx({ fetch })
      const q = await a.quote({ leg: walletLeg, amountIn: { amount: '12.5', asset: BASE_USDC }, source: { chain: BASE_USDC.chain, token: BASE_USDC.token, address: USER }, deliverTo: { address: DEST } }, ctx)
      const step = await a.start({ leg: walletLeg, quote: q }, ctx)
      await a.transition!({ leg: walletLeg, ref: step.ref!, name: 'submit_tx', inputs: { txHash: TX } }, ctx)
      return { status: await a.status!({ leg: walletLeg, ref: step.ref! }, ctx), calls }
    }
    const ok = await run({ status: '0x1', logs: [transferLog(DEST, 12_500_000n)] })
    expect(ok.status).toMatchObject({ state: 'COMPLETED', status: 'succeeded', txHash: TX })
    expect(ok.calls[0]!.body).toMatchObject({ method: 'eth_getTransactionReceipt', params: [TX] })
    expect((await run(null)).status).toMatchObject({ state: 'PROCESSING', sub: 'confirming' })
    expect((await run({ status: '0x0', logs: [] })).status).toMatchObject({ state: 'FAILED', error: { code: 'DELIVERY_FAILED' } })
    expect((await run({ status: '0x1', logs: [transferLog(USER, 12_500_000n)] })).status).toMatchObject({ state: 'FAILED' })
    expect((await run({ status: '0x1', logs: [transferLog(DEST, 12_000_000n)] })).status).toMatchObject({ state: 'FAILED' })
  })

  it('wallet same chain, native: checks the tx recipient and value; a chain without an RPC is refused', async () => {
    const TX = `0x${'ef'.repeat(32)}`
    const nativeLeg: PathwayLeg = { ...walletLeg, to: { asset: { kind: 'crypto', chain: 'eip155:8453', token: 'native' }, location: { kind: 'address', address: DEST } } }
    const { fetch } = fakeFetch([
      { method: 'POST', match: 'custom-rpc', reply: (c) => ({ result: (c.body as { method: string }).method === 'eth_getTransactionReceipt' ? { status: '0x1', logs: [] } : { to: DEST, value: '0x2386f26fc10000' } }) },
    ])
    const a = relay({ rpcUrls: { 'eip155:8453': 'https://custom-rpc.test' } })
    const ctx = makeCtx({ fetch, destination: { type: 'crypto', chain: 'eip155:8453', token: '0x0000000000000000000000000000000000000000', address: DEST } })
    const q = await a.quote({ leg: nativeLeg, amountIn: { amount: '0.01', asset: { kind: 'crypto', chain: 'eip155:8453', token: 'native' } }, source: { chain: 'eip155:8453', token: 'native' } }, ctx)
    const step = await a.start({ leg: nativeLeg, quote: q }, ctx)
    await a.transition!({ leg: nativeLeg, ref: step.ref!, name: 'submit_tx', inputs: { txHash: TX } }, ctx)
    expect(await a.status!({ leg: nativeLeg, ref: step.ref! }, ctx)).toMatchObject({ state: 'COMPLETED' })
    const noRpc = relay({ rpcUrls: {} })
    const monad = { kind: 'crypto' as const, chain: 'eip155:143', token: MONAD_TOKEN, decimals: 6, symbol: 'USDC' }
    const mctx = makeCtx({ fetch, destination: { type: 'crypto', chain: 'eip155:143', token: MONAD_TOKEN, address: DEST } })
    const mleg: PathwayLeg = { ...walletLeg, to: { asset: monad, location: { kind: 'address', address: DEST } } }
    const mq = await noRpc.quote({ leg: mleg, amountIn: { amount: '1', asset: monad }, source: { chain: monad.chain, token: monad.token } }, mctx)
    const ms = await noRpc.start({ leg: mleg, quote: mq }, mctx)
    await noRpc.transition!({ leg: mleg, ref: ms.ref!, name: 'submit_tx', inputs: { txHash: TX } }, mctx)
    await expect(noRpc.status!({ leg: mleg, ref: ms.ref! }, mctx)).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
  })

  it('transfer: same chain and token shows the destination address and completes on a Transfer log', async () => {
    let logs: unknown[] = []
    const { fetch, calls } = fakeFetch([
      { method: 'POST', match: 'mainnet.base.org', reply: (c) => ({ result: (c.body as { method: string }).method === 'eth_blockNumber' ? '0x100' : logs }) },
    ])
    const a = relay()
    const ctx = makeCtx({ fetch })
    const q = await a.quote({ leg: transferLeg, amountIn: { amount: '0', asset: BASE_USDC }, source: { chain: BASE_USDC.chain, token: BASE_USDC.token } }, ctx)
    const step = await a.start({ leg: transferLeg, quote: q }, ctx)
    expect(step.surface).toMatchObject({ kind: 'DEPOSIT_ADDRESS', address: DEST, chain: 'eip155:8453' })
    expect(calls.every((c) => !c.url.includes('relay.link'))).toBe(true)
    expect(await a.status!({ leg: transferLeg, ref: DEST }, ctx)).toMatchObject({ state: 'PAYMENT', status: 'awaiting_user' })
    const getLogs = calls.find((c) => (c.body as { method?: string }).method === 'eth_getLogs')!
    expect((getLogs.body as { params: Array<Record<string, unknown>> }).params[0]).toMatchObject({ fromBlock: '0x100', address: BASE_USDC.token, topics: [TRANSFER, null, `0x${'0'.repeat(24)}${DEST.slice(2).toLowerCase()}`] })
    logs = [{ data: `0x${(5_000_000n).toString(16)}`, transactionHash: '0xaaa' }, { data: `0x${(2_500_000n).toString(16)}`, transactionHash: '0xbbb' }]
    expect(await a.status!({ leg: transferLeg, ref: DEST }, ctx)).toMatchObject({ state: 'COMPLETED', txHash: '0xbbb', output: { amount: '7.5' } })
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


// ---------------- conformance, errors and edge cases ----------------

const SOL = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
const HASH = `0x${'ab'.repeat(32)}`
const walletSrc = { chain: ARB_USDC.chain, token: ARB_USDC.token, address: USER }
const walletQuote = (a: ReturnType<typeof relay>, ctx: ReturnType<typeof makeCtx>, extra: Record<string, unknown> = {}) =>
  a.quote({ leg: walletLeg, amountIn: { amount: '10', asset: ARB_USDC }, source: walletSrc, deliverTo: { address: DEST }, ...extra }, ctx)

describe('relay conformance', () => {
  afterEach(() => vi.useRealTimers())

  it('wallet, transfer and bridge legs pass runAdapterConformance', async () => {
    const { fetch } = fakeFetch([
      { method: 'POST', match: '/quote/v2', reply: (c) => relayQuote({ deposit: !!(c.body as { useDepositAddress?: boolean }).useDepositAddress }) },
      { method: 'GET', match: '/intents/status/v3', reply: () => ({ status: 'pending', inTxHashes: ['0x1'] }) },
      { method: 'GET', match: '/requests/v3', reply: () => ({ requests: [{ id: 'r', status: 'success', createdAt: new Date().toISOString() }] }) },
    ])
    const report = await runAdapterConformance(relay({ apiKey: 'k' }), {
      fetch,
      fixtures: [
        { leg: walletLeg, quote: { amountIn: { amount: '10', asset: ARB_USDC }, source: walletSrc }, start: { source: walletSrc }, transitions: [{ name: 'submit_tx', inputs: { txHash: HASH } }], expect: { start: 'PAYMENT', status: 'PROCESSING' } },
        { leg: transferLeg, quote: { amountIn: { amount: '0', asset: ARB_USDC }, source: { chain: ARB_USDC.chain, token: ARB_USDC.token } }, expect: { start: 'PAYMENT', status: 'COMPLETED' } },
        { leg: bridgeLeg, quote: { amountIn: { amount: '50', asset: BASE_USDC }, deliverTo: { address: DEST } }, start: { deliverTo: { address: DEST } }, expect: { start: 'PROCESSING', status: 'COMPLETED' } },
      ],
    })
    expect(report.problems).toEqual([])
    expect(report.quotes).toHaveLength(3)
  })
})

describe('relay errors', () => {
  afterEach(() => vi.useRealTimers())

  it('maps HTTP 429, 401 and 5xx on quotes; 5xx is logged', async () => {
    const a = relay()
    for (const [status, code] of [[429, 'RATE_LIMITED'], [401, 'PROVIDER_UNAVAILABLE'], [500, 'PROVIDER_UNAVAILABLE'], [503, 'PROVIDER_UNAVAILABLE']] as const) {
      const log = recordingLog()
      const { fetch } = fakeFetch([{ method: 'POST', match: '/quote/v2', status, reply: () => ({ message: 'Invalid API key' }) }])
      const err = await walletQuote(a, makeCtx({ fetch, log })).catch((e) => e)
      expect(err.error.code).toBe(code)
      expect(err.error.message).not.toMatch(/API key/)
      if (status >= 500) expect(log.warnings).toEqual(['Relay: request failed'])
    }
    // 4xx without a message: the generic no-route text
    const { fetch } = fakeFetch([{ method: 'POST', match: '/quote/v2', status: 422, reply: () => ({}) }])
    await expect(walletQuote(a, makeCtx({ fetch }))).rejects.toMatchObject({ status: 422, error: { code: 'NO_QUOTES', message: 'Relay could not find a route for this pair right now.' } })
  })

  it('an HTML 502 page from a proxy is PROVIDER_UNAVAILABLE, not a JSON SyntaxError', async () => {
    const { fetch } = fakeFetch([{ method: 'POST', match: '/quote/v2', reply: () => new Response('<html>502 Bad Gateway</html>', { status: 502 }) }])
    await expect(relay().quote({ leg: transferLeg, amountIn: { amount: '5', asset: ARB_USDC }, source: { chain: ARB_USDC.chain, token: ARB_USDC.token } }, makeCtx({ fetch }))).rejects.toMatchObject({
      status: 502,
      error: { code: 'PROVIDER_UNAVAILABLE' },
    })
  })

  it('times out after 8 s with a 504', async () => {
    vi.useFakeTimers()
    const { fetch } = fakeFetch([{ method: 'POST', match: '/quote/v2', hang: true }])
    const p = walletQuote(relay(), makeCtx({ fetch })).catch((e) => e)
    await vi.advanceTimersByTimeAsync(8001)
    expect(await p).toMatchObject({ status: 504, error: { code: 'PROVIDER_UNAVAILABLE', message: 'Relay did not answer in time.' } })
  })

  it('status errors are mapped too (intents and requests)', async () => {
    const { fetch } = fakeFetch([
      { method: 'GET', match: '/intents/status/v3', status: 500, reply: () => ({}) },
      { method: 'GET', match: '/requests/v2', status: 429, reply: () => ({}) },
    ])
    const ctx = makeCtx({ fetch })
    await expect(relay().status!({ leg: walletLeg, ref: '0xr' }, ctx)).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    await expect(relay().status!({ leg: transferLeg, ref: DEPOSIT }, ctx)).rejects.toMatchObject({ error: { code: 'RATE_LIMITED' } })
  })

  it('missing fields in Relay responses', async () => {
    // no details: incomplete quote
    let reply: unknown = { steps: [] }
    const { fetch } = fakeFetch([{ method: 'POST', match: '/quote/v2', reply: () => reply }])
    const a = relay()
    await expect(walletQuote(a, makeCtx({ fetch }))).rejects.toMatchObject({ status: 502, error: { message: 'Relay returned an incomplete quote.' } })
    await expect(a.quote({ leg: bridgeLeg, amountIn: { amount: '5', asset: BASE_USDC } }, makeCtx({ fetch, destination: { type: 'crypto', chain: 'eip155:143', token: MONAD_TOKEN, decimals: 18, address: DEST } }))).rejects.toMatchObject({
      error: { message: 'Relay did not return a deposit address.' },
    })
    reply = { ...relayQuote({ deposit: true }), details: {} }
    await expect(a.quote({ leg: transferLeg, amountIn: { amount: '5', asset: ARB_USDC }, source: { chain: ARB_USDC.chain, token: ARB_USDC.token } }, makeCtx({ fetch }))).rejects.toMatchObject({
      error: { message: 'Relay returned an incomplete quote.' },
    })
    // no steps at all (was a TypeError): the quote works, start reports no transactions
    const { steps: _s, requestId: _r, ...noSteps } = relayQuote()
    reply = noSteps
    const ctx = makeCtx({ fetch })
    const q = await walletQuote(a, ctx)
    expect(q.data).toMatchObject({ steps: [] })
    expect(q.eta).toEqual({ min: 2, max: 60 })
    const step = await a.start({ leg: walletLeg, quote: q, source: walletSrc }, ctx)
    expect(step).toMatchObject({ state: 'FAILED', error: { code: 'PROVIDER_DECLINED', message: 'Relay returned no transactions for this route.' } })
    expect(step.ref).toMatch(/^relay:sess_1:[0-9a-f]{16}$/)
    expect(checkLegStep(step)).toEqual([])
  })

  it('step kinds Relay adapters cannot run give a FAILED step naming the kind', async () => {
    const quote = relayQuote()
    for (const [kind, text] of [['permit', 'a permit step'], ['', 'a unknown step'], ['signature', 'a signature step']] as const) {
      const { fetch } = fakeFetch([{ method: 'POST', match: '/quote/v2', reply: () => ({ ...quote, steps: [{ id: 'x', kind, items: [] }, ...quote.steps] }) }])
      const a = relay()
      const ctx = makeCtx({ fetch })
      const step = await a.start({ leg: walletLeg, quote: await walletQuote(a, ctx), source: walletSrc }, ctx)
      expect(step).toMatchObject({ state: 'FAILED', status: 'failed', error: { recovery: 'choose_other' } })
      expect(step.error!.message).toContain(`needs ${text}`)
    }
  })

  it('wallet txs skip complete items, drop empty data and zero value, keep gas', async () => {
    const q = relayQuote()
    q.steps = [
      {
        id: 'approve',
        kind: 'transaction',
        items: [
          { status: 'complete', data: { to: '0xdone', chainId: 42161 } },
          { status: 'incomplete' },
          { status: 'incomplete', data: { to: '0xapprove', data: '0x', value: '0', chainId: 42161, gas: '50000' } },
          { status: 'incomplete', data: { to: '0xdeposit', value: '7', chainId: 42161 } },
        ],
      },
    ]
    const { fetch } = fakeFetch([{ method: 'POST', match: '/quote/v2', reply: () => q }])
    const a = relay()
    const ctx = makeCtx({ fetch })
    const step = await a.start({ leg: walletLeg, quote: await walletQuote(a, ctx), source: walletSrc }, ctx)
    expect(step.surface).toEqual({
      kind: 'WALLET_TX',
      chain: 'eip155:42161',
      txs: [
        { to: '0xapprove', chainId: 42161, gas: '50000' },
        { to: '0xdeposit', value: '7', chainId: 42161 },
      ],
    })
    expect(step.ref).toBe('0xreq1')
  })

  it('re-quotes stale or other-user quotes; without a stored body the quote has expired', async () => {
    let n = 0
    const { fetch, calls } = fakeFetch([{ method: 'POST', match: '/quote/v2', reply: () => ({ ...relayQuote(), requestId: `0xreq${++n}` }) }])
    const a = relay()
    const ctx = makeCtx({ fetch })
    const q = await walletQuote(a, ctx)
    // another wallet connected since the quote
    const other = '0x1111111111111111111111111111111111111111'
    const s1 = await a.start({ leg: walletLeg, quote: q, source: { ...walletSrc, address: other } }, ctx)
    expect((calls[1]!.body as { user: string }).user).toBe(other)
    expect(s1.ref).toBe('0xreq2')
    // stale
    vi.useFakeTimers({ now: Date.now() + 25_000 })
    const s2 = await a.start({ leg: walletLeg, quote: q }, ctx)
    expect(calls).toHaveLength(3)
    expect((calls[2]!.body as { user: string }).user).toBe(USER)
    expect(s2.ref).toBe('0xreq3')
    await expect(a.start({ leg: walletLeg, quote: { ...q, data: { direct: false } } }, ctx)).rejects.toMatchObject({ status: 410, error: { code: 'QUOTE_EXPIRED' } })
  })

  it('exact output quotes, unknown-token decimals from /currencies/v2 (cached), and missing tokens', async () => {
    let currencies: unknown = [{ decimals: 18 }]
    const { fetch, calls } = fakeFetch([
      { method: 'POST', match: '/currencies/v2', reply: () => currencies },
      {
        method: 'POST',
        match: '/quote/v2',
        reply: () => ({ ...relayQuote(), details: { currencyIn: { currency: usdc(42161, ARB_USDC.token), amount: '10100000' }, currencyOut: { currency: { chainId: 143, address: MONAD_TOKEN, symbol: 'MON', decimals: 18 }, amount: '5000000000000000000' } } }),
      },
    ])
    const a = relay()
    const shared = memoryKV()
    const monad = { type: 'crypto' as const, chain: 'eip155:143', token: MONAD_TOKEN, address: DEST }
    const ctx = makeCtx({ fetch, shared, destination: monad })
    const leg = { ...walletLeg, to: { asset: { kind: 'crypto' as const, chain: '*', token: '*' }, location: { kind: 'address' as const, address: DEST } } }
    const q = await a.quote({ leg, amountOut: { amount: '5', asset: { kind: 'crypto', chain: 'eip155:143', token: MONAD_TOKEN } }, source: walletSrc }, ctx)
    expect(q.output).toMatchObject({ amount: '5', asset: { chain: 'eip155:143', symbol: 'MON', decimals: 18 } })
    const quoteBody = calls.find((c) => c.url.includes('/quote/v2'))!.body as Record<string, unknown>
    expect(quoteBody).toMatchObject({ tradeType: 'EXACT_OUTPUT', amount: '5000000000000000000', destinationChainId: 143 })
    expect(calls.find((c) => c.url.includes('/currencies/v2'))!.body).toEqual({ chainIds: [143], address: MONAD_TOKEN, limit: 1 })
    await a.quote({ leg, amountOut: { amount: '5', asset: { kind: 'crypto', chain: 'eip155:143', token: MONAD_TOKEN } }, source: walletSrc }, ctx)
    expect(calls.filter((c) => c.url.includes('/currencies/v2'))).toHaveLength(1) // cached in shared
    currencies = []
    await expect(a.quote({ leg, amountIn: { amount: '1', asset: ARB_USDC }, source: walletSrc }, makeCtx({ fetch, destination: monad }))).rejects.toMatchObject({ error: { code: 'BAD_REQUEST', message: 'Relay does not know this token.' } })
    const failing = fakeFetch([{ method: 'POST', match: '/currencies/v2', status: 500, reply: () => ({}) }])
    await expect(a.quote({ leg, amountIn: { amount: '1', asset: ARB_USDC }, source: walletSrc }, makeCtx({ fetch: failing.fetch, destination: monad }))).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    // decimals given on the destination skip the lookup
    const known = fakeFetch([{ method: 'POST', match: '/quote/v2', reply: () => relayQuote() }])
    await a.quote({ leg, amountIn: { amount: '1', asset: ARB_USDC }, source: walletSrc }, makeCtx({ fetch: known.fetch, destination: { ...monad, decimals: 18, symbol: 'MON' } }))
    expect(known.calls.map((c) => c.url)).toEqual(['https://api.relay.link/quote/v2'])
  })

  it('rejects bad inputs with BAD_REQUEST or NOT_FOUND', async () => {
    const { fetch } = fakeFetch([])
    const a = relay()
    const ctx = makeCtx({ fetch })
    // non-EVM wallet source
    await expect(a.quote({ leg: walletLeg, amountIn: { amount: '1', asset: { kind: 'crypto', chain: SOL, token: 'native' } }, source: { chain: SOL, token: 'native' } }, ctx)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST', message: expect.stringContaining('EVM chains only') } })
    // no token chosen yet
    await expect(a.quote({ leg: walletLeg, amountIn: { amount: '1', asset: { kind: 'crypto', chain: '*', token: '*' } } }, ctx)).rejects.toMatchObject({ error: { message: 'Choose the token you want to pay with.' } })
    // fiat amount on a crypto leg
    await expect(a.quote({ leg: bridgeLeg, amountIn: { amount: '1', asset: { kind: 'fiat', currency: 'USD' } } }, ctx)).rejects.toMatchObject({ error: { message: 'Relay needs a crypto source.' } })
    // fiat destination and no deliverTo
    const fiatCtx = makeCtx({ fetch, destination: { type: 'merchant', merchantId: 'm', currency: 'USD' } as never })
    await expect(a.quote({ leg: walletLeg, amountIn: { amount: '1', asset: ARB_USDC }, source: walletSrc }, fiatCtx)).rejects.toMatchObject({ error: { message: 'Relay legs need a crypto destination.' } })
    // unsupported chain
    await expect(a.quote({ leg: walletLeg, amountIn: { amount: '1', asset: { kind: 'crypto', chain: 'eip155:1', token: '0xabc' } }, source: { chain: 'cosmos:hub', token: 'x' } }, ctx)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
    expect(() => relayChainId('cosmos:hub')).toThrow(/does not support chain/)
    // unknown legs
    await expect(a.quote({ leg: { ...walletLeg, legId: 'nope' }, amountIn: { amount: '1', asset: ARB_USDC } }, ctx)).rejects.toMatchObject({ status: 404, error: { code: 'NOT_FOUND' } })
    await expect(a.start({ leg: { ...walletLeg, legId: 'nope' }, quote: {} as LegQuote }, ctx)).rejects.toMatchObject({ status: 404 })
  })

  it('chain and currency helpers', () => {
    expect(relayChainId(SOL)).toBe(RELAY_SOLANA_CHAIN_ID)
    expect(relayChainId('solana')).toBe(RELAY_SOLANA_CHAIN_ID)
    expect(relayChainId('eip155:10')).toBe(10)
    expect(caip2FromRelay(RELAY_SOLANA_CHAIN_ID)).toBe(SOL)
    expect(caip2FromRelay(8453)).toBe('eip155:8453')
    expect(relayCurrency(SOL, 'native')).toBe('11111111111111111111111111111111')
    expect(relayCurrency('eip155:1', 'native')).toBe('0x0000000000000000000000000000000000000000')
    expect(relayCurrency('eip155:1', '0xabc')).toBe('0xabc')
    expect(RELAY_POLL).toEqual({ intervalMs: 2500, backoff: 1.2, maxIntervalMs: 10_000, giveUpAfterMs: 1_800_000 })
  })

  it('transition: rejects other names, bad hashes; accepts `hash` and unknown refs', async () => {
    const { fetch } = fakeFetch([])
    const a = relay()
    const ctx = makeCtx({ fetch })
    await expect(a.transition!({ leg: transferLeg, ref: 'r', name: 'submit_tx', inputs: { txHash: HASH } }, ctx)).rejects.toMatchObject({ status: 409 })
    await expect(a.transition!({ leg: walletLeg, ref: 'r', name: 'cancel' }, ctx)).rejects.toMatchObject({ status: 409 })
    await expect(a.transition!({ leg: walletLeg, ref: 'r', name: 'submit_tx', inputs: { txHash: '0x12' } }, ctx)).rejects.toMatchObject({ error: { message: 'A transaction hash is required.' } })
    await expect(a.transition!({ leg: walletLeg, ref: 'r', name: 'submit_tx' }, ctx)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
    const t = await a.transition!({ leg: walletLeg, ref: '0xunknown', name: 'submit_tx', inputs: { hash: HASH } }, ctx)
    expect(t).toMatchObject({ state: 'PROCESSING', txHash: HASH })
    expect(await ctx.store.get('w:0xunknown')).toEqual({ mode: 'relay', requestId: '0xunknown', txHash: HASH })
  })

  it('wallet status: waiting before the tx, processing after (tx hash from our record)', async () => {
    let s: unknown = { status: 'waiting' }
    const { fetch } = fakeFetch([{ method: 'GET', match: '/intents/status/v3', reply: () => s }])
    const a = relay()
    const ctx = makeCtx({ fetch })
    expect(await a.status!({ leg: walletLeg, ref: '0xr' }, ctx)).toMatchObject({ state: 'PAYMENT', status: 'awaiting_user', transitions: [{ kind: 'SURFACE_RESULT' }] })
    await a.transition!({ leg: walletLeg, ref: '0xr', name: 'submit_tx', inputs: { txHash: HASH } }, ctx)
    const p = await a.status!({ leg: walletLeg, ref: '0xr' }, ctx)
    expect(p).toMatchObject({ state: 'PROCESSING', sub: 'waiting', txHash: HASH })
    expect(checkLegStep(p)).toEqual([])
    s = { status: 'success' }
    expect(await a.status!({ leg: walletLeg, ref: '0xr' }, ctx)).toMatchObject({ state: 'COMPLETED', txHash: HASH })
  })
})

describe('relay deposit addresses', () => {
  afterEach(() => vi.useRealTimers())
  const routeKey = (shared: ReturnType<typeof memoryKV>) => [...shared.data.keys()].find((k) => k.startsWith('da:'))!

  it('cache: miss creates, hit reuses, expiry after 24 h creates again', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-01T00:00:00Z') })
    let address = DEPOSIT
    const { fetch, calls } = fakeFetch([{ method: 'POST', match: '/quote/v2', reply: () => ({ ...relayQuote({ deposit: true }), steps: [{ id: 'd', kind: 'transaction', depositAddress: address, items: [] }] }) }])
    const a = relay()
    const shared = memoryKV()
    const dest = { type: 'crypto' as const, chain: 'eip155:143', token: MONAD_TOKEN, decimals: 18, address: DEST }
    const ctx = () => makeCtx({ fetch, shared, destination: dest })
    expect((await a.prepareDeposit!({ leg: bridgeLeg }, ctx())).address).toBe(DEPOSIT) // miss
    expect(routeKey(shared)).toBe(`da:${DEST}:eip155:8453:${BASE_USDC.token}:eip155:143:${MONAD_TOKEN}`)
    const quoteBody = calls[0]!.body as Record<string, unknown>
    expect(quoteBody).toMatchObject({ amount: '10000000', useDepositAddress: true }) // nominal 10 USDC
    address = '0x2222222222222222222222222222222222222222'
    vi.advanceTimersByTime(23 * 3600_000)
    expect((await a.prepareDeposit!({ leg: bridgeLeg }, ctx())).address).toBe(DEPOSIT) // hit
    expect(calls).toHaveLength(1)
    // a real quote while the cache holds the address keeps showing the cached one
    const q = await a.quote({ leg: bridgeLeg, amountIn: { amount: '20', asset: BASE_USDC } }, ctx())
    expect(q.data).toMatchObject({ depositAddress: DEPOSIT })
    vi.advanceTimersByTime(2 * 3600_000) // 25 h: expired
    expect((await a.prepareDeposit!({ leg: bridgeLeg }, ctx())).address).toBe(address)
    expect(calls).toHaveLength(3)
  })

  it('prepareDeposit records the session start once; start without an address looks it up', async () => {
    const { fetch, calls } = fakeFetch([{ method: 'POST', match: '/quote/v2', reply: () => relayQuote({ deposit: true }) }])
    const a = relay()
    const ctx = makeCtx({ fetch, destination: { type: 'crypto', chain: 'eip155:143', token: MONAD_TOKEN, decimals: 18, address: DEST } })
    await a.prepareDeposit!({ leg: bridgeLeg }, ctx)
    const rec = await ctx.store.get<{ since: number; mode: string }>(`d:${DEPOSIT}`)
    expect(rec).toMatchObject({ address: DEPOSIT, mode: 'relay' })
    await a.prepareDeposit!({ leg: bridgeLeg }, ctx)
    expect((await ctx.store.get<{ since: number }>(`d:${DEPOSIT}`))!.since).toBe(rec!.since)
    // a quote without the deposit address in its data (e.g. from an older server)
    const quote: LegQuote = { adapterId: 'relay', legId: 'bridge', input: { amount: '5', asset: BASE_USDC }, output: { amount: '5', asset: { kind: 'crypto', chain: 'eip155:143', token: MONAD_TOKEN, decimals: 18 } }, fees: [], eta: { min: 1, max: 2 } }
    const step = await a.start({ leg: bridgeLeg, quote }, ctx)
    expect(step).toMatchObject({ state: 'PROCESSING', ref: DEPOSIT })
    expect(calls).toHaveLength(1)
  })

  it('same chain and token: no Relay call; the destination is the address and status waits', async () => {
    const { fetch, calls } = fakeFetch([{ method: 'POST', match: 'mainnet.base.org', reply: (c) => ({ result: (c.body as { method: string }).method === 'eth_blockNumber' ? '0x1' : [] }) }])
    const a = relay()
    const ctx = makeCtx({ fetch })
    const sameBridge: PathwayLeg = { ...bridgeLeg, to: { asset: BASE_USDC, location: { kind: 'address', address: DEST } } }
    expect(await a.prepareDeposit!({ leg: sameBridge }, ctx)).toEqual({ address: DEST, ref: DEST })
    expect(await ctx.store.get(`d:${DEST}`)).toMatchObject({ mode: 'direct' })
    expect(await a.status!({ leg: sameBridge, ref: DEST }, ctx)).toMatchObject({ state: 'PROCESSING', sub: 'waiting_for_deposit' })
    // native ETH on Base by transfer
    const eth: CryptoAsset = { kind: 'crypto', chain: 'eip155:8453', token: 'native' }
    const nctx = makeCtx({ fetch, destination: { type: 'crypto', chain: 'eip155:8453', token: '0x0000000000000000000000000000000000000000', address: DEST } })
    const q = await a.quote({ leg: { ...transferLeg, to: { asset: { kind: 'crypto', chain: '*', token: '*' }, location: { kind: 'address', address: DEST } } }, amountIn: { amount: '0.1', asset: eth }, source: { chain: eth.chain, token: 'native' } }, nctx)
    expect(q).toMatchObject({ output: { amount: '0.1', asset: { decimals: 18, symbol: 'ETH' } }, data: { direct: true, depositAddress: DEST } })
    const step = await a.start({ leg: transferLeg, quote: q }, nctx)
    expect(step.surface).toMatchObject({ kind: 'DEPOSIT_ADDRESS', address: DEST, symbol: 'ETH', warning: 'Send only ETH on Base. Other tokens or chains may be lost.' })
    // native: no Transfer logs to watch, so the leg keeps waiting
    expect(await a.status!({ leg: transferLeg, ref: DEST }, nctx)).toMatchObject({ state: 'PAYMENT', status: 'awaiting_user' })
    expect(calls.every((c) => !c.url.includes('relay.link'))).toBe(true)
  })

  it('Solana origin: native refund address, SOL symbol; explicit refundTo, no app fee at 0 bps', async () => {
    const { fetch, calls } = fakeFetch([{ method: 'POST', match: '/quote/v2', reply: () => relayQuote({ deposit: true }) }])
    const sol: CryptoAsset = { kind: 'crypto', chain: SOL, token: 'native' }
    const q = await relay({ appFee: { bps: 0, recipient: DEST } }).quote({ leg: transferLeg, amountIn: { amount: '0', asset: sol }, source: { chain: SOL, token: 'native' } }, makeCtx({ fetch }))
    expect(calls[0]!.body).toMatchObject({ originChainId: RELAY_SOLANA_CHAIN_ID, originCurrency: '11111111111111111111111111111111', refundTo: '11111111111111111111111111111111', amount: '5000000' })
    expect((calls[0]!.body as Record<string, unknown>).appFees).toBeUndefined()
    expect(q.data).toMatchObject({ nominal: true })
    await relay({ refundTo: '0xrefund' }).quote({ leg: transferLeg, amountIn: { amount: '1', asset: ARB_USDC }, source: { chain: ARB_USDC.chain, token: ARB_USDC.token } }, makeCtx({ fetch }))
    expect(calls[1]!.body).toMatchObject({ refundTo: '0xrefund' })
    const start = await relay().start({ leg: transferLeg, quote: { ...q, input: { amount: '0', asset: sol } } }, makeCtx({ fetch }))
    expect(start.surface).toMatchObject({ symbol: 'SOL', chainName: expect.any(String) })
  })

  it('request status: newest request wins, output from route, failures', async () => {
    const now = Date.now()
    let requests: unknown[] | undefined = []
    const { fetch } = fakeFetch([{ method: 'GET', match: '/requests/v3', reply: () => (requests ? { requests } : {}) }])
    const a = relay({ apiKey: 'k' })
    const ctx = makeCtx({ fetch })
    await ctx.store.put(`d:${DEPOSIT}`, { address: DEPOSIT, since: now, mode: 'relay' })
    requests = undefined
    expect(await a.status!({ leg: transferLeg, ref: DEPOSIT }, ctx)).toMatchObject({ state: 'PAYMENT' })
    const out = (amount: string) => ({ currency: usdc(8453, BASE_USDC.token), amount })
    requests = [
      { id: 'a', status: 'pending', createdAt: new Date(now + 1000).toISOString() },
      { id: 'b', status: 'failure', createdAt: new Date(now + 5000).toISOString(), data: { route: { quoted: { destination: { outputCurrency: out('1000000') } } } } },
      { id: 'c', status: 'success', createdAt: 'not a date' },
    ]
    const failed = await a.status!({ leg: transferLeg, ref: DEPOSIT }, ctx)
    expect(failed).toMatchObject({ state: 'FAILED', status: 'failed', error: { code: 'DELIVERY_FAILED' }, output: { amount: '1' } })
    expect(checkLegStep(failed)).toEqual([])
    requests = [{ id: 'd', status: 'success', createdAt: new Date(now).toISOString(), data: { route: { actual: { destination: { outputCurrency: out('2000000') } }, quoted: { destination: { outputCurrency: out('1') } } } } }]
    expect(await a.status!({ leg: transferLeg, ref: DEPOSIT }, ctx)).toMatchObject({ state: 'COMPLETED', output: { amount: '2' } })
    requests = [{ id: 'e', status: 'delayed', createdAt: new Date(now).toISOString(), data: { outTxs: [], metadata: { currencyOut: { amount: '5' } } } }]
    const delayed = await a.status!({ leg: transferLeg, ref: DEPOSIT }, ctx)
    expect(delayed).toMatchObject({ state: 'PROCESSING', sub: 'delayed' })
    expect(delayed.output).toBeUndefined()
    // no stored record: any request counts (since = 0)
    const fresh = makeCtx({ fetch })
    expect(await a.status!({ leg: bridgeLeg, ref: DEPOSIT }, fresh)).toMatchObject({ state: 'PROCESSING', sub: 'delayed' })
  })

  it('health: down or no chains', async () => {
    const down = fakeFetch([{ match: '/chains', status: 503, reply: () => ({}) }])
    const res = await relay().health!({ fetch: down.fetch, log: silentLog })
    expect(res.ok).toBe(false)
    expect(res.detail).toMatch(/HTTP 503/)
    const empty = fakeFetch([{ match: '/chains', reply: () => ({ chains: [] }) }])
    expect(await relay({ baseUrl: 'https://api.testnets.relay.link/' }).health!({ fetch: empty.fetch, log: silentLog })).toEqual({ ok: false })
    expect(empty.calls[0]!.url).toBe('https://api.testnets.relay.link/chains')
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

describe('relay same-chain tx reuse', () => {
  it('one transaction hash completes one payment only', async () => {
    const TX = `0x${'ab'.repeat(32)}`
    const log = { address: USDC['eip155:8453']!, topics: [TRANSFER, `0x${'0'.repeat(64)}`, `0x${'0'.repeat(24)}${DEST.slice(2).toLowerCase()}`], data: `0x${(12_500_000n).toString(16).padStart(64, '0')}` }
    const { fetch } = fakeFetch([{ method: 'POST', match: 'mainnet.base.org', reply: () => ({ result: { status: '0x1', logs: [log] } }) }])
    const shared = memoryKV()
    const a = relay()
    const pay = async () => {
      const ctx = makeCtx({ fetch, shared })
      const q = await a.quote({ leg: walletLeg, amountIn: { amount: '12.5', asset: BASE_USDC }, source: { chain: BASE_USDC.chain, token: BASE_USDC.token, address: USER }, deliverTo: { address: DEST } }, ctx)
      const step = await a.start({ leg: walletLeg, quote: q }, ctx)
      await a.transition!({ leg: walletLeg, ref: step.ref!, name: 'submit_tx', inputs: { txHash: TX } }, ctx)
      return a.status!({ leg: walletLeg, ref: step.ref! }, ctx)
    }
    expect(await pay()).toMatchObject({ state: 'COMPLETED' })
    expect(await pay()).toMatchObject({ state: 'FAILED', error: { message: 'This transaction was already used for another payment.' } })
  })
})

describe('relay settlement contract', () => {
  const CONTRACT = '0x2222222222222222222222222222222222222222'
  const VAULT = '0x4444444444444444444444444444444444444444'
  const TX = `0x${'aa'.repeat(32)}`
  const w = (v: string | bigint) => (typeof v === 'bigint' ? v.toString(16) : v.slice(2).toLowerCase()).padStart(64, '0')
  const dest = { type: 'crypto' as const, chain: BASE_USDC.chain, token: BASE_USDC.token, address: DEST, settlement: { contract: CONTRACT }, calls: [{ to: VAULT, data: '0x6e553f65' }] }

  function chain(opts: { settledAt?: bigint; amount?: bigint; recipient?: string; receipt?: unknown } = {}) {
    return fakeFetch([
      {
        method: 'POST',
        match: 'mainnet.base.org',
        reply: (c) => {
          const { method } = c.body as { method: string }
          if (method === 'eth_blockNumber') return { result: '0x64' }
          if (method === 'eth_call') return { result: `0x${w(USER)}${w(opts.settledAt ?? 0n)}${w(BASE_USDC.token)}${w(opts.recipient ?? DEST)}${w(opts.amount ?? 12_500_000n)}` }
          if (method === 'eth_getLogs') return { result: [{ data: `0x${w(BASE_USDC.token)}${w(opts.amount ?? 12_500_000n)}${hashSettlementCalls([{ target: VAULT, data: '0x6e553f65' }]).slice(2)}`, topics: [], transactionHash: TX, blockNumber: '0x65' }] }
          if (method === 'eth_getTransactionReceipt') return { result: opts.receipt ?? null }
          return { result: null }
        },
      },
    ])
  }

  const start = async (a: ReturnType<typeof relay>, ctx: ReturnType<typeof makeCtx>) => {
    const q = await a.quote({ leg: walletLeg, amountIn: { amount: '12.5', asset: BASE_USDC }, source: { chain: BASE_USDC.chain, token: BASE_USDC.token, address: USER }, deliverTo: { address: DEST } }, ctx)
    return a.start({ leg: walletLeg, quote: q, deliverTo: { address: DEST }, source: { chain: BASE_USDC.chain, token: BASE_USDC.token, address: USER } }, ctx)
  }

  it('builds approve + settle with the destination calls, and verifies by session id', async () => {
    const { fetch } = chain({ settledAt: 1_700_000_000n })
    const a = relay()
    const ctx = makeCtx({ fetch, destination: dest })
    const step = await start(a, ctx)
    const calls = [{ target: VAULT, data: '0x6e553f65' }]
    expect(step.surface).toEqual({
      kind: 'WALLET_TX',
      chain: 'eip155:8453',
      txs: buildSettlementTxs({ chainId: 8453, contract: CONTRACT, sessionId: 'sess_1', token: BASE_USDC.token, amount: 12_500_000n, recipient: DEST, calls }),
    })
    // Settled on chain: completes even before the client reports the hash, with the hash from the log.
    expect(await a.status!({ leg: walletLeg, ref: step.ref! }, ctx)).toMatchObject({ state: 'COMPLETED', status: 'succeeded', txHash: TX })
  })

  it('waits, confirms and fails as the chain says', async () => {
    const run = async (opts: Parameters<typeof chain>[0], submit = true) => {
      const { fetch } = chain(opts)
      const a = relay()
      const ctx = makeCtx({ fetch, destination: dest })
      const step = await start(a, ctx)
      if (submit) await a.transition!({ leg: walletLeg, ref: step.ref!, name: 'submit_tx', inputs: { txHash: TX } }, ctx)
      return a.status!({ leg: walletLeg, ref: step.ref! }, ctx)
    }
    expect(await run({}, false)).toMatchObject({ state: 'PAYMENT', status: 'awaiting_user' })
    expect(await run({})).toMatchObject({ state: 'PROCESSING', sub: 'confirming' })
    expect(await run({ receipt: { status: '0x0', logs: [] } })).toMatchObject({ state: 'FAILED', error: { message: 'The transaction failed on chain.' } })
    expect(await run({ receipt: { status: '0x1', logs: [] } })).toMatchObject({ state: 'FAILED', error: { message: 'The transaction did not settle this session.' } })
    expect(await run({ settledAt: 1n, amount: 1n })).toMatchObject({ state: 'FAILED', error: { message: 'The settlement paid less than the quoted amount.' } })
    expect(await run({ settledAt: 1n, recipient: USER })).toMatchObject({ state: 'FAILED', error: { message: 'The settlement paid a different recipient.' } })
  })

  it('signs the intent with the app hook', async () => {
    const { fetch } = chain()
    const sign = vi.fn(async (_typed: SettlementIntentTypedData) => '0xabcd')
    const a = relay({ signSettlementIntent: sign, settlementIntentTtlSec: 60 })
    const ctx = makeCtx({ fetch, destination: dest })
    const step = await start(a, ctx)
    expect(sign).toHaveBeenCalledOnce()
    const typed = sign.mock.calls[0]![0]
    expect(typed.domain).toEqual({ name: 'OpenRampSettlement', version: '1', chainId: 8453, verifyingContract: CONTRACT })
    expect(typed.message).toMatchObject({ payer: USER, token: BASE_USDC.token, recipient: DEST, minAmount: 12_500_000n, calls: [{ target: VAULT, data: '0x6e553f65' }] })
    const settleTx = (step.surface as { txs: Array<{ data: string }> }).txs[1]!
    expect(settleTx.data).toBe(
      encodeSettle(
        { sessionId: 'sess_1', token: BASE_USDC.token, amount: 12_500_000n, recipient: DEST, calls: [{ target: VAULT, data: '0x6e553f65' }] },
        { payer: USER, minAmount: 12_500_000n, deadline: typed.message.deadline, signature: '0xabcd' },
      ),
    )
  })

  it('refuses a cross-chain wallet payment into a settlement', async () => {
    const a = relay()
    const ctx = makeCtx({ fetch: fakeFetch([]).fetch, destination: dest })
    await expect(
      a.quote({ leg: walletLeg, amountIn: { amount: '1', asset: ARB_USDC }, source: { chain: ARB_USDC.chain, token: ARB_USDC.token, address: USER }, deliverTo: { address: DEST } }, ctx),
    ).rejects.toMatchObject({ error: { code: 'BAD_REQUEST', message: expect.stringMatching(/settles on Base/) } })
  })

  it('only the wallet leg is offered for a settlement destination', () => {
    const plan = planPathways({
      direction: 'deposit',
      destination: dest,
      user: { country: 'VN', walletConnected: true },
      legs: relay().legs.map((spec) => ({ adapterId: 'relay', provider: 'Relay', spec })),
    })
    const byId = Object.fromEntries(plan.pathways.map((p) => [p.id, p]))
    expect(byId['wallet:relay.wallet']?.reason).toBeUndefined()
    expect(byId['transfer:relay.transfer']?.reason).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' })
  })
})
