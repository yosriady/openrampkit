import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { USDC } from '@openrampkit/core'
import { DEFAULT_PRIVY_CHAINS, privyWallet } from './index.js'
import type { Eip1193Provider, PrivyWalletLike } from './index.js'

const ADDRESS = '0x03508bB71268BBA25ECaCC8F620e01866650532c'
/** eth_getBalance fails for this address, as a dead RPC would. */
const BAD_ADDRESS = '0x00000000000000000000000000000000000000ff'
const BAD_TOKEN = '0x00000000000000000000000000000000000000bd'

const log: string[] = []
const state = { chainId: 1, receipt: true as boolean, reverted: false, disconnected: false }
/** A chain the provider does not know, so wallet_switchEthereumChain fails. */
const UNKNOWN_CHAIN_ID = 99999

const toHex = (value: bigint) => `0x${value.toString(16)}`

function fakeProvider(): Eip1193Provider {
  return {
    async request({ method, params }) {
      switch (method) {
        case 'eth_chainId':
          if (state.disconnected) throw new Error('provider disconnected')
          return toHex(BigInt(state.chainId))
        case 'wallet_switchEthereumChain': {
          const wanted = Number((params as unknown as Array<{ chainId: string }>)[0]!.chainId)
          log.push(`switch:${wanted}`)
          if (wanted === UNKNOWN_CHAIN_ID) throw new Error('Unrecognized chain ID')
          state.chainId = wanted
          return null
        }
        case 'eth_getBalance': {
          if ((params as unknown as string[])[0] === BAD_ADDRESS) throw new Error('rpc down')
          return toHex(1_500_000_000_000_000_000n)
        }
        case 'eth_call': {
          const to = (params as unknown as Array<{ to: string }>)[0]!.to
          log.push(`call:${state.chainId}:${to}`)
          if (to === BAD_TOKEN) throw new Error('execution reverted')
          return toHex(12_345_678n)
        }
        case 'eth_sendTransaction': {
          const tx = (params as unknown as Array<{ to: string; value?: string }>)[0]!
          log.push(`send:${state.chainId}:${tx.to}:${tx.value ?? ''}`)
          return `0x${String(log.length).padStart(64, '0')}`
        }
        case 'eth_getTransactionReceipt':
          log.push('receipt')
          return state.receipt ? { status: state.reverted ? '0x0' : '0x1' } : null
        default:
          throw new Error(`unexpected method ${method}`)
      }
    },
  }
}

function fakeWallet(overrides: Partial<PrivyWalletLike> = {}): PrivyWalletLike {
  return {
    address: ADDRESS,
    chainType: 'ethereum',
    getEthereumProvider: async () => fakeProvider(),
    ...overrides,
  }
}

describe('privyWallet', () => {
  beforeEach(() => {
    log.length = 0
    state.chainId = 1
    state.receipt = true
    state.reverted = false
    state.disconnected = false
    // The unit tests run with the node environment, so the browser path needs a window.
    vi.stubGlobal('window', {})
  })

  afterEach(() => vi.unstubAllGlobals())

  it('is SSR safe: no accounts, no balances and no provider call on the server', async () => {
    vi.unstubAllGlobals()
    const w = privyWallet({ wallet: () => fakeWallet() })
    expect(await w.getAccounts()).toEqual([])
    expect(await w.getBalances!([{ chain: 'eip155:1', address: ADDRESS }])).toEqual([])
    await expect(w.sendTransactions('eip155:1', [{ to: '0xaaaa', chainId: 1 }])).rejects.toThrow(/no EVM wallet is connected/)
    expect(log).toEqual([])
  })

  it('reports the one EVM address on every default chain', async () => {
    const w = privyWallet({ wallet: () => fakeWallet() })
    const accounts = await w.getAccounts()
    expect(accounts.length).toBe(DEFAULT_PRIVY_CHAINS.length)
    expect(accounts[0]).toEqual({ chain: DEFAULT_PRIVY_CHAINS[0], address: ADDRESS })
    expect(accounts.every((a) => a.address === ADDRESS)).toBe(true)
    expect(DEFAULT_PRIVY_CHAINS.length).toBeGreaterThan(3)
    expect(log).toEqual([])
  })

  it('returns no accounts without a wallet, and none for a Solana embedded wallet', async () => {
    expect(await privyWallet().getAccounts()).toEqual([])
    expect(await privyWallet({ wallet: () => undefined }).getAccounts()).toEqual([])
    expect(await privyWallet({ wallet: fakeWallet({ chainType: 'solana' }) }).getAccounts()).toEqual([])
    expect(await privyWallet({ wallet: fakeWallet({ chainType: 'ethereum' }) }).getAccounts()).not.toEqual([])
    expect(log).toEqual([])
  })

  it('honours a custom chains list, in order', async () => {
    const w = privyWallet({ wallet: fakeWallet, chains: ['eip155:8453', 'eip155:1'] })
    expect(await w.getAccounts()).toEqual([
      { chain: 'eip155:8453', address: ADDRESS },
      { chain: 'eip155:1', address: ADDRESS },
    ])
  })

  it('reads native and USDC balances; one failing read does not hide the others; unconfigured chains are skipped', async () => {
    const w = privyWallet({ wallet: fakeWallet, chains: ['eip155:1', 'eip155:8453'] })
    const balances = await w.getBalances!([
      { chain: 'eip155:1', address: BAD_ADDRESS },
      { chain: 'eip155:8453', address: ADDRESS },
      { chain: 'eip155:42161', address: ADDRESS },
    ])
    expect(balances).toContainEqual({ chain: 'eip155:8453', token: 'native', symbol: 'ETH', decimals: 18, amount: '1.5' })
    expect(balances).toContainEqual({ chain: 'eip155:8453', token: USDC['eip155:8453'], symbol: 'USDC', decimals: 6, amount: '12.345678', usd: '12.345678' })
    // The Ethereum native read failed; its USDC read still happened.
    expect(balances.find((b) => b.chain === 'eip155:1' && b.token === 'native')).toBeUndefined()
    expect(balances.find((b) => b.chain === 'eip155:1' && b.symbol === 'USDC')).toBeDefined()
    // Arbitrum is not in the configured list.
    expect(balances.some((b) => b.chain === 'eip155:42161')).toBe(false)
  })

  it('reads an extra token once, even when it repeats USDC, and skips a failing one', async () => {
    const extra = { address: '0x00000000000000000000000000000000000000aa', symbol: 'DAI', decimals: 18 }
    const w = privyWallet({
      wallet: fakeWallet,
      chains: ['eip155:8453'],
      tokens: { 'eip155:8453': [extra, { address: USDC['eip155:8453']!, symbol: 'USDC', decimals: 6 }, { address: BAD_TOKEN, symbol: 'BAD', decimals: 18 }] },
    })
    const balances = await w.getBalances!([{ chain: 'eip155:8453', address: ADDRESS }])
    expect(balances.map((b) => b.symbol)).toEqual(['ETH', 'USDC', 'DAI'])
    // USDC once, DAI, BAD
    expect(log.filter((l) => l.startsWith('call:')).length).toBe(3)
  })

  it('reports nothing for a chain with no known gas token and no known USDC', async () => {
    const w = privyWallet({ wallet: fakeWallet, chains: ['eip155:11155111'] })
    expect(await w.getBalances!([{ chain: 'eip155:11155111', address: ADDRESS }])).toEqual([])
    expect(log).toEqual([])
  })

  it('switches chain, sends in order, waits between them, and returns the last hash', async () => {
    const w = privyWallet({ wallet: fakeWallet, chains: ['eip155:8453'] })
    const res = await w.sendTransactions('eip155:8453', [
      { to: '0xaaaa', data: '0x095ea7b3', chainId: 8453 },
      { to: '0xbbbb', value: '100', chainId: 8453, gas: '60000' },
    ])
    expect(log).toEqual(['switch:8453', 'send:8453:0xaaaa:', 'receipt', 'send:8453:0xbbbb:0x64'])
    expect(res.hash).toBe(`0x${'4'.padStart(64, '0')}`)
  })

  it('stops the batch when a receipt reverted: the next transaction is not sent', async () => {
    state.reverted = true
    const w = privyWallet({ wallet: fakeWallet, chains: ['eip155:8453'] })
    await expect(
      w.sendTransactions('eip155:8453', [
        { to: '0xaaaa', data: '0x095ea7b3', chainId: 8453 },
        { to: '0xbbbb', chainId: 8453 },
      ]),
    ).rejects.toThrow(/reverted/)
    expect(log.filter((l) => l.startsWith('send:'))).toEqual(['send:8453:0xaaaa:'])
  })

  it('does not switch when already on the chain, and surfaces a rejected switch', async () => {
    state.chainId = 8453
    const w = privyWallet({ wallet: fakeWallet, chains: ['eip155:8453'] })
    await w.sendTransactions('eip155:8453', [{ to: '0xcccc', chainId: 8453 }])
    expect(log).toEqual(['send:8453:0xcccc:'])
    // The wallet does not know this chain.
    await expect(w.switchChain!(`eip155:${UNKNOWN_CHAIN_ID}`)).rejects.toThrow(/Unrecognized chain ID/)
    // Not an EVM chain at all, so no switch is attempted.
    await expect(w.switchChain!('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')).rejects.toThrow(/Not an EVM chain/)
  })

  it('waits for the last receipt when waitForLast is set', async () => {
    const w = privyWallet({ wallet: fakeWallet, chains: ['eip155:8453'], waitForLast: true })
    await w.sendTransactions('eip155:8453', [{ to: '0xdddd', chainId: 8453 }])
    expect(log).toEqual(['switch:8453', 'send:8453:0xdddd:', 'receipt'])
  })

  it('rejects a Solana transaction and an empty list', async () => {
    const w = privyWallet({ wallet: fakeWallet })
    await expect(w.sendTransactions('eip155:1', [{ kind: 'solana', type: 'transfer', to: 'x', mint: 'y', amount: '1', decimals: 6 }])).rejects.toThrow(/EVM transactions only/)
    await expect(w.sendTransactions('eip155:1', [])).rejects.toThrow(/No transactions to send/)
  })

  it('propagates a provider failure, a rejected getEthereumProvider and a receipt timeout', async () => {
    state.disconnected = true
    const w = privyWallet({ wallet: fakeWallet })
    await expect(w.sendTransactions('eip155:1', [{ to: '0xaaaa', chainId: 1 }])).rejects.toThrow(/provider disconnected/)

    const broken = privyWallet({
      wallet: { address: ADDRESS, chainType: 'ethereum', getEthereumProvider: async () => { throw new Error('no provider') } },
    })
    await expect(broken.switchChain!('eip155:1')).rejects.toThrow(/no provider/)

    state.disconnected = false
    state.receipt = false
    const slow = privyWallet({ wallet: fakeWallet, confirmTimeoutMs: 20, confirmIntervalMs: 1 })
    await expect(slow.sendTransactions('eip155:1', [{ to: '0xaaaa', chainId: 1 }, { to: '0xbbbb', chainId: 1 }])).rejects.toThrow(/no receipt/)
  })
})
