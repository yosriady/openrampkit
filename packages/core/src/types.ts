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

/** What a fee pays for */
export type FeeKind = 'provider' | 'network' | 'app' | 'swap' | 'bridge' | 'other'

export type Fee = {
  kind: FeeKind
  label: string
  /**
   * The fee in its own asset (a fiat currency, or a token on a chain). `null`: the provider takes this
   * fee but does not say how much (for example a fee in the exchange rate). A UI must not show
   * "No fees" for a quote with such a fee.
   */
  amount: Amount | null
  /**
   * True: the quote already counts this fee. It is part of `input`, or the provider takes it in the
   * rate or from `output`. False: the user pays it on top of `input` (for example network gas that
   * the wallet pays).
   */
  included: boolean
}

/**
 * How firm a quote is:
 * - `firm`: the provider delivers `output` exactly, if the user pays before `expiresAt`.
 * - `min_output`: the provider delivers at least `minOutput` (for example a bridge with slippage).
 * - `estimate`: `output` is an estimate. The rate is set when the provider executes (most fiat
 *   onramps and offramps).
 */
export type QuoteGuarantee = 'firm' | 'min_output' | 'estimate'

/** Amount on one side of a leg or pathway */
export type Amount = { value: string; asset: Asset }

export type LegQuote = {
  adapterId: string
  legId: string
  input: Amount
  output: Amount
  fees: Fee[]
  /** How firm `output` is (see `QuoteGuarantee`) */
  guarantee: QuoteGuarantee
  /** The least output the provider guarantees, in the asset of `output`. Set for `min_output`. */
  minOutput?: Amount
  /** The slippage the provider allows, in basis points, when it says it */
  slippageBps?: number
  /** Seconds */
  eta: { min: number; max: number }
  /** ISO 8601. Always set: use `quoteExpiresAt()` from `@openrampkit/adapter`. */
  expiresAt: string
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
  /** The expected output. See `guarantee` for how firm it is. */
  output: Amount
  /** The weakest guarantee of the legs: a leg cannot promise more than the leg that feeds it */
  guarantee: QuoteGuarantee
  /** The least output, from the last leg. Set when `guarantee` is `firm` (equal to `output`) or `min_output`. */
  minOutput?: Amount
  /** The slippage of the last leg, in basis points, when `guarantee` is not `estimate` */
  slippageBps?: number
  fees: Fee[]
  eta: { min: number; max: number }
  /** ISO 8601: the earliest expiry of the legs. Always set. */
  expiresAt: string
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
 * The closed list of `Step.detail.code` values: a finer label inside `Step.state` for the UI. The values
 * are i18n keys in `@openrampkit/web` (`messages.stepDetail`). Adapters map provider statuses to these
 * codes, and keep the raw provider status in `detail.providerStatus`.
 */
export const STEP_DETAIL_CODES = [
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

/** A value of `StepDetail.code` (see `STEP_DETAIL_CODES`) */
export type StepDetailCode = (typeof STEP_DETAIL_CODES)[number]

const STEP_DETAIL_SET: ReadonlySet<string> = new Set(STEP_DETAIL_CODES)

/** True when `v` is one of `STEP_DETAIL_CODES` */
export function isStepDetailCode(v: unknown): v is StepDetailCode {
  return typeof v === 'string' && STEP_DETAIL_SET.has(v)
}

/** A finer label inside `Step.state` */
export type StepDetail = {
  /** From the closed list `STEP_DETAIL_CODES`. The server drops a step detail with another code. */
  code: StepDetailCode
  /**
   * The provider's own status (for example Relay `pending`), for display and support. Free text: at
   * most 64 characters of letters, digits, spaces and `_ - . :` (the server drops other values).
   */
  providerStatus?: string
}

/** What a transaction did for a leg */
export type TransactionRole =
  /** A token approval before the payment. It moves no funds. */
  | 'approval'
  /** The transaction that paid into the leg: the user's wallet transaction, a deposit, or a treasury send */
  | 'source'
  /** The delivery of a leg that is not the last one, to the next leg (the server sets it from `destination`) */
  | 'hop'
  /** The delivery of the last leg to the destination */
  | 'destination'
  /** The delivery through an OpenRampSettlement contract */
  | 'settlement'
  /** A refund to the user */
  | 'refund'

/** An onchain transaction of a payment */
export type Transaction = {
  role: TransactionRole
  /** CAIP-2 chain id */
  chain: string
  hash: string
  /** Index of the leg in the pathway */
  legIndex: number
  /** The amount that the transaction moved, when known */
  amount?: Amount
  /** A block explorer link, when the adapter gives one */
  explorerUrl?: string
}

/**
 * A transaction as an adapter reports it. The server adds `legIndex`, takes `chain` from the leg when
 * the adapter leaves it out (the `to` chain for a delivery, else the `from` chain), and reports a
 * `destination` of a leg that is not the last one as a `hop`. One transaction can have two roles (for
 * example a same-chain transfer is both the `source` and the `destination`).
 */
export type LegTransaction = {
  role: Exclude<TransactionRole, 'hop'>
  chain?: string
  hash: string
  amount?: Amount
  explorerUrl?: string
}

/** What the user must do in a step: the phase, the UI surface and the moves the UI may make */
export type LegAction = {
  /** The phase: `auth` (sign in to the provider), `kyc` (identity checks) or `payment` (pay or send) */
  kind: 'auth' | 'kyc' | 'payment'
  /**
   * What the UI shows. Absent: the UI keeps the surface of the current action (for example a status
   * poll while the user pays in a provider page).
   */
  surface?: Surface
  transitions: Transition[]
}

/**
 * What an adapter returns for one leg (`start()`, `transition()`, `status()`), and what a provider
 * event carries (`LegEvent` in `@openrampkit/adapter`). The server derives `Step.state` from it with
 * `stateFor()`. Rules (the conformance kit checks them):
 * - `status: 'requires_action'` has an `action`. Other statuses have none.
 * - `phase` is only for `pending` and `processing`.
 */
export type LegStep = {
  status: LegStatus
  /** Set when, and only when, `status` is `requires_action` */
  action?: LegAction
  /**
   * For `pending` and `processing` only: the leg waits in a phase before the payment, for example a
   * KYC review (`kyc`). The UI then shows that phase (`Step.state` KYC). Absent: the payment is in progress.
   */
  phase?: 'auth' | 'kyc'
  /** For a step that is not final and has no action: how often the UI checks. Default: the server poll. */
  poll?: PollSpec
  detail?: StepDetail
  error?: OpenRampError
  /** Our reference for the leg, used to route webhooks and status checks. Set it on the first step. */
  ref?: string
  /**
   * The provider's own id for the order (for example a MoonPay transaction id or a Transak order id),
   * when the provider gives one. Apps show it to the user for provider support. When the provider's
   * order id is our `ref` (for example a Stripe session id), set both.
   */
  providerRef?: string
  /** The output that the provider or the chain reports */
  output?: Amount
  /**
   * The transactions of the leg that the adapter knows. The server keeps every transaction that a
   * leg reported, also when a later step leaves it out.
   */
  transactions?: LegTransaction[]
}

const ACTION_STATE: Record<LegAction['kind'], StateName> = { auth: 'AUTH', kyc: 'KYC', payment: 'PAYMENT' }

const STATUS_STATE: Record<LegStatus, StateName> = {
  pending: 'PROCESSING',
  requires_action: 'PAYMENT',
  processing: 'PROCESSING',
  succeeded: 'COMPLETED',
  failed: 'FAILED',
  refunded: 'REFUNDED',
  expired: 'EXPIRED',
  reversed: 'REVERSED',
}

/**
 * The UI phase (`Step.state`) of a leg step. The one rule for the server, the adapter test kit and
 * adapters:
 * - `requires_action`: the action kind (AUTH, KYC or PAYMENT; PAYMENT without an action).
 * - `pending` and `processing`: the `phase` (AUTH or KYC), else PROCESSING.
 * - `succeeded`: COMPLETED. `failed`, `refunded`, `expired`, `reversed`: the same name in upper case.
 */
export function stateFor(step: Pick<LegStep, 'status' | 'action' | 'phase'>): StateName {
  if (step.status === 'requires_action') return ACTION_STATE[step.action?.kind ?? 'payment'] ?? 'PAYMENT'
  if ((step.status === 'processing' || step.status === 'pending') && step.phase) return ACTION_STATE[step.phase] ?? 'PROCESSING'
  return STATUS_STATE[step.status] ?? 'PROCESSING'
}

export type Step = {
  sessionId: string
  state: StateName
  /** A finer label inside `state` (see `STEP_DETAIL_CODES`) */
  detail?: StepDetail
  legIndex?: number
  surface?: Surface
  transitions: Transition[]
  error?: OpenRampError
  expiresAt?: string
}

/** One leg of a payment, for the app and the user (`PublicSession.payment.legs`) */
export type PaymentLeg = {
  /** Index of the leg in the pathway */
  index: number
  adapterId: string
  legId: string
  /** Display name of the provider */
  provider: string
  /** Our reference for the leg (it routes provider webhooks and status checks), once the leg started */
  ref?: string
  /** The provider's own order id (see `LegStep.providerRef`). Show it to the user for provider support. */
  providerRef?: string
  /** `pending` until the leg starts */
  status: LegStatus
  /** The quoted input of the leg */
  input: Amount
  /** The reported output, else the quoted output */
  output: Amount
  /** True when `output` comes from the provider or the chain */
  outputConfirmed: boolean
  transactions: Transaction[]
}

/** The payment in progress (or the last one), for the app and the user */
export type Payment = {
  /** The attempt: 0 for the first payment, then 1, 2 ... after `restart` */
  attempt: number
  quoteId: string
  method: string
  /** Display name of the first leg's provider */
  provider: string
  /** Index of the active leg */
  activeLeg: number
  legs: PaymentLeg[]
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
  /** The payment in progress, or the last one: its legs, provider references and transactions */
  payment?: Payment
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
  /** Every transaction of the payment, in leg order (see `Transaction.role`) */
  transactions: Transaction[]
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
  'session.late_payment': EventLeg & { reason: LatePaymentReason; transactions?: Transaction[] }
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
  'step.changed': { state: StateName; detail?: StepDetailCode }
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
