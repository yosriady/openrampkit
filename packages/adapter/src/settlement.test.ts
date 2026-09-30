import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  OPEN_RAMP_SETTLEMENT_ABI,
  SETTLED_TOPIC,
  SETTLEMENT_SELECTORS,
  buildSettlementTxs,
  bytes32ToSessionId,
  encodeSettle,
  erc20ApproveData,
  hashSettlementCalls,
  keccak256,
  sessionIdToBytes32,
  settlementCallsFrom,
  settlementIntentTypedData,
  verifySettlement,
} from './index.js'

const selector = (sig: string) => keccak256(sig).slice(0, 10)
const ARTIFACT = fileURLToPath(new URL('../../../contracts/out/OpenRampSettlement.sol/OpenRampSettlement.json', import.meta.url))

describe('keccak256', () => {
  it('matches known vectors', () => {
    expect(keccak256('')).toBe('0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470')
    expect(keccak256('abc')).toBe('0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45')
    expect(keccak256('Transfer(address,address,uint256)')).toBe('0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef')
    // longer than one 136-byte block
    expect(keccak256('a'.repeat(200))).toBe('0x96ea54061def936c4be90b518992fdc6f12f535068a256229aca54267b4d084d')
    // padding edge cases: rate - 1 bytes (0x81 pad byte) and exactly one block
    expect(keccak256(new Uint8Array(135))).toBe('0x29e3704feeca7fb9ba229f0fa04d9b36449cf3ad6e1d85d9cfff3a10df9abc3e')
    expect(keccak256(new Uint8Array(136))).toBe('0x3a5912a7c5faa06ee4fe906253e339467a9ce87d533c65be3c15cb231cdb25f9')
  })
})

describe('settlement ABI constants', () => {
  it('selectors and topic match the signatures', () => {
    const tuple = '(bytes32,address,uint256,address,(address,bytes)[])'
    const intent = '(address,uint256,uint256,bytes)'
    expect(selector(`settle(${tuple},${intent})`)).toBe(SETTLEMENT_SELECTORS.settle)
    expect(selector(`settleFromBalance(${tuple},${intent})`)).toBe(SETTLEMENT_SELECTORS.settleFromBalance)
    expect(selector('receiptOf(bytes32)')).toBe(SETTLEMENT_SELECTORS.receiptOf)
    expect(selector('isSettled(bytes32)')).toBe(SETTLEMENT_SELECTORS.isSettled)
    expect(selector('intentSigner()')).toBe(SETTLEMENT_SELECTORS.intentSigner)
    expect(keccak256('Settled(bytes32,address,address,address,uint256,bytes32)')).toBe(SETTLED_TOPIC)
  })

  it('the exported ABI has the settle entry points and the Settled event', () => {
    const names = OPEN_RAMP_SETTLEMENT_ABI.map((e) => ('name' in e ? e.name : e.type))
    expect(names).toEqual(expect.arrayContaining(['settle', 'settleFromBalance', 'receiptOf', 'Settled']))
  })

  it.skipIf(!existsSync(ARTIFACT))('the committed ABI equals the compiled contract (run scripts/export-settlement-abi.mjs)', () => {
    const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8')) as { abi: unknown; methodIdentifiers: Record<string, string> }
    expect(OPEN_RAMP_SETTLEMENT_ABI).toEqual(artifact.abi)
    const ids = Object.fromEntries(Object.entries(artifact.methodIdentifiers).map(([sig, id]) => [sig.slice(0, sig.indexOf('(')), `0x${id}`]))
    for (const [name, id] of Object.entries(SETTLEMENT_SELECTORS)) expect(ids[name]).toBe(id)
  })
})

describe('session ids', () => {
  it('round-trips a session id through bytes32', () => {
    const w = sessionIdToBytes32('ors_abc')
    expect(w).toBe('0x6f72735f61626300000000000000000000000000000000000000000000000000')
    expect(bytes32ToSessionId(w)).toBe('ors_abc')
    expect(bytes32ToSessionId(sessionIdToBytes32('ors_0123456789abcdef01234567'))).toBe('ors_0123456789abcdef01234567')
  })

  it('rejects empty and long ids', () => {
    expect(() => sessionIdToBytes32('')).toThrow(/1 to 32 bytes/)
    expect(() => sessionIdToBytes32('x'.repeat(33))).toThrow(/1 to 32 bytes/)
  })
})

describe('encoding', () => {
  const vaultCall = {
    target: '0x1111111111111111111111111111111111111111',
    // deposit(250000000, 0x...beef)
    data: '0x6e553f65000000000000000000000000000000000000000000000000000000000ee6b280000000000000000000000000000000000000000000000000000000000000beef',
  }

  it('encodes settle() exactly like `cast calldata`', () => {
    const data = encodeSettle(
      { sessionId: 'ors_abc', token: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', amount: 250_000_000n, recipient: '0x000000000000000000000000000000000000beef', calls: [vaultCall] },
      { payer: '0x0000000000000000000000000000000000000000', minAmount: 250_000_000n, deadline: 1_700_000_000n, signature: '0xabcdef' },
    )
    expect(data).toBe(
      '0x4fcc438f000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000001e06f72735f6162630000000000000000000000000000000000000000000000000000000000000000000000000075faf114eafb1bdbe2f0316df893fd58ce46aa4d000000000000000000000000000000000000000000000000000000000ee6b280000000000000000000000000000000000000000000000000000000000000beef00000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000200000000000000000000000001111111111111111111111111111111111111111000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000446e553f65000000000000000000000000000000000000000000000000000000000ee6b280000000000000000000000000000000000000000000000000000000000000beef000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000ee6b280000000000000000000000000000000000000000000000000000000006553f10000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000003abcdef0000000000000000000000000000000000000000000000000000000000',
    )
  })

  it('uses the settleFromBalance selector on request', () => {
    const data = encodeSettle({ sessionId: 'ors_abc', token: vaultCall.target, amount: 1n, recipient: vaultCall.target }, undefined, { fromBalance: true })
    expect(data.startsWith(SETTLEMENT_SELECTORS.settleFromBalance)).toBe(true)
  })

  it('builds approve + settle transactions', () => {
    const txs = buildSettlementTxs({ chainId: 421614, contract: '0x2222222222222222222222222222222222222222', sessionId: 'ors_abc', token: '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d', amount: 5n, recipient: vaultCall.target })
    expect(txs).toHaveLength(2)
    expect(txs[0]).toEqual({ to: '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d', data: erc20ApproveData('0x2222222222222222222222222222222222222222', 5n), chainId: 421614 })
    expect(txs[0]!.data).toBe('0x095ea7b300000000000000000000000022222222222222222222222222222222222222220000000000000000000000000000000000000000000000000000000000000005')
    expect(txs[1]!.to).toBe('0x2222222222222222222222222222222222222222')
    expect(txs[1]!.data!.startsWith(SETTLEMENT_SELECTORS.settle)).toBe(true)
  })

  it('maps and checks destination calls', () => {
    expect(settlementCallsFrom([{ to: vaultCall.target, data: '0x1234' }])).toEqual([{ target: vaultCall.target, data: '0x1234' }])
    expect(settlementCallsFrom(undefined)).toEqual([])
    expect(() => settlementCallsFrom([{ to: 'nope', data: '0x' }])).toThrow(/`to` address/)
    expect(() => settlementCallsFrom([{ to: vaultCall.target, data: '0x123' }])).toThrow(/hex `data`/)
    expect(() => settlementCallsFrom([{ to: vaultCall.target, data: '0x', value: '1' }])).toThrow(/native value/)
  })

  it('hashes an empty call bundle like the contract', () => {
    expect(hashSettlementCalls([])).toBe(keccak256(''))
  })

  it('builds EIP-712 typed data', () => {
    const td = settlementIntentTypedData({ chainId: 421614, contract: vaultCall.target, sessionId: 'ors_abc', token: vaultCall.target, recipient: vaultCall.target, minAmount: 1n, deadline: 2n })
    expect(td.domain).toEqual({ name: 'OpenRampSettlement', version: '1', chainId: 421614, verifyingContract: vaultCall.target })
    expect(td.message.payer).toBe('0x0000000000000000000000000000000000000000')
    expect(td.message.sessionId).toBe(sessionIdToBytes32('ors_abc'))
    expect(td.primaryType).toBe('SettlementIntent')
  })
})

describe('verifySettlement', () => {
  const contract = '0x2222222222222222222222222222222222222222'
  const token = '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d'
  const recipient = '0x000000000000000000000000000000000000beef'
  const payer = '0x3333333333333333333333333333333333333333'
  const w = (v: string | bigint) => (typeof v === 'bigint' ? v.toString(16) : v.slice(2)).padStart(64, '0')

  function fakeRpc(opts: { settledAt: bigint; amount?: bigint; logs?: boolean }) {
    const calls: Array<{ method: string; params: unknown[] }> = []
    const f = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { method: string; params: unknown[] }
      calls.push(body)
      let result: unknown
      if (body.method === 'eth_call') result = `0x${w(payer)}${w(opts.settledAt)}${w(token)}${w(recipient)}${w(opts.amount ?? 250_000_000n)}`
      if (body.method === 'eth_getLogs') {
        result = opts.logs === false ? [] : [{ data: `0x${w(token)}${w(opts.amount ?? 250_000_000n)}${w('0x' + 'ab'.repeat(32))}`, topics: [], transactionHash: '0xfeed', blockNumber: '0x10' }]
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    return { f, calls }
  }

  it('returns settled: false when the session has no receipt', async () => {
    const { f, calls } = fakeRpc({ settledAt: 0n })
    await expect(verifySettlement({ rpcUrl: 'http://rpc', contract, sessionId: 'ors_abc', fetch: f })).resolves.toEqual({ settled: false })
    expect(calls.map((c) => c.method)).toEqual(['eth_call'])
    expect((calls[0]!.params[0] as { data: string }).data).toBe(`${SETTLEMENT_SELECTORS.receiptOf}${sessionIdToBytes32('ors_abc').slice(2)}`)
  })

  it('reads the receipt and the Settled log', async () => {
    const { f, calls } = fakeRpc({ settledAt: 1_700_000_000n })
    const r = await verifySettlement({ rpcUrl: 'http://rpc', contract, sessionId: 'ors_abc', fetch: f, fromBlock: 16, expect: { token, recipient, minAmount: 250_000_000n } })
    expect(r).toEqual({
      settled: true,
      ok: true,
      record: { sessionId: 'ors_abc', payer, settledAt: 1_700_000_000, token, recipient, amount: 250_000_000n, callsHash: `0x${'ab'.repeat(32)}`, txHash: '0xfeed', blockNumber: 16 },
    })
    expect(calls[1]!.params[0]).toEqual({ address: contract, fromBlock: '0x10', toBlock: 'latest', topics: [SETTLED_TOPIC, sessionIdToBytes32('ors_abc')] })
  })

  it('flags a settlement that does not match the session', async () => {
    const { f } = fakeRpc({ settledAt: 1n, amount: 1n })
    const base = { rpcUrl: 'http://rpc', contract, sessionId: 'ors_abc', fetch: f }
    await expect(verifySettlement({ ...base, expect: { minAmount: 2n } })).resolves.toMatchObject({ ok: false, problem: expect.stringMatching(/less than/) })
    await expect(verifySettlement({ ...base, expect: { recipient: payer } })).resolves.toMatchObject({ ok: false, problem: expect.stringMatching(/recipient/) })
    await expect(verifySettlement({ ...base, expect: { token: payer } })).resolves.toMatchObject({ ok: false, problem: expect.stringMatching(/token/) })
    await expect(verifySettlement({ ...base, expect: { callsHash: `0x${'cd'.repeat(32)}` } })).resolves.toMatchObject({ ok: false, problem: expect.stringMatching(/calls/) })
  })

  it('fails loudly when the log is missing or the contract returns nothing', async () => {
    const { f } = fakeRpc({ settledAt: 1n, logs: false })
    await expect(verifySettlement({ rpcUrl: 'http://rpc', contract, sessionId: 'ors_abc', fetch: f })).rejects.toThrow(/log was not found/)
    const empty = (async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    await expect(verifySettlement({ rpcUrl: 'http://rpc', contract, sessionId: 'ors_abc', fetch: empty })).rejects.toThrow(/no receipt/)
  })
})
