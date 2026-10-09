# @openrampkit/core

Types and pure helpers shared by the server, the client and adapters. No network, no DOM.

## Key types

The full definitions are in `packages/core/src/types.ts`. The concept pages explain them:

| Type | See |
|---|---|
| `Asset`, `FiatAsset`, `CryptoAsset`, `Location`, `Endpoint`, `Destination`, `ContractCall` | [Pathways and legs](../concepts/pathways.md) |
| `LegSpec`, `LegKind`, `EndpointMatcher`, `AssetMatcher`, `RegionPolicy` | [Pathways and legs](../concepts/pathways.md#leg-specs) |
| `Pathway`, `PathwayLeg`, `PathwayGroup`, `LegQuote`, `Quote`, `PublicLegQuote`, `PublicQuote`, `Fee`, `Amount` | [Pathways and legs](../concepts/pathways.md#quoting) |
| `Step`, `StateName`, `Transition`, `PollSpec`, `LegStep`, `LegStatus`, `FieldSpec`, `TxRequest` | [Flow state machine](../concepts/flow.md) |
| `Surface`, `SurfaceKind`, `IframeMessages` | [Surfaces](../concepts/surfaces.md) |
| `OrkError`, `OrkErrorCode` | [Flow: errors as fields](../concepts/flow.md#errors-as-fields) |
| `OrkEvent`, `OrkEventType` | [Events](../concepts/events.md) |
| `WalletAdapter`, `WalletBalance` | [Wallets (wagmi)](../adapters/wagmi.md) |
| `WithdrawSource`, `Custody`, `AllowedTargets`, `WithdrawTarget` | [Withdrawals](../guide/withdraw.md) |

### PublicSession

What the browser and your backend see of a session:

```ts
type PublicSession = {
  id: string
  direction: 'deposit' | 'withdraw'
  destination?: Destination       // deposit: set by the app; withdraw: the target the user picked
  source?: WithdrawSource         // withdraw only
  allowedTargets?: AllowedTargets // withdraw only
  targetLocked?: boolean          // withdraw only: the app set and locked the target
  status: 'open' | 'processing' | 'completed' | 'failed' | 'expired' | 'refunded' | 'reversed'
  country?: string
  currency?: string
  locale?: string
  amountBounds?: { min?: string; max?: string; currency: string }
  step: Step
  result?: SessionResult          // once a payment started
  expiresAt: string
  livemode: boolean
}
```

### SessionResult

What was paid and delivered. It is present once a payment started, and final when `status` is `completed`.

```ts
type SessionResult = {
  method: string          // e.g. 'vietqr'
  provider: string        // display name of the first leg's provider
  input: Amount           // what the user paid (the first leg's quoted input)
  output: Amount          // what arrived: the last leg's reported output, else its quoted output
  outputConfirmed: boolean // true when output comes from the provider or the chain; false when it is the quote
  fees: Fee[]             // the fees of every leg's quote
  txHashes: string[]      // transaction hashes the legs reported, in leg order
  amountMismatch?: AmountMismatch // a leg reported less than its quote (see below)
}

type AmountMismatch = {
  reason: 'short' | 'asset_mismatch' | 'invalid_amount'
  legIndex: number   // the leg
  expected: Amount   // its quoted output
  received: Amount   // the output the provider reported
  shortfall: string  // short: expected minus received. Other reasons: the full expected amount.
}
```

The server compares each leg's reported output with the leg's quote. It fails closed:

- `short`: the provider reports less than the quote by more than `policy.outputToleranceBps` (default 100, that is 1%). The leg keeps its result. The next leg starts (it takes what arrived), and the session can complete.
- `asset_mismatch`: the output is in another asset (another token, chain or currency) than the quote.
- `invalid_amount`: the reported or the quoted amount is not a decimal number.

For `asset_mismatch` and `invalid_amount`, `outputConfirmed` is `false` on the last leg. On a leg before the last, the next leg does not start: the step becomes `FAILED` with `DELIVERY_FAILED` (recovery `contact_support`), and an operator checks the funds. When more than one leg has a mismatch, `amountMismatch` shows the last one. The timeline gets `leg.amount_mismatch` with the reason. The server checks the output again each time its amount or its asset changes.

### Withdraw types

```ts
type Custody = 'user_wallet' | 'app'

type WithdrawSource = { chain: string; token: string; symbol?: string; decimals?: number; custody: Custody }

type AllowedTargets = {
  crypto?: { chains?: string[] }
  fiat?: { currencies?: string[] }
}

type WithdrawTarget =
  | { type: 'crypto'; chain: string; token: string; address: string; symbol?: string; decimals?: number }
  | { type: 'fiat'; currency: string }
```

`Destination` also has a `{ type: 'fiat'; currency: string }` case: a withdrawal to the user's own bank or e-wallet account.

### Fee and Quote

```ts
type Fee = {
  kind: 'provider' | 'network' | 'app' | 'swap' | 'other'; label: string; amount: string; currency: string
  /** The fee is in the exchange rate. With amount '0', the provider did not say how much: do not show "No fees". */
  inRate?: boolean
}

type Quote = {
  id: string; pathwayId: string; method: string; provider: string
  legs: LegQuote[]
  input: Amount; output: Amount   // Amount = { amount: string; asset: Asset }
  fees: Fee[]
  eta: { min: number; max: number } // seconds
  expiresAt?: string
  badges?: Array<'best_price' | 'fastest'>
}

/** What the browser gets from `POST /sessions/:id/quotes` */
type PublicLegQuote = Omit<LegQuote, 'data'>
type PublicQuote = Omit<Quote, 'legs'> & { legs: PublicLegQuote[] }
```

`Quote` is the server-side quote. Each `LegQuote` has the adapter's opaque `data`, which can hold a provider URL with a session token, a request body or an idempotency nonce. The server keeps the full quote in its store and gives `data` only to the adapter's `start()`. The browser, the client and the MCP server get a `PublicQuote`: the same quote without `legs[].data`.

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
| `orkError(code, overrides?)` | An `OrkError` with the default message and retryable flag for the code |
| `OrkException` | `new OrkException(error, status = 400)`: throw it across boundaries; the server turns it into a JSON error response |
| `isOrkError(value)` | Type guard |

Error codes with `retryable: true` by default: `CONFLICT`, `QUOTE_EXPIRED`, `NO_QUOTES`, `PAYMENT_FAILED`, `RATE_LIMITED`, `PROVIDER_UNAVAILABLE`, `INTERNAL`. Codes for withdrawals: `ADDRESS_REJECTED`, `TARGET_NOT_ALLOWED` and `TARGET_LOCKED`. `CONFLICT` means two requests changed the session at the same time; send the request again.

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
| `createEvent(type, object, { sessionId?, livemode? })` | An `OrkEvent` with a random `evt_` id |
| `randomId(prefix, bytes = 12)` | `{prefix}_{hex}` |
