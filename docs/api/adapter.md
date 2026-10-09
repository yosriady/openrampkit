# @openrampkit/adapter

The adapter API: `createAdapter()`, the `Adapter` interface, helpers for provider calls, and a test kit at `@openrampkit/adapter/testing`. For a walkthrough, read [Writing an adapter](../adapters/writing-an-adapter.md).

## createAdapter(definition)

```ts
import { createAdapter, ADAPTER_API_VERSION } from '@openrampkit/adapter'

const adapter = createAdapter({ id: 'acme', name: 'Acme Pay', legs, quote, start })
```

Throws when `id` is not lowercase letters, digits or dashes, or when two legs share an id. Sets `apiVersion` to `ADAPTER_API_VERSION` (`1`) unless the definition gives one.

## Adapter

```ts
interface Adapter {
  id: string
  name: string
  apiVersion: number
  legs: LegSpec[]
  catalog?(input: CatalogInput, ctx: Pick<AdapterContext, 'fetch' | 'log' | 'shared'>): Promise<LegSpec[]>
  quote(input: QuoteInput, ctx: AdapterContext): Promise<LegQuote>
  prepareDeposit?(input: { leg: PathwayLeg; amountIn?: Amount }, ctx: AdapterContext):
    Promise<{ address: string; ref?: string; data?: Record<string, unknown> }>
  start(input: StartInput, ctx: AdapterContext): Promise<LegStep>
  transition?(input: TransitionInput, ctx: AdapterContext): Promise<LegStep>
  status?(input: { leg: PathwayLeg; ref: string }, ctx: AdapterContext): Promise<LegStep>
  webhook?: {
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

type LegEvent = {
  ref: string; status: LegStatus; output?: Amount; txHash?: string; error?: OrkError
  eventId?: string           // provider event id: the server drops an id that the session already applied
  surface?: Surface          // non-terminal events only: a new surface, e.g. a WALLET_TX once an offramp knows its deposit address
  transitions?: Transition[] // goes with surface; default: an AWAIT poll
}
```

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
| `httpErrorToOrk(e, provider, { what?, noQuoteStatuses?, log? })` | `OrkException` passes through; 429 gives `RATE_LIMITED` (429); `noQuoteStatuses` (default 400, 404, 409, 422) give `NO_QUOTES` (422) with the provider's message; a timeout gives `PROVIDER_UNAVAILABLE` (504); anything else gives `PROVIDER_UNAVAILABLE` (502) and a warning log |
| `httpStatus(e)` | The numeric `status` of an error, or `undefined` |
| `providerMessage(e)` | The provider's message from `body.message`, `body.errorMessage` or `body.error(.message)` |

Types: `HttpError`, `FetchJsonInit`, `HttpErrorOptions`.

## Step helpers

| Export | Description |
|---|---|
| `POLL` | `onchain` (2.5 s start, 10 s max, 30 min), `checkout` (4 s, 15 s, 60 min), `dev` (1.5 s, 5 s, 15 min) |
| `awaitPoll(poll, name = 'poll')` | An AWAIT transition |
| `legStepFromEvent(event, ref, poll)` | No event, `pending` or `awaiting_user`: `PAYMENT`. `succeeded`: `COMPLETED`. `failed`: `FAILED`. `refunded`, `expired`, `reversed`: those states. `processing`: `PROCESSING`. |
| `decimalFrom(n, digits = 8)` | Provider number to an exact decimal string; missing or non-finite gives `'0'` |
| `minWithToleranceBps(expectedBase, bps)` | The smallest amount (integer base units, as a string) that still counts as `expectedBase` when it can be up to `bps` basis points lower: `expected - floor(expected * bps / 10000)`, with bigint math. `minWithToleranceBps('999', 50)` is `'995'`. |
| `randomHex(bytes = 8)` | Random hex string |
| `bytesToHex(bytes)` | Lowercase hex of a `Uint8Array` or `ArrayBuffer`, no `0x` |
| `base64ToBytes(b64)`, `bytesToBase64(bytes)` | Standard base64 (not base64url). `base64ToBytes` ignores whitespace and throws on other characters. |
| `hmacSha256(secret, message, 'hex' \| 'base64')` | WebCrypto HMAC |
| `timingSafeEqual(a, b)` | Constant-time string compare (the same function as in `@openrampkit/core`) |

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
| `checkAdapterShape(adapter)` | API version, legs, ETAs, surfaces, region policy, decimal limits |
| `checkLegQuote(quote)` | Decimal strings and an ISO `expiresAt` |
| `checkLegStep(step)` | A legal step, and a terminal state only with a terminal leg status (except `PROCESSING`) |

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
| `ctx` | `() => AdapterContext`, a fresh context per fixture. Default `makeCtx({ fetch })`. |
| `fetch` | Used by the default context. Default: a fake fetch with no routes. |
| `webhooks` | `ConformanceWebhook[]`: `{ name?, request: () => Request, rawBody, valid? (default true), events? }` |
| `webhookCtx` | Default `makeWebhookCtx({ fetch })` |

Per fixture, `quote` is the `QuoteInput` without `leg`; `start` is `true` (default), `false`, or extra `StartInput` fields; `transitions` is a list of `{ name, inputs? }`; `status` defaults to true when the adapter has `status()`; `expect` is `{ start?: StateName; status?: StateName }`.

## Other exports

`Logger`, `ScopedKV`, `AdapterDefinition`, and the types above.
