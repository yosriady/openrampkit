// The testnet server of the playground, end to end in Node: the real server, the mock adapter's
// settlement leg and a fake JSON-RPC chain behind the page's `fetch`.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { hashSettlementCalls, settlementCallsFrom } from '@openrampkit/adapter'
import { createOpenRampClient } from '@openrampkit/client'
import type { ContractCall } from '@openrampkit/core'
import { approveAmount, settleSessionId } from './chain.js'
import { DEFAULT_NETWORKS } from './config.js'
import { createTestnetServer, testnetAdapters, testnetSessionInput } from './server.js'

const ME = '0x1111111111111111111111111111111111111111'
const HASH = `0x${'ab'.repeat(32)}`
const arb = DEFAULT_NETWORKS[0]!
const testToken = arb.tokens.find((t) => t.key === 'test')!
const usdc = arb.tokens.find((t) => t.key === 'usdc')!
const word = (v: string | bigint) => (typeof v === 'bigint' ? v.toString(16) : v.toLowerCase().replace(/^0x/, '')).padStart(64, '0')

/** A fake chain at the testnet RPC URL. `settle()` records a settlement as the contract would. */
function fakeChain() {
  let settled: { amount: bigint; token: string; recipient: string; callsHash: string } | undefined
  const calls: string[] = []
  const passed: string[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    passed.push(req.url)
    if (req.url !== arb.rpcUrl) return new Response('not here', { status: 404 })
    const { method, id } = (await req.json()) as { method: string; id: number }
    calls.push(method)
    const s = settled
    let result: unknown = null
    if (method === 'eth_blockNumber') result = '0x100'
    if (method === 'eth_call') result = `0x${word(s ? ME : 0n)}${word(s ? 1_700_000_000n : 0n)}${word(s ? s.token : 0n)}${word(s ? s.recipient : 0n)}${word(s ? s.amount : 0n)}`
    if (method === 'eth_getLogs') result = s ? [{ data: `0x${word(s.recipient)}${word(s.token)}${s.callsHash.slice(2)}`, topics: [], transactionHash: HASH, blockNumber: '0x101' }] : []
    if (method === 'eth_getTransactionReceipt') result = { status: '0x1', logs: [] }
    return Response.json({ jsonrpc: '2.0', id, result })
  })
  return {
    calls,
    passed,
    settle(p: { amount: bigint; token: string; recipient: string; destCalls?: ContractCall[] }) {
      settled = { amount: p.amount, token: p.token.toLowerCase(), recipient: p.recipient.toLowerCase(), callsHash: hashSettlementCalls(settlementCallsFrom(p.destCalls)) }
    },
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('testnet server', () => {
  it('has one wallet leg per network and token, and no card or cash legs', () => {
    const adapters = testnetAdapters(DEFAULT_NETWORKS)
    expect(adapters.map((a) => a.id)).toEqual(['testnet-arbitrum-sepolia-test', 'testnet-arbitrum-sepolia-usdc', 'testnet-robinhood-testnet-test'])
    for (const a of adapters) expect(a.legs.map((l) => l.id)).toEqual(['onchain'])
  })

  it('builds a plain settlement session, or a fixed-amount vault session', () => {
    const plain = testnetSessionInput({ network: arb, token: usdc, recipient: ME })
    expect(plain.destination).toMatchObject({ type: 'crypto', chain: 'eip155:421614', token: usdc.address, address: ME, settlement: { contract: arb.settlement } })
    expect(plain.destination).not.toHaveProperty('calls')
    expect(plain.amountBounds).toBeUndefined()
    // Circle USDC has no vault: the vault choice falls back to a plain settlement.
    expect(testnetSessionInput({ network: arb, token: usdc, recipient: ME, vault: { amount: '5' } }).destination).not.toHaveProperty('calls')

    const vault = testnetSessionInput({ network: arb, token: testToken, recipient: ME, vault: { amount: '5' } })
    expect(vault.destination).toMatchObject({ calls: [{ to: testToken.vault, data: `0x6e553f65${word(5_000_000n)}${word(ME)}` }] })
    expect(vault.amountBounds).toEqual({ min: '5', max: '5', currency: 'tUSDC' })
  })

  it('pays a vault session with approve + settle and completes it from the chain, by session id', async () => {
    const chain = fakeChain()
    const { openramp, fakeFetch } = createTestnetServer(DEFAULT_NETWORKS)
    const client = createOpenRampClient({ baseUrl: 'https://playground.openrampkit.invalid/api/openramp', fetch: fakeFetch })
    const input = testnetSessionInput({ network: arb, token: testToken, recipient: ME, vault: { amount: '5' } })
    const { clientSecret, id } = await openramp.sessions.create(input)

    const plan = await client.plan(clientSecret, { walletConnected: true, walletAddress: ME })
    expect(plan.methods.map((m) => m.method)).toEqual(['wallet'])
    const source = { chain: 'eip155:421614', token: testToken.address }
    // The vault call deposits 5, so another amount is refused.
    const wrong = await client.quotes(clientSecret, { method: 'wallet', amount: '6', amountSide: 'source', source })
    expect(wrong.quotes).toHaveLength(0)
    expect(wrong.errors[0]?.message).toMatch(/maximum is 5 tUSDC/)

    const q = await client.quotes(clientSecret, { method: 'wallet', amount: '5', amountSide: 'source', source })
    const paying = await client.select(clientSecret, { quoteId: q.quotes[0]!.id, walletAddress: ME })
    const surface = paying.step.surface!
    if (surface.kind !== 'WALLET_TX') throw new Error(`Expected WALLET_TX, got ${surface.kind}`)
    expect(surface.chain).toBe('eip155:421614')
    expect(surface.txs).toHaveLength(2)
    const [approve, settle] = surface.txs as Array<{ to: string; data: string }>
    expect(approve!.to.toLowerCase()).toBe(testToken.address.toLowerCase())
    expect(approveAmount(approve!.data)).toBe(5_000_000n)
    expect(settle!.to.toLowerCase()).toBe(arb.settlement.toLowerCase())
    expect(settleSessionId(settle!.data)).toBe(id)

    // The wallet sends both; the contract records the session.
    chain.settle({ amount: 5_000_000n, token: testToken.address, recipient: ME, destCalls: input.destination?.type === 'crypto' ? input.destination.calls : [] })
    const done = await client.transition(clientSecret, 'submit_tx', { txHash: HASH })
    expect(done.step.state).toBe('COMPLETED')
    expect(done.step.progress?.legs[0]).toMatchObject({ legId: 'onchain', status: 'succeeded', txHash: HASH })
    expect(chain.calls).toEqual(expect.arrayContaining(['eth_blockNumber', 'eth_call', 'eth_getLogs']))
    // Only the testnet RPC left the page.
    expect(new Set(chain.passed)).toEqual(new Set([arb.rpcUrl]))
  })

  it('fails a session that the chain settled for less than the quote', async () => {
    const chain = fakeChain()
    const { openramp, fakeFetch } = createTestnetServer(DEFAULT_NETWORKS)
    const client = createOpenRampClient({ baseUrl: 'https://playground.openrampkit.invalid/api/openramp', fetch: fakeFetch })
    const { clientSecret } = await openramp.sessions.create(testnetSessionInput({ network: arb, token: usdc, recipient: ME }))
    await client.plan(clientSecret, { walletConnected: true, walletAddress: ME })
    const q = await client.quotes(clientSecret, { method: 'wallet', amount: '5', amountSide: 'source', source: { chain: 'eip155:421614', token: usdc.address } })
    await client.select(clientSecret, { quoteId: q.quotes[0]!.id, walletAddress: ME })
    chain.settle({ amount: 4_000_000n, token: usdc.address, recipient: ME })
    const done = await client.transition(clientSecret, 'submit_tx', { txHash: HASH })
    expect(done.step.state).toBe('FAILED')
    expect(done.step.error?.message).toMatch(/less than the quoted amount/)
  })
})
