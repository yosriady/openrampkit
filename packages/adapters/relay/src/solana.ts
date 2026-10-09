// Solana transactions as the adapter reads them (getTransaction with jsonParsed).

import { isNative } from './helpers.js'

export type SolTokenBalance = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }
export type SolTx = {
  blockTime?: number | null
  meta: { err: unknown; preBalances: number[]; postBalances: number[]; preTokenBalances?: SolTokenBalance[]; postTokenBalances?: SolTokenBalance[] } | null
  transaction: { message: { accountKeys: Array<string | { pubkey: string }> } }
}
export type SolStatus = { err: unknown; confirmationStatus?: 'processed' | 'confirmed' | 'finalized' | null } | null

/** Net amount (base units) that `tx` moved to `owner`: SOL lamports for `native`, else the SPL `mint` */
export function solanaReceived(tx: SolTx, chain: string, owner: string, token: string): bigint {
  const meta = tx.meta
  if (!meta) return 0n
  if (isNative(chain, token)) {
    const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey))
    const i = keys.indexOf(owner)
    return i < 0 ? 0n : BigInt(meta.postBalances[i] ?? 0) - BigInt(meta.preBalances[i] ?? 0)
  }
  // Sum the change of every token account of `mint` that `owner` owns (a new account has no pre balance).
  const mine = (b: SolTokenBalance) => b.owner === owner && b.mint === token
  const pre = new Map<number, bigint>()
  for (const b of meta.preTokenBalances ?? []) if (mine(b)) pre.set(b.accountIndex, BigInt(b.uiTokenAmount.amount))
  let total = 0n
  for (const b of meta.postTokenBalances ?? []) if (mine(b)) total += BigInt(b.uiTokenAmount.amount) - (pre.get(b.accountIndex) ?? 0n)
  return total
}
