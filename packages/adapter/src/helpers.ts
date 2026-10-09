// Shared helpers for adapter authors: quote expiry, provider status tables, timestamped HMAC
// webhook signatures, and a cache for provider catalogs. Web-standard APIs only.

import { timingSafeEqual } from '@openrampkit/core'
import type { Logger, ScopedKV } from './index.js'
import { bytesToBase64, bytesToHex } from './util.js'

// ---------------- quote expiry ----------------

/** The quote lifetime that `quoteExpiresAt` uses when the adapter gives none: 5 minutes */
export const DEFAULT_QUOTE_TTL_MINUTES = 5

/**
 * The `expiresAt` of a quote, as an ISO 8601 string. Every `LegQuote` must have one.
 * - `provider`: the expiry that the provider gave (an ISO string, or milliseconds since 1970). It is
 *   used when it is a valid time in the future and not later than `minutes` from now.
 * - Else: `minutes` from now (default `DEFAULT_QUOTE_TTL_MINUTES`).
 */
export function quoteExpiresAt(minutes: number = DEFAULT_QUOTE_TTL_MINUTES, provider?: string | number | null): string {
  const now = Date.now()
  const max = now + Math.max(0, minutes) * 60_000
  const at = typeof provider === 'number' ? provider : typeof provider === 'string' && provider ? Date.parse(provider) : Number.NaN
  return new Date(Number.isFinite(at) && at > now && at <= max ? at : max).toISOString()
}

// ---------------- provider status tables ----------------

/** A lookup made by `statusMap` */
export type StatusLookup<T> = {
  /**
   * The entry for a provider status, or `undefined` for a status that is not in the table. An unknown
   * status is logged (once per value and process) with `log`. It never falls back to another entry:
   * the adapter decides what an unknown status means (usually: keep the current step).
   */
  (raw: unknown, log?: Pick<Logger, 'warn'>): T | undefined
  /** The provider statuses in the table */
  readonly known: readonly string[]
}

const unknownSeen = new Set<string>()

/**
 * A typed table from provider statuses to the adapter's own values (for example a `LegStatus` and a
 * step detail). Use it in place of a hand-written `switch` with a `default` branch, so that a new
 * provider status never becomes `processing` (or anything else) by accident.
 *
 * ```ts
 * const STATUS = statusMap('MoonPay', {
 *   waitingPayment: { status: 'requires_action' },
 *   pending: { status: 'processing', detail: 'settling' },
 *   completed: { status: 'succeeded' },
 *   failed: { status: 'failed' },
 * })
 * const m = STATUS(tx.status, ctx.log) // undefined for an unknown status
 * ```
 */
export function statusMap<T>(provider: string, table: Readonly<Record<string, T>>, opts: { ignoreCase?: boolean } = {}): StatusLookup<T> {
  const entries = new Map<string, T>()
  for (const [k, v] of Object.entries(table)) entries.set(opts.ignoreCase ? k.toLowerCase() : k, v)
  const lookup = ((raw: unknown, log?: Pick<Logger, 'warn'>) => {
    if (typeof raw !== 'string' || !raw) return undefined
    const hit = entries.get(opts.ignoreCase ? raw.toLowerCase() : raw)
    if (hit !== undefined) return hit
    const key = `${provider}:${raw}`
    if (log && !unknownSeen.has(key)) {
      unknownSeen.add(key)
      log.warn(`${provider}: unknown provider status; the leg keeps its current step`, { status: raw.slice(0, 64) })
    }
    return undefined
  }) as StatusLookup<T>
  Object.defineProperty(lookup, 'known', { value: Object.freeze(Object.keys(table)) })
  return lookup
}

// ---------------- timestamped HMAC signatures ----------------

/**
 * Parse a signature header of `key=value` pairs separated by commas, for example
 * `t=1700000000,v1=5257a8...` (Stripe, Coinbase, MoonPay). A key can repeat (Stripe sends several
 * `v1` values during a secret rotation), so each key maps to a list.
 */
export function parseSignatureHeader(header: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const part of header.split(',')) {
    const i = part.indexOf('=')
    if (i <= 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k && v) (out[k] ??= []).push(v)
  }
  return out
}

export type TimestampedHmacInput = {
  /** The webhook secret. An empty secret never verifies. */
  secret: string | undefined
  /** The raw request body, as received */
  rawBody: string
  /**
   * The signature header value. With `timestamp` unset it is a list of pairs (`t=...,v1=...`); see
   * `timestampKey` and `signatureKey`. With `timestamp` set it is the signature alone.
   */
  header: string | null | undefined
  /** The timestamp, when the provider sends it in its own header (Unix seconds or ISO 8601) */
  timestamp?: string | null
  /** Key of the timestamp in `header`. Default `t`. */
  timestampKey?: string
  /** Key of the signature in `header`. Default `v1`. Every value of the key is tried. */
  signatureKey?: string
  /** Most seconds between the timestamp and now. Default 300. */
  toleranceSec?: number
  /** The signed string, from the raw timestamp. Default `${timestamp}.${rawBody}`. */
  message?: (timestamp: string) => string
  /** Encoding of the signature. Default `hex` (compared without case). */
  encoding?: 'hex' | 'base64' | 'base64url'
}

/** The time of a webhook timestamp in ms: Unix seconds, or an ISO 8601 date */
function timestampMs(t: string): number {
  if (/^\d{1,12}$/.test(t)) return Number(t) * 1000
  return Date.parse(t)
}

/**
 * Verify an HMAC-SHA256 webhook signature over a timestamp and the body, with a time window. This is
 * the pattern of Stripe (`t=,v1=`), MoonPay (`t=,s=`), Coinbase (`t=,v0=`), Peer (separate headers) and
 * Meld (separate headers, ISO time, base64url, the URL in the message). False for a missing secret,
 * header or timestamp, a timestamp outside the window, or a wrong signature. Constant-time compare.
 */
export async function verifyTimestampedHmac(input: TimestampedHmacInput): Promise<boolean> {
  const { secret, rawBody, header } = input
  if (!secret || !header) return false
  let ts: string | undefined
  let sigs: string[]
  if (input.timestamp !== undefined) {
    ts = input.timestamp ?? undefined
    sigs = [header.trim()]
  } else {
    const parts = parseSignatureHeader(header)
    ts = parts[input.timestampKey ?? 't']?.[0]
    sigs = parts[input.signatureKey ?? 'v1'] ?? []
  }
  if (!ts || !sigs.length) return false
  const when = timestampMs(ts)
  if (!Number.isFinite(when) || Math.abs(Date.now() - when) > (input.toleranceSec ?? 300) * 1000) return false
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(input.message ? input.message(ts) : `${ts}.${rawBody}`)))
  const encoding = input.encoding ?? 'hex'
  const expected = encoding === 'hex' ? bytesToHex(mac) : encoding === 'base64' ? bytesToBase64(mac) : bytesToBase64(mac).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return sigs.some((s) => timingSafeEqual(encoding === 'hex' ? s.toLowerCase() : s, expected))
}

// ---------------- cache ----------------

/**
 * Read `key` from `kv`, or run `load` and keep its result for `ttlSec` seconds. Use it for provider
 * catalogs, rates and token data. A value that `valid` refuses (for example an empty list) is not
 * kept and not returned from the cache: `load` runs again next time. Errors from `load` go to the
 * caller, and nothing is kept.
 */
export async function cachedJson<T>(kv: ScopedKV, key: string, ttlSec: number, load: () => Promise<T>, opts: { valid?: (v: T) => boolean } = {}): Promise<T> {
  const ok = (v: T | undefined): v is T => v !== undefined && v !== null && (opts.valid ? opts.valid(v) : true)
  const hit = await kv.get<T>(key)
  if (ok(hit)) return hit
  const v = await load()
  if (ok(v)) await kv.put(key, v, ttlSec)
  return v
}
