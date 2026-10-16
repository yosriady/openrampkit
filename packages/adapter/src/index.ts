// The adapter API. Adapters work like wagmi connectors: a package exports a factory,
// the app passes configured instances to the server, and the server treats them all the same way.

import type {
  Amount,
  Destination,
  Direction,
  LegQuote,
  LegSpec,
  LegStep,
  PathwayLeg,
  SourceToken,
} from '@openrampkit/core'
import { bytesToBase64, bytesToHex } from './util.js'

/**
 * The version of the adapter contract. Version 2: a `LegStep` has a `status` and, when the user must
 * act, an `action` (no `state`, no loose surface fields); `detail` replaces `sub`; transactions are
 * records with a role; quotes have a `guarantee` and an `expiresAt`; fees have a typed amount.
 */
export const ADAPTER_API_VERSION = 2

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
  /**
   * Gas abstraction: the client asks to pay without native gas (the wallet has none on the source
   * chain, or the app opted in), and its wallet can sign EIP-712 typed data. An adapter that supports
   * it may return a `WALLET_SIGN` step instead of `WALLET_TX`; any other adapter ignores it.
   */
  gasless?: boolean
}

export type TransitionInput = {
  leg: PathwayLeg
  ref: string
  name: string
  inputs?: Record<string, unknown>
}

/**
 * A provider event for one leg (from a webhook, or an adapter route): a `LegStep` with the leg's
 * `ref`. The server applies it with the same rules as a step from `status()` (see `stateFor` in
 * `@openrampkit/core`). For example, an offramp `payment_pending` webhook that carries the deposit
 * address is `{ ref, status: 'requires_action', action: { kind: 'payment', surface: { kind: 'WALLET_TX', ... }, transitions } }`,
 * and a KYC review webhook is `{ ref, status: 'processing', phase: 'kyc' }`.
 */
export type LegEvent = LegStep & {
  ref: string
  /**
   * Optional provider event id (or another value that is the same for each delivery of one event).
   * The server keeps the recent ids of each session and drops an event whose id it already applied.
   */
  eventId?: string
}

export type CatalogInput = { country?: string; currency: string; direction: Direction }

/** The route of a standing deposit address (see `Adapter.standingAddress`) */
export type StandingAddressInput = {
  userId: string
  /** The asset the user sends: a CAIP-2 chain and a token address (or `native`) */
  origin: { chain: string; token: string }
  /** Where each deposit goes (always a crypto destination) */
  destination: Extract<Destination, { type: 'crypto' }>
}

export type StandingDepositsInput = {
  /** The `ref` that `standingAddress` returned */
  ref: string
  address: string
  origin: { chain: string; token: string }
  /** Return deposits seen at or after this time (ms). Repeats are fine: the server dedupes by `id`. */
  since: number
}

/**
 * The route of a standing bank account (see `Adapter.standingAccount`): the user pays fiat by bank
 * transfer, and the provider converts it and delivers to `destination`.
 */
export type StandingAccountInput = {
  userId: string
  /** The fiat currency the user pays in (ISO 4217, upper case) */
  origin: { currency: string }
  /** Where each deposit goes (always a crypto destination) */
  destination: Extract<Destination, { type: 'crypto' }>
}

/** `standingDeposits` input for a standing bank account (the `ref` that `standingAccount` returned) */
export type StandingAccountDepositsInput = {
  ref: string
  /** The main account identifier that `standingAccount` returned */
  address: string
  origin: { currency: string }
  /** Return deposits seen at or after this time (ms). Repeats are fine: the server dedupes by `id`. */
  since: number
}

/** A standing bank account (see `Adapter.standingAccount`) */
export type StandingAccountResult = {
  /** The main account identifier (account number, IBAN, CLABE or Pix code) */
  address: string
  ref: string
  /** Every field the user needs to pay, as in a `BANK_FIELDS` surface */
  bank: { fields: Array<{ label: string; value: string; copy: boolean }> }
  data?: Record<string, unknown>
}

/**
 * A kind of standing address route (see `Adapter.standingRoutes`): `convert` (another token or chain),
 * `same` (the same token on the same chain) or `bank` (fiat by bank transfer, see `standingAccount`).
 */
export type StandingRoute = 'convert' | 'same' | 'bank'

/** One deposit at a standing address (see `Adapter.standingDeposits`) */
export type StandingDeposit = {
  /** The same for one deposit on every call: a provider request id, or the deposit transaction hash */
  id: string
  /** The ref that `status()` understands for this deposit */
  legRef: string
  /** When the provider saw the deposit (ms) */
  at: number
  /** The deposit amount, when known: the origin token, or for a bank account the origin currency */
  input?: Amount
}

/**
 * The provider environment that an adapter calls: test keys and no real money (`sandbox`), or real
 * money (`production`). Every first-party adapter takes it as the `env` option.
 */
export type AdapterEnv = 'sandbox' | 'production'

export interface Adapter {
  id: string
  name: string
  apiVersion: number
  /**
   * The provider environment this adapter calls, from its options (or its keys). Undefined when the
   * adapter follows each session's `livemode`. The server refuses to start with `livemode: true` and an
   * adapter in `sandbox`, and warns for an adapter in `production` when `livemode` is false.
   */
  readonly env?: AdapterEnv
  /** Static leg declarations */
  legs: LegSpec[]
  /**
   * Optional: tokens the user can pay with on `chains` for a deposit method (`transfer`,
   * `exchange_transfer` or `wallet`), most popular first. The server caches the list for some hours and
   * adds the default tokens (USDC and native). It only fills the picker: the quote decides what is valid.
   */
  sourceTokens?(input: { chains: string[]; method: string }, ctx: Pick<AdapterContext, 'fetch' | 'log' | 'shared'>): Promise<SourceToken[]>
  /**
   * Optional: a reusable deposit address for one user and route (`openramp.depositAddresses.get`).
   * Any deposit of `origin` to it, at any time, must reach `destination`. It must be stable: the same
   * input returns the same address. Keep it in `ctx.shared` with no TTL, or a very long one. `ref` is
   * what `standingDeposits` gets back. The server keeps its own record, so it calls this once per route.
   */
  standingAddress?(input: StandingAddressInput, ctx: Pick<AdapterContext, 'fetch' | 'log' | 'shared'>): Promise<{ address: string; ref: string; data?: Record<string, unknown> }>
  /**
   * Optional, with `standingAddress`: the deposits seen at a standing address since `since` (ms).
   * The server polls it from `sweep()` and makes one deposit session per new `id`. `id` must be the
   * same for one deposit on every call (a provider request id, or the deposit transaction hash).
   * `legRef` is a ref that `status()` understands for this one deposit: the session's leg polls it.
   * `input` is the deposit amount, when the provider says it.
   */
  standingDeposits?(input: StandingDepositsInput | StandingAccountDepositsInput, ctx: Pick<AdapterContext, 'fetch' | 'log' | 'shared'>): Promise<StandingDeposit[]>
  /**
   * Optional, with `standingDeposits` and `'bank'` in `standingRoutes`: a standing bank account for one
   * user and route. The user pays `origin.currency` by bank transfer to it, at any time, and each
   * deposit must reach `destination`. Like `standingAddress`, it must be stable, and the server calls it
   * once per route. `standingDeposits` then gets a `StandingAccountDepositsInput` (with `origin.currency`).
   */
  standingAccount?(input: StandingAccountInput, ctx: Pick<AdapterContext, 'fetch' | 'log' | 'shared'>): Promise<StandingAccountResult>
  /**
   * Optional, with `standingAddress`: the routes that its standing addresses serve. `convert` (the
   * default): the origin is another token or chain than the destination, and the provider converts.
   * `same`: the origin is the destination token on the destination chain, so the address is the
   * destination itself and the adapter watches the chain (see `@openrampkit/adapter-chain-watch`).
   * `bank`: the origin is a fiat currency paid by bank transfer (needs `standingAccount`).
   * The server picks, for each route, the first adapter that serves it.
   */
  standingRoutes?: ReadonlyArray<StandingRoute>
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
  /**
   * Optional: void the provider order of a started leg when the session is canceled
   * (`POST /sessions/:id/cancel`, `openramp.sessions.cancel`). Best effort: the server logs an error and
   * cancels the session anyway. A payment that arrives later takes the late payment path.
   */
  cancel?(input: { leg: PathwayLeg; ref: string }, ctx: AdapterContext): Promise<void>
  webhook?: {
    /**
     * False when the adapter cannot verify webhooks with its options (for example no webhook secret),
     * so no provider event can arrive. Default true. The server warns at start when an adapter with
     * legs has neither `status()` nor a configured webhook (see `resultChannels`).
     */
    configured?: boolean
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

/**
 * How the server learns the result of this adapter's legs:
 * - `polling`: the adapter has `status()`, so the server and the client can check a leg.
 * - `webhooks`: the adapter has a `webhook` that can verify events (`configured` is not false).
 * An adapter with neither cannot move a leg past the provider step by itself.
 */
export function resultChannels(a: Pick<Adapter, 'status' | 'webhook'>): { polling: boolean; webhooks: boolean } {
  return { polling: typeof a.status === 'function', webhooks: !!a.webhook && a.webhook.configured !== false }
}

export type RouteContext = Pick<AdapterContext, 'fetch' | 'log' | 'shared'> & {
  baseUrl: string
  /** Apply a provider event to the session that owns `ref` (same effect as a webhook) */
  applyEvent(event: LegEvent): Promise<void>
}

export type AdapterDefinition = Omit<Adapter, 'apiVersion'> & { apiVersion?: number }

export function createAdapter(def: AdapterDefinition): Adapter {
  if (!def.id || !/^[a-z0-9-]+$/.test(def.id)) throw new Error(`Adapter id must be lowercase letters, digits or dashes: ${def.id}`)
  if (def.apiVersion !== undefined && def.apiVersion !== ADAPTER_API_VERSION) {
    throw new Error(
      `Adapter ${def.id} was built for adapter API version ${def.apiVersion}, but @openrampkit/adapter supports version ${ADAPTER_API_VERSION}. ` +
        'Update the adapter: a LegStep has `status` and an `action` (no `state`), `detail` (no `sub`) and `transactions` (no `txHash`). ' +
        'See docs/adapters/writing-an-adapter.md.',
    )
  }
  const ids = new Set<string>()
  for (const leg of def.legs) {
    if (ids.has(leg.id)) throw new Error(`Adapter ${def.id} has duplicate leg id ${leg.id}`)
    ids.add(leg.id)
  }
  return { apiVersion: ADAPTER_API_VERSION, ...def }
}

// ---------- helpers for adapter authors ----------

const deprecationsShown = new Set<string>()

/**
 * Write a deprecation warning once per process (adapters have no logger when they are built).
 * Returns true the first time for `key`.
 */
export function warnDeprecatedOnce(key: string, message: string): boolean {
  if (deprecationsShown.has(key)) return false
  deprecationsShown.add(key)
  console.warn(`[openrampkit] Deprecated: ${message}`)
  return true
}

/**
 * The `env` of an adapter from its options. `legacy` is the value of an older option (for example
 * peer's `env: 'live'` or coinbase's `sandbox: true`), already mapped to an `AdapterEnv`; it is used only
 * when `env` is not set, with a one-time warning. Returns `fallback` when neither is set.
 */
export function resolveEnv<F extends AdapterEnv | undefined>(
  adapter: string,
  env: AdapterEnv | undefined,
  legacy: { value: AdapterEnv | undefined; option: string } | undefined,
  fallback: F,
): AdapterEnv | F {
  if (env !== undefined && env !== 'sandbox' && env !== 'production') throw new Error(`${adapter}: env must be 'sandbox' or 'production', not ${JSON.stringify(env)}`)
  if (env) return env
  if (legacy?.value) {
    warnDeprecatedOnce(`${adapter}:${legacy.option}`, `${adapter}: the option ${legacy.option} is deprecated. Use env: '${legacy.value}'.`)
    return legacy.value
  }
  return fallback
}

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
export * from './helpers.js'
export * from './claim.js'
export * from './rsa.js'
export * from './util.js'
export * from './evm.js'
export * from './solana.js'
export * from './chain-watch.js'
export * from './testkit.js'
export * from './settlement.js'
export * from './eip712.js'
