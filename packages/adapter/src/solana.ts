// Solana helpers for adapters that check transfers on chain over JSON-RPC (`getTransaction` with
// `jsonParsed`). Web-standard APIs only, no Solana library.

import { SOLANA_SYSTEM_PROGRAM, SPL_TOKEN_2022_PROGRAM, SPL_TOKEN_PROGRAM } from '@openrampkit/core'

/** A token balance entry of `getTransaction` (`meta.preTokenBalances` / `meta.postTokenBalances`) */
export type SolanaTokenBalance = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }

/** A `jsonParsed` instruction. Unknown programs have no `parsed` field. */
export type SolanaParsedInstruction = {
  program?: string
  programId?: string
  parsed?: { type?: string; info?: Record<string, unknown> } | string
}

/** The fields of `getTransaction` (`encoding: 'jsonParsed'`) that the checks read */
export type SolanaParsedTx = {
  slot?: number
  blockTime?: number | null
  meta: {
    err: unknown
    preBalances?: number[]
    postBalances?: number[]
    preTokenBalances?: SolanaTokenBalance[]
    postTokenBalances?: SolanaTokenBalance[]
    innerInstructions?: Array<{ index: number; instructions: SolanaParsedInstruction[] }> | null
  } | null
  transaction: { message: { accountKeys: Array<string | { pubkey: string }>; instructions: SolanaParsedInstruction[] } }
}

/** The status entry of `getSignatureStatuses` */
export type SolanaSignatureStatus = { slot?: number; err: unknown; confirmationStatus?: 'processed' | 'confirmed' | 'finalized' | null } | null

/** Every instruction of the transaction: the top-level ones, then the inner ones (CPI) */
function allInstructions(tx: SolanaParsedTx): SolanaParsedInstruction[] {
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions)
  return [...tx.transaction.message.instructions, ...inner]
}

const keyOf = (k: string | { pubkey: string }) => (typeof k === 'string' ? k : k.pubkey)

/**
 * The amount (base units) that the transfer instructions of `tx` move to `owner`:
 * - `mint: 'native'`: System Program `transfer` instructions to `owner`, in lamports.
 * - an SPL mint: SPL Token (and Token-2022) `transfer` and `transferChecked` instructions into a token
 *   account of `mint` that `owner` owns. The token accounts come from the token balances of the transaction.
 *
 * It reads the instructions, not the balance changes. Thus a transfer from the owner to itself counts
 * too (the balance does not change). Only the owner can sign such a transfer.
 */
export function solanaPaidTo(tx: SolanaParsedTx, owner: string, mint: string): bigint {
  if (!tx.meta || tx.meta.err) return 0n
  const instructions = allInstructions(tx)
  let paid = 0n
  if (mint === 'native') {
    for (const ix of instructions) {
      if (typeof ix.parsed !== 'object' || !ix.parsed) continue
      if (ix.program !== 'system' && ix.programId !== SOLANA_SYSTEM_PROGRAM) continue
      const info = ix.parsed.info ?? {}
      if ((ix.parsed.type === 'transfer' || ix.parsed.type === 'transferWithSeed') && info.destination === owner) paid += BigInt(String(info.lamports ?? 0))
    }
    return paid
  }
  const keys = tx.transaction.message.accountKeys.map(keyOf)
  const accounts = new Set<string>()
  for (const b of [...(tx.meta.preTokenBalances ?? []), ...(tx.meta.postTokenBalances ?? [])]) {
    const k = keys[b.accountIndex]
    if (k && b.owner === owner && b.mint === mint) accounts.add(k)
  }
  if (!accounts.size) return 0n
  for (const ix of instructions) {
    if (typeof ix.parsed !== 'object' || !ix.parsed) continue
    const isToken = ix.program === 'spl-token' || ix.program === 'spl-token-2022' || ix.programId === SPL_TOKEN_PROGRAM || ix.programId === SPL_TOKEN_2022_PROGRAM
    if (!isToken) continue
    const info = ix.parsed.info ?? {}
    const dest = typeof info.destination === 'string' ? info.destination : undefined
    if (!dest || !accounts.has(dest)) continue
    if (ix.parsed.type === 'transferChecked') {
      if (info.mint !== mint) continue
      const amt = (info.tokenAmount as { amount?: string } | undefined)?.amount
      paid += BigInt(amt ?? '0')
    } else if (ix.parsed.type === 'transfer') {
      paid += BigInt(String(info.amount ?? '0'))
    }
  }
  return paid
}
