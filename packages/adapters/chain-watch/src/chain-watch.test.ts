// The chain-watch adapter on a fake RPC: the address is the destination itself, a deposit counts only
// after its confirmations, each log or signature is one deposit (never two), re-orgs and amount checks.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ERC20_TRANSFER_TOPIC, topicAddress } from '@openrampkit/adapter'
import type { StandingDeposit } from '@openrampkit/adapter'
import { fakeFetch, makeCtx, memoryKV, silentLog } from '@openrampkit/adapter/testing'
import type { FakeCall, MemoryKV } from '@openrampkit/adapter/testing'
import { USDC } from '@openrampkit/core'
import type { PathwayLeg } from '@openrampkit/core'
import { chainWatch } from './index.js'

const BASE = 'eip155:8453'
const TOKEN = USDC[BASE]!
const DEST = '0x000000000000000000000000000000000000beef'
const DESTINATION = { type: 'crypto' as const, chain: BASE, token: TOKEN, address: DEST }
const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`
const units = (n: number) => BigInt(Math.round(n * 1e6))
const leg: PathwayLeg = {
  adapterId: 'chain-watch',
  legId: 'transfer',
  from: { asset: { kind: 'crypto', chain: BASE, token: TOKEN }, location: { kind: 'user_wallet' } },
  to: { asset: { kind: 'crypto', chain: BASE, token: TOKEN }, location: { kind: 'address', address: DEST } },
}

afterEach(() => vi.useRealTimers())

type Log = { address: string; topics: string[]; data: string; transactionHash: string; blockNumber: string; logIndex: string }

/** A fake Base node: a head block, USDC Transfer logs, and receipts */
function fakeEvm() {
  const state = { head: 1000n, logs: [] as Log[], receipts: new Map<string, unknown>() }
  const getLogs: Array<[bigint, bigint]> = []
  const route = {
    method: 'POST',
    match: 'rpc.base.test',
    reply: (c: FakeCall) => {
      const body = c.body as { method: string; params: Array<Record<string, string>> }
      if (body.method === 'eth_blockNumber') return { result: hex(state.head) }
      if (body.method === 'eth_getLogs') {
        const from = BigInt(body.params[0]!.fromBlock!)
        const to = BigInt(body.params[0]!.toBlock!)
        getLogs.push([from, to])
        return { result: state.logs.filter((l) => BigInt(l.blockNumber) >= from && BigInt(l.blockNumber) <= to) }
      }
      if (body.method === 'eth_getTransactionReceipt') return { result: state.receipts.get(String(body.params[0])) ?? null }
      return { result: null }
    },
  }
  let n = 0
  /** Mine one USDC transfer to `to` in a new block */
  const send = (amount: bigint, to = DEST) => {
    state.head += 1n
    const log: Log = { address: TOKEN, topics: [ERC20_TRANSFER_TOPIC, topicAddress('0x1111111111111111111111111111111111111111'), topicAddress(to)], data: hex(amount), transactionHash: `0x${(++n).toString(16).padStart(64, '0')}`, blockNumber: hex(state.head), logIndex: '0x0' }
    state.logs.push(log)
    state.receipts.set(log.transactionHash, { status: '0x1', blockNumber: log.blockNumber, logs: [log] })
    return log
  }
  const mine = (blocks: number) => {
    state.head += BigInt(blocks)
  }
  return { state, getLogs, route, send, mine }
}

function setup(opts: Parameters<typeof chainWatch>[0] = {}) {
  const evm = fakeEvm()
  const { fetch, calls } = fakeFetch([evm.route])
  const shared = memoryKV()
  const a = chainWatch({ rpcUrls: { [BASE]: 'https://rpc.base.test' }, confirmations: 3, ...opts })
  const ctx = { fetch, log: silentLog, shared }
  const address = (userId = 'u1', destination = DESTINATION) => a.standingAddress!({ userId, origin: { chain: destination.chain, token: destination.token }, destination }, ctx)
  const list = async (ref: string, since = 0) => a.standingDeposits!({ ref, address: DEST, origin: { chain: BASE, token: TOKEN }, since }, ctx)
  const status = (ref: string, s: MemoryKV = shared) => a.status!({ leg, ref }, makeCtx({ fetch, shared: s, destination: DESTINATION }))
  return { a, evm, calls, shared, ctx, address, list, status }
}

describe('chain-watch: the address', () => {
  it('is the destination itself, with a stable ref; the adapter is never in a plan', async () => {
    const t = setup()
    const got = await t.address()
    expect(got.address).toBe(DEST)
    expect(got.ref).toBe(`cw1|${BASE}|${TOKEN}|${DEST}|1001|${got.ref.split('|')[5]}`)
    t.evm.mine(5)
    expect((await t.address()).ref).toBe(got.ref)
    expect(t.a.standingRoutes).toEqual(['same'])
    expect(await t.a.catalog!({ currency: 'USD', direction: 'deposit' }, t.ctx)).toEqual([])
    await expect(t.a.quote({ leg }, makeCtx({ fetch: t.ctx.fetch }))).rejects.toMatchObject({ status: 404 })
  })

  it('refuses another route, native EVM transfers, a chain with no RPC, and a second user on the same address', async () => {
    const t = setup()
    const other = { userId: 'u1', origin: { chain: 'eip155:42161', token: USDC['eip155:42161']! }, destination: DESTINATION }
    await expect(t.a.standingAddress!(other, t.ctx)).rejects.toMatchObject({ status: 400, error: { message: expect.stringMatching(/only for the same token on the same chain/) } })
    await expect(t.address('u1', { ...DESTINATION, token: 'native' })).rejects.toMatchObject({ status: 400, error: { message: expect.stringMatching(/native transfers/) } })
    const op = { ...DESTINATION, chain: 'eip155:143', token: '0x00000000000000000000000000000000000000aa' }
    await expect(chainWatch({ defaultRpcUrls: {} }).standingAddress!({ userId: 'u1', origin: { chain: op.chain, token: op.token }, destination: op }, t.ctx)).rejects.toMatchObject({
      status: 400,
      error: { message: expect.stringMatching(/no RPC URL/) },
    })
    await t.address('u1')
    await expect(t.address('u2')).rejects.toMatchObject({ status: 409, error: { code: 'CONFLICT' } })
    // The same user again is fine.
    expect((await t.address('u1')).address).toBe(DEST)
  })
})

describe('chain-watch: EVM deposits', () => {
  it('a log counts after its confirmations, once, and is listed again while it is recent', async () => {
    const t = setup()
    const { ref } = await t.address()
    const log = t.evm.send(units(25))
    // 1 block on top of it, 3 needed: not yet.
    expect(await t.list(ref)).toEqual([])
    t.evm.mine(3)
    const [d, ...rest] = await t.list(ref)
    expect(rest).toEqual([])
    expect(d).toMatchObject({
      id: `${BASE}:${log.transactionHash}:0`,
      input: { value: '25', asset: { kind: 'crypto', chain: BASE, token: TOKEN, decimals: 6 } },
    })
    // The next poll reads on from the next block, and lists the recent deposit again (same id).
    const before = t.evm.getLogs.length
    const again = await t.list(ref, d!.at)
    expect(again.map((x: StandingDeposit) => x.id)).toEqual([d!.id])
    expect(t.evm.getLogs.slice(before).every(([from]) => from > BigInt(log.blockNumber))).toBe(true)
    // A `since` after it: not listed.
    expect(await t.list(ref, d!.at + 1)).toEqual([])
  })

  it('logs before the address, dust below minDeposit and logs that another owner took are not deposits', async () => {
    const t = setup({ minDeposit: { [`${BASE}:${TOKEN}`]: '1' } })
    const early = t.evm.send(units(50))
    const { ref } = await t.address()
    const dust = t.evm.send(units(0.5))
    const taken = t.evm.send(units(7))
    const ok = t.evm.send(units(3))
    await t.shared.put(`txused:${BASE}:${taken.transactionHash}:0`, 'someone-else')
    t.evm.mine(3)
    const ids = (await t.list(ref)).map((d) => d.id)
    expect(ids).toEqual([`${BASE}:${ok.transactionHash}:0`])
    expect(ids.join()).not.toContain(early.transactionHash)
    expect(ids.join()).not.toContain(dust.transactionHash)
  })

  it('reads at most maxLogPages pages of logBlockRange blocks per poll, and goes on next time', async () => {
    const t = setup({ logBlockRange: 10, maxLogPages: 2, confirmations: 0 })
    const { ref } = await t.address()
    t.evm.mine(100)
    await t.list(ref)
    expect(t.evm.getLogs).toEqual([
      [1001n, 1010n],
      [1011n, 1020n],
    ])
    await t.list(ref)
    expect(t.evm.getLogs.slice(2)).toEqual([
      [1021n, 1030n],
      [1031n, 1040n],
    ])
  })

  it('status: confirming until the depth, then succeeded with the amount; a re-org fails the leg', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-10T00:00:00Z'), toFake: ['Date'] })
    const t = setup()
    const { ref } = await t.address()
    const log = t.evm.send(units(12.5))
    t.evm.mine(3)
    const [d] = await t.list(ref)
    expect(await t.status(d!.legRef)).toMatchObject({ status: 'succeeded', output: { value: '12.5', asset: { chain: BASE, token: TOKEN } }, transactions: [{ role: 'source', hash: log.transactionHash }, { role: 'destination', hash: log.transactionHash }] })

    // The transaction moves to a newer block (a re-org): it waits for its confirmations again.
    t.evm.state.receipts.set(log.transactionHash, { status: '0x1', blockNumber: hex(t.evm.state.head), logs: [{ ...log, logIndex: '0x4' }] })
    expect(await t.status(d!.legRef)).toMatchObject({ status: 'processing', detail: { code: 'confirming' } })

    // The amount on chain is not the deposit: failed.
    t.evm.state.receipts.set(log.transactionHash, { status: '0x1', blockNumber: log.blockNumber, logs: [{ ...log, data: hex(units(1)) }] })
    expect(await t.status(d!.legRef)).toMatchObject({ status: 'failed', error: { code: 'DELIVERY_FAILED' } })

    // The transaction is gone: confirming for a while (a node that lags), then failed.
    t.evm.state.receipts.delete(log.transactionHash)
    expect(await t.status(d!.legRef)).toMatchObject({ status: 'processing' })
    vi.setSystemTime(Date.now() + 61 * 60_000)
    expect(await t.status(d!.legRef)).toMatchObject({ status: 'failed', error: { message: expect.stringMatching(/re-org/) } })

    // A reverted transaction fails.
    t.evm.state.receipts.set(log.transactionHash, { status: '0x0', blockNumber: log.blockNumber, logs: [] })
    expect(await t.status(d!.legRef)).toMatchObject({ status: 'failed' })
  })

  it('reads the decimals of an unknown token once (ERC-20 decimals())', async () => {
    const TOK = '0x00000000000000000000000000000000000000aa'
    const evm = fakeEvm()
    const replies: Record<string, unknown> = { eth_call: '0x12' }
    const { fetch, calls } = fakeFetch([
      {
        method: 'POST',
        match: 'rpc.base.test',
        reply: (c) => {
          const m = (c.body as { method: string }).method
          return m in replies ? { result: replies[m] } : evm.route.reply(c)
        },
      },
    ])
    const shared = memoryKV()
    const a = chainWatch({ rpcUrls: { [BASE]: 'https://rpc.base.test' }, confirmations: 0 })
    const ctx = { fetch, log: silentLog, shared }
    const dest = { ...DESTINATION, token: TOK }
    const { ref } = await a.standingAddress!({ userId: 'u1', origin: { chain: BASE, token: TOK }, destination: dest }, ctx)
    evm.state.head += 1n
    evm.state.logs.push({ address: TOK, topics: [], data: hex(10n ** 18n), transactionHash: `0x${'ab'.repeat(32)}`, blockNumber: hex(evm.state.head), logIndex: '0x1' })
    const [d] = await a.standingDeposits!({ ref, address: DEST, origin: { chain: BASE, token: TOK }, since: 0 }, ctx)
    expect(d!.input).toMatchObject({ value: '1', asset: { decimals: 18 } })
    await a.standingDeposits!({ ref, address: DEST, origin: { chain: BASE, token: TOK }, since: 0 }, ctx)
    expect(calls.filter((c) => (c.body as { method: string }).method === 'eth_call')).toHaveLength(1)
  })
})

describe('chain-watch: Solana deposits', () => {
  const SOL = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
  const MINT = USDC[SOL]!
  const OWNER = 'Owner1111111111111111111111111111111111111'
  const ACC = 'TokAcc111111111111111111111111111111111111'
  const sdest = { type: 'crypto' as const, chain: SOL, token: MINT, address: OWNER }

  function solTx(amountIn: bigint, err: unknown = null) {
    return {
      blockTime: Math.floor(Date.now() / 1000),
      meta: {
        err,
        preBalances: [0, 0],
        postBalances: [0, 0],
        preTokenBalances: [{ accountIndex: 1, mint: MINT, owner: OWNER, uiTokenAmount: { amount: '1000000', decimals: 6 } }],
        postTokenBalances: [{ accountIndex: 1, mint: MINT, owner: OWNER, uiTokenAmount: { amount: String(1_000_000n + amountIn), decimals: 6 } }],
      },
      transaction: { message: { accountKeys: ['Sender', ACC] } },
    }
  }

  it('SPL: finalized signatures of the token accounts; incoming transfers only, each once; status checks the amount', async () => {
    const sigs: Array<{ signature: string; err: unknown; blockTime: number }> = []
    const txs = new Map<string, unknown>()
    const { fetch, calls } = fakeFetch([
      {
        method: 'POST',
        match: 'sol.test',
        reply: (c) => {
          const body = c.body as { method: string; params: unknown[] }
          if (body.method === 'getTokenAccountsByOwner') return { result: { value: [{ pubkey: ACC }] } }
          if (body.method === 'getSignaturesForAddress') {
            const until = (body.params[1] as { until?: string }).until
            const i = until ? sigs.findIndex((s) => s.signature === until) : -1
            return { result: (i >= 0 ? sigs.slice(0, i) : sigs).slice() }
          }
          if (body.method === 'getTransaction') return { result: txs.get(String(body.params[0])) ?? null }
          return { result: null }
        },
      },
    ])
    const shared = memoryKV()
    const a = chainWatch({ rpcUrls: { [SOL]: 'https://sol.test' } })
    const ctx = { fetch, log: silentLog, shared }
    const { address, ref } = await a.standingAddress!({ userId: 'u1', origin: { chain: SOL, token: MINT }, destination: sdest }, ctx)
    expect(address).toBe(OWNER)
    const now = Math.floor(Date.now() / 1000)
    // newest first, like the RPC
    sigs.unshift({ signature: 'SigIn1', err: null, blockTime: now })
    txs.set('SigIn1', solTx(5_000_000n))
    sigs.unshift({ signature: 'SigOut', err: null, blockTime: now })
    txs.set('SigOut', solTx(-2_000_000n))
    sigs.unshift({ signature: 'SigErr', err: { x: 1 }, blockTime: now })
    const list = () => a.standingDeposits!({ ref, address: OWNER, origin: { chain: SOL, token: MINT }, since: 0 }, ctx)
    const first = await list()
    expect(first.map((d) => [d.id, d.input?.value])).toEqual([[`${SOL}:SigIn1`, '5']])
    const sigCall = calls.find((c) => (c.body as { method: string }).method === 'getSignaturesForAddress')!
    expect((sigCall.body as { params: unknown[] }).params[1]).toMatchObject({ commitment: 'finalized' })
    // The next poll asks only for newer signatures, and lists the recent one again.
    sigs.unshift({ signature: 'SigIn2', err: null, blockTime: now })
    txs.set('SigIn2', solTx(1_500_000n))
    expect((await list()).map((d) => d.id)).toEqual([`${SOL}:SigIn1`, `${SOL}:SigIn2`])
    const last = calls.filter((c) => (c.body as { method: string }).method === 'getSignaturesForAddress').pop()!
    expect((last.body as { params: unknown[] }).params[1]).toMatchObject({ until: 'SigErr' })

    const sctx = makeCtx({ fetch, shared, destination: sdest })
    const sleg: PathwayLeg = { ...leg, to: { asset: { kind: 'crypto', chain: SOL, token: MINT }, location: { kind: 'address', address: OWNER } } }
    expect(await a.status!({ leg: sleg, ref: first[0]!.legRef }, sctx)).toMatchObject({ status: 'succeeded', output: { value: '5' } })
    txs.set('SigIn1', solTx(4_000_000n))
    expect(await a.status!({ leg: sleg, ref: first[0]!.legRef }, sctx)).toMatchObject({ status: 'failed' })
  })
})
