// Solana transactions as the adapter reads them (getTransaction with jsonParsed).

import { solanaNetReceived } from '@openrampkit/adapter'
import { isNative } from './helpers.js'

type SolTokenBalance = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }
export type SolTx = {
  blockTime?: number | null
  meta: { err: unknown; preBalances: number[]; postBalances: number[]; preTokenBalances?: SolTokenBalance[]; postTokenBalances?: SolTokenBalance[] } | null
  transaction: { message: { accountKeys: Array<string | { pubkey: string }> } }
}
export type SolStatus = { err: unknown; confirmationStatus?: 'processed' | 'confirmed' | 'finalized' | null } | null

/** Net amount (base units) that `tx` moved to `owner`: SOL lamports for `native`, else the SPL `mint` (see `solanaNetReceived`) */
export function solanaReceived(tx: SolTx, chain: string, owner: string, token: string): bigint {
  return solanaNetReceived(tx, owner, isNative(chain, token) ? 'native' : token)
}
