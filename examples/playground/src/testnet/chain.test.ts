import { describe, expect, it, vi } from 'vitest'
import { buildSettlementTxs, sessionIdToBytes32 } from '@openrampkit/adapter'
import type { WalletAdapter } from '@openrampkit/core'
import { approveAmount, friendlyWalletError, guardWallet, isSettledData, mintData, settleSessionId, settleSessionWord, vaultDepositData } from './chain.js'
import type { GuardOptions } from './chain.js'
import { DEFAULT_NETWORKS, testnetBanner, testnetNetworks, txLinks } from './config.js'

const ME = '0x1111111111111111111111111111111111111111'
const TOKEN = '0x9a38c55160186c3e1e770e193fa96997e60ed425'
const SETTLEMENT = '0xbf66696115128b8f9f794780061348b4213a7132'
const CHAIN = 'eip155:421614'
const ctx = { chainName: 'Arbitrum Sepolia', symbol: 'tUSDC' }

const txsFor = (sessionId: string, amount = 5_000_000n) =>
  buildSettlementTxs({ chainId: 421614, contract: SETTLEMENT, sessionId, token: TOKEN, amount, recipient: ME })

describe('testnet calldata', () => {
  it('encodes mint, vault deposit and isSettled', () => {
    expect(mintData(ME, 100_000_000n)).toBe(`0x40c10f19${'0'.repeat(24)}${ME.slice(2)}${(100_000_000n).toString(16).padStart(64, '0')}`)
    expect(vaultDepositData(5_000_000n, ME)).toBe(`0x6e553f65${(5_000_000n).toString(16).padStart(64, '0')}${'0'.repeat(24)}${ME.slice(2)}`)
    expect(isSettledData(sessionIdToBytes32('ors_abc'))).toBe(`0xbd07f3c9${sessionIdToBytes32('ors_abc').slice(2)}`)
  })

  it('reads the approve amount and the session id of the settle call that buildSettlementTxs makes', () => {
    const [approve, settle] = txsFor('ors_0123456789abcdef01234567', 7_500_000n)
    expect(approveAmount(approve!.data)).toBe(7_500_000n)
    expect(approveAmount(settle!.data)).toBeUndefined()
    expect(settleSessionId(settle!.data)).toBe('ors_0123456789abcdef01234567')
    expect(settleSessionWord(settle!.data)).toBe(sessionIdToBytes32('ors_0123456789abcdef01234567'))
    expect(settleSessionId(approve!.data)).toBeUndefined()
    expect(settleSessionId(undefined)).toBeUndefined()
  })
})

describe('friendlyWalletError', () => {
  it('names a rejected request, also when viem wraps it', () => {
    const wrapped = { name: 'TransactionExecutionError', shortMessage: 'User rejected the request.', cause: { name: 'UserRejectedRequestError', code: 4001, message: 'User rejected the request.\n\nDetails: MetaMask Tx Signature: User denied transaction signature.' } }
    expect(friendlyWalletError(wrapped, ctx)).toBe('You rejected the request in your wallet. Nothing was sent.')
    expect(friendlyWalletError({ code: 4001, message: 'x' }, ctx)).toMatch(/rejected/)
  })

  it('names an unknown chain, a chain switch, gas, a settled session and a low token balance', () => {
    expect(friendlyWalletError({ code: 4902, message: 'Unrecognized chain ID' }, ctx)).toMatch(/does not know Arbitrum Sepolia/)
    expect(friendlyWalletError({ name: 'SwitchChainError', message: 'An error occurred when attempting to switch chain.' }, ctx)).toBe('Switch your wallet to Arbitrum Sepolia, then try again.')
    expect(friendlyWalletError(new Error('insufficient funds for gas * price + value'), ctx)).toMatch(/Not enough test ETH for gas on Arbitrum Sepolia/)
    // Tempo has no gas token: the node says "gas required exceeds allowance (0)" when the fee token balance is 0.
    const tempo = { chainName: 'Tempo Testnet', feeToken: { symbol: 'pathUSD', faucet: 'https://docs.tempo.xyz/quickstart/faucet' } }
    expect(friendlyWalletError(new Error('gas required exceeds allowance (0)'), tempo)).toBe('Not enough pathUSD for fees on Tempo Testnet. Get pathUSD at https://docs.tempo.xyz/quickstart/faucet, then try again.')
    expect(friendlyWalletError({ shortMessage: 'Execution reverted with reason: AlreadySettled(bytes32)' }, ctx)).toMatch(/already settled/)
    expect(friendlyWalletError({ message: 'reverted', data: '0xb196a44a6f72735f' }, ctx)).toMatch(/already settled/)
    expect(friendlyWalletError({ message: 'execution reverted: 0xe450d38c...' }, ctx)).toBe('Not enough tUSDC in your wallet for this amount.')
  })

  it('falls back to the first line of the short message', () => {
    expect(friendlyWalletError({ shortMessage: 'Something odd.\nMore lines', message: 'long' }, ctx)).toBe('Something odd.')
    expect(friendlyWalletError(undefined, ctx)).toBe('The wallet could not send the transaction.')
  })
})

describe('guardWallet', () => {
  function setup(o: { balance?: bigint; settled?: boolean; send?: WalletAdapter['sendTransactions'] } = {}) {
    const send = vi.fn(o.send ?? (async () => ({ hash: `0x${'ab'.repeat(32)}` })))
    const base: WalletAdapter = {
      id: 'wagmi',
      namespaces: ['eip155'],
      getAccounts: async () => [{ chain: 'eip155:1', address: ME }, { chain: CHAIN, address: ME }],
      getBalances: async () => [
        { chain: CHAIN, token: 'native', symbol: 'ETH', decimals: 18, amount: '1' },
        { chain: CHAIN, token: '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d', symbol: 'USDC', decimals: 6, amount: '20' },
        { chain: CHAIN, token: TOKEN, symbol: 'USDC', decimals: 6, amount: '100' },
      ],
      sendTransactions: send,
    }
    const isSettled = vi.fn(async () => o.settled ?? false)
    const g: GuardOptions = {
      chain: CHAIN,
      chainName: 'Arbitrum Sepolia',
      settlement: SETTLEMENT,
      token: { address: TOKEN, symbol: 'tUSDC', decimals: 6 },
      readBalance: async () => o.balance ?? 100_000_000n,
      isSettled,
      topUpHint: 'Press "Mint".',
    }
    return { wallet: guardWallet(base, g), send, isSettled }
  }

  it('reports only the chosen token on the network, with its testnet symbol', async () => {
    const { wallet } = setup()
    expect(await wallet.getAccounts()).toEqual([{ chain: CHAIN, address: ME }])
    expect(await wallet.getBalances!([{ chain: CHAIN, address: ME }])).toEqual([{ chain: CHAIN, token: TOKEN, symbol: 'tUSDC', decimals: 6, amount: '100' }])
  })

  it('sends approve + settle when the balance is enough and the session is open', async () => {
    const { wallet, send, isSettled } = setup()
    const txs = txsFor('ors_open')
    await expect(wallet.sendTransactions(CHAIN, txs)).resolves.toEqual({ hash: `0x${'ab'.repeat(32)}` })
    expect(send).toHaveBeenCalledWith(CHAIN, txs)
    expect(isSettled).toHaveBeenCalledWith(sessionIdToBytes32('ors_open'))
  })

  it('stops before the wallet opens when the balance is too low', async () => {
    const { wallet, send } = setup({ balance: 1_000_000n })
    await expect(wallet.sendTransactions(CHAIN, txsFor('ors_low'))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Not enough tUSDC. You have 1, and this payment needs 5. Press "Mint".',
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('stops when the session already settled on chain', async () => {
    const { wallet, send } = setup({ settled: true })
    await expect(wallet.sendTransactions(CHAIN, txsFor('ors_done'))).rejects.toMatchObject({ message: /already settled on chain/ })
    expect(send).not.toHaveBeenCalled()
  })

  it('turns a rejected transaction into a short message', async () => {
    const { wallet } = setup({ send: async () => Promise.reject({ shortMessage: 'User rejected the request.', cause: { code: 4001 } }) })
    await expect(wallet.sendTransactions(CHAIN, txsFor('ors_rej'))).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'You rejected the request in your wallet. Nothing was sent.' })
  })
})

describe('testnet config', () => {
  it('links a transaction on Arbiscan and Blockscout, and labels the network', () => {
    const arb = DEFAULT_NETWORKS[0]!
    expect(txLinks(arb, '0xabc')).toEqual([
      { name: 'Arbiscan', href: 'https://sepolia.arbiscan.io/tx/0xabc' },
      { name: 'Blockscout', href: 'https://arbitrum-sepolia.blockscout.com/tx/0xabc' },
    ])
    expect(testnetBanner(arb)).toBe('Testnet: real transactions on Arbitrum Sepolia, test tokens with no value.')
  })

  it('uses the public testnets without an override; the Circle USDC has no vault', () => {
    expect(testnetNetworks()).toBe(DEFAULT_NETWORKS)
    expect(DEFAULT_NETWORKS.map((n) => n.chainId)).toEqual([421614, 46630, 42431])
    const tempo = DEFAULT_NETWORKS.find((n) => n.key === 'tempo-testnet')!
    expect(tempo.feeToken?.symbol).toBe('pathUSD')
    expect(tempo.tokens.find((t) => t.key === 'alphausd')?.address).toBe('0x20c0000000000000000000000000000000000001')
    const usdc = DEFAULT_NETWORKS[0]!.tokens.find((t) => t.key === 'usdc')!
    expect(usdc).toMatchObject({ faucet: 'https://faucet.circle.com/' })
    expect(usdc.vault).toBeUndefined()
    expect(DEFAULT_NETWORKS.every((n) => n.tokens.find((t) => t.key === 'test')?.mint)).toBe(true)
  })
})
