// The adapter API. Adapters work like wagmi connectors: a package exports a factory,
// the app passes configured instances to the server, and the server treats them all the same way.

import type {
  Amount,
  Destination,
  Direction,
  LegQuote,
  LegSpec,
  LegStatus,
  LegStep,
  OrkError,
  PathwayLeg,
  Surface,
  Transition,
} from '@openrampkit/core'
import { bytesToBase64, bytesToHex } from './util.js'

export const ADAPTER_API_VERSION = 1

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
}

/** Small key-value store scoped to one adapter (and optionally one session). */
export interface ScopedKV {
  get<T = unknown>(key: string): Promise<T | undefined>
  put(key: string, value: unknown, ttlSec?: number): Promise<void>
  /**
   * Optional: write `value` only when `key` has no live value, as one atomic step. Returns true when
   * it wrote, false when the key was already set. Stores with no atomic operation leave it out.
   * Use `claimOnce` instead of calling it directly.
   */
  putIfAbsent?(key: string, value: unknown, ttlSec: number): Promise<boolean>
}

export interface AdapterContext {
  session: {
    id: string
    userId: string
    direction: Direction
    country?: string
    locale: string
    livemode: boolean
    email?: string
    /** ISO 3166-2 region, e.g. `US-CA`, when known */
    region?: string
    /** End-user IP address from the latest browser request, when known */
    ip?: string
  }
  destination: Destination
  /** The full pathway, and this leg's index in it */
  pathway: { legs: PathwayLeg[]; index: number }
  urls: {
    /** Where providers send the user back */
    returnUrl: string
    /** Provider webhook URL for this adapter */
    webhookUrl: string
  }
  /** Adapter scratch data for this session */
  store: ScopedKV
  /** Adapter data shared across sessions (e.g. cached catalogs, reusable deposit addresses) */
  shared: ScopedKV
  fetch: typeof fetch
  log: Logger
  idempotencyKey(scope: string): string
}

export type QuoteInput = {
  leg: PathwayLeg
  /** Exactly one side is set */
  amountIn?: Amount
  amountOut?: Amount
  /** Where this leg must deliver. For hop legs this is the next leg's deposit address. */
  deliverTo?: { address: string }
  /** For crypto source legs: the token the user pays with, and the user's address when a wallet is connected */
  source?: { chain: string; token: string; address?: string }
}

export type StartInput = {
  leg: PathwayLeg
  quote: LegQuote
  deliverTo?: { address: string }
  source?: { chain: string; token: string; address?: string }
}

export type TransitionInput = {
  leg: PathwayLeg
  ref: string
  name: string
  inputs?: Record<string, unknown>
}

export type LegEvent = {
  ref: string
  status: LegStatus
  /**
   * Optional provider event id (or another value that is the same for each delivery of one event).
   * The server keeps the recent ids of each session and drops an event whose id it already applied.
   */
  eventId?: string
  output?: Amount
  txHash?: string
  /** The transaction that paid into the leg (see `LegStep.sourceTxHash`) */
  sourceTxHash?: string
  error?: OrkError
  /**
   * Optional new surface for a non-terminal event, e.g. an offramp `payment_pending` webhook that
   * carries the deposit address: `{ kind: 'WALLET_TX', ... }` with status `awaiting_user`.
   * The server shows it instead of the current surface.
   */
  surface?: Surface
  /** Transitions that go with `surface`. Default: an AWAIT poll. */
  transitions?: Transition[]
}

export type CatalogInput = { country?: string; currency: string; direction: Direction }

export interface Adapter {
  id: string
  name: string
  apiVersion: number
  /** Static leg declarations */
  legs: LegSpec[]
  /** Optional live catalog: returns legs refined for this user (methods, limits, assets) */
  catalog?(input: CatalogInput, ctx: Pick<AdapterContext, 'fetch' | 'log' | 'shared'>): Promise<LegSpec[]>
  quote(input: QuoteInput, ctx: AdapterContext): Promise<LegQuote>
  /**
   * Optional: before quoting a previous leg, a bridge adapter may provide the address that
   * the previous leg must deliver to (e.g. a Relay open deposit address).
   */
  prepareDeposit?(input: { leg: PathwayLeg; amountIn?: Amount }, ctx: AdapterContext): Promise<{ address: string; ref?: string; data?: Record<string, unknown> }>
  start(input: StartInput, ctx: AdapterContext): Promise<LegStep>
  transition?(input: TransitionInput, ctx: AdapterContext): Promise<LegStep>
  status?(input: { leg: PathwayLeg; ref: string }, ctx: AdapterContext): Promise<LegStep>
  webhook?: {
    verify(req: Request, rawBody: string, ctx: WebhookContext): Promise<boolean>
    parse(rawBody: string, ctx: WebhookContext & { url?: string }): Promise<LegEvent[]>
    /**
     * Optional replay protection. Return a key that is the same for every delivery of one provider
     * event: the provider event id, or `webhookBodyKey(rawBody)` when the provider signs the body with
     * no timestamp. The server calls it after `verify`. It remembers each key for 7 days in the
     * adapter's shared store (`claimWebhook`), and answers a repeat with `200` and applies nothing.
     * When an event of the delivery cannot be applied yet (the server answers `503`), the server gives
     * the key back, so the provider's retry still applies.
     */
    replayKey?(req: Request, rawBody: string, ctx: WebhookContext): Promise<string | undefined>
  }
  health?(ctx: Pick<AdapterContext, 'fetch' | 'log'>): Promise<{ ok: boolean; detail?: string }>
  /**
   * Optional HTTP routes mounted at `{baseUrl}/adapters/{id}/*` (return pages, hosted pay pages).
   * Return undefined to fall through to a 404.
   */
  routes?(req: Request, subpath: string, ctx: RouteContext): Promise<Response | undefined>
}

export type WebhookContext = Pick<AdapterContext, 'log' | 'shared' | 'fetch'>

export type RouteContext = Pick<AdapterContext, 'fetch' | 'log' | 'shared'> & {
  baseUrl: string
  /** Apply a provider event to the session that owns `ref` (same effect as a webhook) */
  applyEvent(event: LegEvent): Promise<void>
}

export type AdapterDefinition = Omit<Adapter, 'apiVersion'> & { apiVersion?: number }

export function createAdapter(def: AdapterDefinition): Adapter {
  if (!def.id || !/^[a-z0-9-]+$/.test(def.id)) throw new Error(`Adapter id must be lowercase letters, digits or dashes: ${def.id}`)
  const ids = new Set<string>()
  for (const leg of def.legs) {
    if (ids.has(leg.id)) throw new Error(`Adapter ${def.id} has duplicate leg id ${leg.id}`)
    ids.add(leg.id)
  }
  return { apiVersion: ADAPTER_API_VERSION, ...def }
}

// ---------- helpers for adapter authors ----------

export async function hmacSha256(secret: string, message: string, encoding: 'hex' | 'base64' = 'hex'): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)))
  if (encoding === 'hex') return bytesToHex(sig)
  return bytesToBase64(sig)
}

/** Constant-time string compare. The one implementation lives in `@openrampkit/core`. */
export { timingSafeEqual } from '@openrampkit/core'

export * from './http.js'
export * from './claim.js'
export * from './rsa.js'
export * from './util.js'
export * from './evm.js'
export * from './solana.js'
export * from './testkit.js'
export * from './settlement.js'
