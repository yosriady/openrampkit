import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '@wagmi/core'
import { USDC } from '@openrampkit/core'

const state = { chainId: 1, address: '0x03508bB71268BBA25ECaCC8F620e01866650532c' as string | undefined }
const log: string[] = []
const BAD_TOKEN = '0x00000000000000000000000000000000000000bd'

vi.mock('@wagmi/core', () => ({
  getAccount: () => ({ address: state.address, chainId: state.chainId }),
  getBalance: vi.fn(async (_c: unknown, p: { chainId: number }) => {
    if (p.chainId === 137) throw new Error('rpc down')
    return { value: 1_500_000_000_000_000_000n, decimals: 18, symbol: 'ETH' }
  }),
  readContract: vi.fn(async (_c: unknown, p: { address: string; chainId: number }) => {
    log.push(`read:${p.chainId}:${p.address}`)
    if (p.address === BAD_TOKEN) throw new Error('execution reverted')
    return 12_345_678n
  }),
  switchChain: vi.fn(async (_c: unknown, p: { chainId: number }) => {
    log.push(`switch:${p.chainId}`)
    state.chainId = p.chainId
  }),
  sendTransaction: vi.fn(async (_c: unknown, p: { chainId: number; to: string; value?: bigint }) => {
    log.push(`send:${p.chainId}:${p.to}:${p.value ?? ''}`)
    return `0x${String(log.length).padStart(64, '0')}`
  }),
  waitForTransactionReceipt: vi.fn(async (_c: unknown, p: { hash: string }) => {
    log.push(`wait:${p.hash.slice(-2)}`)
    return { status: 'success' }
  }),
}))

const { wagmiWallet } = await import('./index.js')
const core = await import('@wagmi/core')

const config = {
  chains: [
    { id: 1, nativeCurrency: { symbol: 'ETH', decimals: 18, name: 'Ether' } },
    { id: 8453, nativeCurrency: { symbol: 'ETH', decimals: 18, name: 'Ether' } },
    { id: 137, nativeCurrency: { symbol: 'POL', decimals: 18, name: 'POL' } },
  ],
} as unknown as Config

describe('wagmiWallet', () => {
  beforeEach(() => {
    log.length = 0
    state.chainId = 1
    state.address = '0x03508bB71268BBA25ECaCC8F620e01866650532c'
  })

  it('lists the connected address on every configured chain', async () => {
    const w = wagmiWallet(config)
    expect(await w.getAccounts()).toEqual([
      { chain: 'eip155:1', address: state.address },
      { chain: 'eip155:8453', address: state.address },
      { chain: 'eip155:137', address: state.address },
    ])
    state.address = undefined
    expect(await w.getAccounts()).toEqual([])
  })

  it('reads native and USDC balances, skipping failed RPCs and unconfigured chains', async () => {
    const w = wagmiWallet(config)
    const accounts = [...(await w.getAccounts()), { chain: 'eip155:42161', address: state.address! }]
    const balances = await w.getBalances!(accounts)
    expect(balances).toContainEqual({ chain: 'eip155:8453', token: 'native', symbol: 'ETH', decimals: 18, amount: '1.5' })
    expect(balances).toContainEqual({ chain: 'eip155:8453', token: USDC['eip155:8453'], symbol: 'USDC', decimals: 6, amount: '12.345678', usd: '12.345678' })
    // Polygon native failed; Polygon USDC still read
    expect(balances.find((b) => b.chain === 'eip155:137' && b.token === 'native')).toBeUndefined()
    expect(balances.find((b) => b.chain === 'eip155:137' && b.symbol === 'USDC')).toBeDefined()
    // Arbitrum is not in the config
    expect(balances.some((b) => b.chain === 'eip155:42161')).toBe(false)
  })

  it('switches chain, sends txs in order, waits between them, returns the last hash', async () => {
    const w = wagmiWallet(config)
    const res = await w.sendTransactions('eip155:8453', [
      { to: '0xaaaa', data: '0x095ea7b3', chainId: 8453 },
      { to: '0xbbbb', value: '100', chainId: 8453 },
    ])
    expect(log).toEqual(['switch:8453', 'send:8453:0xaaaa:', 'wait:02', 'send:8453:0xbbbb:100'])
    expect(res.hash).toBe(`0x${'4'.padStart(64, '0')}`)
  })

  it('does not switch when already on the chain; rejects chains outside the config', async () => {
    state.chainId = 8453
    const w = wagmiWallet(config)
    await w.sendTransactions('eip155:8453', [{ to: '0xcccc', chainId: 8453 }])
    expect(log).toEqual(['send:8453:0xcccc:'])
    await expect(w.switchChain!('eip155:42161')).rejects.toThrow(/not in the wagmi config/)
  })
})


describe('wagmiWallet: more', () => {
  beforeEach(() => {
    log.length = 0
    state.chainId = 1
    state.address = '0x03508bB71268BBA25ECaCC8F620e01866650532c'
    vi.mocked(core.sendTransaction).mockClear()
  })

  it('partial balance failures: a failing token read hides only that token; extra tokens are read once', async () => {
    const extra = { address: '0x00000000000000000000000000000000000000aa', symbol: 'DAI', decimals: 18 }
    const w = wagmiWallet(config, {
      tokens: {
        'eip155:8453': [extra, { address: BAD_TOKEN, symbol: 'BAD', decimals: 18 }, { address: USDC['eip155:8453']!.toUpperCase().replace('0X', '0x'), symbol: 'USDC', decimals: 6 }],
      },
    })
    const balances = await w.getBalances!([
      { chain: 'eip155:8453', address: state.address! },
      { chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', address: 'So1ana' },
    ])
    expect(balances.map((b) => b.symbol)).toEqual(['ETH', 'USDC', 'DAI'])
    expect(balances.find((b) => b.symbol === 'DAI')).toEqual({ chain: 'eip155:8453', token: extra.address, symbol: 'DAI', decimals: 18, amount: '0.000000000012345678' })
    expect(log.filter((l) => l.startsWith('read:')).length).toBe(3) // USDC once, DAI, BAD
  })

  it('a configured chain without known USDC reports only native balance', async () => {
    const cfg = { chains: [{ id: 11155111, nativeCurrency: { symbol: 'SEP', decimals: 18, name: 'Sepolia' } }] } as unknown as Config
    const balances = await wagmiWallet(cfg).getBalances!([{ chain: 'eip155:11155111', address: state.address! }])
    expect(balances).toEqual([{ chain: 'eip155:11155111', token: 'native', symbol: 'SEP', decimals: 18, amount: '1.5' }])
    expect(log).toEqual([])
  })

  it('multiple txs across chains: switches before each, in order, and passes gas and value', async () => {
    const w = wagmiWallet(config)
    const res = await w.sendTransactions('eip155:8453', [
      { to: '0xaaaa', data: '0x095ea7b3', chainId: 8453, gas: '60000' },
      { to: '0xbbbb', value: '5', chainId: 1 },
      { to: '0xcccc', chainId: 0 },
    ])
    expect(log).toEqual(['switch:8453', 'send:8453:0xaaaa:', 'wait:02', 'switch:1', 'send:1:0xbbbb:5', 'wait:05', 'switch:8453', 'send:8453:0xcccc:'])
    expect(res.hash).toBe(`0x${'8'.padStart(64, '0')}`)
    const calls = vi.mocked(core.sendTransaction).mock.calls.map((c) => c[1])
    expect(calls[0]).toEqual({ chainId: 8453, to: '0xaaaa', data: '0x095ea7b3', gas: 60000n })
    expect(calls[1]).toEqual({ chainId: 1, to: '0xbbbb', value: 5n })
    expect(calls[2]).toEqual({ chainId: 8453, to: '0xcccc' })
  })

  it('waitBetweenTxs: false sends without waiting; waitForLast waits for the final receipt', async () => {
    await wagmiWallet(config, { waitBetweenTxs: false }).sendTransactions('eip155:1', [{ to: '0x1', chainId: 1 }, { to: '0x2', chainId: 1 }])
    expect(log).toEqual(['send:1:0x1:', 'send:1:0x2:'])
    log.length = 0
    await wagmiWallet(config, { waitForLast: true }).sendTransactions('eip155:1', [{ to: '0x3', chainId: 1 }])
    expect(log).toEqual(['send:1:0x3:', 'wait:01'])
  })

  it('rejects empty batches, non-EVM chains and unconfigured chains before sending', async () => {
    const w = wagmiWallet(config)
    await expect(w.sendTransactions('eip155:1', [])).rejects.toThrow('No transactions to send')
    await expect(w.sendTransactions('solana:x', [{ to: 'x', chainId: 0 }])).rejects.toThrow('Not an EVM chain: solana:x')
    await expect(w.sendTransactions('eip155:10', [{ to: '0x1', chainId: 10 }])).rejects.toThrow(/Chain 10 is not in the wagmi config/)
    await expect(w.switchChain!('solana:x')).rejects.toThrow(/Not an EVM chain/)
    expect(log).toEqual([])
    await w.switchChain!('eip155:137')
    await w.switchChain!('eip155:137')
    expect(log).toEqual(['switch:137'])
  })
})
