# @openrampkit/adapter

The adapter API: `createAdapter()`, the `Adapter` interface, helpers for provider calls, and a test kit at `@openrampkit/adapter/testing`. For a walkthrough, read [Writing an adapter](../adapters/writing-an-adapter.md).

## createAdapter(definition)

```ts
import { createAdapter, ADAPTER_API_VERSION } from '@openrampkit/adapter'

const adapter = createAdapter({ id: 'acme', name: 'Acme Pay', legs, quote, start })
```

Throws when `id` is not lowercase letters, digits or dashes, or when two legs share an id. Sets `apiVersion` to `ADAPTER_API_VERSION` (`2`). A definition with another `apiVersion` throws, with a message that tells you what to update. See [Upgrade from version 1](../adapters/writing-an-adapter.md#upgrade-from-version-1).

## Adapter

```ts
interface Adapter {
  id: string
  name: string
  apiVersion: number
  readonly env?: 'sandbox' | 'production'   // AdapterEnv. Undefined: follows each session's livemode
  legs: LegSpec[]
  catalog?(input: CatalogInput, ctx: Pick<AdapterContext, 'fetch' | 'log' | 'shared'>): Promise<LegSpec[]>
  quote(input: QuoteInput, ctx: AdapterContext): Promise<LegQuote>
  prepareDeposit?(input: { leg: PathwayLeg; amountIn?: Amount }, ctx: AdapterContext):
    Promise<{ address: string; ref?: string; data?: Record<string, unknown> }>
  start(input: StartInput, ctx: AdapterContext): Promise<LegStep>
  transition?(input: TransitionInput, ctx: AdapterContext): Promise<LegStep>
  status?(input: { leg: PathwayLeg; ref: string }, ctx: AdapterContext): Promise<LegStep>
  webhook?: {
    // Optional: false when the options have no webhook secret, so no event can verify. Default true.
    configured?: boolean
    verify(req: Request, rawBody: string, ctx: WebhookContext): Promise<boolean>
    parse(rawBody: string, ctx: WebhookContext & { url?: string }): Promise<LegEvent[]>
    // Optional: the same key for every delivery of one provider event. The server ignores a repeat for 7 days.
    replayKey?(req: Request, rawBody: string, ctx: WebhookContext): Promise<string | undefined>
  }
  health?(ctx: Pick<AdapterContext, 'fetch' | 'log'>): Promise<{ ok: boolean; detail?: string }>
  routes?(req: Request, subpath: string, ctx: RouteContext): Promise<Response | undefined>
}
```

| Member | Called by the server |
|---|---|
| `env` | At start: checked against `livemode` (a `sandbox` adapter stops a live server; a `production` adapter in a test server gets a warning) |
| `legs` | At plan time, when there is no `catalog` or it fails |
| `catalog` | At plan time, with `{ country?, currency, direction }` |
| `quote` | `POST /quotes`, once per leg of each quoted pathway |
| `prepareDeposit` | Before quoting a pathway, for every leg after the first |
| `start` | `POST /select` for the first leg; after a leg succeeds, for the next one |
| `transition` | `POST /transitions/:name` for SUBMIT and SURFACE_RESULT transitions |
| `status` | `GET /step` (at most every 2 s per leg), `sweep()` and `sessions.refresh()` |
| `webhook` | `POST /webhooks/:adapterId` |
| `health` | `GET /health?deep=1` with the tasks token (plain `GET /health` does not call adapters) |
| `routes` | Any request to `/adapters/:adapterId/*` |

`resultChannels(adapter)` returns `{ polling, webhooks }`: `polling` is true when the adapter has `status()`, and `webhooks` is true when it has a `webhook` whose `configured` is not `false`. The server uses it at start. It writes one warning for each adapter with legs that has neither, because the payments of that adapter cannot complete. Leg capabilities do not say how results arrive: `LegSpec.capabilities` has only `settlement` and `surface_after_processing`.

## Inputs

```ts
type CatalogInput = { country?: string; currency: string; direction: Direction }

type QuoteInput = {
  leg: PathwayLeg
  amountIn?: Amount        // exactly one side is set
  amountOut?: Amount
  deliverTo?: { address: string }
  source?: { chain: string; token: string; address?: string }
}

type StartInput = {
  leg: PathwayLeg
  quote: LegQuote
  deliverTo?: { address: string }
  source?: { chain: string; token: string; address?: string }
}

type TransitionInput = { leg: PathwayLeg; ref: string; name: string; inputs?: Record<string, unknown> }

type LegEvent = LegStep & {
  ref: string
  eventId?: string           // provider event id: the server drops an id that the session already applied
}
```

A `LegEvent` is a `LegStep` with the leg's `ref` (see [Legs and the session step](../concepts/flow.md#legs-and-the-session-step)). The server applies it with the same rules as a step from `status()`. Examples:

- A payment: `{ ref, status: 'succeeded', output, transactions: [{ role: 'destination', hash }] }`.
- A KYC review: `{ ref, status: 'processing', phase: 'kyc' }`. The leg stays in `KYC`.
- An offramp that learns its deposit address: `{ ref, status: 'requires_action', action: { kind: 'payment', surface: { kind: 'WALLET_TX', ... }, transitions } }`.

## Context

```ts
interface AdapterContext {
  session: {
    id: string; userId: string; direction: Direction; locale: string; livemode: boolean
    country?: string; region?: string; email?: string; ip?: string
  }
  destination: Destination
  pathway: { legs: PathwayLeg[]; index: number }
  urls: { returnUrl: string; webhookUrl: string }
  store: ScopedKV      // this adapter, this session
  shared: ScopedKV     // this adapter, all sessions
  fetch: typeof fetch
  log: Logger
  idempotencyKey(scope: string): string   // `${sessionId}:${scope}`
}

interface ScopedKV {
  get<T = unknown>(key: string): Promise<T | undefined>
  put(key: string, value: unknown, ttlSec?: number): Promise<void>
  /** Optional: write only when the key has no live value, as one atomic step. True when it wrote. */
  putIfAbsent?(key: string, value: unknown, ttlSec: number): Promise<boolean>
}

type WebhookContext = Pick<AdapterContext, 'log' | 'shared' | 'fetch'>

type RouteContext = Pick<AdapterContext, 'fetch' | 'log' | 'shared'> & {
  baseUrl: string
  applyEvent(event: LegEvent): Promise<void>   // same effect as a webhook
}
```

`putIfAbsent` is set when the server's store has an atomic operation for it: `memoryStore`, `redisStore` and `durableObjectStore` have it, `cloudflareKvStore` does not. Do not call it directly. Use `claimOnce`.

`ctx.session.locale` is `en` when the app did not set one. `ctx.session.ip` is the end user's IP from the latest browser request, when known.

## One owner per record

```ts
claimOnce(shared: ScopedKV, key: string, owner: string, ttlSec: number): Promise<boolean>
```

Records `key` as used by `owner`, for example a transaction hash, a log, or a provider deposit that can complete one payment only. Returns true when `owner` holds the key after the call. It also returns true when `owner` held the key before, so a retry gets the same answer. Returns false when another owner holds the key. The stored value is the `owner` string, with the TTL `ttlSec`.

When `shared.putIfAbsent` is set, the claim is atomic: when two claims run at the same time, exactly one wins. When it is not set, `claimOnce` reads the key, writes it when it is free, then reads it back. This catches most races, but not all.

```ts
const key = `txused:${chain}:${txHash.toLowerCase()}`
if (!(await claimOnce(ctx.shared, key, `${ctx.session.id}:${ref}`, 90 * 24 * 3600))) {
  return fail('This transaction was already used for another payment.')
}
```

### Webhook replay keys

```ts
webhookBodyKey(rawBody: string): Promise<string>       // SHA-256 of the body, hex
claimWebhook(shared, key, ttlSec = WEBHOOK_REPLAY_TTL_SEC): Promise<string | undefined>
releaseWebhook(shared, key, token, ttlSec = WEBHOOK_REPLAY_TTL_SEC): Promise<void>
```

The server uses these with `webhook.replayKey`. `claimWebhook` returns a token for the first delivery of a key, and `undefined` for a repeat within `WEBHOOK_REPLAY_TTL_SEC` (7 days). It is built on `claimOnce`. `releaseWebhook` gives the key back (only with the token), so the next delivery can take it. The server releases a key when it cannot apply the events yet and answers `503`. An adapter only returns the key from `replayKey`: it does not call these functions.

## HTTP helpers

| Export | Description |
|---|---|
| `fetchJson<T>(fetch, url, init?)` | JSON request with `accept: application/json`, `content-type` when there is a body, and a timeout (`init.timeoutMs`, default `DEFAULT_TIMEOUT_MS` = 8000). Throws an `HttpError` with `status` and parsed `body` on non-2xx, `timeout: true` on timeout, and a clear error for non-JSON bodies. |
| `httpErrorToOpenRamp(e, provider, { what?, noQuoteStatuses?, log?, setupHint? })` | `OpenRampException` passes through; 429 gives `RATE_LIMITED` (429); `noQuoteStatuses` (default 400, 404, 409, 422) give `NO_QUOTES` (422) with the provider's message; 401 and 403 give a setup error (see below); a timeout gives `PROVIDER_UNAVAILABLE` (504); anything else gives `PROVIDER_UNAVAILABLE` (502) and a warning log |
| `findDeliverAsset(list, asset)` | The entry of `list` (`{ chain, token, symbol?, decimals? }`) that delivers `asset`: same chain and token (EVM addresses without case). `undefined` on no match. It never falls back to another entry. |
| `requireDeliverAsset(list, asset, provider)` | `findDeliverAsset`, or `NO_QUOTES` (422, recovery `choose_other`) "{provider} does not deliver {token} on {chain}." Use it in `quote()`, so the user never gets a quote for another token. |
| `deliverableToAsset(d)` | The `CryptoAsset` of a list entry, with `symbol` and `decimals` when known |
| `providerSetupError(provider)` | The setup error: `PROVIDER_UNAVAILABLE` (502), `retryable: false`, recovery `choose_other`, message "{provider} is not set up for this app yet. Try another method." Use it in an adapter with its own error mapping. |
| `httpStatus(e)` | The numeric `status` of an error, or `undefined` |
| `providerMessage(e)` | The provider's message from `body.message`, `body.errorMessage` or `body.error(.message)` |

Types: `HttpError`, `FetchJsonInit`, `HttpErrorOptions`.

A 401 or 403 from a provider means that the provider refused our credentials or setup (API key, environment, IP allowlist). A retry cannot fix it. `httpErrorToOpenRamp` returns `providerSetupError(provider)`, so the user sees a neutral message and can choose another method. It also writes one `error` log for the operator. The log names the provider and the HTTP status, and tells the operator what to check. Give `setupHint` to add a provider-specific fix to the log, for example "Set relay({ apiKey })".

## Step helpers

| Export | Description |
|---|---|
| `POLL` | `onchain` (2.5 s start, 10 s max, 30 min), `checkout` (4 s, 15 s, 60 min), `dev` (1.5 s, 5 s, 15 min) |
| `awaitPoll(poll, name = 'poll')` | An AWAIT transition |
| `awaitingPayment(ref, poll)` | A `requires_action` step while the user pays in a provider page: `{ status: 'requires_action', action: { kind: 'payment', transitions: [awaitPoll(poll)] }, ref }`. It has no surface, so the UI keeps the current one. |
| `legStepFromEvent(event, ref, poll)` | The `status()` answer for a provider order that you mapped to a `LegEvent` (the same mapping as the webhook parser). No event: `awaitingPayment(ref, poll)`. Else the event without `eventId`, with `poll` on a step that waits, and with an AWAIT poll action on a `requires_action` event without an action. It sets no state: the server uses `stateFor()`. |
| `decimalFrom(n, digits = 8)` | Provider number to an exact decimal string; missing or non-finite gives `'0'` |
| `minWithToleranceBps(expectedBase, bps)` | The smallest amount (integer base units, as a string) that still counts as `expectedBase` when it can be up to `bps` basis points lower: `expected - floor(expected * bps / 10000)`, with bigint math. `minWithToleranceBps('999', 50)` is `'995'`. |
| `randomHex(bytes = 8)` | Random hex string |
| `bytesToHex(bytes)` | Lowercase hex of a `Uint8Array` or `ArrayBuffer`, no `0x` |
| `base64ToBytes(b64)`, `bytesToBase64(bytes)` | Standard base64 (not base64url). `base64ToBytes` ignores whitespace and throws on other characters. |
| `hmacSha256(secret, message, 'hex' \| 'base64')` | WebCrypto HMAC |
| `timingSafeEqual(a, b)` | Constant-time string compare (the same function as in `@openrampkit/core`) |

## Shared adapter helpers

| Export | Description |
|---|---|
| `quoteExpiresAt(minutes = 5, providerExpiry?)` | The `expiresAt` of a quote (ISO 8601). Every `LegQuote` must have one. It uses the provider's expiry (an ISO string or milliseconds) when it is a valid time in the future and not later than `minutes` from now. Else `minutes` from now. `DEFAULT_QUOTE_TTL_MINUTES` is 5. |
| `statusMap(provider, table, { ignoreCase? })` | A typed table from provider statuses to your values (for example a `LegStatus` and a detail code). Use it in place of a `switch` with a `default` branch. An unknown status gives `undefined` and one warning log per value. It never falls back to another entry: you decide what an unknown status means (usually: keep the current step). `.known` lists the statuses. |
| `verifyTimestampedHmac({ secret, rawBody, header, timestamp?, timestampKey?, signatureKey?, toleranceSec?, message?, encoding? })` | Checks an HMAC-SHA256 webhook signature over a timestamp and the body, with a time window (default 300 s). Defaults: header `t=...,v1=...`, message `{t}.{body}`, hex. False for a missing secret, header or timestamp, a timestamp outside the window, or a wrong signature. Constant-time compare. Stripe, MoonPay, Coinbase, Peer and Meld use it. |
| `parseSignatureHeader(header)` | Parses `key=value` pairs separated by commas (`t=1700000000,v1=...`). A key can repeat, so each key maps to a list. |
| `cachedJson(kv, key, ttlSec, load, { valid? })` | Reads `key` from `kv`, or runs `load` and keeps its result for `ttlSec` seconds. A value that `valid` refuses (for example an empty list) is not kept. Use it for provider catalogs, rates and token data. |

```ts
import { statusMap, quoteExpiresAt } from '@openrampkit/adapter'

const STATUS = statusMap('Acme', {
  waitingPayment: { status: 'requires_action' },
  pending: { status: 'processing', detail: 'settling' },
  completed: { status: 'succeeded' },
  failed: { status: 'failed' },
})
const m = STATUS(order.status, ctx.log) // undefined for an unknown status
const expiresAt = quoteExpiresAt(5, order.quoteExpiresAt)
```

## RSA signatures

For providers that sign webhooks with RSA (RSASSA-PKCS1-v1_5 with SHA-256, also known as SHA256withRSA), for example Binance and Bridge.

| Export | Description |
|---|---|
| `rsaVerify(publicKey, data, signatureB64)` | Checks a base64 signature of `data` (a string is UTF-8 encoded; a `Uint8Array` is used as given). WebCrypto hashes `data` with SHA-256 first. `publicKey` is an SPKI key as PEM or base64, or a `CryptoKey`. Returns false for a wrong or malformed signature. Throws when the key string is not a valid public key. |
| `importRsaPublicKey(key)` | Imports an SPKI public key (PEM or base64) once, for many `rsaVerify` calls |
| `rsaKeyDer(key, 'public' \| 'private')` | The DER bytes of a PEM or base64 key. Accepts `\n` escapes from environment variables. Throws for a PKCS#1 PEM (`RSA PUBLIC KEY`, `RSA PRIVATE KEY`): convert it with `openssl rsa -pubout` or `openssl pkcs8 -topk8`. |

```ts
import { importRsaPublicKey, rsaVerify } from '@openrampkit/adapter'

let key: Promise<CryptoKey> | undefined
async function verify(rawBody: string, signature: string) {
  key ??= importRsaPublicKey(opts.webhookPublicKey)
  return rsaVerify(await key, rawBody, signature)
}
```

## EVM helpers

Plain JSON-RPC over `fetch`. No viem.

| Export | Description |
|---|---|
| `evmRpc(fetch, url, method, params, { log? })` | One JSON-RPC call. A network, HTTP or RPC error becomes `PROVIDER_UNAVAILABLE` (502, or 504 on a timeout). |
| `erc20TransferData(to, amountBase)` | ERC-20 `transfer(to, amount)` calldata |
| `erc20PaidTo(receipt, token, recipient)` | The sum of ERC-20 `Transfer` logs of `token` to `recipient` in a receipt, in base units (`bigint`) |
| `ERC20_TRANSFER_TOPIC`, `topicAddress(address)` | The `Transfer` event topic, and an address as a 32-byte topic, for `eth_getLogs` filters |
| `EvmReceipt` | The receipt fields the helpers read (`status`, `blockNumber`, `logs`) |

## Solana helpers

| Export | Description |
|---|---|
| `solanaPaidTo(tx, owner, mint)` | The amount (base units, `bigint`) that the transfer instructions of a parsed transaction (`getTransaction` with `jsonParsed`) send to `owner`. With `mint: 'native'`, it counts System Program transfers in lamports. With an SPL mint, it counts SPL Token and Token-2022 `transfer` and `transferChecked` instructions into a token account of `owner`. A failed transaction gives `0n`. |

Types: `SolanaParsedTx`, `SolanaParsedInstruction`, `SolanaTokenBalance`, `SolanaSignatureStatus`.

## Settlement helpers

Helpers for the `OpenRampSettlement` contract. See [On-chain settlement](../concepts/settlement.md) and the [settlement flow](../concepts/flows.md#on-chain-settlement).

| Export | Description |
|---|---|
| `buildSettlementTxs({ chainId, contract, sessionId, token, amount, recipient, calls?, intent? })` | The two WALLET_TX transactions: `approve`, then `settle` |
| `encodeSettle(params, intent?, { fromBalance? })` | `settle` (or `settleFromBalance`) calldata. With `fromBalance`, the intent `minAmount` must equal `amount`. |
| `erc20ApproveData(spender, amountBase)` | ERC-20 `approve` calldata |
| `settlementIntentTypedData({ chainId, contract, sessionId, token, recipient, minAmount, calls?, deadline, payer? })` | The EIP-712 typed data for the intent signer, for `settle` |
| `settlementBalanceIntentTypedData({ chainId, contract, sessionId, token, recipient, amount, calls?, deadline, payer? })` | The EIP-712 typed data for `settleFromBalance`. It binds the exact amount. |
| `hashSettlementCalls(calls)` | The calls hash, equal to the contract `hashCalls` and to `callsHash` in `Settled` |
| `settlementCallsFrom(destination.calls)` | `ContractCall[]` to `SettlementCall[]`. Throws on a bad address, bad data or native value. |
| `verifySettlement({ rpcUrl, contract, sessionId, fromBlock?, expect? })` | Reads `receiptOf` and the `Settled` log. Returns `{ settled: false }` or `{ settled: true, ok, problem?, record }`. |
| `sessionIdToBytes32(id)`, `bytes32ToSessionId(word)` | The session id as `bytes32` (UTF-8, padded with zeros), and back |
| `isEvmAddress(value)`, `keccak256(data)` | Small utilities |
| `OPEN_RAMP_SETTLEMENT_ABI`, `SETTLEMENT_SELECTORS`, `SETTLED_TOPIC`, `SETTLEMENT_INTENT_TYPES`, `SETTLEMENT_BALANCE_INTENT_TYPES` | The ABI, the function selectors, the `Settled` topic and the EIP-712 types |

Types: `SettlementCall`, `SettlementIntent`, `SettlementParams`, `SettlementIntentTypedData`, `SettlementBalanceIntentTypedData`, `SettlementRecord`, `VerifySettlementResult`.

## Conformance checks (main entry)

| Export | Description |
|---|---|
| `checkAdapterShape(adapter)` | API version 2, legs, ETAs, surfaces, region policy, decimal limits, known capabilities. Declared capabilities and surfaces need their methods: `surface_after_processing` needs a webhook; `settlement` needs a crypto `to` asset at an address; a `FORM`, `OTP` or `WALLET_TX` surface needs `transition()`. An adapter with legs needs a result channel (`status()` or a configured webhook). |
| `checkLegQuote(quote)` | Decimal strings; an ISO `expiresAt` in the future; a known `guarantee`; `minOutput` with `min_output`, in the asset of `output`; `slippageBps` an integer from 0 to 10000; each fee with a boolean `included` and an `amount` that is `null` or an `Amount` with a valid asset |
| `checkLegStep(step)` | The v2 step rules: a known status; an `action` (known kind, transitions) with `requires_action` and with no other status; `phase` only with `pending` or `processing`; `detail.code` in `STEP_DETAIL_CODES`; transaction roles (not `hop`) and hashes; legal transitions. It flags the v1 fields `state`, `sub`, `txHash`, `sourceTxHash`, `surface` and `transitions`. |
| `LEG_STATUSES` | Every `LegStatus` |
| `sameQuotedAsset(a, b)` | Same fiat currency, or same chain and token. A wildcard (`*`) matches anything. |

Each returns `ConformanceProblem[]` (`{ where, problem }`).

## @openrampkit/adapter/testing

Test helpers. They do not import a test runner.

```ts
import {
  runAdapterConformance, fakeFetch, makeCtx, makeWebhookCtx, memoryKV, recordingLog, silentLog, TEST_DESTINATION,
} from '@openrampkit/adapter/testing'
```

| Export | Description |
|---|---|
| `fakeFetch(routes)` | `{ fetch, calls }`. Each route: `method?`, `match` (substring or RegExp), `reply?(call)` (JSON value, a `Response`, or throw), `status?` (default 200), `hang?`. First match wins; unmatched calls get 404. `calls` records `{ method, url, headers, body?, raw? }`. |
| `makeCtx({ fetch, destination?, pathway?, shared?, store?, session?, urls?, log? })` | An `AdapterContext`: session `sess_1`, user `user_1`, US, `en`, test mode; USDC on Base to `0x...beef`; fresh `memoryKV()` stores |
| `makeWebhookCtx({ fetch?, shared?, log? })` | A `WebhookContext` |
| `memoryKV()` | A `ScopedKV` with TTLs checked against `Date.now()` (fake timers work). Has `data`. |
| `recordingLog()` | A logger that records `warnings` and `errors` |
| `silentLog` | A shared recording logger |
| `TEST_DESTINATION` | The default destination |
| `runAdapterConformance(adapter, options)` | Runs the checks; returns `{ problems, quotes, steps, events }` |

`ConformanceOptions`:

| Field | Description |
|---|---|
| `fixtures` | `ConformanceFixture[]`: `{ name?, leg, quote, start?, transitions?, status?, expect?, ctx? }` |
| `errorPaths` | `ConformanceErrorPath[]`: `{ name?, leg, quote, ctx?, skip? }`. Each runs `quote()` against a provider that answers HTTP 400, 401, 429 or 500, or times out. `quote()` must throw an `OpenRampException` with the code and `retryable` of `httpErrorToOpenRamp` (see `ERROR_PATHS`). `skip` lists cases to leave out. |
| `ctx` | `() => AdapterContext`, a fresh context per fixture. Default `makeCtx({ fetch })`. |
| `fetch` | Used by the default context. Default: a fake fetch with no routes. |
| `webhooks` | `ConformanceWebhook[]`: `{ name?, request: () => Request, rawBody, valid? (default true), events? }` |
| `webhookCtx` | Default `makeWebhookCtx({ fetch })` |

Per fixture, `quote` is the `QuoteInput` without `leg`; `start` is `true` (default), `false`, or extra `StartInput` fields; `transitions` is a list of `{ name, inputs? }`; `status` defaults to true when the adapter has `status()`; `expect` is `{ start?: StateName; status?: StateName }`, compared with `stateFor(step)`.

Per fixture, the kit also checks that the quote output asset is the leg's `to` asset, and that the first `requires_action` step has a surface. An action with a SUBMIT or SURFACE_RESULT transition needs `transition()`. Webhook events get the same step rules.

| Error case | Expected code | `retryable` |
|---|---|---|
| HTTP 400 | `NO_QUOTES`, or a more exact code (`AMOUNT_TOO_LOW`, `AMOUNT_TOO_HIGH`, `REGION_UNSUPPORTED`, `BAD_REQUEST`, `PROVIDER_ERROR`) | any |
| HTTP 401 | `PROVIDER_UNAVAILABLE` | `false` |
| HTTP 429 | `RATE_LIMITED` | `true` |
| HTTP 500 | `PROVIDER_UNAVAILABLE` | `true` |
| Timeout | `PROVIDER_UNAVAILABLE` | `true` |

## Environment helpers

| Export | Description |
|---|---|
| `AdapterEnv` | `'sandbox' \| 'production'`: the type of the `env` option and of `adapter.env` |
| `resolveEnv(adapter, env, legacy, fallback)` | The `env` of an adapter: `env` when set; else the value of a deprecated option (`legacy`), with a one-time warning; else `fallback`. Throws on a value that is not `sandbox` or `production`. |
| `warnDeprecatedOnce(key, message)` | Writes a deprecation warning once per process. Returns true the first time. |

## Other exports

`Logger`, `ScopedKV`, `AdapterDefinition`, and the types above.
