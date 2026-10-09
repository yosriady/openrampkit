# @openrampkit/core

Types and pure helpers shared by the server, the client and adapters. No network, no DOM.

## Key types

The full definitions are in `packages/core/src/types.ts`. The concept pages explain them:

| Type | See |
|---|---|
| `Asset`, `FiatAsset`, `CryptoAsset`, `Location`, `Endpoint`, `Destination`, `ContractCall` | [Pathways and legs](../concepts/pathways.md) |
| `LegSpec`, `LegKind`, `LegCapability`, `EndpointMatcher`, `AssetMatcher`, `RegionPolicy` | [Pathways and legs](../concepts/pathways.md#leg-specs) |
| `Pathway`, `PathwayLeg`, `PathwayGroup`, `LegQuote`, `Quote`, `QuoteGuarantee`, `PublicLegQuote`, `PublicQuote`, `Fee`, `FeeKind`, `Amount` | [Pathways and legs](../concepts/pathways.md#quoting) |
| `Step`, `StateName`, `StepDetail`, `StepDetailCode` (with `STEP_DETAIL_CODES` and `isStepDetailCode`), `Transition`, `PollSpec`, `LegStep`, `LegAction`, `LegStatus`, `FieldSpec`, `TxRequest` | [Flow state machine](../concepts/flow.md) |
| `Transaction`, `TransactionRole`, `LegTransaction`, `Payment`, `PaymentLeg`, `Delivery`, `DeliveryStatus` | [Transactions](#transactions), [SessionResult](#sessionresult) |
| `Surface`, `SurfaceKind`, `IframeMessages` | [Surfaces](../concepts/surfaces.md) |
| `OpenRampError`, `OpenRampErrorCode` | [Flow: errors as fields](../concepts/flow.md#errors-as-fields) |
| `WebhookEvent`, `WebhookEventOf`, `WebhookEventType`, `WebhookEventFields` (with `WEBHOOK_EVENT_TYPES` and `API_VERSION`), `ClientEvent`, `ClientEventType`, `ClientEventFields` | [Events](../concepts/events.md) |
| `Session` (the backend view), `PublicSession`, `SessionStatus` (with `isFinalStatus`) | [Sessions](#publicsession) |
| `WalletAdapter`, `WalletBalance` | [Wallets (wagmi)](../adapters/wagmi.md) |
| `WithdrawSource`, `Custody`, `AllowedDestinations`, `WithdrawDestination` | [Withdrawals](../guide/withdraw.md) |

### PublicSession

What the browser and your backend see of a session:

```ts
type PublicSession = {
  id: string
  direction: 'deposit' | 'withdraw'
  destination?: Destination       // deposit: set by the app; withdraw: the target the user picked
  source?: WithdrawSource         // withdraw only
  allowedDestinations?: AllowedDestinations // withdraw only
  destinationLocked?: boolean          // withdraw only: the app set and locked the destination
  status: 'requires_payment_method' | 'requires_action' | 'processing' | 'succeeded' | 'failed' | 'canceled' | 'expired' | 'refunded' | 'reversed'
  country?: string
  currency?: string
  locale?: string
  amountBounds?: { min?: string; max?: string; currency: string }
  step: Step
  payment?: Payment               // the payment in progress (or the last one): legs, provider refs, transactions
  result?: SessionResult          // once a payment started
  lastError?: OpenRampError       // the last failed attempt, or the final failure
  expiresAt: string
  livemode: boolean
}
```

### Session

The backend view of a session: `PublicSession` plus the app's data. Webhooks (`data.object.session`) and `openramp.sessions.retrieve()` return it. Never send it to the browser.

```ts
type Session = PublicSession & {
  userId: string
  metadata: Record<string, string>
}
```

### Session status

| `status` | Meaning |
|---|---|
The names follow Stripe PaymentIntents.

| `status` | Meaning | Final |
|---|---|---|
| `requires_payment_method` | No payment is in progress. The user picks a method, an amount and a quote. After a failed attempt, the session comes back here with `lastError`. | no |
| `requires_action` | A payment started, and the active leg waits for the user: to pay, to send from the wallet, or to finish a provider step (the leg status is `requires_action`). No money moved on this leg yet. | no |
| `processing` | The user paid or acted. The provider or the chain is working. | no |
| `succeeded` | Every leg succeeded. | yes (it can still become `reversed`) |
| `failed` | Final failure, with `lastError`. The session takes no new attempt. | yes |
| `canceled` | The app or the user canceled the session before a payment was under way. | yes |
| `expired` | The session deadline passed with no payment, or the provider order expired. | yes (a late payment can still move it on) |
| `refunded` | The provider returned the payment before it succeeded. | yes |
| `reversed` | The payment succeeded, then the provider refunded it or took it back. | yes |

A failed attempt is not a failed session. When a leg fails and the user can try again, the status goes back to `requires_payment_method`, `lastError` tells why, and the server sends `session.payment_failed`. The status is `failed` (and the server sends `session.failed`) only when the session ends: no attempts are left (`policy.maxAttempts`, default 10), money already arrived on a leg of the payment, or an operator resolved the session as `FAILED`. Nothing follows `session.failed`.

`isFinalStatus(status)` and `FINAL_SESSION_STATUSES` tell the final statuses apart. To find sessions that are not final, check for `requires_payment_method`, `requires_action` and `processing`.

### Payment

The payment in progress, or the last one. It is present once a payment started. Use it to show the legs, the provider order ids and the transactions.

```ts
type Payment = {
  attempt: number      // 0 for the first payment, then 1, 2 ... after `restart`
  quoteId: string
  method: string
  provider: string     // display name of the first leg's provider
  activeLeg: number    // index of the active leg
  legs: PaymentLeg[]
}

type PaymentLeg = {
  index: number
  adapterId: string
  legId: string
  provider: string          // display name of the leg's provider
  ref?: string              // our reference for the leg, once it started
  providerRef?: string      // the provider's own order id: show it to the user for provider support
  status: LegStatus         // 'pending' until the leg starts
  input: Amount             // the quoted input
  output: Amount            // the reported output, else the quoted output
  outputConfirmed: boolean  // true when output comes from the provider or the chain
  transactions: Transaction[]
}
```

`payment` replaces `step.progress` of the adapter API version 1.

### Transactions

Each onchain transaction of a payment is a record with a role:

```ts
type Transaction = {
  role: 'approval' | 'source' | 'hop' | 'destination' | 'settlement' | 'refund'
  chain: string        // CAIP-2
  hash: string
  legIndex: number
  amount?: Amount      // the amount it moved, when known
  explorerUrl?: string // built by the server from its chain table
}
```

| Role | Meaning |
|---|---|
| `approval` | A token approval before the payment. It moves no funds. |
| `source` | The transaction that paid into the leg: the user's wallet transaction, a deposit, or a treasury send. |
| `hop` | The delivery of a leg that is not the last one, to the next leg. The server sets it from the adapter's `destination`. |
| `destination` | The delivery of the last leg to the destination. |
| `settlement` | The delivery through an OpenRampSettlement contract. |
| `refund` | A refund to the user. |

One transaction can have two roles. For example, a same-chain transfer is both the `source` and the `destination`. Adapters report a `LegTransaction` (`{ role, chain?, hash, amount? }`, no `hop`, no link). The server adds `legIndex`, takes `chain` from the leg when the adapter leaves it out, and builds `explorerUrl` with `explorerTxUrl(chain, hash)`. It never takes a link from an adapter.

Any transaction that moves funds (any role but `approval`) makes a failure of the payment final, and blocks cancel and restart.

### SessionResult

What was paid and delivered. It is present once a payment started, and final when `status` is `succeeded`.

```ts
type SessionResult = {
  method: string          // e.g. 'vietqr'
  provider: string        // display name of the first leg's provider
  input: Amount           // what the user paid (the first leg's quoted input)
  output: Amount          // what arrived: the last leg's reported output, else its quoted output
  outputConfirmed: boolean // true when output comes from the provider or the chain; false when it is the quote
  fees: Fee[]             // the fees of every leg's quote
  transactions: Transaction[] // every transaction of the payment, in leg order
  delivery?: Delivery     // the check of a leg's reported output against its quote (see below)
}

type Delivery = {
  status: 'ok' | 'short' | 'asset_mismatch' | 'invalid'
  legIndex: number   // the leg
  expected: Amount   // its quoted output
  minimum?: Amount   // the least output that counts as ok
  received: Amount   // the output the provider or the chain reported
  shortfall?: string // short: expected minus received
}
```

The server checks each leg's reported output against the leg's quote. It fails closed:

- `ok`: the output is at least the quote's `minOutput`. For a quote without `minOutput`, the output is at most `policy.outputToleranceBps` (default 100, that is 1%) below the quoted output. `minimum` is that limit.
- `short`: less than that. The leg keeps its result. The next leg starts (it takes what arrived), and the session can complete. `shortfall` tells how much less than the quoted output arrived.
- `asset_mismatch`: the output is in another asset (another token, chain or currency) than the quote.
- `invalid`: the reported or the quoted amount is not a decimal number.

`delivery` shows the last leg whose delivery is not `ok`. When all are `ok`, it shows the last leg with a checked output. It is absent until a leg reports an output. Credit the full amount only when `delivery.status` is `ok`.

For `asset_mismatch` and `invalid`, `outputConfirmed` is `false` on the last leg. On a leg before the last, the next leg does not start: the step becomes `FAILED` with `DELIVERY_FAILED` (recovery `contact_support`), and an operator checks the funds. The timeline gets `leg.delivery` with the status, and the server sends the metric `leg.delivery_mismatch`. The server checks the output again each time its amount or its asset changes.

To check a delivery on chain, use the `destination` transaction (or the `hop` of a leg before the last). The `source` transaction is the one that the user's wallet (or your treasury) sent.

### Withdraw types

```ts
type Custody = 'user_wallet' | 'app'

type WithdrawSource = { chain: string; token: string; symbol?: string; decimals?: number; custody: Custody }

type AllowedDestinations = {
  crypto?: { chains?: string[] }
  fiat?: { currencies?: string[] }
}

type WithdrawDestination =
  | { type: 'crypto'; chain: string; token: string; address: string; symbol?: string; decimals?: number }
  | { type: 'fiat'; currency: string }
```

`Destination` also has a `{ type: 'fiat'; currency: string }` case: a withdrawal to the user's own bank or e-wallet account.

### Fee and Quote

```ts
type Fee = {
  kind: 'provider' | 'network' | 'app' | 'swap' | 'bridge' | 'other'
  label: string
  amount: Amount | null // null: the provider takes this fee but does not say how much
  included: boolean     // true: the quote already counts it (in input, in the rate or from output); false: the user pays it on top
}

type QuoteGuarantee = 'firm' | 'min_output' | 'estimate'

type Quote = {
  id: string; pathwayId: string; method: string; provider: string
  legs: LegQuote[]
  input: Amount; output: Amount   // Amount = { value: string; asset: Asset }
  guarantee: QuoteGuarantee       // the weakest guarantee of the legs
  minOutput?: Amount              // the least output, from the last leg
  slippageBps?: number            // the slippage of the last leg, when the guarantee is not 'estimate'
  fees: Fee[]
  eta: { min: number; max: number } // seconds
  expiresAt: string               // ISO 8601: the earliest expiry of the legs
  badges?: Array<'best_price' | 'fastest'>
}

/** What the browser gets from `POST /sessions/:id/quotes` */
type PublicLegQuote = Omit<LegQuote, 'data'>
type PublicQuote = Omit<Quote, 'legs'> & { legs: PublicLegQuote[] }
```

A fee amount has its own asset: a fiat currency, or a token on a chain. When a fee has `amount: null`, a UI must not show "No fees" for the quote.

The guarantee tells how firm `output` is:

| `guarantee` | Meaning |
|---|---|
| `firm` | The provider delivers `output` exactly, if the user pays before `expiresAt`. `minOutput` is equal to `output`. |
| `min_output` | The provider delivers at least `minOutput` (for example a bridge with slippage). |
| `estimate` | `output` is an estimate. The rate is set when the provider executes (most fiat onramps and offramps). |

A pathway cannot promise more than its weakest leg. `minOutput` and `slippageBps` come from the last leg. `expiresAt` is the earliest expiry of the legs. Each `LegQuote` also has `guarantee`, `minOutput?`, `slippageBps?` and a required `expiresAt`. The server gives 5 minutes to a leg quote without a valid expiry.

`Quote` is the server-side quote. Each `LegQuote` has the adapter's opaque `data`, which can hold a provider URL with a session token, a request body or an idempotency nonce. The server keeps the full quote in its store and gives `data` only to the adapter's `start()`. The browser, the client and the MCP server get a `PublicQuote`: the same quote without `legs[].data`. It keeps `guarantee`, `minOutput`, `slippageBps` and `expiresAt`.

## Money

Exact decimal math on strings, built on `bigint`. No floats.

| Function | Example |
|---|---|
| `isDecimal(s)` | `isDecimal('12.5')` is `true`; `'1e5'` is `false` |
| `add(a, b)`, `sub(a, b)` | `add('0.1', '0.2')` is `'0.3'` |
| `cmp(a, b)` | `-1`, `0` or `1` |
| `mulRatio(value, ratio)` | `mulRatio('100', '0.25')` is `'25'` |
| `bps(value, points)` | `bps('100', 12)` is `'0.12'` |
| `roundTo(value, digits)` | Half up: `roundTo('1.005', 2)` is `'1.01'` |
| `toBaseUnits(value, decimals)` | `toBaseUnits('12.5', 6)` is `'12500000'` |
| `fromBaseUnits(value, decimals)` | `fromBaseUnits('12500000', 6)` is `'12.5'` |
| `toScaled`, `fromScaled` | Lower-level `bigint` conversion |

Math runs at 18 fraction digits. Extra digits are truncated.

## Codes

| Export | Description |
|---|---|
| `METHODS` | Built-in method vocabulary: `{ id, name, kind }` with kind `card`, `wallet_pay`, `bank`, `qr`, `ewallet`, `crypto` or `exchange` |
| `methodName(id)` | Display name, or the id title-cased |
| `ADDRESS_TRANSFER_METHODS`, `isAddressTransfer(method)` | The methods where the user sends crypto to a deposit address: `transfer` and `exchange_transfer` |
| `METHOD_COUNTRIES`, `methodAvailableIn(method, country)` | Where local methods exist |
| `DEFAULT_METHOD_PRIORITY` | Default method order per country |
| `COUNTRY_CURRENCY`, `currencyForCountry(country)` | Local currency (USD when unknown) |
| `CURRENCY_MINOR_UNITS`, `minorUnits(currency)` | Minor units (IDR, VND, JPY, KRW, CLP, UGX, RWF: 0; default 2) |
| `explorerTxUrl(chain, hash)` | The block explorer link of a transaction, from the trusted chain table. `undefined` for a chain with no explorer, or for a hash that is not an EVM transaction hash or a Solana signature. |
| `CHAINS`, `chainName(chain)`, `evmChainId(chain)` | Known chains (Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain, Monad, HyperEVM, Tempo, Tempo Testnet, Solana, Solana Devnet, Robinhood Chain, Arbitrum Sepolia, Robinhood Chain Testnet). See [Chains and tokens](../concepts/chains.md). |
| `SOLANA_MAINNET`, `SOLANA_DEVNET`, `TEMPO_MAINNET`, `TEMPO_TESTNET` | CAIP-2 ids |
| `isEvmChain(chain)`, `isSolanaChain(chain)`, `nativeDecimals(chain)` | Chain helpers |
| `USDC` | Well-known USDC per chain: Ethereum, Base, Arbitrum, Optimism, Polygon, Tempo, Arbitrum Sepolia (lowercase), Solana (base58 mint as given) |
| `TESTNET_USDC`, `isUsdc(chain, token)` | Testnet USDC (Solana devnet), and a check for mainnet or testnet USDC |
| `SOLANA_USDC_MINT`, `SOLANA_DEVNET_USDC_MINT`, `TEMPO_USDC`, `TEMPO_PATH_USD` | Token addresses |
| `normalizeToken(chain, token)`, `sameToken(chain, a, b)` | EVM addresses lowercased, Solana mints as given |
| `isSolanaAddress`, `isSolanaSignature` | Format checks (base58) |
| `SOLANA_NATIVE_DECIMALS`, `SOLANA_SYSTEM_PROGRAM`, `SPL_TOKEN_PROGRAM`, `SPL_TOKEN_2022_PROGRAM`, `SPL_ASSOCIATED_TOKEN_PROGRAM` | Solana constants: SOL has 9 decimals; the program ids of the System, SPL Token, Token-2022 and Associated Token programs |
| `toSplAmount(value, decimals)`, `fromSplAmount(base, decimals)`, `lamportsToSol`, `solToLamports` | SPL amounts. `toSplAmount` is strict: it refuses extra decimals, negative values and values above u64. |
| `isSolanaTx(tx)`, `isEvmTx(tx)` | Tell `TxRequest` kinds apart |
| `combineWallets(...wallets)`, `accountFor(accounts, chain)`, `chainNamespace(chain)` | Join an EVM and a Solana wallet adapter; pick the account of a chain |

## Region policy

| Export | Description |
|---|---|
| `isRegionAllowed(policy, country?, region?)` | Most specific entry wins; deny wins a tie; an unknown country passes only when `*` is allowed and not denied |
| `combinePolicies(...policies)` | A function that is true when every policy allows |
| `ALLOW_ALL` | `{ allow: ['*'], deny: [] }` |

## Errors

| Export | Description |
|---|---|
| `openRampError(code, overrides?)` | An `OpenRampError` with the default message and retryable flag for the code |
| `OpenRampException` | `new OpenRampException(error, status = 400)`: throw it across boundaries; the server turns it into a JSON error response |
| `isOpenRampError(value)` | Type guard |

Error codes with `retryable: true` by default: `CONFLICT`, `QUOTE_EXPIRED`, `NO_QUOTES`, `PAYMENT_FAILED`, `RATE_LIMITED`, `PROVIDER_UNAVAILABLE`, `INTERNAL`. Codes for withdrawals: `ADDRESS_REJECTED`, `DESTINATION_NOT_ALLOWED` and `DESTINATION_LOCKED`. `CONFLICT` means two requests changed the session at the same time; send the request again.

## URL checks

```ts
isWebUrl(url, { allowHttp? })  // true for an absolute https: URL (http: too with allowHttp)
isSafeLinkUrl(url)             // true for a web URL or an app scheme; false for javascript:, data:, vbscript:, blob:, file:, about:
```

The server, the client and the web component use them on surface URLs. See [Surface URLs](../guide/security.md#surface-urls).

## Constant-time compare

```ts
timingSafeEqual(a, b)  // true when the strings are equal
```

Compares two strings in constant time for a given length, for tokens and signatures. Strings of different lengths give `false` at once, so only the length can leak. When the length is secret too, compare fixed-length values, such as hex digests. `@openrampkit/adapter` exports the same function.

## Flow table

| Export | Description |
|---|---|
| `TRANSITION_TABLE` | `Record<StateName, { next: StateName[]; terminal: boolean }>` |
| `TABLE_VERSION` | `1` |
| `isTerminal(state)`, `isLegalMove(from, to)` | |
| `TERMINAL_LEG_STATUSES`, `isLegTerminal(status)` | `succeeded`, `failed`, `refunded`, `expired`, `reversed` |
| `LEG_STATUS_RANK`, `isLegalLegMove(from, to)` | The order of leg statuses. A provider event moves a leg only to a status of the same or a higher rank. See [Leg status](../concepts/flow.md#leg-status). |
| `validateStep(step)` | Problems with a step's shape (AWAIT on a terminal state, duplicate transition names) |
| `stateFor(legStep)` | The `Step.state` of a leg step: the one rule for the server, the test kit and adapters. See [Leg status](../concepts/flow.md#leg-status). |
| `STEP_DETAIL_CODES`, `isStepDetailCode(v)` | The closed list of `Step.detail.code` values |

## Planner and ranking

| Export | Description |
|---|---|
| `planPathways(input: PlannerInput): PlanResult` | The pure planner. See [the algorithm](../concepts/pathways.md#the-planner-algorithm). |
| `destinationEndpoint(destination)` | The target endpoint |
| `withdrawSourceEndpoint(source)` | The endpoint a withdrawal starts from: the source asset in the user's wallet, or at the app's address |
| `assetMatches(matcher, asset)`, `endpointMatches(matcher, endpoint)` | Matching helpers |
| `rankQuotes(quotes)` | Most output first, then fastest; adds `best_price` and `fastest` badges |

```ts
type PlannerInput = {
  direction: Direction
  destination: Destination
  user: { country?: string; region?: string; walletConnected?: boolean }
  legs: Array<{ adapterId: string; provider: string; spec: LegSpec }>
  policy?: {
    maxLegs?: 1 | 2
    regions?: RegionPolicy
    methodPriority?: Record<string, string[]>
    disabledMethods?: string[]
    clientSurfaces?: SurfaceKind[]
    hopPreference?: CryptoAsset[]
  }
  withdraw?: { source: WithdrawSource; treasury: boolean } // required when direction is 'withdraw'
}
```

## Events

| Export | Description |
|---|---|
| `createClientEvent(type, object, { sessionId?, livemode? })` | A `ClientEvent` with a random `evt_` id and an ISO `createdAt` |
| `createWebhookEvent(type, object, { id, sessionId, livemode })` | A `WebhookEvent` envelope (`object: 'event'`, `apiVersion: 1`, ISO `createdAt`) |
| `randomId(prefix, bytes = 12)` | `{prefix}_{hex}` |
