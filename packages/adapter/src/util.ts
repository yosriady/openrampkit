// Small helpers shared by the first-party adapters. Web-standard APIs only.

import { OpenRampException, isDecimal, isLegTerminal, openRampError, sameToken } from '@openrampkit/core'
import type { Asset, CryptoAsset, LegStep, PollSpec, Transition } from '@openrampkit/core'
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

/**
 * The smallest amount that still counts as `expectedBase` when it can be up to `bps` basis points
 * lower: `expected - floor(expected * bps / 10000)`, in integer base units with bigint math. The
 * tolerance rounds down, so the result never goes below the exact value. `expectedBase` is a
 * non-negative integer string and `bps` an integer (BigInt throws otherwise).
 */
export function minWithToleranceBps(expectedBase: string, bps: number): string {
  const expected = BigInt(expectedBase)
  return (expected - (expected * BigInt(bps)) / 10_000n).toString()
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
 * A `requires_action` step while the user pays in a provider page: an AWAIT poll and no surface, so
 * the UI keeps the surface of the current action.
 */
export function awaitingPayment(ref: string, poll: PollSpec): LegStep {
  return { status: 'requires_action', action: { kind: 'payment', transitions: [awaitPoll(poll)] }, ref }
}

/**
 * The `status()` answer for a provider order that was mapped to a `LegEvent` (the same mapping as the
 * webhook parser): the event without its `eventId`, with `poll` for a step that waits, and with an
 * AWAIT poll action for a `requires_action` event with no action. No event means that the provider
 * has no result yet and the user is still paying (`awaitingPayment`). It sets no state: the server
 * derives `Step.state` with `stateFor()` from `@openrampkit/core`.
 */
export function legStepFromEvent(ev: LegEvent | undefined, ref: string, poll: PollSpec): LegStep {
  if (!ev) return awaitingPayment(ref, poll)
  const { eventId: _id, ...step } = ev
  if (step.status === 'requires_action' && !step.action) return { ...step, action: { kind: 'payment', transitions: [awaitPoll(poll)] } }
  if (!isLegTerminal(step.status) && step.status !== 'requires_action' && !step.poll) return { ...step, poll }
  return step
}

/** A token that a provider delivers: a CAIP-2 chain and a token address (or `native`), with optional display data. */
export type DeliverableAsset = { chain: string; token: string; symbol?: string; decimals?: number }

/**
 * The entry of `list` that delivers `asset`: the same chain and the same token (EVM addresses compare
 * without case). Undefined when no entry matches, or when `asset` is not a concrete crypto asset.
 * Never falls back to another entry: an adapter that gets undefined must not quote (throw NO_QUOTES),
 * because a quote for another token would deliver the wrong asset.
 */
export function findDeliverAsset<T extends DeliverableAsset>(list: readonly T[], asset: Asset | undefined): T | undefined {
  if (asset?.kind !== 'crypto' || asset.chain === '*' || asset.token === '*') return undefined
  return list.find((d) => d.chain === asset.chain && sameToken(d.chain, d.token, asset.token))
}

/**
 * `findDeliverAsset`, or a NO_QUOTES error (422) when the provider does not deliver `asset`.
 * Use it in `quote()` and `start()`: the planner then shows "no quote" for this method, not a quote for another token.
 */
export function requireDeliverAsset<T extends DeliverableAsset>(list: readonly T[], asset: Asset | undefined, provider: string): T {
  const found = findDeliverAsset(list, asset)
  if (!found) {
    const what = asset?.kind === 'crypto' ? `${asset.symbol ?? asset.token} on ${asset.chain}` : 'this asset'
    throw new OpenRampException(openRampError('NO_QUOTES', { message: `${provider} does not deliver ${what}.`, recovery: 'choose_other' }), 422)
  }
  return found
}

/** The `CryptoAsset` of a deliverable asset, with `symbol` and `decimals` when known. */
export function deliverableToAsset(d: DeliverableAsset): CryptoAsset {
  return { kind: 'crypto', chain: d.chain, token: d.token, ...(d.symbol ? { symbol: d.symbol } : {}), ...(d.decimals !== undefined ? { decimals: d.decimals } : {}) }
}
