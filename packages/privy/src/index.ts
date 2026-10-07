// @openrampkit/privy: a WalletAdapter for Privy embedded wallets.
// Browser-side. It calls the wallet's EIP-1193 provider, so it does not depend on a Privy SDK
// version and it also works for other embedded wallets that expose one.

import { CHAINS, USDC, evmChainId, fromBaseUnits, isEvmChain, isSolanaTx } from '@openrampkit/core'
import type { TxRequest, WalletAdapter, WalletBalance } from '@openrampkit/core'

/** The EIP-1193 `request` method. `getEthereumProvider()` on a Privy wallet returns this shape. */
export type Eip1193Provider = {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>
}

/**
 * The part of a Privy wallet this adapter uses. `useWallets()` from `@privy-io/react-auth`
 * returns EVM embedded wallets of this shape.
 */
export type PrivyWalletLike = {
  address: string
  /** Privy sets `ethereum` for an EVM embedded wallet and `solana` for a Solana one. */
  chainType?: string
  getEthereumProvider(): Promise<Eip1193Provider>
}

export type PrivyWalletOptions = {
  /**
   * The Privy wallet to use, or a function that returns it (read at each call).
   * Pass `() => wallets[0]` so a wallet connected after the modal opens is picked up.
   */
  wallet?: PrivyWalletLike | (() => PrivyWalletLike | undefined)
  /** CAIP-2 chains that report the one EVM address. Default: `DEFAULT_PRIVY_CHAINS`. */
  chains?: string[]
  /** Extra ERC-20 tokens to report per CAIP-2 chain, besides USDC */
  tokens?: Record<string, Array<{ address: string; symbol: string; decimals: number }>>
  /** Wait for each receipt before sending the next tx (so an approve lands before the deposit). Default true. */
  waitBetweenTxs?: boolean
  /** Also wait for the last tx's receipt before returning. Default false. */
  waitForLast?: boolean
  /** How long to wait for a receipt, in ms. Default 60000. */
  confirmTimeoutMs?: number
  /** How often to check for a receipt, in ms. Default 1000. */
  confirmIntervalMs?: number
}

/** The CAIP-2 EVM mainnet chains that have a USDC address in `@openrampkit/core`. */
export const DEFAULT_PRIVY_CHAINS: string[] = Object.keys(CHAINS).filter(
  (chain) => isEvmChain(chain) && !CHAINS[chain]?.testnet && Boolean(USDC[chain]),
)

/** The ERC-20 `balanceOf(address)` selector, keccak256("balanceOf(address)")[0..4] */
const BALANCE_OF = '0x70a08231'

/** A 20-byte address as the 32-byte word an ABI call expects */
function paddedAddress(address: string): string {
  return address.toLowerCase().replace(/^0x/, '').padStart(64, '0')
}

/** A decimal string or bigint as a hex quantity, e.g. ('60000') -> '0xea60' */
function toQuantity(value: bigint | string): string {
  return `0x${BigInt(value).toString(16)}`
}

/** A hex quantity from the provider as a bigint. `0x` means zero. */
function asBigInt(value: unknown, what: string): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value))
  if (typeof value === 'string') {
    if (value === '0x' || value === '') return 0n
    return BigInt(value)
  }
  throw new Error(`Privy wallet: expected a hex value for ${what}, got ${String(value)}`)
}

function chainIdOf(chain: string): number {
  const id = evmChainId(chain)
  if (id === undefined) throw new Error(`Not an EVM chain: ${chain}`)
  return id
}

export function privyWallet(opts: PrivyWalletOptions = {}): WalletAdapter {
  const chains = opts.chains ?? DEFAULT_PRIVY_CHAINS
  const waitBetween = opts.waitBetweenTxs ?? true
  const timeoutMs = opts.confirmTimeoutMs ?? 60_000
  const intervalMs = opts.confirmIntervalMs ?? 1_000

  /**
   * The wallet, when it is an EVM wallet and the code runs in a browser.
   * `undefined` on the server and with no wallet, so every call is safe to make during SSR.
   */
  function ethereumWallet(): PrivyWalletLike | undefined {
    if (typeof window === 'undefined') return undefined
    const wallet = typeof opts.wallet === 'function' ? opts.wallet() : opts.wallet
    if (!wallet) return undefined
    if (wallet.chainType && wallet.chainType !== 'ethereum') return undefined
    return wallet
  }

  async function providerOf(): Promise<Eip1193Provider> {
    const wallet = ethereumWallet()
    if (!wallet) throw new Error('Privy wallet: no EVM wallet is connected')
    return wallet.getEthereumProvider()
  }

  async function ensureChain(provider: Eip1193Provider, chainId: number): Promise<void> {
    const current = Number(asBigInt(await provider.request({ method: 'eth_chainId' }), 'eth_chainId'))
    if (current === chainId) return
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: toQuantity(BigInt(chainId)) }] })
  }

  async function waitForReceipt(provider: Eip1193Provider, hash: string): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [hash] })
      if (receipt !== null && receipt !== undefined) return
      if (Date.now() >= deadline) throw new Error(`Privy wallet: no receipt for ${hash} after ${timeoutMs} ms`)
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }

  /** ERC-20 `balanceOf(owner)` through `eth_call` */
  async function erc20Balance(provider: Eip1193Provider, token: string, owner: string): Promise<bigint> {
    const value = await provider.request({ method: 'eth_call', params: [{ to: token, data: `${BALANCE_OF}${paddedAddress(owner)}` }, 'latest'] })
    return asBigInt(value, 'eth_call')
  }

  return {
    id: 'privy',
    namespaces: ['eip155'],

    async getAccounts() {
      const wallet = ethereumWallet()
      if (!wallet) return []
      return chains.map((chain) => ({ chain, address: wallet.address }))
    },

    async getBalances(accounts) {
      const wallet = ethereumWallet()
      if (!wallet) return []
      const provider = await wallet.getEthereumProvider()
      const jobs: Array<Promise<WalletBalance | undefined>> = []
      for (const { chain, address } of accounts) {
        const chainId = evmChainId(chain)
        if (chainId === undefined || !chains.includes(chain)) continue
        const info = CHAINS[chain]
        // Tempo has no native gas token: eth_getBalance returns a placeholder, not a balance.
        // A chain outside the CHAINS table has no known gas token, so its native balance is not read.
        if (info && !info.stablecoinFees) {
          const decimals = info.nativeDecimals ?? 18
          jobs.push(
            provider.request({ method: 'eth_getBalance', params: [address, 'latest'] }).then((value) => ({
              chain,
              token: 'native',
              symbol: info.nativeSymbol,
              decimals,
              amount: fromBaseUnits(asBigInt(value, 'eth_getBalance').toString(), decimals),
            })),
          )
        }
        const tokens = [...(USDC[chain] ? [{ address: USDC[chain]!, symbol: 'USDC', decimals: 6 }] : []), ...(opts.tokens?.[chain] ?? [])]
        // An extra token that repeats USDC (or another entry) is read once.
        const seen = new Set<string>()
        for (const token of tokens) {
          if (seen.has(token.address.toLowerCase())) continue
          seen.add(token.address.toLowerCase())
          jobs.push(
            erc20Balance(provider, token.address, address).then((value) => ({
              chain,
              token: token.address.toLowerCase(),
              symbol: token.symbol,
              decimals: token.decimals,
              amount: fromBaseUnits(value.toString(), token.decimals),
              ...(token.symbol === 'USDC' ? { usd: fromBaseUnits(value.toString(), token.decimals) } : {}),
            })),
          )
        }
      }
      // One failing RPC must not hide the other balances.
      const settled = await Promise.allSettled(jobs)
      return settled.flatMap((s) => (s.status === 'fulfilled' && s.value ? [s.value] : []))
    },

    async switchChain(chain) {
      await ensureChain(await providerOf(), chainIdOf(chain))
    },

    async sendTransactions(chain: string, txs: TxRequest[]) {
      if (!txs.length) throw new Error('No transactions to send')
      const wallet = ethereumWallet()
      if (!wallet) throw new Error('Privy wallet: no EVM wallet is connected')
      const provider = await wallet.getEthereumProvider()
      let hash: string | undefined
      for (let i = 0; i < txs.length; i++) {
        const tx = txs[i]!
        if (isSolanaTx(tx)) throw new Error('privyWallet sends EVM transactions only. Use @openrampkit/solana for Solana.')
        const chainId = tx.chainId || chainIdOf(chain)
        await ensureChain(provider, chainId)
        hash = String(
          await provider.request({
            method: 'eth_sendTransaction',
            params: [
              {
                from: wallet.address,
                to: tx.to,
                ...(tx.data ? { data: tx.data } : {}),
                ...(tx.value ? { value: toQuantity(tx.value) } : {}),
                ...(tx.gas ? { gas: toQuantity(tx.gas) } : {}),
              },
            ],
          }),
        )
        const last = i === txs.length - 1
        if ((!last && waitBetween) || (last && opts.waitForLast)) {
          await waitForReceipt(provider, hash)
        }
      }
      return { hash: hash! }
    },
  }
}
