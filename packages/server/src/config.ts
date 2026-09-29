import type { Adapter, Logger } from '@openrampkit/adapter'
import type { AllowedTargets, CryptoAsset, Destination, Direction, PollSpec, RegionPolicy, SurfaceKind, TxRequest, WithdrawSource } from '@openrampkit/core'
import type { SessionStore } from './store.js'

export type CreateSessionInput = {
  userId: string
  direction?: Direction
  /** Deposit: where the money ends (required). Withdraw: leave it out; the user picks the target. */
  destination?: Destination
  /** Withdraw: the asset to send out and who holds it (required for withdraw) */
  source?: WithdrawSource
  /** Withdraw: limit the targets the user can pick. Default: any. */
  allowedTargets?: AllowedTargets
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
  }
  /**
   * Signed webhooks to the app backend. Failed deliveries are kept in an outbox and retried by
   * `sweep()` with backoff (30 s doubling, max 1 h), up to `maxAttempts` (default 8).
   */
  webhooks?: { url: string; secret: string; maxAttempts?: number }
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
   * Per-session request limits for routes that call provider APIs (plan, quotes, target).
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
  /** Sign and send `txs` in order; return the hash of the last one. */
  send(input: TreasurySendInput): Promise<{ hash: string }>
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
export const MAX_QUOTED_PATHWAYS = 5
export const START_URL_TTL_MS = 10 * 60_000
export const IDEMPOTENCY_TTL_SEC = 60 * 60 * 24
export const REF_INDEX_TTL_SEC = 60 * 60 * 24 * 30
export const STATUS_CHECK_MIN_INTERVAL_MS = 2000
