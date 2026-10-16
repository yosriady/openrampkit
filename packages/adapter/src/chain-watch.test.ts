// The shared chain watcher: RPC URLs, the rate limit, Transfer log pages with a block range cap,
// confirmations, Solana reads, and the net amount a Solana transaction moved.
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIRMATIONS, MAX_LOG_BLOCK_RANGE, PUBLIC_RPC_URLS, createChainWatch, solanaMintDecimals, solanaNetReceived, txUsedKey } from './index.js'
import { fakeFetch, silentLog } from './testing.js'
import type { FakeCall } from './testing.js'

const TOKEN = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const TO = '0x000000000000000000000000000000000000BEEF'
const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`
const method = (c: FakeCall) => (c.body as { method: string }).method

function chain(logs: Array<{ data: string; transactionHash: string; blockNumber: string; logIndex: string; removed?: boolean }> = []) {
  const ranges: Array<[bigint, bigint]> = []
  const { fetch, calls } = fakeFetch([
    {
      method: 'POST',
      match: 'rpc.test',
      reply: (c) => {
        const body = c.body as { method: string; params: Array<{ fromBlock: string; toBlock: string }> }
        if (body.method === 'eth_blockNumber') return { result: '0x100' }
        if (body.method === 'eth_getLogs') {
          const from = BigInt(body.params[0]!.fromBlock)
          const to = BigInt(body.params[0]!.toBlock)
          ranges.push([from, to])
          return { result: logs.filter((l) => BigInt(l.blockNumber) >= from && BigInt(l.blockNumber) <= to) }
        }
        return { result: null }
      },
    },
  ])
  return { ctx: { fetch, log: silentLog }, calls, ranges }
}

describe('createChainWatch', () => {
  it('picks the RPC URL: rpcUrls, then the defaults; a chain with no URL is PROVIDER_UNAVAILABLE', async () => {
    const w = createChainWatch({ rpcUrls: { 'eip155:8453': 'https://rpc.test/base' } })
    expect(w.rpcUrl('eip155:8453')).toBe('https://rpc.test/base')
    expect(w.rpcUrl('eip155:1')).toBe(PUBLIC_RPC_URLS['eip155:1'])
    expect(createChainWatch({ defaultRpcUrls: {} }).rpcUrl('eip155:1')).toBeUndefined()
    const { ctx } = chain()
    await expect(createChainWatch({ defaultRpcUrls: {} }).rpc(ctx, 'eip155:143', 'eth_blockNumber', [])).rejects.toMatchObject({
      status: 502,
      error: { code: 'PROVIDER_UNAVAILABLE', message: expect.stringMatching(/No RPC is configured/) },
    })
  })

  it('confirmations: 12 by default, one number, or one per chain', () => {
    expect(createChainWatch().confirmationsFor('eip155:1')).toBe(DEFAULT_CONFIRMATIONS)
    expect(createChainWatch({ confirmations: 3 }).confirmationsFor('eip155:1')).toBe(3)
    const w = createChainWatch({ confirmations: { 'eip155:1': 30 } })
    expect(w.confirmationsFor('eip155:1')).toBe(30)
    expect(w.confirmationsFor('eip155:8453')).toBe(DEFAULT_CONFIRMATIONS)
    expect(createChainWatch({ confirmations: -1 }).confirmationsFor('eip155:1')).toBe(DEFAULT_CONFIRMATIONS)
  })

  it('reads Transfer logs page by page, capped by the block range and the page count, oldest first', async () => {
    const logs = [
      { data: hex(2), transactionHash: '0xb', blockNumber: hex(0x105), logIndex: '0x2' },
      { data: hex(1), transactionHash: '0xa', blockNumber: hex(0x105), logIndex: '0x1' },
      { data: hex(9), transactionHash: '0xc', blockNumber: hex(0x104), logIndex: '0x0', removed: true },
      { data: hex(3), transactionHash: '0xd', blockNumber: hex(0x140), logIndex: '0x0' },
    ]
    const { ctx, ranges, calls } = chain(logs)
    const w = createChainWatch({ rpcUrls: { 'eip155:8453': 'https://rpc.test' }, logBlockRange: 16, maxLogPages: 2 })
    const pages = []
    for await (const p of w.transferLogPages(ctx, { chain: 'eip155:8453', token: TOKEN, to: TO, from: 0x100n, latest: 0x200n })) pages.push(p)
    expect(ranges).toEqual([
      [0x100n, 0x10fn],
      [0x110n, 0x11fn],
    ])
    expect(pages[0]!.logs.map((l) => l.transactionHash)).toEqual(['0xa', '0xb'])
    expect(pages[1]!).toMatchObject({ from: 0x110n, to: 0x11fn, logs: [] })
    const first = calls.find((c) => method(c) === 'eth_getLogs')!
    expect((first.body as { params: unknown[] }).params[0]).toMatchObject({ address: TOKEN, topics: [expect.any(String), null, `0x${'0'.repeat(24)}${TO.slice(2).toLowerCase()}`] })
    // The range never goes past `latest`, and a block range above the cap is capped.
    expect(createChainWatch({ logBlockRange: 1_000_000 }).logBlockRange).toBe(BigInt(MAX_LOG_BLOCK_RANGE))
    const short = chain(logs)
    for await (const _ of createChainWatch({ rpcUrls: { 'eip155:8453': 'https://rpc.test' } }).transferLogPages(short.ctx, { chain: 'eip155:8453', token: TOKEN, to: TO, from: 0x100n, latest: 0x101n })) void _
    expect(short.ranges).toEqual([[0x100n, 0x101n]])
  })

  it('rate limit: calls to one RPC URL wait for their turn', async () => {
    const { ctx } = chain()
    const w = createChainWatch({ rpcUrls: { 'eip155:8453': 'https://rpc.test' }, requestsPerSecond: 50 })
    const t0 = Date.now()
    await Promise.all([1, 2, 3, 4].map(() => w.latestBlock(ctx, 'eip155:8453')))
    // Four calls at 50 per second: the last one starts at least 60 ms after the first.
    const limited = Date.now() - t0
    expect(limited).toBeGreaterThanOrEqual(55)
    const free = createChainWatch({ rpcUrls: { 'eip155:8453': 'https://rpc.test' } })
    const t1 = Date.now()
    await Promise.all([1, 2, 3, 4].map(() => free.latestBlock(ctx, 'eip155:8453')))
    // No limit: the calls do not wait. Compare with the limited run, not a fixed time, so a busy machine does not fail it.
    expect(Date.now() - t1).toBeLessThan(limited)
  })

  it('Solana reads use the configured commitment (default finalized)', async () => {
    const { fetch, calls } = fakeFetch([{ method: 'POST', match: 'sol.test', reply: () => ({ result: [] }) }])
    const ctx = { fetch, log: silentLog }
    const w = createChainWatch({ rpcUrls: { 'solana:x': 'https://sol.test' } })
    await w.solanaSignatures(ctx, 'solana:x', 'Acc', { limit: 5, until: 'S1' })
    await w.solanaTx(ctx, 'solana:x', 'S2')
    await w.solanaTx(ctx, 'solana:x', 'S3', 'confirmed')
    const params = calls.map((c) => (c.body as { params: unknown[] }).params)
    expect(params[0]).toEqual(['Acc', { limit: 5, commitment: 'finalized', until: 'S1' }])
    expect(params[1]).toEqual(['S2', { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }])
    expect((params[2]![1] as { commitment: string }).commitment).toBe('confirmed')
  })

  it('txUsedKey: EVM hashes in lower case, Solana signatures as given', () => {
    expect(txUsedKey('eip155:1', '0xABC')).toBe('txused:eip155:1:0xabc')
    expect(txUsedKey('solana:x', 'AbC')).toBe('txused:solana:x:AbC')
  })
})

describe('solanaNetReceived', () => {
  const tx = {
    meta: {
      err: null,
      preBalances: [5_000, 100],
      postBalances: [3_000, 2_100],
      preTokenBalances: [{ accountIndex: 2, mint: 'M', owner: 'Owner', uiTokenAmount: { amount: '10', decimals: 6 } }],
      postTokenBalances: [
        { accountIndex: 2, mint: 'M', owner: 'Owner', uiTokenAmount: { amount: '25', decimals: 6 } },
        { accountIndex: 3, mint: 'M', owner: 'Owner', uiTokenAmount: { amount: '5', decimals: 6 } },
      ],
    },
    transaction: { message: { accountKeys: ['Payer', { pubkey: 'Owner' }, 'TokAcc', 'TokAcc2'] } },
  }
  it('sums the balance changes of the owner: lamports, or the token accounts of the mint', () => {
    expect(solanaNetReceived(tx, 'Owner', 'native')).toBe(2_000n)
    expect(solanaNetReceived(tx, 'Payer', 'native')).toBe(-2_000n)
    expect(solanaNetReceived(tx, 'Owner', 'M')).toBe(20n)
    expect(solanaNetReceived(tx, 'Owner', 'Other')).toBe(0n)
    expect(solanaNetReceived({ ...tx, meta: null }, 'Owner', 'M')).toBe(0n)
    expect(solanaMintDecimals(tx, 'M')).toBe(6)
    expect(solanaMintDecimals(tx, 'native')).toBe(9)
    expect(solanaMintDecimals(tx, 'Other')).toBeUndefined()
  })
})
