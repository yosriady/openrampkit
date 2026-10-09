import { describe, expect, it } from 'vitest'
import { ERC20_TRANSFER_TOPIC, checkAdapterShape, checkLegQuote, checkLegStep, topicAddress } from '@openrampkit/adapter'
import { SOLANA_MAINNET, SOLANA_USDC_MINT, USDC, planPathways } from '@openrampkit/core'
import type { CryptoAsset, LegQuote, PathwayLeg } from '@openrampkit/core'
import { fakeFetch, makeCtx, memoryKV, runAdapterConformance } from '@openrampkit/adapter/testing'
import type { FakeCall } from '@openrampkit/adapter/testing'
import { LIFI_SOLANA_CHAIN_ID, caip2FromLifi, erc20ApproveData, lifi, lifiChainId, lifiToken } from './index.js'
import type { LifiQuote, LifiStatus } from './index.js'

const USER = '0x03508bB71268BBA25ECaCC8F620e01866650532c'
const DEST = '0x000000000000000000000000000000000000beef'
const OTHER = '0x000000000000000000000000000000000000cafe'
const DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'
const SOL_USER = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
const BASE_USDC: CryptoAsset = { kind: 'crypto', chain: 'eip155:8453', token: USDC['eip155:8453']! }
const ARB_USDC: CryptoAsset = { kind: 'crypto', chain: 'eip155:42161', token: USDC['eip155:42161']! }
const HASH = `0x${'a'.repeat(64)}`
const HASH2 = `0x${'b'.repeat(64)}`
const OUT_HASH = `0x${'d'.repeat(64)}`
const SOL_SIG = '5'.repeat(88)

const tok = (chainId: number, address: string, symbol = 'USDC', decimals = 6) => ({ chainId, address, symbol, decimals })

function lifiQuote(o: { fromChainId?: number; fromToken?: ReturnType<typeof tok>; toAddress?: string; fromAmount?: string; toAmountMin?: string; integratorFee?: string; id?: string; solana?: boolean } = {}): LifiQuote {
  const fromAmount = o.fromAmount ?? '10000000'
  const fromChainId = o.fromChainId ?? 42161
  const fromToken = o.fromToken ?? tok(42161, ARB_USDC.token)
  return {
    id: o.id ?? 'step-1:0',
    type: 'lifi',
    tool: 'across',
    action: { fromToken, toToken: tok(8453, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'), fromChainId, toChainId: 8453, fromAmount, fromAddress: USER, toAddress: o.toAddress ?? DEST, slippage: 0.005 },
    estimate: {
      fromAmount,
      toAmount: '9970218',
      toAmountMin: o.toAmountMin ?? '9920367',
      approvalAddress: DIAMOND,
      executionDuration: 2,
      feeCosts: [
        { name: 'LIFI Fixed Fee', amount: '25000', included: true, token: fromToken, feeSplit: { lifiFee: '25000', integratorFee: o.integratorFee ?? '0' } },
        { name: 'Relayer fee', amount: '997', included: true, token: fromToken },
      ],
      gasCosts: [{ amount: '4168981320000', token: tok(fromChainId, '0x0000000000000000000000000000000000000000', 'ETH', 18) }],
    },
    transactionRequest: o.solana ? { data: 'AQAAAAAAAAAAAAAA' } : { to: DIAMOND, data: '0x1794958f00', value: '0x0', gasLimit: '0x2ae892', chainId: fromChainId, from: USER },
  }
}

function lifiStatus(o: Partial<LifiStatus> & { amount?: string; sendHash?: string; timestamp?: number; token?: string } = {}): LifiStatus {
  return {
    status: o.status ?? 'DONE',
    ...(o.substatus ? { substatus: o.substatus } : (o.status ?? 'DONE') === 'DONE' ? { substatus: 'COMPLETED' } : {}),
    fromAddress: USER,
    toAddress: o.toAddress ?? DEST,
    tool: 'across',
    sending: { txHash: o.sendHash ?? HASH, chainId: 42161, amount: '10000000', token: tok(42161, ARB_USDC.token), timestamp: o.timestamp ?? Math.floor(Date.now() / 1000) },
    receiving: { txHash: OUT_HASH, chainId: 8453, amount: o.amount ?? '9970000', token: tok(8453, o.token ?? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913') },
    ...(o.quote ? { quote: o.quote } : {}),
  }
}

/** A Transfer log of Base USDC to `to` */
const transferLog = (to: string, amount: bigint, logIndex = 0) => ({
  address: BASE_USDC.token,
  topics: [ERC20_TRANSFER_TOPIC, topicAddress(DIAMOND), topicAddress(to)],
  data: `0x${amount.toString(16).padStart(64, '0')}`,
  logIndex: `0x${logIndex.toString(16)}`,
})

type Rpc = { allowance?: bigint; logs?: ReturnType<typeof transferLog>[]; receipt?: 'missing' | 'failed' }

function rpcReply(r: Rpc) {
  return (c: FakeCall) => {
    const b = c.body as { method: string }
    if (b.method === 'eth_call') return { jsonrpc: '2.0', id: 1, result: `0x${(r.allowance ?? 0n).toString(16).padStart(64, '0')}` }
    if (b.method === 'eth_getTransactionReceipt') {
      if (r.receipt === 'missing') return { jsonrpc: '2.0', id: 1, result: null }
      return { jsonrpc: '2.0', id: 1, result: { status: r.receipt === 'failed' ? '0x0' : '0x1', blockNumber: '0x10', logs: r.logs ?? [transferLog(DEST, 9970000n)] } }
    }
    return { jsonrpc: '2.0', id: 1, error: { message: `unexpected ${b.method}` } }
  }
}

function routes(o: { quote?: (c: FakeCall) => unknown; status?: (c: FakeCall) => unknown; statusCode?: number; rpc?: Rpc } = {}) {
  return fakeFetch([
    { method: 'GET', match: '/v1/quote', reply: o.quote ?? (() => lifiQuote()) },
    { method: 'GET', match: '/v1/status', reply: o.status ?? (() => lifiStatus()), ...(o.statusCode ? { status: o.statusCode } : {}) },
    { method: 'GET', match: '/v1/token', reply: () => tok(8453, '0x00000000000000000000000000000000000000c0', 'TKN', 18) },
    { method: 'GET', match: '/v1/chains', reply: () => ({ chains: [{ id: 1 }] }) },
    { method: 'POST', match: /arbitrum|base\.org/, reply: rpcReply(o.rpc ?? {}) },
  ])
}

const walletLeg: PathwayLeg = {
  adapterId: 'lifi',
  legId: 'wallet',
  from: { asset: { kind: 'crypto', chain: '*', token: '*' }, location: { kind: 'user_wallet' } },
  to: { asset: BASE_USDC, location: { kind: 'address', address: DEST } },
}
const src = { chain: ARB_USDC.chain, token: ARB_USDC.token, address: USER }

async function started(o: Parameters<typeof routes>[0] = {}, opts: Parameters<typeof lifi>[0] = {}) {
  const r = routes(o)
  const a = lifi(opts)
  const ctx = makeCtx({ fetch: r.fetch })
  const q = await a.quote({ leg: walletLeg, amountIn: { value: '10', asset: ARB_USDC }, source: src }, ctx)
  const step = await a.start({ leg: walletLeg, quote: q, source: src }, ctx)
  return { a, ctx, q, step, calls: r.calls, ref: step.ref! }
}

describe('lifi helpers', () => {
  it('maps chains and tokens', () => {
    expect(lifiChainId('eip155:8453')).toBe(8453)
    expect(lifiChainId(SOLANA_MAINNET)).toBe(LIFI_SOLANA_CHAIN_ID)
    expect(caip2FromLifi(LIFI_SOLANA_CHAIN_ID)).toBe(SOLANA_MAINNET)
    expect(caip2FromLifi(10)).toBe('eip155:10')
    expect(() => lifiChainId('bip122:000000000019d6689c085ae165831e93')).toThrow()
    expect(lifiToken('eip155:1', 'native')).toBe('0x0000000000000000000000000000000000000000')
    expect(lifiToken(SOLANA_MAINNET, 'native')).toBe('11111111111111111111111111111111')
    expect(erc20ApproveData(DIAMOND, '10')).toBe(`0x095ea7b3${DIAMOND.slice(2).toLowerCase().padStart(64, '0')}${'a'.padStart(64, '0')}`)
  })

  it('refuses a fee without an integrator', () => {
    expect(() => lifi({ feeBps: 25 })).toThrow(/integrator/)
    expect(() => lifi({ feeBps: 10_000, integrator: 'x' })).toThrow(/feeBps/)
  })
})

describe('lifi quote', () => {
  it('passes the shape check and plans a wallet pathway', () => {
    const a = lifi()
    expect(checkAdapterShape(a)).toEqual([])
    const plan = planPathways({
      direction: 'deposit',
      destination: { type: 'crypto', chain: BASE_USDC.chain, token: BASE_USDC.token, address: DEST },
      user: { country: 'VN', walletConnected: true },
      legs: a.legs.map((spec) => ({ adapterId: 'lifi', provider: 'LI.FI', spec })),
    })
    expect(plan.pathways.map((p) => p.id)).toContain('wallet:lifi.wallet')
  })

  it('quotes exact input with the integrator, fee, slippage, order and API key', async () => {
    const { fetch, calls } = routes({ quote: () => lifiQuote({ integratorFee: '5000' }) })
    const a = lifi({ apiKey: 'k', integrator: 'myapp', feeBps: 25, slippageBps: 50, order: 'CHEAPEST' })
    const q = await a.quote({ leg: walletLeg, amountIn: { value: '10', asset: ARB_USDC }, source: src }, makeCtx({ fetch }))
    expect(checkLegQuote(q)).toEqual([])
    const url = new URL(calls[0]!.url)
    expect(url.pathname).toBe('/v1/quote')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      fromChain: '42161',
      toChain: '8453',
      fromToken: ARB_USDC.token,
      toToken: BASE_USDC.token,
      fromAddress: USER,
      toAddress: DEST,
      fromAmount: '10000000',
      integrator: 'myapp',
      fee: '0.0025',
      slippage: '0.005',
      order: 'CHEAPEST',
    })
    expect(calls[0]!.headers.get('x-lifi-api-key')).toBe('k')
    expect(q.input.value).toBe('10')
    expect(q.output.value).toBe('9.970218')
    expect(q.data?.minOutput).toBe('9.920367')
    expect(q.fees).toEqual([
      { kind: 'provider', label: 'LIFI Fixed Fee', amount: '0.02', currency: 'USDC' },
      { kind: 'app', label: 'App fee', amount: '0.005', currency: 'USDC' },
      { kind: 'provider', label: 'Relayer fee', amount: '0.000997', currency: 'USDC' },
      { kind: 'network', label: 'Network fee', amount: '0.00000416898132', currency: 'ETH' },
    ])
    expect(q.eta.min).toBe(2)
  })

  it('quotes exact output with /quote/toAmount and a placeholder sender', async () => {
    const { fetch, calls } = routes()
    const q = await lifi().quote({ leg: walletLeg, amountOut: { value: '10', asset: BASE_USDC }, source: { chain: ARB_USDC.chain, token: ARB_USDC.token } }, makeCtx({ fetch }))
    const url = new URL(calls[0]!.url)
    expect(url.pathname).toBe('/v1/quote/toAmount')
    expect(url.searchParams.get('toAmount')).toBe('10000000')
    expect(url.searchParams.get('fromAddress')).toBe('0x000000000000000000000000000000000000dEaD')
    expect(q.input.value).toBe('10')
  })

  it('looks up unknown decimals once with /token', async () => {
    const { fetch, calls } = routes({ quote: () => lifiQuote({ fromChainId: 8453, fromToken: tok(8453, '0x00000000000000000000000000000000000000c0', 'TKN', 18), fromAmount: '1000000000000000000' }) })
    const ctx = makeCtx({ fetch })
    const tkn = { chain: 'eip155:8453', token: '0x00000000000000000000000000000000000000c0', address: USER }
    await lifi().quote({ leg: walletLeg, amountIn: { value: '1', asset: { kind: 'crypto', chain: tkn.chain, token: tkn.token } }, source: tkn }, ctx)
    await lifi().quote({ leg: walletLeg, amountIn: { value: '1', asset: { kind: 'crypto', chain: tkn.chain, token: tkn.token } }, source: tkn }, ctx)
    expect(calls.filter((c) => c.url.includes('/v1/token')).length).toBe(1)
    expect(new URL(calls.find((c) => c.url.includes('/v1/quote'))!.url).searchParams.get('fromAmount')).toBe('1000000000000000000')
  })

  it('gives no quote for the same token, a settlement contract or an unsupported chain', async () => {
    const { fetch } = routes()
    const a = lifi()
    const code = async (p: Promise<unknown>) => (await p.then(() => undefined, (e) => e as { error: { code: string } }))?.error.code
    expect(await code(a.quote({ leg: walletLeg, amountIn: { value: '10', asset: BASE_USDC }, source: { chain: BASE_USDC.chain, token: BASE_USDC.token, address: USER } }, makeCtx({ fetch })))).toBe('NO_QUOTES')
    const settle = makeCtx({ fetch, destination: { type: 'crypto', chain: BASE_USDC.chain, token: BASE_USDC.token, address: DEST, settlement: { contract: OTHER } } })
    expect(await code(a.quote({ leg: walletLeg, amountIn: { value: '10', asset: ARB_USDC }, source: src }, settle))).toBe('NO_QUOTES')
    expect(await code(a.quote({ leg: walletLeg, amountIn: { value: '10', asset: ARB_USDC }, source: { chain: 'tron:mainnet', token: 'x' } }, makeCtx({ fetch })))).toBe('NO_QUOTES')
  })

  it('refuses a route to another receiver', async () => {
    const { fetch } = routes({ quote: () => lifiQuote({ toAddress: OTHER }) })
    await expect(lifi().quote({ leg: walletLeg, amountIn: { value: '10', asset: ARB_USDC }, source: src }, makeCtx({ fetch }))).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
  })

  it('maps HTTP 429 to RATE_LIMITED and 400 to NO_QUOTES', async () => {
    for (const [status, want] of [[429, 'RATE_LIMITED'], [400, 'NO_QUOTES']] as const) {
      const { fetch } = fakeFetch([{ match: '/v1/quote', status, reply: () => ({ message: 'No available quotes for the requested transfer', code: 1002 }) }])
      await expect(lifi().quote({ leg: walletLeg, amountIn: { value: '10', asset: ARB_USDC }, source: src }, makeCtx({ fetch }))).rejects.toMatchObject({ error: { code: want } })
    }
  })
})

describe('lifi start', () => {
  it('returns the approval and the LI.FI transaction for the user', async () => {
    const { step } = await started()
    expect(checkLegStep(step)).toEqual([])
    expect(step).toMatchObject({ state: 'PAYMENT', status: 'awaiting_user', surface: { kind: 'WALLET_TX', chain: 'eip155:42161' }, transitions: [{ name: 'submit_tx', kind: 'SURFACE_RESULT', expects: 'tx_hash' }] })
    expect(step.surface?.kind === 'WALLET_TX' && step.surface.txs).toEqual([
      { to: ARB_USDC.token, data: erc20ApproveData(DIAMOND, '10000000'), chainId: 42161 },
      { to: DIAMOND, data: '0x1794958f00', chainId: 42161, gas: String(0x2ae892) },
    ])
    expect(step.ref).toMatch(/^lifi:sess_1:/)
  })

  it('skips the approval when the allowance is enough', async () => {
    const { step } = await started({ rpc: { allowance: 10_000_000n } })
    expect(step.surface?.kind === 'WALLET_TX' && step.surface.txs.length).toBe(1)
  })

  it('sends native value without an approval', async () => {
    const eth = { kind: 'crypto' as const, chain: 'eip155:42161', token: 'native' }
    const q0 = lifiQuote({ fromToken: tok(42161, '0x0000000000000000000000000000000000000000', 'ETH', 18), fromAmount: '10000000000000000' })
    q0.transactionRequest!.value = '0x2386f26fc10000'
    const { fetch } = routes({ quote: () => q0 })
    const a = lifi()
    const ctx = makeCtx({ fetch })
    const s = { chain: eth.chain, token: 'native', address: USER }
    const q = await a.quote({ leg: walletLeg, amountIn: { value: '0.01', asset: eth }, source: s }, ctx)
    const step = await a.start({ leg: walletLeg, quote: q, source: s }, ctx)
    expect(step.surface?.kind === 'WALLET_TX' && step.surface.txs).toEqual([{ to: DIAMOND, data: '0x1794958f00', value: '10000000000000000', chainId: 42161, gas: String(0x2ae892) }])
  })

  it('quotes again for the real wallet when the quote used a placeholder', async () => {
    const { fetch, calls } = routes()
    const a = lifi()
    const ctx = makeCtx({ fetch })
    const q = await a.quote({ leg: walletLeg, amountIn: { value: '10', asset: ARB_USDC }, source: { chain: src.chain, token: src.token } }, ctx)
    await a.start({ leg: walletLeg, quote: q, source: src }, ctx)
    const quotes = calls.filter((c) => c.url.includes('/v1/quote'))
    expect(quotes).toHaveLength(2)
    expect(new URL(quotes[1]!.url).searchParams.get('fromAddress')).toBe(USER)
  })

  it('needs a connected wallet of the source chain', async () => {
    const { fetch } = routes()
    const a = lifi()
    const ctx = makeCtx({ fetch })
    const q = await a.quote({ leg: walletLeg, amountIn: { value: '10', asset: ARB_USDC }, source: src }, ctx)
    await expect(a.start({ leg: walletLeg, quote: q, source: { chain: src.chain, token: src.token } }, ctx)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
  })

  it('Solana: gives the serialized transaction and takes a signature', async () => {
    const sol = { kind: 'crypto' as const, chain: SOLANA_MAINNET, token: SOLANA_USDC_MINT }
    const { fetch, calls } = routes({ quote: () => lifiQuote({ fromChainId: LIFI_SOLANA_CHAIN_ID, fromToken: tok(LIFI_SOLANA_CHAIN_ID, SOLANA_USDC_MINT), solana: true }) })
    const a = lifi()
    const ctx = makeCtx({ fetch })
    const s = { chain: SOLANA_MAINNET, token: SOLANA_USDC_MINT, address: SOL_USER }
    const q = await a.quote({ leg: walletLeg, amountIn: { value: '10', asset: sol }, source: s }, ctx)
    expect(new URL(calls[0]!.url).searchParams.get('fromChain')).toBe(String(LIFI_SOLANA_CHAIN_ID))
    const step = await a.start({ leg: walletLeg, quote: q, source: s }, ctx)
    expect(step.surface).toEqual({ kind: 'WALLET_TX', chain: SOLANA_MAINNET, txs: [{ kind: 'solana', type: 'transaction', transaction: 'AQAAAAAAAAAAAAAA' }] })
    await expect(a.transition!({ leg: walletLeg, ref: step.ref!, name: 'submit_tx', inputs: { txHash: HASH } }, ctx)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
    const t = await a.transition!({ leg: walletLeg, ref: step.ref!, name: 'submit_tx', inputs: { txHash: SOL_SIG } }, ctx)
    expect(t).toMatchObject({ state: 'PROCESSING', txHash: SOL_SIG })
  })
})

describe('lifi status', () => {
  async function statusFor(o: Parameters<typeof routes>[0], opts: Parameters<typeof lifi>[0] = {}) {
    const s = await started(o, opts)
    await s.a.transition!({ leg: walletLeg, ref: s.ref, name: 'submit_tx', inputs: { txHash: HASH } }, s.ctx)
    return { ...s, result: await s.a.status!({ leg: walletLeg, ref: s.ref }, s.ctx) }
  }

  it('waits for the tx hash, then completes with the on-chain delivery amount', async () => {
    const s = await started()
    expect(await s.a.status!({ leg: walletLeg, ref: s.ref }, s.ctx)).toMatchObject({ state: 'PAYMENT', status: 'awaiting_user' })
    await s.a.transition!({ leg: walletLeg, ref: s.ref, name: 'submit_tx', inputs: { txHash: HASH } }, s.ctx)
    const done = await s.a.status!({ leg: walletLeg, ref: s.ref }, s.ctx)
    expect(checkLegStep(done)).toEqual([])
    // txHash: the delivery. sourceTxHash: the source transaction the wallet sent.
    expect(done).toMatchObject({ state: 'COMPLETED', status: 'succeeded', txHash: OUT_HASH, sourceTxHash: HASH, output: { value: '9.97', asset: { chain: 'eip155:8453' } } })
    const st = new URL(s.calls.find((c) => c.url.includes('/v1/status'))!.url)
    expect(Object.fromEntries(st.searchParams)).toEqual({ txHash: HASH, fromChain: '42161', toChain: '8453' })
  })

  it('maps LI.FI statuses', async () => {
    // sub: a value from the closed list; the raw LI.FI status stays in providerStatus.
    const cases: Array<[Partial<LifiStatus>, string, string?, string?]> = [
      [{ status: 'PENDING', substatus: 'WAIT_DESTINATION_TRANSACTION' }, 'PROCESSING', 'bridging', 'WAIT_DESTINATION_TRANSACTION'],
      [{ status: 'PENDING', substatus: 'WAIT_SOURCE_CONFIRMATIONS' }, 'PROCESSING', 'confirming', 'WAIT_SOURCE_CONFIRMATIONS'],
      [{ status: 'PENDING', substatus: 'REFUND_IN_PROGRESS' }, 'PROCESSING', 'refunding', 'REFUND_IN_PROGRESS'],
      [{ status: 'PENDING', substatus: 'BRIDGE_NOT_AVAILABLE' }, 'PROCESSING', 'delayed', 'BRIDGE_NOT_AVAILABLE'],
      [{ status: 'PENDING', substatus: 'SOMETHING_NEW' }, 'PROCESSING', 'processing', 'SOMETHING_NEW'],
      [{ status: 'NOT_FOUND' }, 'PROCESSING', 'confirming', 'NOT_FOUND'],
      [{ status: 'FAILED', substatus: 'SLIPPAGE_EXCEEDED' }, 'FAILED'],
      [{ status: 'FAILED', substatus: 'REFUNDED' }, 'REFUNDED'],
      [{ status: 'DONE', substatus: 'REFUNDED' }, 'REFUNDED'],
      [{ status: 'DONE', substatus: 'PARTIAL' }, 'FAILED'],
      [{ status: 'INVALID' }, 'FAILED'],
    ]
    for (const [st, state, sub, raw] of cases) {
      const { result } = await statusFor({ status: () => lifiStatus(st) })
      expect(checkLegStep(result)).toEqual([])
      expect(result.state).toBe(state)
      if (sub) expect(result.sub).toBe(sub)
      if (raw) expect(result.providerStatus).toBe(raw)
    }
  })

  it('a 404 from LI.FI (not indexed yet) keeps the leg processing', async () => {
    const { result } = await statusFor({ statusCode: 404, status: () => ({ message: 'Transaction hash not found', code: 1003 }) })
    expect(result).toMatchObject({ state: 'PROCESSING', sub: 'confirming', providerStatus: 'NOT_FOUND', txHash: HASH })
  })

  it('waits while the delivery receipt is not on chain yet', async () => {
    const { result } = await statusFor({ rpc: { receipt: 'missing' } })
    expect(result).toMatchObject({ state: 'PROCESSING', sub: 'confirming' })
  })
})

describe('lifi money checks', () => {
  async function statusFor(o: Parameters<typeof routes>[0], opts: Parameters<typeof lifi>[0] = {}) {
    const s = await started(o, opts)
    await s.a.transition!({ leg: walletLeg, ref: s.ref, name: 'submit_tx', inputs: { txHash: HASH } }, s.ctx)
    return await s.a.status!({ leg: walletLeg, ref: s.ref }, s.ctx)
  }
  const failed = (msg: RegExp) => expect.objectContaining({ state: 'FAILED', status: 'failed', error: expect.objectContaining({ code: 'DELIVERY_FAILED', message: expect.stringMatching(msg) }) })

  it('fails when LI.FI reports less than the quoted minimum (bigint compare)', async () => {
    expect(await statusFor({ status: () => lifiStatus({ amount: '9920366' }) })).toEqual(failed(/minimum/))
    expect(await statusFor({ status: () => lifiStatus({ amount: '9920367' }), rpc: { logs: [transferLog(DEST, 9920367n)] } })).toMatchObject({ state: 'COMPLETED' })
  })

  it('does not add small Transfer logs together', async () => {
    const logs = [transferLog(DEST, 5000000n, 1), transferLog(DEST, 4970000n, 2)]
    expect(await statusFor({ rpc: { logs } })).toEqual(failed(/quoted minimum/))
  })

  it('ignores logs to another address or of another token', async () => {
    const wrongToken = { ...transferLog(DEST, 9970000n), address: OTHER }
    expect(await statusFor({ rpc: { logs: [transferLog(OTHER, 9970000n), wrongToken] } })).toEqual(failed(/quoted minimum/))
    expect(await statusFor({ rpc: { receipt: 'failed' } })).toEqual(failed(/failed on chain/))
  })

  it('fails on another receiver, token or chain in the LI.FI status', async () => {
    expect(await statusFor({ status: () => lifiStatus({ toAddress: OTHER }) })).toEqual(failed(/another address/))
    expect(await statusFor({ status: () => lifiStatus({ token: OTHER }) })).toEqual(failed(/another token/))
    const st = lifiStatus()
    st.receiving!.chainId = 10
    expect(await statusFor({ status: () => st })).toEqual(failed(/another chain/))
  })

  it('fails on a source tx from before the payment, or not built for it', async () => {
    expect(await statusFor({ status: () => lifiStatus({ timestamp: Math.floor(Date.now() / 1000) - 3600 }) })).toEqual(failed(/before this payment/))
    expect(await statusFor({ status: () => lifiStatus({ quote: { stepId: 'other:0' } }) })).toEqual(failed(/not the one built/))
    expect(await statusFor({ status: () => lifiStatus({ sendHash: HASH2 }) })).toEqual(failed(/not the source/))
  })

  it('without an RPC check, trusts the LI.FI amount but still checks the minimum', async () => {
    expect(await statusFor({ rpc: { logs: [] } }, { verifyOnChain: false })).toMatchObject({ state: 'COMPLETED', output: { value: '9.97' } })
  })

  it('refuses a source tx hash that another session used (replay)', async () => {
    const shared = memoryKV()
    const r = routes()
    const a = lifi()
    const ctx1 = makeCtx({ fetch: r.fetch, shared })
    const ctx2 = makeCtx({ fetch: r.fetch, shared, session: { id: 'sess_2' } })
    const q1 = await a.quote({ leg: walletLeg, amountIn: { value: '10', asset: ARB_USDC }, source: src }, ctx1)
    const s1 = await a.start({ leg: walletLeg, quote: q1, source: src }, ctx1)
    const q2 = await a.quote({ leg: walletLeg, amountIn: { value: '10', asset: ARB_USDC }, source: src }, ctx2)
    const s2 = await a.start({ leg: walletLeg, quote: q2, source: src }, ctx2)
    await a.transition!({ leg: walletLeg, ref: s1.ref!, name: 'submit_tx', inputs: { txHash: HASH } }, ctx1)
    // The same hash again for the same payment is fine; for another payment it is refused.
    await a.transition!({ leg: walletLeg, ref: s1.ref!, name: 'submit_tx', inputs: { txHash: HASH.toUpperCase().replace('0X', '0x') } }, ctx1)
    await expect(a.transition!({ leg: walletLeg, ref: s2.ref!, name: 'submit_tx', inputs: { txHash: HASH } }, ctx2)).rejects.toMatchObject({ status: 409 })
    expect(await a.status!({ leg: walletLeg, ref: s1.ref! }, ctx1)).toMatchObject({ state: 'COMPLETED' })
  })

  it('a delivery log completes one session only', async () => {
    const shared = memoryKV()
    const r = routes({ status: (c) => lifiStatus({ sendHash: new URL(c.url).searchParams.get('txHash')! }) })
    const a = lifi()
    const run = async (id: string, hash: string) => {
      const ctx = makeCtx({ fetch: r.fetch, shared, session: { id } })
      const q = await a.quote({ leg: walletLeg, amountIn: { value: '10', asset: ARB_USDC }, source: src }, ctx)
      const s = await a.start({ leg: walletLeg, quote: q, source: src }, ctx)
      await a.transition!({ leg: walletLeg, ref: s.ref!, name: 'submit_tx', inputs: { txHash: hash } }, ctx)
      return a.status!({ leg: walletLeg, ref: s.ref! }, ctx)
    }
    expect(await run('sess_a', HASH)).toMatchObject({ state: 'COMPLETED' })
    // A second session whose (other) source tx resolves to the same delivery log cannot take it.
    const r2 = await run('sess_b', HASH2)
    expect(r2).toMatchObject({ state: 'FAILED', error: { message: expect.stringMatching(/already used/) } })
  })
})

describe('lifi conformance', () => {
  it('the wallet leg passes runAdapterConformance', async () => {
    const { fetch } = routes()
    const report = await runAdapterConformance(lifi({ apiKey: 'k' }), {
      fetch,
      fixtures: [
        { leg: walletLeg, quote: { amountIn: { value: '10', asset: ARB_USDC }, source: src }, start: { source: src }, transitions: [{ name: 'submit_tx', inputs: { txHash: HASH } }], expect: { start: 'PAYMENT', status: 'COMPLETED' } },
      ],
    })
    expect(report.problems).toEqual([])
    expect(report.quotes).toHaveLength(1)
    const q: LegQuote = report.quotes[0]!
    expect(q.adapterId).toBe('lifi')
  })

  it('health reads /chains', async () => {
    const { fetch } = routes()
    expect(await lifi().health!({ fetch, log: makeCtx({ fetch }).log })).toEqual({ ok: true })
  })
})

// LIVE=1 with a real key in LIFI_API_KEY. LI.FI has no sandbox host (staging.li.quest returns 403), so this asks
// the mainnet API for one small quote. It never starts, signs or sends anything.
describe('lifi live API', () => {
  it.runIf(process.env.LIVE === '1')('a small mainnet quote: 1 USDC Arbitrum -> USDC Base (LIFI_API_KEY)', async ({ skip }) => {
    const apiKey = process.env.LIFI_API_KEY
    skip(!apiKey, 'LIFI_API_KEY is not set. Set a key from the LI.FI Partner Portal.')
    const q = await lifi({ apiKey: apiKey! }).quote({ leg: walletLeg, amountIn: { value: '1', asset: ARB_USDC }, source: src }, makeCtx({ fetch: globalThis.fetch }))
    expect(checkLegQuote(q)).toEqual([])
    expect(q.output.asset).toMatchObject({ chain: BASE_USDC.chain })
    expect(Number(q.output.value)).toBeGreaterThan(0.5)
    expect(Number(q.output.value)).toBeLessThanOrEqual(1)
  }, 30_000)
})
