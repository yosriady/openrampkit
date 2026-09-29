import type { TxRequest } from './types.js'

export type WalletBalance = { chain: string; token: string; symbol: string; decimals: number; amount: string; usd?: string }

/** Browser-side wallet access. `@openrampkit/wagmi` implements it for wagmi apps. */
export interface WalletAdapter {
  id: string
  getAccounts(): Promise<Array<{ chain: string; address: string }>>
  getBalances?(accounts: Array<{ chain: string; address: string }>): Promise<WalletBalance[]>
  /** Sends the transactions in order and returns the hash of the last one */
  sendTransactions(chain: string, txs: TxRequest[]): Promise<{ hash: string }>
  switchChain?(chain: string): Promise<void>
}
