// @openrampkit/wagmi: a WalletAdapter backed by the app's existing wagmi config.
// Browser-side. @wagmi/core and viem are peer dependencies.

import { getAccount, getBalance, readContract, sendTransaction, switchChain, waitForTransactionReceipt } from '@wagmi/core'
import type { Config } from '@wagmi/core'
import { CHAINS, USDC, evmChainId, fromBaseUnits, isSolanaTx } from '@openrampkit/core'
import type { TxRequest, WalletAdapter, WalletBalance } from '@openrampkit/core'

export type WagmiWalletOptions = {
  /** Wait for each receipt before sending the next tx (so an approve lands before the deposit). Default true. */
  waitBetweenTxs?: boolean
  /** Also wait for the last tx's receipt before returning. Default false. */
  waitForLast?: boolean
  /** Extra ERC-20 tokens to report per CAIP-2 chain, besides USDC */
  tokens?: Record<string, Array<{ address: string; symbol: string; decimals: number }>>
}

const erc20BalanceOf = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

type Hex = `0x${string}`

function chainIdOf(chain: string): number {
  const id = evmChainId(chain)
  if (id === undefined) throw new Error(`Not an EVM chain: ${chain}`)
  return id
}

export function wagmiWallet(config: Config, opts: WagmiWalletOptions = {}): WalletAdapter {
  const waitBetween = opts.waitBetweenTxs ?? true
  const configured = new Set(config.chains.map((c) => c.id))

  async function ensureChain(chainId: number) {
    const account = getAccount(config)
    if (account.chainId === chainId) return
    if (!configured.has(chainId)) throw new Error(`Chain ${chainId} is not in the wagmi config`)
    await switchChain(config, { chainId: chainId as Config['chains'][number]['id'] })
  }

  return {
    id: 'wagmi',
    namespaces: ['eip155'],

    async getAccounts() {
      const account = getAccount(config)
      if (!account.address) return []
      return config.chains.map((c) => ({ chain: `eip155:${c.id}`, address: account.address! }))
    },

    async getBalances(accounts) {
      const jobs: Array<Promise<WalletBalance | undefined>> = []
      for (const { chain, address } of accounts) {
        const chainId = evmChainId(chain)
        if (chainId === undefined || !configured.has(chainId)) continue
        const info = config.chains.find((c) => c.id === chainId)!
        const id = chainId as Config['chains'][number]['id']
        // Tempo has no native gas token: eth_getBalance returns a placeholder, not a balance.
        if (!CHAINS[chain]?.stablecoinFees) {
          jobs.push(
            getBalance(config, { address: address as Hex, chainId: id }).then((b) => ({
              chain,
              token: 'native',
              symbol: info.nativeCurrency.symbol,
              decimals: info.nativeCurrency.decimals,
              amount: fromBaseUnits(b.value.toString(), info.nativeCurrency.decimals),
            })),
          )
        }
        const tokens = [...(USDC[chain] ? [{ address: USDC[chain]!, symbol: 'USDC', decimals: 6 }] : []), ...(opts.tokens?.[chain] ?? [])]
        // An extra token that repeats USDC (or another entry) is read once.
        const seen = new Set<string>()
        for (const t of tokens) {
          if (seen.has(t.address.toLowerCase())) continue
          seen.add(t.address.toLowerCase())
          jobs.push(
            readContract(config, { address: t.address as Hex, abi: erc20BalanceOf, functionName: 'balanceOf', args: [address as Hex], chainId: id }).then((v) => ({
              chain,
              token: t.address.toLowerCase(),
              symbol: t.symbol,
              decimals: t.decimals,
              amount: fromBaseUnits((v as bigint).toString(), t.decimals),
              ...(t.symbol === 'USDC' ? { usd: fromBaseUnits((v as bigint).toString(), t.decimals) } : {}),
            })),
          )
        }
      }
      // One failing RPC must not hide the other balances.
      const settled = await Promise.allSettled(jobs)
      return settled.flatMap((s) => (s.status === 'fulfilled' && s.value ? [s.value] : []))
    },

    async switchChain(chain) {
      await ensureChain(chainIdOf(chain))
    },

    async sendTransactions(chain: string, txs: TxRequest[]) {
      if (!txs.length) throw new Error('No transactions to send')
      let hash: Hex | undefined
      for (let i = 0; i < txs.length; i++) {
        const tx = txs[i]!
        if (isSolanaTx(tx)) throw new Error('wagmiWallet sends EVM transactions only. Use @openrampkit/solana for Solana.')
        const chainId = tx.chainId || chainIdOf(chain)
        await ensureChain(chainId)
        const id = chainId as Config['chains'][number]['id']
        hash = await sendTransaction(config, {
          chainId: id,
          to: tx.to as Hex,
          ...(tx.data ? { data: tx.data as Hex } : {}),
          ...(tx.value ? { value: BigInt(tx.value) } : {}),
          ...(tx.gas ? { gas: BigInt(tx.gas) } : {}),
        })
        const last = i === txs.length - 1
        if ((!last && waitBetween) || (last && opts.waitForLast)) {
          const receipt = await waitForTransactionReceipt(config, { hash, chainId: id })
          // A reverted approve must stop the batch: the next transaction (the deposit) would fail or misbehave.
          if (receipt.status === 'reverted') throw new Error(`Transaction ${hash} reverted on chain ${chainId}. Nothing else was sent.`)
        }
      }
      return { hash: hash! }
    },
  }
}
