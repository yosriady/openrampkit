// Solana helpers that need no Solana library: address and signature formats, SPL amounts.

import { fromBaseUnits, isDecimal } from './money.js'

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/

/** Decimals of SOL (1 SOL = 10^9 lamports) */
export const SOLANA_NATIVE_DECIMALS = 9
/** The System Program id. Relay uses it as the currency address of native SOL. */
export const SOLANA_SYSTEM_PROGRAM = '11111111111111111111111111111111'
/** SPL Token program */
export const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
/** SPL Token-2022 program */
export const SPL_TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
/** Associated Token Account program */
export const SPL_ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'

const U64_MAX = (1n << 64n) - 1n

/** True when `value` looks like a Solana address (base58, 32 to 44 characters). It does not check the curve. */
export function isSolanaAddress(value: string): boolean {
  return value.length >= 32 && value.length <= 44 && BASE58.test(value)
}

/** True when `value` looks like a Solana transaction signature (base58 of 64 bytes: 64 to 88 characters). */
export function isSolanaSignature(value: string): boolean {
  return value.length >= 64 && value.length <= 88 && BASE58.test(value)
}

/**
 * Decimal amount to SPL base units, e.g. ('12.5', 6) -> '12500000'.
 * Strict: it throws when the amount is negative, has more fraction digits than `decimals`,
 * or does not fit in a u64 (the SPL amount type). `toBaseUnits` truncates instead.
 */
export function toSplAmount(value: string, decimals: number): string {
  if (!isDecimal(value) || value.startsWith('-')) throw new Error(`Invalid SPL amount: ${value}`)
  const [int = '0', frac = ''] = value.split('.')
  if (frac.replace(/0+$/, '').length > decimals) throw new Error(`${value} has more than ${decimals} decimals`)
  const base = BigInt(int + frac.padEnd(decimals, '0').slice(0, decimals))
  if (base > U64_MAX) throw new Error(`${value} is too large for an SPL amount`)
  return base.toString()
}

/** SPL base units (a u64 as a decimal string, or a bigint) to a decimal string, e.g. ('12500000', 6) -> '12.5' */
export function fromSplAmount(base: string | bigint, decimals: number): string {
  const v = typeof base === 'bigint' ? base : BigInt(base)
  if (v < 0n || v > U64_MAX) throw new Error(`Invalid SPL amount: ${String(base)}`)
  return fromBaseUnits(v.toString(), decimals)
}

/** Lamports to SOL, e.g. 1500000000 -> '1.5' */
export function lamportsToSol(lamports: string | bigint | number): string {
  return fromSplAmount(BigInt(lamports), SOLANA_NATIVE_DECIMALS)
}

/** SOL to lamports, e.g. '1.5' -> '1500000000' */
export function solToLamports(sol: string): string {
  return toSplAmount(sol, SOLANA_NATIVE_DECIMALS)
}
