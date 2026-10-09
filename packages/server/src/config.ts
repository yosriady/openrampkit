import type { Adapter, Logger } from '@openrampkit/adapter'
import type { AllowedDestinations, CryptoAsset, Destination, Direction, PollSpec, RegionPolicy, SurfaceKind, TxRequest, WithdrawSource } from '@openrampkit/core'
import type { SessionStore } from './store.js'

export type CreateSessionInput = {
  userId: string
  /**
   * Your own id for this session (an order id, for example): 1 to 256 printable characters, unique per
   * app. A create that repeats the `externalId` of a session that is not final returns that session
   * (with the same client secret). A repeat for a final session answers `409 CONFLICT`.
   */
  externalId?: string
  direction?: Direction
  /**
   * Where the money ends. Deposit: required. Withdraw: optional, a destination that the app sets at
   * creation (`{ type: 'crypto', chain, token, address }` or `{ type: 'fiat', currency }`, the same shape
   * as the body of `POST /sessions/:id/target`). The server checks it with `allowedDestinations` and
   * `screenAddress`. Without it, the user picks the destination.
   */
  destination?: Destination
  /** Withdraw: the asset to send out and who holds it (required for withdraw) */
  source?: WithdrawSource
  /** Withdraw: limit the destinations the user can pick. Default: any. */
  allowedDestinations?: AllowedDestinations
  /**
   * Withdraw with `destination`: lock it. Then nobody can change it with the client secret or a pay
   * link: `POST /sessions/:id/target` answers `409 DESTINATION_LOCKED`. Default `false`. A deposit
   * destination is always locked.
   */
  lockDestination?: boolean
  country?: string
  region?: string
  email?: string
  locale?: string
  amountBounds?: { min?: string; max?: string; currency: string }
  allowedMethods?: string[]
  metadata?: Record<string, string>
  /** Minutes until the session expires (default 30) */
  ttlMinutes?: number
}

export type OpenRampConfig = {
  /** Secret used to sign start URLs. At least 32 characters. */
  secret: string
  /** Public URL where this handler is mounted, e.g. https://app.example.com/api/openramp */
  baseUrl: string
  adapters: Adapter[]
  store?: SessionStore
  livemode?: boolean
  policy?: {
    maxLegs?: 1 | 2
    regions?: RegionPolicy
    methodPriority?: Record<string, string[]>
    disabledMethods?: string[]
    /** Preferred hop assets for two-leg pathways, most preferred first (default: USDC on Base, Arbitrum, Polygon, Optimism, Ethereum) */
    hopPreference?: CryptoAsset[]
    /**
     * How much less than the quote a provider may report as a leg's output, in basis points, before
     * the delivery is `short` (`result.delivery`, timeline entry `leg.delivery`). Default 100 (1%). A quote
     * with a `minOutput` uses that minimum instead.
     */
    outputToleranceBps?: number
    /**
     * The most payment attempts of one session (the first payment and each new one after `restart`).
     * A failed attempt that leaves no attempt makes the session `failed`. Default 10.
     */
    maxAttempts?: number
  }
  /**
   * Signed webhooks to the app backend. Each event is saved with the session change that made it, and
   * sent after that save. Failed deliveries are retried by `sweep()` with backoff (30 s doubling, max 2 h)
   * for `retryHours` (default 24), or until `maxAttempts` attempts when you set it. Then the event stays
   * in the session as a dead letter (`openramp.webhooks.replay(sessionId)` sends it again).
   */
  webhooks?: { url: string; secret: string; maxAttempts?: number; retryHours?: number }
  /**
   * Bearer token for operational routes: `POST {baseUrl}/tasks/sweep` and `GET {baseUrl}/health?deep=1`.
   * Without it, those routes are off (health answers a quick check only).
   */
  tasksToken?: string
  /** Resolve the user's country. Defaults to Cloudflare / Vercel geo headers. */
  geo?: (req: Request) => { country?: string; region?: string } | undefined
  /**
   * Optional: let the browser create sessions through `POST {baseUrl}/sessions`.
   * Return the session input for this request (the app decides userId and destination), or null to refuse.
   */
  authorize?: (req: Request, body: unknown) => Promise<CreateSessionInput | null>
  /** Allowed origins for CORS. Default: same origin only. */
  cors?: { origins: string[] | '*' }
  logger?: Logger
  /** Where providers return the user. Default: `{baseUrl}/return` which closes the tab. */
  returnUrl?: string
  fetch?: typeof fetch
  /** Timeouts in ms. Defaults: quote 9000, webhook delivery 4000. */
  timeouts?: { quote?: number; webhook?: number }
  /**
   * Per-session request limits for routes that call provider APIs (plan, quotes, target, select, transitions).
   * Default 60 per minute. The counter lives in the store's KV space (best effort on non-atomic stores).
   */
  limits?: { providerCallsPerMinute?: number }
  /**
   * Withdraw: screen a crypto target address (sanctions, blocked lists) before the user can use it.
   * Return false to refuse the address. An error also refuses it (fail closed).
   */
  screenAddress?: (address: string, chain: string) => Promise<boolean>
  /**
   * Withdraw with `custody: 'app'`: send transactions from the app's treasury wallet.
   * The server calls it when a leg asks for a WALLET_TX, instead of asking the user.
   * Without it, withdraw methods for app custody show as unavailable.
   */
  treasury?: TreasuryHook
  /**
   * Hosted pay links (`GET {baseUrl}/pay/:credential`): a page that mounts `<openramp-modal>` for one session.
   * Links come from `openramp.sessions.payLink(id)` or `POST {baseUrl}/sessions/:id/pay-link`.
   * `scriptUrl` is the ES module of `@openrampkit/web` the page imports (default: esm.sh).
   * Set `false` to turn pay links off.
   */
  payPage?: false | { scriptUrl?: string; title?: string }
  /**
   * Admin tools for operators. With `admin` set, the server keeps a time index of new sessions, and
   * `openramp.admin.*` can list, inspect, resolve and replay them. With `token` (at least 32 characters),
   * the HTTP routes `{baseUrl}/admin/*` and the dashboard page `GET {baseUrl}/admin` are on. Keep the token
   * on the server, and put `/admin` behind your own auth or a VPN in production.
   */
  admin?: AdminConfig
  /** Optional metrics callback. See `Telemetry`. */
  telemetry?: Telemetry
  /**
   * Late payments. When the sweep expires a session whose payment still waits for the user (for
   * example a bank transfer or a deposit address), it keeps polling that payment at a slower rate for
   * `graceHours` (default 72; 0 turns it off), every `pollMinutes` (default 10). When the payment
   * arrives, the session completes, and the server sends `session.late_payment` and `session.succeeded`.
   * Only adapters with `status()` can be polled; a provider webhook completes an expired session too.
   */
  latePayments?: { graceHours?: number; pollMinutes?: number }
}

export type AdminConfig = {
  /** Bearer token for `{baseUrl}/admin/*`. At least 32 characters. Without it, the HTTP routes answer 404. */
  token?: string
  /** A session that is not final after this many minutes counts as stuck (default 60) */
  stuckAfterMinutes?: number
  /** Days of the time index that `list` and `stats` read, and that the sweep keeps (default 8) */
  indexDays?: number
  /** Serve the dashboard page at `GET {baseUrl}/admin` (default true, needs `token`) */
  page?: boolean
}

/**
 * A plain metrics callback. The server calls `onMetric` with a metric name, a number and string tags.
 * Send them to your metrics system (StatsD, Prometheus, Datadog, OpenTelemetry). An error in the
 * callback is ignored. Names: `quote.latency_ms`, `start.error`, `webhook.verify_failed`, `event.out_of_order`, `leg.delivery_mismatch`, `payment.reversed`, `webhook.replayed`,
 * `webhook.delivery_failed`, `webhook.dead_letter`, `outbox.depth`, `open_sessions.depth`,
 * `sweep.lag_ms`, `sweep.duration_ms`, `sessions.stuck`.
 */
export type Telemetry = {
  onMetric(name: string, value: number, tags: Record<string, string>): void
}

export type TreasurySendInput = {
  sessionId: string
  userId: string
  /** CAIP-2 chain id */
  chain: string
  txs: TxRequest[]
  /** Stable for one leg step. Send at most once per key. */
  idempotencyKey: string
}

export type TreasuryHook = {
  /** Sender address, given to providers for exact quotes (e.g. Relay). Optional. */
  address?: string
  /**
   * Sign and send `txs` in order; return the hash of the last one. To refuse (nothing was sent), throw
   * `TreasuryRefusedError`: the attempt fails and the user may try again. Any other error is read as
   * "the funds may have left": the failure is final, and an operator resolves the session.
   */
  send(input: TreasurySendInput): Promise<{ hash: string }>
}

/**
 * Throw this from `treasury.send` only when you are sure that nothing was sent (for example the hot
 * wallet has too little balance, or your own limits refuse the payout). The user may then try again.
 */
export class TreasuryRefusedError extends Error {
  readonly treasuryRefused = true
  constructor(message = 'The treasury refused the payout.') {
    super(message)
    this.name = 'TreasuryRefusedError'
  }
}

/** True for a `TreasuryRefusedError`, also across package copies. */
export function isTreasuryRefused(e: unknown): boolean {
  return e instanceof TreasuryRefusedError || (typeof e === 'object' && e !== null && (e as { treasuryRefused?: unknown }).treasuryRefused === true)
}

export const consoleLogger: Logger = {
  debug: () => {},
  info: (m, d) => console.info(`[openramp] ${m}`, d ?? ''),
  warn: (m, d) => console.warn(`[openramp] ${m}`, d ?? ''),
  error: (m, d) => console.error(`[openramp] ${m}`, d ?? ''),
}

export const ALL_SURFACES: SurfaceKind[] = ['REDIRECT', 'IFRAME', 'QR', 'DEEPLINK', 'BANK_FIELDS', 'DEPOSIT_ADDRESS', 'WALLET_TX', 'OTP', 'FORM']

/** Default poll spec for steps that wait on a provider or a chain */
export const DEFAULT_POLL: PollSpec = { intervalMs: 2500, backoff: 1.2, maxIntervalMs: 10_000, giveUpAfterMs: 30 * 60_000 }

export const MAX_STORED_QUOTES = 20

/** How long a leg quote lives when its adapter sent no valid `expiresAt` (a third-party adapter bug): 5 minutes */
export const DEFAULT_QUOTE_TTL_MS = 5 * 60_000
export const MAX_QUOTED_PATHWAYS = 5
export const START_URL_TTL_MS = 10 * 60_000
/** A pay link works until the session expires plus this grace, so a payment in progress can finish. */
export const PAY_LINK_GRACE_MS = 30 * 60_000
export const IDEMPOTENCY_TTL_SEC = 60 * 60 * 24
export const REF_INDEX_TTL_SEC = 60 * 60 * 24 * 30
/** How long the `externalId` index keeps an id (longer than the longest session) */
export const EXTERNAL_ID_TTL_SEC = 60 * 60 * 24 * 30
export const STATUS_CHECK_MIN_INTERVAL_MS = 2000
/** Defaults of `latePayments` */
export const DEFAULT_LATE_GRACE_HOURS = 72
export const DEFAULT_LATE_POLL_MINUTES = 10
/** Default `policy.maxAttempts` */
export const DEFAULT_MAX_ATTEMPTS = 10
/** Default `policy.outputToleranceBps`: 1% */
export const DEFAULT_OUTPUT_TOLERANCE_BPS = 100
/** Largest JSON body the browser routes accept */
export const MAX_JSON_BODY_BYTES = 64 * 1024
/** Largest provider webhook body */
export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024
