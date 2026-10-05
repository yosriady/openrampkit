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
export type AllowedTargets = {
  crypto?: { chains?: string[] }
  fiat?: { currencies?: string[] }
}

/** The target the user picks for a withdrawal (`POST /sessions/:id/target`). */
export type WithdrawTarget =
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
  /** `settlement`: the leg can pay into an OpenRampSettlement contract (destination `settlement`) */
  capabilities?: Array<'webhooks' | 'polling' | 'refunds' | 'exact_output' | 'saved_methods' | 'settlement'>
}

export type Fee = {
  kind: 'provider' | 'network' | 'app' | 'swap' | 'other'
  label: string
  amount: string
  currency: string
}

/** Amount on one side of a leg or pathway */
export type Amount = { amount: string; asset: Asset }

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
  reason?: OrkError
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

export type OrkErrorCode =
  | 'REGION_UNSUPPORTED'
  | 'AMOUNT_TOO_LOW'
  | 'AMOUNT_TOO_HIGH'
  | 'QUOTE_EXPIRED'
  | 'NO_QUOTES'
  | 'PROVIDER_DECLINED'
  | 'KYC_REJECTED'
  | 'PAYMENT_FAILED'
  | 'DELIVERY_FAILED'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'CLIENT_UPGRADE_REQUIRED'
  | 'SESSION_EXPIRED'
  | 'UNAUTHORIZED'
  | 'CONFLICT'
  | 'ADDRESS_REJECTED'
  | 'TARGET_NOT_ALLOWED'
  | 'TARGET_LOCKED'
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'INTERNAL'
  | (string & {})

export type OrkError = {
  code: OrkErrorCode
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
  | 'BLOCKED'

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
  | 'awaiting_user'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'refunded'
  | 'expired'

export type Step = {
  sessionId: string
  state: StateName
  sub?: string
  legIndex?: number
  surface?: Surface
  transitions: Transition[]
  error?: OrkError
  progress?: { legs: Array<{ adapterId: string; legId: string; provider?: string; status: LegStatus; txHash?: string }> }
  expiresAt?: string
}

/** What an adapter returns for one leg; the server wraps it into a Step */
export type LegStep = {
  state: StateName
  sub?: string
  surface?: Surface
  transitions: Transition[]
  status: LegStatus
  error?: OrkError
  /** Provider reference, used to route webhooks and status checks */
  ref?: string
  output?: Amount
  txHash?: string
}

// ---------- Sessions ----------

export type SessionStatus = 'open' | 'processing' | 'completed' | 'failed' | 'expired' | 'refunded'

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
  allowedTargets?: AllowedTargets
  /**
   * Withdraw only: true when the app set the target at creation and locked it (`lockTarget`).
   * `destination` is that target. `POST /sessions/:id/target` answers `409 TARGET_LOCKED`.
   */
  targetLocked?: boolean
  status: SessionStatus
  country?: string
  currency?: string
  /** BCP 47 locale set when the session was created, e.g. `vi` or `en-US` */
  locale?: string
  amountBounds?: { min?: string; max?: string; currency: string }
  step: Step
  /** What was paid and delivered, once a payment started. Final when `status` is `completed`. */
  result?: SessionResult
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
  txHashes: string[]
}

// ---------- Events ----------

export type OrkEventType =
  | 'session.created'
  | 'session.completed'
  | 'session.failed'
  | 'session.expired'
  | 'session.refunded'
  | 'session.late_payment'
  | 'leg.succeeded'
  | 'leg.failed'
  | 'withdrawal.completed'
  | 'withdrawal.failed'
  | 'step.changed'
  | 'modal.opened'
  | 'modal.closed'
  | 'method.selected'
  | 'quotes.shown'
  | 'quote.selected'
  | 'surface.opened'
  | (string & {})

export type OrkEvent<T = unknown> = {
  id: string
  type: OrkEventType
  created: number
  livemode: boolean
  sessionId?: string
  data: { object: T }
}
