// Core domain model shared by server, client and adapters.
// Money values are decimal strings. Chains are CAIP-2 ids. Countries are ISO 3166-1 alpha-2.

export type Direction = 'deposit' | 'withdraw'

export type FiatAsset = { kind: 'fiat'; currency: string }
export type CryptoAsset = {
  kind: 'crypto'
  /** CAIP-2 chain id, e.g. `eip155:8453` */
  chain: string
  /** Token address, or `native` for the gas token */
  token: string
  symbol?: string
  decimals?: number
}
export type Asset = FiatAsset | CryptoAsset

export type Location =
  | { kind: 'user_wallet' }
  | { kind: 'user_account' }
  | { kind: 'merchant_account'; accountRef?: string }
  | { kind: 'address'; address: string }

export type Endpoint = { asset: Asset; location: Location }

export type ContractCall = { to: string; data: string; value?: string }

/**
 * An OpenRampSettlement contract (see `contracts/` in the repo) on the destination chain.
 * The payment goes through the contract: it records the session id on chain, pays `address`,
 * and runs the destination `calls` (if any) in the same transaction.
 */
export type SettlementTarget = {
  /** The OpenRampSettlement contract address, on the destination chain */
  contract: string
}

export type Destination =
  | {
      type: 'crypto'
      chain: string
      token: string
      address: string
      symbol?: string
      decimals?: number
      /**
       * Contract calls after delivery, e.g. an ERC-4626 `deposit(amount, address)`. Needs `settlement`:
       * the settlement contract runs them atomically, with an allowance of the settled amount to each
       * `to` (which must be on the contract's allowlist). `value` must be absent: no native value.
       */
      calls?: ContractCall[]
      /** Settle through an OpenRampSettlement contract. Only pathways whose last leg supports it are offered. */
      settlement?: SettlementTarget
    }
  | { type: 'merchant'; currency: string; accountRef?: string }
  /** Withdraw to cash: the user's own bank or e-wallet account, paid out in `currency` */
  | { type: 'fiat'; currency: string }

// ---------- Withdraw ----------

/**
 * Who holds the funds of a withdraw session.
 * - `user_wallet`: the user's own wallet signs every transaction (the client shows WALLET_TX).
 * - `app`: the app holds the funds. The server calls the app's `treasury.send()` hook instead of the user.
 */
export type Custody = 'user_wallet' | 'app'

/** The asset a withdraw session sends out. The app sets it when it creates the session. */
export type WithdrawSource = {
  /** CAIP-2 chain id, e.g. `eip155:8453` */
  chain: string
  /** Token address, or `native` for the gas token */
  token: string
  symbol?: string
  decimals?: number
  custody: Custody
}

/**
 * Where the user may send a withdrawal. Absent: any target. Present: only the listed types;
 * inside a type, an absent list means "any" (any chain, any currency).
 */
export type AllowedDestinations = {
  crypto?: { chains?: string[] }
  fiat?: { currencies?: string[] }
}

/** The target the user picks for a withdrawal (`POST /sessions/:id/target`). */
export type WithdrawDestination =
  | { type: 'crypto'; chain: string; token: string; address: string; symbol?: string; decimals?: number }
  | { type: 'fiat'; currency: string }

export type LegKind =
  | 'fiat_onramp'
  | 'fiat_payin'
  | 'wallet_transfer'
  | 'bridge_swap'
  | 'crypto_withdraw'
  | 'crypto_offramp'
  | 'fiat_payout'

export type SurfaceKind =
  | 'REDIRECT'
  | 'IFRAME'
  | 'PROVIDER_SDK'
  | 'QR'
  | 'DEEPLINK'
  | 'BANK_FIELDS'
  | 'DEPOSIT_ADDRESS'
  | 'WALLET_TX'
  | 'OTP'
  | 'FORM'

export type RegionPolicy = { allow: string[]; deny: string[] }

export type AssetMatcher =
  | { kind: 'fiat'; currencies: string[] | '*' }
  | {
      kind: 'crypto'
      /** chain -> token addresses (lowercase) or '*' */
      chains: Record<string, string[] | '*'> | '*'
    }

export type LocationKind = Location['kind']

export type EndpointMatcher = { asset: AssetMatcher; location: LocationKind[] }

export type LegSpec = {
  /** Unique within its adapter */
  id: string
  kind: LegKind
  /** User-facing methods for the first leg, e.g. ['card', 'apple_pay'] or ['vietqr'] */
  methods?: string[]
  from: EndpointMatcher
  to: EndpointMatcher
  regions: RegionPolicy
  /** Static hint only; quotes carry exact limits */
  limits?: { min?: string; max?: string; currency: string }
  /** Seconds */
  eta: { min: number; max: number }
  surfaces: SurfaceKind[]
  requires?: Array<'provider_account' | 'provider_kyc' | 'wallet' | 'otp'>
  /**
   * What the server must allow for this leg. Only these two values have a meaning, and the server checks both:
   * - `settlement`: the leg can pay into an OpenRampSettlement contract (destination `settlement`).
   *   The planner offers a settlement destination only through a pathway whose last leg has it.
   * - `surface_after_processing`: a provider event may move the leg from `processing` back to
   *   `requires_action` with a new surface, once, before the leg has a transaction. Only for a leg that
   *   learns where the user must pay after it started (for example an offramp that gets its deposit
   *   address in a webhook). The surface kind must be one of `surfaces`.
   * How the server learns a leg's result is not a capability: it comes from the adapter's `status()`
   * (polling) and `webhook` (see `resultChannels` in `@openrampkit/adapter`).
   */
  capabilities?: LegCapability[]
}

/** A leg capability (see `LegSpec.capabilities`) */
export type LegCapability = 'settlement' | 'surface_after_processing'

export type Fee = {
  kind: 'provider' | 'network' | 'app' | 'swap' | 'other'
  label: string
  amount: string
  currency: string
  /**
   * The provider takes this fee in the exchange rate, not on top. With amount '0', the provider did not
   * say how much it is: a UI must not show "No fees" for such a quote.
   */
  inRate?: boolean
}

/** Amount on one side of a leg or pathway */
export type Amount = { value: string; asset: Asset }

export type LegQuote = {
  adapterId: string
  legId: string
  input: Amount
  output: Amount
  fees: Fee[]
  /** Seconds */
  eta: { min: number; max: number }
  expiresAt?: string
  /** Opaque adapter data carried to start() */
  data?: Record<string, unknown>
  limits?: { min?: string; max?: string; currency: string }
}

export type PathwayLeg = {
  adapterId: string
  legId: string
  from: Endpoint
  to: Endpoint
  /** User-facing method of the pathway (set on the first leg), e.g. `gcash`, so a multi-method leg knows which one the user chose */
  method?: string
}

export type PathwayGroup = 'connected' | 'recommended' | 'more' | 'unavailable'

export type Pathway = {
  id: string
  legs: PathwayLeg[]
  method: string
  group: PathwayGroup
  reason?: OpenRampError
  eta: { min: number; max: number }
  limits?: { min?: string; max?: string; currency: string }
  /** Display name of the first leg's provider */
  provider: string
}

export type Quote = {
  id: string
  pathwayId: string
  method: string
  provider: string
  legs: LegQuote[]
  input: Amount
  output: Amount
  fees: Fee[]
  eta: { min: number; max: number }
  expiresAt?: string
  badges?: Array<'best_price' | 'fastest'>
}

/** A leg quote as the browser sees it: no adapter `data` (provider URLs, request bodies, idempotency nonces). */
export type PublicLegQuote = Omit<LegQuote, 'data'>

/**
 * A quote as the browser sees it (`POST /sessions/:id/quotes`). The server keeps the full `Quote`,
 * with each leg's adapter `data`, in its store, and never sends it to the browser.
 */
export type PublicQuote = Omit<Quote, 'legs'> & { legs: PublicLegQuote[] }

export type OpenRampErrorCode =
  | 'REGION_UNSUPPORTED'
  | 'AMOUNT_TOO_LOW'
  | 'AMOUNT_TOO_HIGH'
  | 'QUOTE_EXPIRED'
  | 'NO_QUOTES'
  | 'PROVIDER_DECLINED'
  | 'KYC_REJECTED'
  | 'PAYMENT_FAILED'
  | 'PAYMENT_REVERSED'
  | 'DELIVERY_FAILED'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'CLIENT_UPGRADE_REQUIRED'
  | 'SESSION_EXPIRED'
  | 'UNAUTHORIZED'
  | 'CONFLICT'
  | 'ADDRESS_REJECTED'
  | 'DESTINATION_NOT_ALLOWED'
  | 'DESTINATION_LOCKED'
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'INTERNAL'
  /** A provider error that maps to no other code. The provider's own code stays in the server logs. */
  | 'PROVIDER_ERROR'
  /** The session was canceled */
  | 'CANCELED'
  | 'IDEMPOTENCY_MISMATCH'
  /** A create repeated an `externalId` for another user, with other input, or after a final status */
  | 'EXTERNAL_ID_CONFLICT'
  /** The user closed the UI before the session finished (`openDeposit()`, `openWithdraw()` and the UI packages) */
  | 'CLOSED'

export type OpenRampError = {
  code: OpenRampErrorCode
  /** Safe to show to the user */
  message: string
  retryable: boolean
  recovery?: 'requote' | 'retry_payment' | 'choose_other' | 'contact_support'
  legId?: string
}

// ---------- Flow ----------

export type StateName =
  | 'SELECT_METHOD'
  | 'QUOTE'
  | 'AUTH'
  | 'KYC'
  | 'PAYMENT'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED'
  | 'EXPIRED'
  | 'REFUNDED'
  /** The payment completed, then the provider took it back (a refund or a chargeback after success) */
  | 'REVERSED'
  | 'BLOCKED'
  /** The app or the user canceled the session (`POST /sessions/:id/cancel`) */
  | 'CANCELED'

/** An EVM transaction for the wallet to send */
export type EvmTxRequest = { kind?: 'evm'; to: string; data?: string; value?: string; chainId: number; gas?: string }

/** A Solana instruction in the JSON form that Relay returns. `data` is hex. */
export type SolanaInstruction = {
  programId: string
  keys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>
  /** Instruction data, hex (with or without `0x`) */
  data: string
}

/**
 * A Solana transaction for the wallet to sign and send. The wallet adds the fee payer
 * (the connected account) and a recent blockhash.
 * - `instructions`: build a v0 transaction from these instructions (Relay's Solana steps).
 * - `transaction`: an already built transaction, base64 wire format (unsigned or partly signed).
 * - `transfer`: move `amount` base units of `mint` (or `native` SOL) to the owner address `to`.
 *   For an SPL token the wallet creates the recipient's associated token account when it is missing.
 */
export type SolanaTxRequest =
  | { kind: 'solana'; type: 'instructions'; instructions: SolanaInstruction[]; addressLookupTableAddresses?: string[] }
  | { kind: 'solana'; type: 'transaction'; transaction: string }
  | { kind: 'solana'; type: 'transfer'; to: string; mint: string; amount: string; decimals: number }

/** A transaction for the wallet: EVM (no `kind`, or `kind: 'evm'`) or Solana (`kind: 'solana'`) */
export type TxRequest = EvmTxRequest | SolanaTxRequest

export function isSolanaTx(tx: TxRequest): tx is SolanaTxRequest {
  return tx.kind === 'solana'
}

export function isEvmTx(tx: TxRequest): tx is EvmTxRequest {
  return tx.kind !== 'solana'
}

export type FieldSpec = {
  id: string
  label: string
  type: 'text' | 'email' | 'tel' | 'number' | 'select' | 'checkbox'
  required?: boolean
  options?: Array<{ value: string; label: string }>
}

/** How to read `postMessage` events from an IFRAME surface. */
export type IframeMessages = {
  /** Allowed sender origin. Default: the surface `origin` */
  origin?: string
  /** Event types that mean the user finished paying */
  completed?: string[]
  /** Event types that mean the payment failed */
  failed?: string[]
  /** Event types that mean the user closed the provider page */
  closed?: string[]
  /** Field of `event.data` that holds the type. Default: `type` */
  typeField?: string
}

export type Surface =
  | { kind: 'REDIRECT'; url: string; popup: boolean; provider?: string; /** Keep the Referer header on the start redirect (some providers check it) */ keepReferrer?: boolean }
  | {
      kind: 'IFRAME'
      url: string
      origin: string
      allow?: string
      height?: number
      provider?: string
      /** `referrerpolicy` of the frame. Default: `strict-origin-when-cross-origin`. Some providers need `no-referrer`. */
      referrerPolicy?: 'no-referrer' | 'strict-origin-when-cross-origin'
      /**
       * `postMessage` events from the provider page that end the user's part of the step.
       * The UI only uses them to check the status at once (or to show a "closed" notice).
       * It never takes the outcome from a message: the server status is the source of truth.
       */
      messages?: IframeMessages
    }
  | { kind: 'PROVIDER_SDK'; provider: string; params: Record<string, unknown> }
  | { kind: 'QR'; payload: string; amount: string; currency: string; reference?: string; method?: string; expiresAt?: string }
  | { kind: 'DEEPLINK'; url: string; appName: string }
  | { kind: 'BANK_FIELDS'; fields: Array<{ label: string; value: string; copy: boolean }> }
  | {
      kind: 'DEPOSIT_ADDRESS'
      chain: string
      chainName?: string
      token: string
      symbol?: string
      address: string
      min?: string
      memo?: string
      warning?: string
    }
  | { kind: 'WALLET_TX'; chain: string; txs: TxRequest[] }
  | { kind: 'OTP'; channel: 'email' | 'sms'; to: string }
  | { kind: 'FORM'; fields: FieldSpec[] }

export type PollSpec = { intervalMs: number; backoff: number; maxIntervalMs: number; giveUpAfterMs: number }

export type Transition =
  | { name: string; kind: 'SUBMIT'; label: string; inputs?: FieldSpec[] }
  | { name: string; kind: 'AWAIT'; poll: PollSpec }
  | { name: string; kind: 'SURFACE_RESULT'; expects: 'completed' | 'closed' | 'tx_hash' }

export type LegStatus =
  | 'pending'
  | 'requires_action'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'refunded'
  | 'expired'
  /** The provider took back a payment (a chargeback or a reversal) */
  | 'reversed'

/**
 * The closed list of sub-states that `Step.sub` can have: a finer label inside `Step.state` for the UI.
 * The values are i18n keys in `@openrampkit/web` (`messages.stepSub`). Adapters map provider statuses to
 * these values and put the raw provider status in `LegStep.providerStatus` (timeline and logs only).
 */
export const STEP_SUBS = [
  // KYC
  'kyc_details',
  'kyc_terms',
  'kyc_verify',
  'kyc_review',
  // PAYMENT: what the user does
  'card_details',
  'bank_details',
  'payout_account',
  'send_crypto',
  // PROCESSING: what the provider or the chain does
  'waiting_for_deposit',
  'ambiguous_deposit',
  'confirming',
  'bridging',
  'settling',
  'delayed',
  'refunding',
  'processing',
] as const

/** A value of `Step.sub` (see `STEP_SUBS`) */
export type StepSub = (typeof STEP_SUBS)[number]

const STEP_SUB_SET: ReadonlySet<string> = new Set(STEP_SUBS)

/** True when `v` is one of `STEP_SUBS` */
export function isStepSub(v: unknown): v is StepSub {
  return typeof v === 'string' && STEP_SUB_SET.has(v)
}

export type Step = {
  sessionId: string
  state: StateName
  /** A finer label inside `state` (see `STEP_SUBS`). The server drops a value that is not in the list. */
  sub?: StepSub
  legIndex?: number
  surface?: Surface
  transitions: Transition[]
  error?: OpenRampError
  progress?: {
    legs: Array<{
      adapterId: string
      legId: string
      provider?: string
      status: LegStatus
      /** The leg's main transaction: the delivery (fill) when the provider reports it, else the one the user sent */
      txHash?: string
      /** The transaction that paid into the leg (the user's wallet transaction or deposit), when the adapter knows it */
      sourceTxHash?: string
    }>
  }
  expiresAt?: string
}

/** What an adapter returns for one leg; the server wraps it into a Step */
export type LegStep = {
  state: StateName
  /** A finer label inside `state`, from the closed list `STEP_SUBS`. Map provider statuses to it. */
  sub?: StepSub
  /**
   * The provider's own status for this step (for example Relay `pending`), for operators. The server
   * keeps it in the session timeline. It never reaches the browser.
   */
  providerStatus?: string
  surface?: Surface
  transitions: Transition[]
  status: LegStatus
  error?: OpenRampError
  /** Provider reference, used to route webhooks and status checks */
  ref?: string
  output?: Amount
  /**
   * The leg's main transaction. For a bridge or swap it is the delivery (fill) on the destination chain
   * once the provider reports it; before that, the transaction the user sent.
   */
  txHash?: string
  /**
   * The transaction that paid into the leg: the one the user's wallet (or the app treasury) sent on the
   * origin chain, or the transfer into a deposit address. Equal to `txHash` for a same-chain transfer.
   * The server keeps the last value when a later step leaves it out.
   */
  sourceTxHash?: string
}

// ---------- Sessions ----------

/**
 * The coarse status of a session, for apps and webhooks. The names follow Stripe PaymentIntents.
 * - `requires_payment_method`: no payment in progress. The user picks a method, an amount and a quote.
 *   After a failed attempt the session comes back here, with `lastError` set (`session.payment_failed`).
 * - `requires_action`: a payment started, and the active leg waits for the user: for example to pay,
 *   send from the wallet, or finish a provider step. No money moved on this leg yet.
 * - `processing`: the user paid (or acted), and the provider or the chain is working.
 * - `succeeded`: every leg succeeded. Final (it can still become `reversed`).
 * - `failed`: final failure, with `lastError`. No new attempt is possible (`session.failed`).
 * - `canceled`: the app or the user canceled the session before a payment was under way. Final.
 * - `expired`: the deadline passed with no payment. Final (a late payment can still move it on).
 * - `refunded`: the provider returned the funds before success. Final.
 * - `reversed`: the payment succeeded, then the provider refunded it or took it back. Take back or freeze the credit.
 */
export type SessionStatus =
  | 'requires_payment_method'
  | 'requires_action'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'expired'
  | 'refunded'
  | 'reversed'

/** The statuses after which a session takes no new payment attempt */
export const FINAL_SESSION_STATUSES: readonly SessionStatus[] = ['succeeded', 'failed', 'canceled', 'expired', 'refunded', 'reversed']

/** True when `status` is final: the session takes no new payment attempt (see `FINAL_SESSION_STATUSES`) */
export function isFinalStatus(status: SessionStatus): boolean {
  return FINAL_SESSION_STATUSES.includes(status)
}

export type PublicSession = {
  id: string
  direction: Direction
  /**
   * Where the money ends. Deposit: set by the app at creation. Withdraw: the target the user
   * picked with `POST /sessions/:id/target`; absent until then.
   */
  destination?: Destination
  /** Withdraw only: the asset the session sends out, and who holds it */
  source?: WithdrawSource
  /** Withdraw only: the targets the app allows */
  allowedDestinations?: AllowedDestinations
  /**
   * Withdraw only: true when the app set the target at creation and locked it (`lockDestination`).
   * `destination` is that target. `POST /sessions/:id/target` answers `409 DESTINATION_LOCKED`.
   */
  destinationLocked?: boolean
  status: SessionStatus
  country?: string
  currency?: string
  /** BCP 47 locale set when the session was created, e.g. `vi` or `en-US` */
  locale?: string
  amountBounds?: { min?: string; max?: string; currency: string }
  step: Step
  /** What was paid and delivered, once a payment started. Final when `status` is `succeeded`. */
  result?: SessionResult
  /**
   * The error of the last failed payment attempt (status `requires_payment_method`), or of the final
   * failure (status `failed`). Cleared when a new payment starts.
   */
  lastError?: OpenRampError
  /** Set when the session was canceled (status `canceled`) */
  canceled?: { at: string; reason: CancelReason }
  expiresAt: string
  livemode: boolean
}

export type SessionResult = {
  method: string
  provider: string
  /** What the user paid (first leg input) */
  input: Amount
  /** What arrived: the last leg's reported output, else its quoted output */
  output: Amount
  /** True when `output` comes from the provider or chain, false when it is the quote */
  outputConfirmed: boolean
  fees: Fee[]
  /** The main transaction of each leg (`LegStep.txHash`): for a bridge or swap, the delivery (fill) on the destination chain */
  txHashes: string[]
  /**
   * The transaction that paid into each leg (`LegStep.sourceTxHash`), when the adapter reports it: for
   * example the origin chain transaction that the user's wallet sent. Absent when no leg reports one.
   */
  sourceTxHashes?: string[]
  /**
   * Set when a provider reported less output than the quote, by more than the server's tolerance
   * (`policy.outputToleranceBps`), or an output that is not comparable with the quote (another asset,
   * or not a number). `received` is the reported output. Check it before you credit.
   */
  amountMismatch?: AmountMismatch
}

/**
 * A leg's reported output that the server cannot accept as a full delivery:
 * - `short`: less than the quote, by more than the tolerance.
 * - `asset_mismatch`: in another asset (another token, chain or currency) than the quote.
 * - `invalid_amount`: the reported or the quoted amount is not a decimal number.
 */
export type AmountMismatch = {
  reason: 'short' | 'asset_mismatch' | 'invalid_amount'
  /** Index of the leg in the pathway */
  legIndex: number
  /** The quoted output of the leg */
  expected: Amount
  /** The output that the provider reported */
  received: Amount
  /** `expected - received` for `short`. The full expected amount for the other reasons. */
  shortfall: string
}

// ---------- Events ----------

/** The version of the webhook payload format. It changes only on a breaking change of the wire format. */
export const API_VERSION = 1

/**
 * The backend view of a session: the browser view (`PublicSession`) plus the app's own data. Webhooks
 * and `openramp.sessions.retrieve()` return it. Never send it to the browser.
 */
export type Session = PublicSession & {
  userId: string
  /** The app's own id for this session (`externalId` at create). Unique per app. */
  externalId?: string
  metadata: Record<string, string>
}

/** The leg of a payment that an event is about */
export type EventLeg = {
  /** The payment attempt: 0 for the first payment, then 1, 2 ... after `restart` */
  attempt?: number
  /** Index of the leg in the pathway */
  index: number
  adapterId: string
  legId: string
}

/** An operator decision (`admin.resolve`), on the event it sent */
export type EventResolution = { by: 'admin'; state: 'COMPLETED' | 'FAILED' | 'REFUNDED' | 'EXPIRED'; note: string; at: string }

/** Why a session was canceled */
export type CancelReason = 'requested_by_app' | 'requested_by_user' | 'abandoned'

/** Why a payment counts as late (`session.late_payment`) */
export type LatePaymentReason = 'after_expiry' | 'after_grace' | 'earlier_attempt' | 'after_cancel'

/** The fields that each webhook event type adds to `data.object` (next to `session`) */
export type WebhookEventFields = {
  'session.created': {}
  'session.requires_action': EventLeg
  'session.processing': EventLeg
  'session.succeeded': { resolution?: EventResolution }
  /** An attempt failed. The user can try again: the status is `requires_payment_method`. */
  'session.payment_failed': EventLeg & { error: OpenRampError }
  /** Final failure. No event follows it. */
  'session.failed': { error?: OpenRampError; resolution?: EventResolution }
  'session.canceled': { reason: CancelReason }
  'session.expired': { resolution?: EventResolution }
  'session.refunded': { resolution?: EventResolution }
  /** The provider took back a payment after it succeeded. `attempt` is set for an earlier attempt. */
  'session.reversed': EventLeg & { legStatus: 'refunded' | 'reversed'; previous: StateName }
  'session.late_payment': EventLeg & { reason: LatePaymentReason; txHash?: string }
  'leg.succeeded': EventLeg
  'leg.failed': EventLeg & { error?: OpenRampError }
}

/** A webhook event type */
export type WebhookEventType = keyof WebhookEventFields

/** All webhook event types */
export const WEBHOOK_EVENT_TYPES: readonly WebhookEventType[] = [
  'session.created',
  'session.requires_action',
  'session.processing',
  'session.succeeded',
  'session.payment_failed',
  'session.failed',
  'session.canceled',
  'session.expired',
  'session.refunded',
  'session.reversed',
  'session.late_payment',
  'leg.succeeded',
  'leg.failed',
]

/** The webhook event of one type */
export type WebhookEventOf<T extends WebhookEventType> = {
  /** Deterministic (`evt_...`): the same change always has the same id, also on a retry */
  id: string
  object: 'event'
  /** The payload format version (`API_VERSION`) */
  apiVersion: typeof API_VERSION
  type: T
  /** ISO 8601 time when the server made the event */
  createdAt: string
  livemode: boolean
  sessionId: string
  data: { object: { session: Session } & WebhookEventFields[T] }
}

/**
 * A signed event that the server sends to the app backend. Narrow it on `type`, for example
 * `if (event.type === 'session.succeeded') event.data.object.session.result`.
 */
export type WebhookEvent = { [T in WebhookEventType]: WebhookEventOf<T> }[WebhookEventType]

/** The data that each browser event type carries */
export type ClientEventFields = {
  'modal.opened': {}
  'target.selected': { type: 'crypto'; chain: string; token: string } | { type: 'fiat'; currency: string }
  'method.selected': { method: string }
  'quotes.shown': { method: string; count: number }
  'quote.selected': { quoteId: string }
  'step.changed': { state: StateName; sub?: StepSub }
  'surface.opened': { kind: SurfaceKind }
  'surface.message': { kind: 'completed' | 'failed' | 'closed'; detail?: unknown }
  'modal.closed': { screen: string; state?: StateName }
}

/** A browser UI event type (`onEvent` of the client and the UI packages) */
export type ClientEventType = keyof ClientEventFields

/** The browser UI event of one type */
export type ClientEventOf<T extends ClientEventType> = {
  id: string
  type: T
  /** ISO 8601 */
  createdAt: string
  livemode: boolean
  sessionId?: string
  data: { object: ClientEventFields[T] }
}

/**
 * An event from the browser UI, for analytics. It is not signed and is not a source of truth: credit
 * only from a `WebhookEvent`.
 */
export type ClientEvent = { [T in ClientEventType]: ClientEventOf<T> }[ClientEventType]
