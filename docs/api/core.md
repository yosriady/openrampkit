# @openrampkit/core

Types and pure helpers shared by the server, the client and adapters. No network, no DOM.

## Key types

The full definitions are in `packages/core/src/types.ts`. The concept pages explain them:

| Type | See |
|---|---|
| `Asset`, `FiatAsset`, `CryptoAsset`, `Location`, `Endpoint`, `Destination`, `ContractCall` | [Pathways and legs](../concepts/pathways.md) |
| `LegSpec`, `LegKind`, `EndpointMatcher`, `AssetMatcher`, `RegionPolicy` | [Pathways and legs](../concepts/pathways.md#leg-specs) |
| `Pathway`, `PathwayLeg`, `PathwayGroup`, `LegQuote`, `Quote`, `Fee`, `Amount` | [Pathways and legs](../concepts/pathways.md#quoting) |
| `Step`, `StateName`, `Transition`, `PollSpec`, `LegStep`, `LegStatus`, `FieldSpec`, `TxRequest` | [Flow state machine](../concepts/flow.md) |
| `Surface`, `SurfaceKind`, `IframeMessages` | [Surfaces](../concepts/surfaces.md) |
| `OrkError`, `OrkErrorCode` | [Flow: errors as fields](../concepts/flow.md#errors-as-fields) |
| `OrkEvent`, `OrkEventType` | [Events](../concepts/events.md) |
| `WalletAdapter`, `WalletBalance` | [Wallets (wagmi)](../adapters/wagmi.md) |

### PublicSession

What the browser and your backend see of a session:

```ts
type PublicSession = {
  id: string
  direction: 'deposit' | 'withdraw'
  destination: Destination
  status: 'open' | 'processing' | 'completed' | 'failed' | 'expired' | 'refunded'
  country?: string
  currency?: string
  locale?: string
  amountBounds?: { min?: string; max?: string; currency: string }
  step: Step
  expiresAt: string
  livemode: boolean
}
```

### Fee and Quote

```ts
type Fee = { kind: 'provider' | 'network' | 'app' | 'swap' | 'other'; label: string; amount: string; currency: string }

type Quote = {
  id: string; pathwayId: string; method: string; provider: string
  legs: LegQuote[]
  input: Amount; output: Amount   // Amount = { amount: string; asset: Asset }
  fees: Fee[]
  eta: { min: number; max: number } // seconds
  expiresAt?: string
  badges?: Array<'best_price' | 'fastest'>
}
```

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
| `METHOD_COUNTRIES`, `methodAvailableIn(method, country)` | Where local methods exist |
| `DEFAULT_METHOD_PRIORITY` | Default method order per country |
| `COUNTRY_CURRENCY`, `currencyForCountry(country)` | Local currency (USD when unknown) |
| `CURRENCY_MINOR_UNITS`, `minorUnits(currency)` | Minor units (IDR, VND, JPY, KRW: 0; default 2) |
| `CHAINS`, `chainName(chain)`, `evmChainId(chain)` | Known chains (Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain, Monad, HyperEVM, Solana) |
| `USDC` | Well-known USDC addresses (lowercase) on Ethereum, Base, Arbitrum, Optimism, Polygon |

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

## Flow table

| Export | Description |
|---|---|
| `TRANSITION_TABLE` | `Record<StateName, { next: StateName[]; terminal: boolean }>` |
| `TABLE_VERSION` | `1` |
| `isTerminal(state)`, `isLegalMove(from, to)` | |
| `TERMINAL_LEG_STATUSES`, `isLegTerminal(status)` | `succeeded`, `failed`, `refunded`, `expired` |
| `validateStep(step)` | Problems with a step's shape (AWAIT on a terminal state, duplicate transition names) |

## Planner and ranking

| Export | Description |
|---|---|
| `planPathways(input: PlannerInput): PlanResult` | The pure planner. See [the algorithm](../concepts/pathways.md#the-planner-algorithm). |
| `destinationEndpoint(destination)` | The target endpoint |
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
}
```

## Events

| Export | Description |
|---|---|
| `createEvent(type, object, { sessionId?, livemode? })` | An `OrkEvent` with a random `evt_` id |
| `randomId(prefix, bytes = 12)` | `{prefix}_{hex}` |
