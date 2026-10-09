// One deposit completes one session: Transfer logs to a shared destination (P0-3) and Relay
// deposit-address requests (P0-4).
import { describe, expect, it } from 'vitest'
import { USDC } from '@openrampkit/core'
import type { CryptoAsset, LegStep, PathwayLeg } from '@openrampkit/core'
import type { AdapterContext } from '@openrampkit/adapter'
import { erc20TransferData, relay } from './index.js'
import { fakeFetch, makeCtx, memoryKV, recordingLog } from '@openrampkit/adapter/testing'
import type { FakeCall, MemoryKV } from '@openrampkit/adapter/testing'

const DEST = '0x000000000000000000000000000000000000beef'
const BASE_USDC: CryptoAsset = { kind: 'crypto', chain: 'eip155:8453', token: USDC['eip155:8453']! }
const ARB_USDC: CryptoAsset = { kind: 'crypto', chain: 'eip155:42161', token: USDC['eip155:42161']! }
const transferLeg: PathwayLeg = {
  adapterId: 'relay',
  legId: 'transfer',
  from: { asset: { kind: 'crypto', chain: '*', token: '*' }, location: { kind: 'user_wallet' } },
  to: { asset: BASE_USDC, location: { kind: 'address', address: DEST } },
}
const usdc = (chainId: number, address: string) => ({ chainId, address, symbol: 'USDC', name: 'USD Coin', decimals: 6 })
const units = (n: number) => BigInt(Math.round(n * 1e6))
const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`

// ---------------- a fake EVM chain (Base) ----------------

type Log = { data: string; transactionHash: string; blockNumber: string; logIndex: string }

function fakeChain() {
  const state = { head: 100n, logs: [] as Log[] }
  const getLogs: Array<{ from: bigint; to: bigint }> = []
  const route = {
    method: 'POST',
    match: 'mainnet.base.org',
    reply: (c: FakeCall) => {
      const body = c.body as { method: string; params: Array<{ fromBlock: string; toBlock: string }> }
      if (body.method === 'eth_blockNumber') return { result: hex(state.head) }
      if (body.method === 'eth_getLogs') {
        const from = BigInt(body.params[0]!.fromBlock)
        const to = BigInt(body.params[0]!.toBlock)
        getLogs.push({ from, to })
        return { result: state.logs.filter((l) => BigInt(l.blockNumber) >= from && BigInt(l.blockNumber) <= to) }
      }
      return { result: null }
    },
  }
  let n = 0
  /** Mine a block with one USDC transfer to DEST */
  const send = (amount: bigint, block = state.head + 1n): Log => {
    if (block > state.head) state.head = block
    const log = { data: hex(amount), transactionHash: `0x${(++n).toString(16).padStart(64, '0')}`, blockNumber: hex(block), logIndex: '0x0' }
    state.logs.push(log)
    return log
  }
  return { state, getLogs, route, send }
}

/** Start a same-chain `transfer` session that expects `amount` USDC (0: any amount) */
async function directSession(a: ReturnType<typeof relay>, fetch: typeof globalThis.fetch, shared: MemoryKV, id: string, amount: string, log = recordingLog()) {
  const ctx = makeCtx({ fetch, shared, session: { id }, log })
  const q = await a.quote({ leg: transferLeg, amountIn: { value: amount, asset: BASE_USDC }, source: { chain: BASE_USDC.chain, token: BASE_USDC.token } }, ctx)
  const step = await a.start({ leg: transferLeg, quote: q }, ctx)
  return { ctx, ref: step.ref!, log, status: () => a.status!({ leg: transferLeg, ref: step.ref! }, ctx) }
}

describe('relay: one Transfer log completes one session (same chain and token)', () => {
  it('two sessions and one transfer: only the session of that amount completes', async () => {
    const chain = fakeChain()
    const { fetch } = fakeFetch([chain.route])
    const shared = memoryKV()
    const a = relay()
    const s1 = await directSession(a, fetch, shared, 'sess_a', '10')
    const s2 = await directSession(a, fetch, shared, 'sess_b', '25')
    expect(s1.ref).not.toBe(s2.ref)
    const log = chain.send(units(10))
    // the 25 USDC session polls first: 10 USDC is not enough for it
    expect(await s2.status()).toMatchObject({ state: 'PAYMENT', status: 'awaiting_user' })
    expect(await s1.status()).toMatchObject({ state: 'COMPLETED', txHash: log.transactionHash, output: { value: '10' } })
    expect(await s2.status()).toMatchObject({ state: 'PAYMENT' })
    // the completed session checks again: same answer (its own claim)
    expect(await s1.status()).toMatchObject({ state: 'COMPLETED', txHash: log.transactionHash })
  })

  it('a larger open session does not take the exact payment of another session', async () => {
    const chain = fakeChain()
    const { fetch } = fakeFetch([chain.route])
    const shared = memoryKV()
    const a = relay()
    const s5 = await directSession(a, fetch, shared, 'sess_5', '5')
    const s10 = await directSession(a, fetch, shared, 'sess_10', '10')
    const log = chain.send(units(10))
    // 10 USDC is at least 5, but it is the exact amount of the other session: contested for sess_5
    expect(await s5.status()).toMatchObject({ state: 'PAYMENT', sub: 'ambiguous_deposit' })
    expect(await s10.status()).toMatchObject({ state: 'COMPLETED', txHash: log.transactionHash })
    // after sess_10 took it, sess_5 sees a used log and keeps waiting
    const after = await s5.status()
    expect(after).toMatchObject({ state: 'PAYMENT' })
    expect(after.sub).toBeUndefined()
  })

  it('a transfer that two open sessions could claim is ambiguous: neither session completes', async () => {
    const chain = fakeChain()
    const { fetch } = fakeFetch([chain.route])
    const shared = memoryKV()
    const a = relay()
    const s1 = await directSession(a, fetch, shared, 'sess_a', '10')
    const s2 = await directSession(a, fetch, shared, 'sess_b', '10')
    chain.send(units(10))
    expect(await s1.status()).toMatchObject({ state: 'PAYMENT', sub: 'ambiguous_deposit' })
    expect(await s2.status()).toMatchObject({ state: 'PAYMENT', sub: 'ambiguous_deposit' })
    expect(s1.log.warnings.some((w) => w.includes('matches more than one open session'))).toBe(true)
    // nothing was recorded as used
    expect([...shared.data.keys()].some((k) => k.startsWith('txused:'))).toBe(false)
  })

  it('a dust transfer does not complete a session; the full amount (minus 0.5%) does', async () => {
    const chain = fakeChain()
    const { fetch } = fakeFetch([chain.route])
    const shared = memoryKV()
    const a = relay()
    const s = await directSession(a, fetch, shared, 'sess_a', '10')
    chain.send(1n) // 0.000001 USDC
    chain.send(units(9.9)) // 1% short
    expect(await s.status()).toMatchObject({ state: 'PAYMENT', status: 'awaiting_user' })
    const ok = chain.send(units(9.96)) // 0.4% short: inside the tolerance
    expect(await s.status()).toMatchObject({ state: 'COMPLETED', txHash: ok.transactionHash, output: { value: '9.96' } })
  })

  it('a log used by one session is refused for a replay: by another session, and by a same-chain wallet payment', async () => {
    const chain = fakeChain()
    const { fetch } = fakeFetch([chain.route])
    const shared = memoryKV()
    const a = relay()
    const s1 = await directSession(a, fetch, shared, 'sess_a', '10')
    const log = chain.send(units(10))
    expect(await s1.status()).toMatchObject({ state: 'COMPLETED', txHash: log.transactionHash })
    expect(shared.data.get(`txused:eip155:8453:${log.transactionHash}:0`)).toBe(`sess_a:${s1.ref}`)
    // a later session that started before the log (same start block) and expects the same amount
    chain.state.head = 100n
    const s2 = await directSession(a, fetch, shared, 'sess_b', '10')
    expect(await s2.status()).toMatchObject({ state: 'PAYMENT', status: 'awaiting_user' })
    // the same tx hash, submitted to a same-chain wallet leg
    const walletLeg: PathwayLeg = { ...transferLeg, legId: 'wallet' }
    const wctx = makeCtx({ fetch: fakeFetch([wrpc(log)]).fetch, shared, session: { id: 'sess_w' } })
    const q = await a.quote({ leg: walletLeg, amountIn: { value: '10', asset: BASE_USDC }, source: { chain: BASE_USDC.chain, token: BASE_USDC.token } }, wctx)
    const ws = await a.start({ leg: walletLeg, quote: q }, wctx)
    await a.transition!({ leg: walletLeg, ref: ws.ref!, name: 'submit_tx', inputs: { txHash: log.transactionHash } }, wctx)
    expect(await a.status!({ leg: walletLeg, ref: ws.ref! }, wctx)).toMatchObject({ state: 'FAILED', error: { message: 'This transaction was already used for another payment.' } })
  })

  it('reads logs in pages of `logBlockRange` blocks, a few pages per check, and goes on from there', async () => {
    const chain = fakeChain()
    chain.state.head = 0n
    const { fetch } = fakeFetch([chain.route])
    const a = relay({ logBlockRange: 10 })
    const s = await directSession(a, fetch, memoryKV(), 'sess_a', '10')
    chain.state.head = 100n
    const log = chain.send(units(10), 90n)
    chain.state.head = 100n
    expect(await s.status()).toMatchObject({ state: 'PAYMENT' })
    expect(chain.getLogs).toHaveLength(5)
    expect(chain.getLogs.every((r) => r.to - r.from + 1n <= 10n)).toBe(true)
    expect(chain.getLogs[0]).toEqual({ from: 0n, to: 9n })
    expect(chain.getLogs[4]).toEqual({ from: 40n, to: 49n })
    expect(await s.ctx.store.get(`d:${s.ref}`)).toMatchObject({ scanFrom: '0x32' })
    expect(await s.status()).toMatchObject({ state: 'COMPLETED', txHash: log.transactionHash })
    expect(chain.getLogs[5]).toEqual({ from: 50n, to: 59n })
    expect(chain.getLogs.every((r) => r.to - r.from + 1n <= 10n)).toBe(true)
  })
})

/** RPC for a same-chain wallet check of `log`'s transaction: success, new block, pays DEST 10 USDC */
function wrpc(log: Log) {
  return {
    method: 'POST',
    match: 'mainnet.base.org',
    reply: (c: FakeCall) => {
      const m = (c.body as { method: string }).method
      if (m === 'eth_getTransactionReceipt') {
        const topic = (a: string) => `0x${'0'.repeat(24)}${a.slice(2).toLowerCase()}`
        return {
          result: {
            status: '0x1',
            blockNumber: log.blockNumber,
            logs: [{ address: BASE_USDC.token, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', topic('0x0000000000000000000000000000000000000001'), topic(DEST)], data: log.data }],
          },
        }
      }
      if (m === 'eth_getBlockByNumber') return { result: { timestamp: hex(Math.floor(Date.now() / 1000)) } }
      return { result: null }
    },
  }
}

// ---------------- Relay deposit addresses ----------------

describe('relay: deposit-address sessions to the same recipient', () => {
  const quoteReply = (address: string) => (c: FakeCall) => {
    const amount = String((c.body as { amount: string }).amount)
    return {
      requestId: '0xq',
      steps: [{ id: 'deposit', kind: 'transaction', depositAddress: address, items: [{ status: 'incomplete', data: { to: ARB_USDC.token, data: erc20TransferData(address, amount), chainId: 42161 } }] }],
      details: {
        currencyIn: { currency: usdc(42161, ARB_USDC.token), amount },
        currencyOut: { currency: usdc(8453, BASE_USDC.token), amount: String(BigInt(amount) - 40000n), minimumAmount: String(BigInt(amount) - 240000n) },
      },
    }
  }
  const request = (id: string, depositAmount: bigint, extra: Record<string, unknown> = {}) => ({
    id,
    status: 'success',
    createdAt: new Date().toISOString(),
    depositAddress: { address: '', depositTxHash: `0x${id.padStart(64, '0')}` },
    data: {
      outTxs: [{ hash: `0xout${id}` }],
      metadata: { currencyIn: { currency: usdc(42161, ARB_USDC.token), amount: depositAmount.toString() }, currencyOut: { currency: usdc(8453, BASE_USDC.token), amount: (depositAmount - 40000n).toString() } },
    },
    ...extra,
  })

  async function session(a: ReturnType<typeof relay>, fetch: typeof globalThis.fetch, shared: MemoryKV, id: string, amount: string) {
    const ctx: AdapterContext = makeCtx({ fetch, shared, session: { id } })
    const q = await a.quote({ leg: transferLeg, amountIn: { value: amount, asset: ARB_USDC }, source: { chain: ARB_USDC.chain, token: ARB_USDC.token } }, ctx)
    const step = await a.start({ leg: transferLeg, quote: q }, ctx)
    return { q, step, status: (): Promise<LegStep> => a.status!({ leg: transferLeg, ref: step.ref! }, ctx) }
  }

  it('each session gets its own address (Relay gives a new one per quote), and requests of one address never complete the other', async () => {
    const addrs = ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222']
    let n = 0
    const byAddress: Record<string, unknown[]> = {}
    const { fetch, calls } = fakeFetch([
      { method: 'POST', match: '/quote/v2', reply: (c) => quoteReply(addrs[n++]!)(c) },
      { method: 'GET', match: '/requests/v3', reply: (c) => ({ requests: byAddress[new URL(c.url).searchParams.get('depositAddress')!.toLowerCase()] ?? [] }) },
    ])
    const shared = memoryKV()
    const a = relay({ apiKey: 'k', slippageBps: 150 })
    const s1 = await session(a, fetch, shared, 'sess_a', '10')
    const s2 = await session(a, fetch, shared, 'sess_b', '10')
    expect(s1.step.surface).toMatchObject({ address: addrs[0] })
    expect(s2.step.surface).toMatchObject({ address: addrs[1] })
    expect(s1.step.ref).not.toBe(s2.step.ref)
    // slippage goes to Relay, and the quote shows Relay's minimum output
    expect(calls[0]!.body).toMatchObject({ slippageTolerance: '150' })
    expect(s1.q.data).toMatchObject({ minOutput: '9.76' })
    byAddress[addrs[1]!] = [request('2', units(10))]
    expect(await s1.status()).toMatchObject({ state: 'PAYMENT', status: 'awaiting_user' })
    expect(await s2.status()).toMatchObject({ state: 'COMPLETED', txHash: '0xout2' })
  })

  it('when Relay gives both sessions the same address: a request completes one session only, matched by amount; equal amounts are ambiguous', async () => {
    const SAME = '0x3333333333333333333333333333333333333333'
    let requests: unknown[] = []
    const { fetch } = fakeFetch([
      { method: 'POST', match: '/quote/v2', reply: quoteReply(SAME) },
      { method: 'GET', match: '/requests/v3', reply: () => ({ requests }) },
    ])
    const shared = memoryKV()
    const a = relay({ apiKey: 'k' })
    const s10 = await session(a, fetch, shared, 'sess_10', '10')
    const s25 = await session(a, fetch, shared, 'sess_25', '25')
    expect(s10.step.surface).toMatchObject({ address: SAME })
    expect(s25.step.surface).toMatchObject({ address: SAME })
    expect(s10.step.ref).not.toBe(s25.step.ref)
    requests = [request('a', units(25))]
    expect(await s10.status()).toMatchObject({ state: 'PAYMENT', sub: 'ambiguous_deposit' }) // 25 is at least 10, but it is the exact amount of sess_25
    expect(await s25.status()).toMatchObject({ state: 'COMPLETED', txHash: '0xouta' })
    expect(await s10.status()).toMatchObject({ state: 'PAYMENT' })
    expect(shared.data.get(`relayreq:tx:0x${'a'.padStart(64, '0')}`)).toBe(`sess_25:${s25.step.ref}`)
    requests = [request('b', 1n), ...requests] // dust
    expect(await s10.status()).toMatchObject({ state: 'PAYMENT' })
    requests = [request('c', units(10)), ...requests]
    expect(await s10.status()).toMatchObject({ state: 'COMPLETED', txHash: '0xoutc' })

    // two more sessions with the same amount on the same address: neither takes the request
    const t1 = await session(a, fetch, shared, 'sess_t1', '7')
    const t2 = await session(a, fetch, shared, 'sess_t2', '7')
    requests = [request('d', units(7))]
    expect(await t1.status()).toMatchObject({ state: 'PAYMENT', sub: 'ambiguous_deposit' })
    expect(await t2.status()).toMatchObject({ state: 'PAYMENT', sub: 'ambiguous_deposit' })
  })

  it('a bound request is followed by its key, also when Relay re-quotes it under a new id', async () => {
    const ADDR = '0x4444444444444444444444444444444444444444'
    let requests: unknown[] = []
    const { fetch } = fakeFetch([
      { method: 'POST', match: '/quote/v2', reply: quoteReply(ADDR) },
      { method: 'GET', match: '/requests/v2', reply: () => ({ requests }) },
    ])
    const log = recordingLog()
    const a = relay()
    const ctx = makeCtx({ fetch, log })
    const q = await a.quote({ leg: transferLeg, amountIn: { value: '10', asset: ARB_USDC }, source: { chain: ARB_USDC.chain, token: ARB_USDC.token } }, ctx)
    expect(log.warnings.filter((w) => w.includes('2026-11-24'))).toHaveLength(1) // first call warns without a key
    const step = await a.start({ leg: transferLeg, quote: q }, ctx)
    requests = [request('1', units(10), { status: 'pending' })]
    expect(await a.status!({ leg: transferLeg, ref: step.ref! }, ctx)).toMatchObject({ state: 'PROCESSING' })
    requests = [request('1', units(10), { id: 'regenerated', status: 'success' })]
    expect(await a.status!({ leg: transferLeg, ref: step.ref! }, ctx)).toMatchObject({ state: 'COMPLETED', txHash: '0xout1' })
    expect(log.warnings.filter((w) => w.includes('2026-11-24'))).toHaveLength(1)
  })
})
