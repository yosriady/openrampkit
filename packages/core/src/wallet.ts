import type { TxRequest } from './types.js'

export type WalletBalance = { chain: string; token: string; symbol: string; decimals: number; amount: string; usd?: string }

/**
 * Browser-side wallet access. `@openrampkit/wagmi` implements it for EVM wallets (wagmi),
 * `@openrampkit/solana` for Solana wallets (Wallet Standard). `combineWallets` joins several.
 */
export interface WalletAdapter {
  id: string
  getAccounts(): Promise<Array<{ chain: string; address: string }>>
  getBalances?(accounts: Array<{ chain: string; address: string }>): Promise<WalletBalance[]>
  /** Sends the transactions in order and returns the hash (Solana: the signature) of the last one */
  sendTransactions(chain: string, txs: TxRequest[]): Promise<{ hash: string }>
  switchChain?(chain: string): Promise<void>
  /** CAIP-2 namespaces this wallet can send on, e.g. `['eip155']` or `['solana']`. Absent: any. */
  namespaces?: string[]
}

/** CAIP-2 namespace of a chain id: `eip155:8453` -> `eip155` */
export function chainNamespace(chain: string): string {
  const i = chain.indexOf(':')
  return i < 0 ? chain : chain.slice(0, i)
}

/**
 * The account for `chain` among `accounts`: the same chain first, else the same namespace
 * (an EVM account is valid on every EVM chain), else undefined.
 */
export function accountFor(accounts: Array<{ chain: string; address: string }>, chain: string): { chain: string; address: string } | undefined {
  return accounts.find((a) => a.chain === chain) ?? accounts.find((a) => chainNamespace(a.chain) === chainNamespace(chain))
}

/**
 * One WalletAdapter over several, e.g. an EVM wallet and a Solana wallet. Accounts and balances
 * are joined. A send goes to the first wallet whose `namespaces` include the chain's namespace
 * (a wallet without `namespaces` takes any chain).
 */
export function combineWallets(...wallets: WalletAdapter[]): WalletAdapter {
  const serves = (w: WalletAdapter, chain: string) => !w.namespaces || w.namespaces.includes(chainNamespace(chain))
  const pick = (chain: string) => {
    const w = wallets.find((x) => serves(x, chain))
    if (!w) throw new Error(`No wallet can send on ${chain}`)
    return w
  }
  return {
    id: wallets.map((w) => w.id).join('+'),
    namespaces: wallets.some((w) => !w.namespaces) ? undefined : [...new Set(wallets.flatMap((w) => w.namespaces ?? []))],
    async getAccounts() {
      const lists = await Promise.all(wallets.map((w) => w.getAccounts().catch(() => [])))
      return lists.flat()
    },
    async getBalances(accounts) {
      const lists = await Promise.all(
        wallets.map((w) => {
          if (!w.getBalances) return []
          const mine = accounts.filter((a) => serves(w, a.chain))
          return mine.length ? w.getBalances(mine).catch(() => []) : []
        }),
      )
      return lists.flat()
    },
    async sendTransactions(chain, txs) {
      return pick(chain).sendTransactions(chain, txs)
    },
    async switchChain(chain) {
      await pick(chain).switchChain?.(chain)
    },
  }
}
