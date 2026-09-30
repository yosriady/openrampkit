import { describe, expect, it } from 'vitest'
import {
  CHAINS,
  SOLANA_DEVNET,
  SOLANA_DEVNET_USDC_MINT,
  SOLANA_MAINNET,
  SOLANA_USDC_MINT,
  TEMPO_MAINNET,
  TEMPO_TESTNET,
  TEMPO_USDC,
  USDC,
  accountFor,
  chainNamespace,
  combineWallets,
  destinationEndpoint,
  evmChainId,
  fromSplAmount,
  isEvmTx,
  isSolanaAddress,
  isSolanaChain,
  isSolanaSignature,
  isSolanaTx,
  isUsdc,
  lamportsToSol,
  nativeDecimals,
  normalizeToken,
  planPathways,
  sameToken,
  solToLamports,
  toSplAmount,
  withdrawSourceEndpoint,
} from './index.js'
import type { LegSpec, TxRequest, WalletAdapter } from './index.js'

describe('Solana and Tempo metadata', () => {
  it('knows Solana mainnet and devnet, and Tempo mainnet and testnet', () => {
    expect(CHAINS[SOLANA_MAINNET]).toMatchObject({ name: 'Solana', nativeSymbol: 'SOL', nativeDecimals: 9 })
    expect(CHAINS[SOLANA_DEVNET]).toMatchObject({ name: 'Solana Devnet', testnet: true })
    expect(CHAINS[TEMPO_MAINNET]).toMatchObject({ chainId: 4217, name: 'Tempo', stablecoinFees: true })
    expect(CHAINS[TEMPO_TESTNET]).toMatchObject({ chainId: 42431, testnet: true, stablecoinFees: true })
    expect(evmChainId(TEMPO_MAINNET)).toBe(4217)
    expect(nativeDecimals(SOLANA_MAINNET)).toBe(9)
    expect(nativeDecimals('solana:unknown')).toBe(9)
    expect(nativeDecimals('eip155:4217')).toBe(18)
    expect(nativeDecimals('eip155:77777')).toBe(18)
    expect(isSolanaChain(SOLANA_DEVNET)).toBe(true)
    expect(chainNamespace(SOLANA_MAINNET)).toBe('solana')
    expect(chainNamespace('plain')).toBe('plain')
  })

  it('USDC on Solana keeps the case of its mint; testnet USDC stays out of USDC', () => {
    expect(USDC[SOLANA_MAINNET]).toBe(SOLANA_USDC_MINT)
    expect(USDC[TEMPO_MAINNET]).toBe(TEMPO_USDC)
    expect(USDC[SOLANA_DEVNET]).toBeUndefined()
    expect(isUsdc(SOLANA_MAINNET, SOLANA_USDC_MINT)).toBe(true)
    expect(isUsdc(SOLANA_MAINNET, SOLANA_USDC_MINT.toLowerCase())).toBe(false)
    expect(isUsdc(SOLANA_DEVNET, SOLANA_DEVNET_USDC_MINT)).toBe(true)
    expect(isUsdc('eip155:8453', USDC['eip155:8453']!.toUpperCase().replace('0X', '0x'))).toBe(true)
    expect(isUsdc('eip155:56', '0x1')).toBe(false)
  })

  it('normalizes tokens per chain: EVM lowercased, Solana as given', () => {
    expect(normalizeToken('eip155:1', '0xABCDEF')).toBe('0xabcdef')
    expect(normalizeToken(SOLANA_MAINNET, SOLANA_USDC_MINT)).toBe(SOLANA_USDC_MINT)
    expect(normalizeToken(SOLANA_MAINNET, 'NATIVE')).toBe('native')
    expect(sameToken('eip155:1', '0xAB', '0xab')).toBe(true)
    expect(sameToken(SOLANA_MAINNET, 'Ab', 'ab')).toBe(false)
  })
})

describe('Solana formats and SPL amounts', () => {
  it('checks addresses and signatures by format', () => {
    expect(isSolanaAddress(SOLANA_USDC_MINT)).toBe(true)
    expect(isSolanaAddress('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')).toBe(false)
    expect(isSolanaAddress('short')).toBe(false)
    expect(isSolanaAddress('O'.repeat(40))).toBe(false) // O is not base58
    expect(isSolanaSignature('5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW')).toBe(true)
    expect(isSolanaSignature(`0x${'ab'.repeat(32)}`)).toBe(false)
  })

  it('converts SPL amounts strictly', () => {
    expect(toSplAmount('12.5', 6)).toBe('12500000')
    expect(toSplAmount('12.500000', 6)).toBe('12500000')
    expect(toSplAmount('0', 6)).toBe('0')
    expect(() => toSplAmount('0.0000001', 6)).toThrow(/more than 6 decimals/)
    expect(() => toSplAmount('-1', 6)).toThrow(/Invalid SPL amount/)
    expect(() => toSplAmount('abc', 6)).toThrow(/Invalid SPL amount/)
    expect(() => toSplAmount('18446744073709551616', 0)).toThrow(/too large/)
    expect(toSplAmount('18446744073709551615', 0)).toBe('18446744073709551615')
    expect(fromSplAmount('12500000', 6)).toBe('12.5')
    expect(fromSplAmount(1n, 6)).toBe('0.000001')
    expect(() => fromSplAmount(-1n, 6)).toThrow(/Invalid SPL amount/)
    expect(lamportsToSol(1_500_000_000)).toBe('1.5')
    expect(solToLamports('0.000000001')).toBe('1')
  })

  it('tells Solana and EVM tx requests apart', () => {
    const evm: TxRequest = { to: '0x1', chainId: 1 }
    const sol: TxRequest = { kind: 'solana', type: 'transfer', to: SOLANA_USDC_MINT, mint: 'native', amount: '1', decimals: 9 }
    expect([isSolanaTx(evm), isEvmTx(evm), isSolanaTx(sol), isEvmTx(sol)]).toEqual([false, true, true, false])
  })
})

describe('planner with Solana tokens', () => {
  const spec = (to: LegSpec['to']): LegSpec => ({
    id: 'x', kind: 'bridge_swap', methods: ['wallet'],
    from: { asset: { kind: 'crypto', chains: '*' }, location: ['user_wallet'] },
    to, regions: { allow: ['*'], deny: [] }, eta: { min: 1, max: 2 }, surfaces: ['WALLET_TX'],
  })

  it('keeps the mint case in endpoints and matches leg specs exactly', () => {
    const dest = { type: 'crypto' as const, chain: SOLANA_MAINNET, token: SOLANA_USDC_MINT, address: 'x' }
    expect(destinationEndpoint(dest).asset).toMatchObject({ token: SOLANA_USDC_MINT })
    expect(withdrawSourceEndpoint({ chain: SOLANA_MAINNET, token: SOLANA_USDC_MINT, custody: 'user_wallet' }).asset).toMatchObject({ token: SOLANA_USDC_MINT })
    expect(withdrawSourceEndpoint({ chain: 'eip155:1', token: '0xABC', custody: 'user_wallet' }).asset).toMatchObject({ token: '0xabc' })
    const match = planPathways({ direction: 'deposit', destination: dest, user: { walletConnected: true }, legs: [{ adapterId: 'a', provider: 'A', spec: spec({ asset: { kind: 'crypto', chains: { [SOLANA_MAINNET]: [SOLANA_USDC_MINT] } }, location: ['address'] }) }] })
    expect(match.pathways).toHaveLength(1)
    const lower = planPathways({ direction: 'deposit', destination: dest, user: { walletConnected: true }, legs: [{ adapterId: 'a', provider: 'A', spec: spec({ asset: { kind: 'crypto', chains: { [SOLANA_MAINNET]: [SOLANA_USDC_MINT.toLowerCase()] } }, location: ['address'] }) }] })
    expect(lower.pathways).toHaveLength(0)
  })
})

describe('combineWallets', () => {
  const log: string[] = []
  const make = (id: string, chain: string, namespaces?: string[]): WalletAdapter => ({
    id,
    ...(namespaces ? { namespaces } : {}),
    getAccounts: async () => [{ chain, address: `${id}-addr` }],
    getBalances: async (accounts) => accounts.map((a) => ({ chain: a.chain, token: 'native', symbol: id, decimals: 1, amount: '1' })),
    sendTransactions: async (c) => {
      log.push(`${id}:${c}`)
      return { hash: `${id}-hash` }
    },
    switchChain: async (c) => void log.push(`switch:${id}:${c}`),
  })

  it('joins accounts and balances and routes sends by namespace', async () => {
    const evm = make('evm', 'eip155:8453', ['eip155'])
    const sol = make('sol', SOLANA_MAINNET, ['solana'])
    const both = combineWallets(evm, sol)
    expect(both.id).toBe('evm+sol')
    expect(both.namespaces).toEqual(['eip155', 'solana'])
    const accounts = await both.getAccounts()
    expect(accounts).toEqual([{ chain: 'eip155:8453', address: 'evm-addr' }, { chain: SOLANA_MAINNET, address: 'sol-addr' }])
    expect((await both.getBalances!(accounts)).map((b) => b.symbol)).toEqual(['evm', 'sol'])
    expect(await both.sendTransactions(SOLANA_MAINNET, [])).toEqual({ hash: 'sol-hash' })
    expect(await both.sendTransactions('eip155:1', [])).toEqual({ hash: 'evm-hash' })
    await both.switchChain!('eip155:10')
    expect(log).toEqual([`sol:${SOLANA_MAINNET}`, 'evm:eip155:1', 'switch:evm:eip155:10'])
    await expect(both.sendTransactions('bip122:x', [])).rejects.toThrow(/No wallet can send on bip122:x/)
    expect(accountFor(accounts, 'eip155:10')).toEqual({ chain: 'eip155:8453', address: 'evm-addr' })
    expect(accountFor(accounts, SOLANA_MAINNET)?.address).toBe('sol-addr')
    expect(accountFor(accounts, 'bip122:x')).toBeUndefined()
  })

  it('a wallet without namespaces takes any chain; a failing wallet does not hide the others', async () => {
    const any = make('any', 'eip155:1')
    const broken: WalletAdapter = { id: 'broken', namespaces: ['solana'], getAccounts: async () => { throw new Error('x') }, sendTransactions: async () => ({ hash: '' }) }
    const w = combineWallets(broken, any)
    expect(w.namespaces).toBeUndefined()
    expect(await w.getAccounts()).toEqual([{ chain: 'eip155:1', address: 'any-addr' }])
    expect(await w.sendTransactions('cosmos:hub', [])).toEqual({ hash: 'any-hash' })
    expect(await w.getBalances!([{ chain: SOLANA_MAINNET, address: 'x' }])).toHaveLength(1)
  })
})
