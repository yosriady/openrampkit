// Small helpers shared by the first-party adapters. Web-standard APIs only.

import { isDecimal } from '@openrampkit/core'
import type { LegStep, PollSpec, Transition } from '@openrampkit/core'
import type { LegEvent } from './index.js'

/**
 * Poll schedules for AWAIT transitions.
 * - `onchain`: bridges and swaps that settle in seconds to minutes
 * - `checkout`: hosted provider checkouts (card, bank, KYC) that take minutes to an hour
 * - `dev`: mock and local development
 */
export const POLL = {
  onchain: { intervalMs: 2500, backoff: 1.2, maxIntervalMs: 10_000, giveUpAfterMs: 30 * 60_000 },
  checkout: { intervalMs: 4000, backoff: 1.2, maxIntervalMs: 15_000, giveUpAfterMs: 60 * 60_000 },
  dev: { intervalMs: 1500, backoff: 1.1, maxIntervalMs: 5000, giveUpAfterMs: 15 * 60_000 },
} as const satisfies Record<string, PollSpec>

/** An AWAIT transition named `poll` (or `name`) */
export function awaitPoll(poll: PollSpec, name = 'poll'): Transition {
  return { name, kind: 'AWAIT', poll }
}

/** Lowercase hex of `bytes`, two digits per byte, no `0x` */
export function bytesToHex(bytes: Uint8Array | ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

/** Standard base64 to bytes. Whitespace is ignored. Throws on characters that are not base64. */
export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64.replace(/\s+/g, ''))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Bytes to standard base64 (with padding) */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** Hex string of `bytes` random bytes (WebCrypto) */
export function randomHex(bytes = 8): string {
  const b = new Uint8Array(bytes)
  crypto.getRandomValues(b)
  return bytesToHex(b)
}

/**
 * A JSON number (or numeric string) from a provider -> exact decimal string, at most `digits`
 * fraction digits, no exponent. Missing or non-finite values give '0'.
 */
export function decimalFrom(n: number | string | undefined | null, digits = 8): string {
  if (n === undefined || n === null) return '0'
  if (typeof n === 'string') return isDecimal(n) ? n : decimalFrom(Number(n), digits)
  if (!Number.isFinite(n)) return '0'
  const s = n.toFixed(digits)
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}

/**
 * The LegStep for a provider order status that was mapped to a LegEvent (by a webhook parser
 * or a status poll). No event means the user is still paying: PAYMENT, awaiting_user.
 */
export function legStepFromEvent(ev: LegEvent | undefined, ref: string, poll: PollSpec): LegStep {
  const extra = { ref, ...(ev?.txHash ? { txHash: ev.txHash } : {}), ...(ev?.output ? { output: ev.output } : {}) }
  switch (ev?.status) {
    case undefined:
    case 'pending':
    case 'awaiting_user':
      return {
        state: 'PAYMENT',
        status: 'awaiting_user',
        transitions: ev?.surface && ev.transitions ? ev.transitions : [awaitPoll(poll)],
        ref,
        ...(ev?.surface ? { surface: ev.surface } : {}),
      }
    case 'succeeded':
      return { state: 'COMPLETED', status: 'succeeded', transitions: [], ...extra }
    case 'failed':
      return { state: 'FAILED', status: 'failed', transitions: [], ...extra, ...(ev.error ? { error: ev.error } : {}) }
    case 'refunded':
      return { state: 'REFUNDED', status: 'refunded', transitions: [], ...extra }
    case 'expired':
      return { state: 'EXPIRED', status: 'expired', transitions: [], ...extra }
    default:
      return { state: 'PROCESSING', status: 'processing', transitions: [awaitPoll(poll)], ...extra }
  }
}
