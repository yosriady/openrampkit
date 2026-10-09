# Writing an adapter

An adapter is a factory that returns an `Adapter` object. It works like a wagmi connector: your package exports the factory, the app passes a configured instance to the server, and the server treats every adapter the same way.

This page builds a small but complete adapter for an imaginary provider, "Acme Pay", that sells USDC on Base for a card payment at a hosted checkout.

## The shape

```ts
import { createAdapter } from '@openrampkit/adapter'

export function acme(opts: AcmeOptions) {
  return createAdapter({
    id: 'acme',            // lowercase letters, digits and dashes; unique per server
    name: 'Acme Pay',      // shown to users
    legs: [/* LegSpec[] */],
    async quote(input, ctx) { /* -> LegQuote */ },
    async start(input, ctx) { /* -> LegStep */ },
    // optional:
    async status(input, ctx) { /* -> LegStep */ },
    async transition(input, ctx) { /* -> LegStep */ },
    webhook: { async verify(req, rawBody, ctx) {}, async parse(rawBody, ctx) {} },
    async catalog(input, ctx) { /* -> LegSpec[] */ },
    async prepareDeposit(input, ctx) { /* -> { address } */ },
    async routes(req, subpath, ctx) { /* -> Response | undefined */ },
    async health(ctx) { /* -> { ok, detail? } */ },
  })
}
```

`createAdapter` checks the id format and that leg ids are unique, and sets `apiVersion` to `ADAPTER_API_VERSION` (2). It throws for a definition with another `apiVersion`, and the message tells you what to change. The server refuses an adapter with another API version. To move an adapter from version 1, see [Upgrade from version 1](#upgrade-from-version-1).

## Legs

Declare what each leg takes and delivers. The planner reads only these declarations. See [Pathways and legs](../concepts/pathways.md#leg-specs) for every field.

```ts
import type { LegSpec } from '@openrampkit/core'
import { USDC } from '@openrampkit/core'

const legs: LegSpec[] = [
  {
    id: 'card',
    kind: 'fiat_onramp',
    methods: ['card', 'apple_pay'],
    from: { asset: { kind: 'fiat', currencies: ['USD', 'EUR'] }, location: ['user_account'] },
    to: { asset: { kind: 'crypto', chains: { 'eip155:8453': [USDC['eip155:8453']!] } }, location: ['address'] },
    regions: { allow: ['*'], deny: ['US-NY'] },
    limits: { min: '20', max: '5000', currency: 'USD' },
    eta: { min: 60, max: 900 },
    surfaces: ['REDIRECT'],
    requires: ['provider_kyc'],
  },
]
```

Tips:

- `capabilities` has two values only, and the server checks both: `settlement` (the leg can pay into a settlement contract) and `surface_after_processing` (see [webhook](#webhook)). Leave it out for a normal leg. How the server learns a leg result is not a capability: it comes from `status()` (polling) and `webhook`. `checkAdapterShape` reports any other value.

- Use method ids from the built-in vocabulary (`METHODS` in `@openrampkit/core`) so the modal shows the right name and icon. Unknown ids work too; they are title-cased.
- List concrete delivery assets (chain and lowercase token). The planner can only build a hop from concrete assets, not from `'*'`.
- If the provider has a live list of methods or countries, add `catalog()`. Cache the result in `ctx.shared`.

## The context

Every call gets an `AdapterContext`:

| Field | Description |
|---|---|
| `session` | `id`, `userId`, `direction`, `country`, `region` (ISO 3166-2), `locale`, `livemode`, `email`, `ip` (the end user's IP from the latest browser request) |
| `destination` | The session's `Destination` |
| `pathway` | `{ legs, index }`: the full pathway and this leg's index |
| `urls.returnUrl` | Where the provider should send the user back |
| `urls.webhookUrl` | `{baseUrl}/webhooks/{adapterId}` |
| `store` | Key-value scratch space for this adapter and session: `get(key)`, `put(key, value, ttlSec?)` |
| `shared` | Key-value space for this adapter across sessions (catalogs, tokens, reusable addresses) |
| `fetch` | Use this, not the global `fetch`, so tests and the app can replace it |
| `log` | `debug`, `info`, `warn`, `error` |
| `idempotencyKey(scope)` | `{sessionId}:{scope}`, for provider idempotency headers |

Webhook handlers and `catalog()` get a smaller context: `fetch`, `log` and `shared`. `routes()` also gets `baseUrl` and `applyEvent(event)`.

### One transaction, one payment

A transaction hash, a log or a provider deposit must complete one payment only. Record it in `ctx.shared` with `claimOnce` from `@openrampkit/adapter`. Do not write your own get-then-put: two requests at the same time can both see a free key.

```ts
import { claimOnce } from '@openrampkit/adapter'

const owner = `${ctx.session.id}:${ref}`
if (!(await claimOnce(ctx.shared, `txused:${chain}:${txHash.toLowerCase()}`, owner, 90 * 24 * 3600))) {
  // another payment has this transaction
}
```

`claimOnce` returns true for the first owner, and again for the same owner on a retry. It returns false for every other owner. On a store with `putIfAbsent` (memory, Redis, Durable Objects), the claim is atomic. On Workers KV, it is best effort. See [`claimOnce`](../api/adapter.md#one-owner-per-record).

## quote()

```ts
type QuoteInput = {
  leg: PathwayLeg
  amountIn?: Amount    // exactly one side is set
  amountOut?: Amount
  deliverTo?: { address: string }  // for hop legs: the next leg's deposit address
  source?: { chain: string; token: string; address?: string }  // crypto source legs
}
```

Return a `LegQuote` with decimal strings, every fee you know, an `eta`, a `guarantee` and an `expiresAt`. Put anything `start()` needs in `data`.

- `output` must be in the leg's `to` asset.
- `guarantee` tells how firm `output` is: `firm` (the provider delivers `output` exactly before `expiresAt`), `min_output` (the provider delivers at least `minOutput`, for example a bridge with slippage) or `estimate` (the rate is set when the provider executes, as for most fiat onramps and offramps). With `min_output`, set `minOutput` in the asset of `output`. Set `slippageBps` when the provider says it.
- `expiresAt` is required. Use `quoteExpiresAt(minutes, providerExpiry?)`: it takes the provider's expiry when it is valid and not later than `minutes` from now. The server gives 5 minutes to a quote without a valid expiry, and the conformance kit reports it.
- Each fee is `{ kind, label, amount, included }`. `kind` is `provider`, `network`, `app`, `swap`, `bridge` or `other`. `amount` is an `Amount` in the fee's own asset (a fiat currency, or a token on a chain), or `null` when the provider takes a fee but does not say how much (for example a fee in the rate). `included` is `true` when the quote already counts the fee (in `input`, in the rate, or from `output`), and `false` when the user pays it on top (for example gas that the wallet pays).

The server checks the reported output against `minOutput` when it is set, else against the quoted output less `policy.outputToleranceBps`. See [SessionResult](../api/core.md#sessionresult).

## start()

Create the order and return the first `LegStep`: the leg status, an `action` when the user must act, and a `ref`. The `ref` is how webhooks and status checks find the leg later. Always return one. Set `providerRef` to the provider's own order id when it has one (for example a MoonPay transaction id). Apps show it to the user for provider support. When the provider's order id is your `ref`, set both.

```ts
type LegStep = {
  status: LegStatus
  action?: { kind: 'auth' | 'kyc' | 'payment'; surface?: Surface; transitions: Transition[] } // only with requires_action
  phase?: 'auth' | 'kyc'   // only with pending or processing
  poll?: PollSpec          // how often the UI checks a step with no action
  detail?: { code: StepDetailCode; providerStatus?: string }
  error?: OpenRampError
  ref?: string
  providerRef?: string
  output?: Amount
  transactions?: LegTransaction[] // { role, chain?, hash, amount? }
}
```

The rules (the conformance kit checks them):

- `status: 'requires_action'` has an `action`. Other statuses have none. The action kind gives the screen: `auth` (sign in to the provider), `kyc` (identity checks) or `payment` (pay or send). The first `requires_action` step has a `surface`.
- An action without a `surface` keeps the surface of the current action. For example, a status poll while the user pays in a provider page returns `awaitingPayment(ref, poll)`.
- `phase` is only for `pending` and `processing`: the leg waits in a phase before the payment, for example a KYC review (`{ status: 'processing', phase: 'kyc' }`). The UI then shows `KYC`.
- A step that waits and has no action gets an AWAIT poll from the server. Set `poll` to change the schedule.
- Do not set a state. The server gets `Step.state` from the step with `stateFor(step)` in `@openrampkit/core`.

Surface URLs must be safe for the browser. `REDIRECT`, `IFRAME` (`url` and `origin`) and a `PROVIDER_SDK` `redirectUrl` must use `https:` (`http:` is accepted in test mode only). A `DEEPLINK` can use an app scheme such as `gcash://`. The server fails the leg with `PROVIDER_UNAVAILABLE` when a URL uses `javascript:`, `data:` or another unsafe scheme.

If the pathway has two legs and your leg is the first, deliver to `input.deliverTo.address` when it is set. Otherwise deliver to `ctx.destination.address`.

## status() and transition()

- `status({ leg, ref })` asks the provider for the current state. The server calls it when the browser polls (at most every 2 seconds per leg), from the background `sweep()`, and from `sessions.refresh()`.
- `transition({ leg, ref, name, inputs })` handles SUBMIT and SURFACE_RESULT transitions that your steps offer, for example an OTP form or `submit_tx` with `{ txHash }`.

### Transactions

Report each onchain transaction that you know in `transactions`, with a role:

| Role | When |
|---|---|
| `approval` | A token approval before the payment. It moves no funds. |
| `source` | The transaction that paid into the leg: the user's wallet transaction (for example the hash from `submit_tx`), or the transfer into a deposit address. |
| `destination` | The delivery of the leg (for a bridge or swap: the fill on the destination chain). The server reports it as `hop` when the leg is not the last one. |
| `settlement` | The delivery through an OpenRampSettlement contract. |
| `refund` | A refund to the user. |

Do not set `hop`: the server sets it. `chain` is optional: the server takes the leg's `to` chain for a delivery, else the `from` chain. Do not send a link: the server builds `explorerUrl` from its chain table. A hash has letters and digits only (an `0x` prefix is allowed). One transaction can have two roles (a same-chain transfer is both `source` and `destination`).

The server keeps every transaction that a leg reported, also when a later step leaves it out. It also keeps `ref`, `providerRef` and `output`. Any transaction that moves funds (any role but `approval`) makes a failure final, and blocks cancel and restart.

### Step detail

A `LegStep` can carry `detail`, a finer label. `detail.code` comes from the closed list `STEP_DETAIL_CODES` (see [Step detail](../concepts/flow.md#step-detail)). Map your provider's statuses to it. Put the raw provider status in `detail.providerStatus`: the server keeps each new value in the timeline. The server drops a `detail` whose code is not in the list.

Map provider statuses with `statusMap(provider, table)`, not with a `switch` that has a `default` branch. An unknown status then gives `undefined` and one warning log. Keep the current step for it: a new provider status must never become `processing` (or anything else) by accident.

The server learns a leg result from `status()` (polling), from the `webhook`, or from both. `resultChannels(adapter)` in `@openrampkit/adapter` tells which: `{ polling: !!status, webhooks: webhook configured }`. When an adapter with legs has neither, the server writes a warning at start: its payments cannot complete. An adapter without `status()` (for example Transak) relies on its webhook only.

## webhook

```ts
webhook: {
  configured?: boolean       // false when the options have no webhook secret, so nothing can verify
  verify(req: Request, rawBody: string, ctx): Promise<boolean>
  parse(rawBody: string, ctx): Promise<LegEvent[]>
  replayKey?(req: Request, rawBody: string, ctx): Promise<string | undefined>
}
type LegEvent = LegStep & {
  ref: string
  eventId?: string           // the provider event id, when the provider has one
}
```

## webhook

```ts
webhook: {
  configured?: boolean       // false when the options have no webhook secret, so nothing can verify
  verify(req: Request, rawBody: string, ctx): Promise<boolean>
  parse(rawBody: string, ctx): Promise<LegEvent[]>
  replayKey?(req: Request, rawBody: string, ctx): Promise<string | undefined>
}
type LegEvent = {
  ref: string; status: LegStatus; output?: Amount; txHash?: string; error?: OpenRampError
  eventId?: string           // the provider event id, when the provider has one
  surface?: Surface          // non-terminal events only: a new surface, e.g. a WALLET_TX once an offramp knows its deposit address
  transitions?: Transition[] // goes with surface; default: an AWAIT poll
}
```

The server calls `verify` first and answers 401 when it returns false. Then it applies each event to the session that owns `ref`. When the provider signs the body with no timestamp, a captured webhook could be sent again later. Add `replayKey` and return the provider event id, or `webhookBodyKey(rawBody)` (the SHA-256 of the body). The server keeps the key for 7 days and ignores a repeat (`200`, no change). It gives the key back when it answers `503`, so a provider retry still applies.

A `LegEvent` is a `LegStep` with a `ref`, so an event follows the same rules as a step. A KYC review event is `{ ref, status: 'processing', phase: 'kyc' }`: the leg stays in `KYC`. When a provider has a timestamped HMAC signature (`t=...,v1=...` or separate headers), use `verifyTimestampedHmac` in `verify`.

Events move a leg only forward. When your leg learns where the user must pay after it started (for example a deposit address in a webhook, while the leg is `processing`), add `'surface_after_processing'` to the leg's `capabilities` and the surface kind to its `surfaces`. The server then allows one move from `processing` back to `requires_action` with that `action.surface`, before the leg has a transaction that moves funds. `parse` must be idempotent: the same body must give the same events. Set `eventId` when the provider gives an event id: the server drops an event whose id the session already applied. The server ignores an event that would move a leg back (for example `pending` after `processing`). See [Leg status](../concepts/flow.md#leg-status). `parse` also gets `ctx.url`, the full webhook request URL (Meld reads it). The [fiat onramp flow](../concepts/flows.md#fiat-onramp-with-redirect-or-iframe) shows where each adapter method runs.

## Withdraw legs

A leg can serve [withdrawals](../guide/withdraw.md) when:

- its kind is `bridge_swap`, `crypto_withdraw`, `crypto_offramp` or `wallet_transfer`,
- it declares the `WALLET_TX` surface, and it takes the funds with a `WALLET_TX` step,
- its `from` takes crypto at `user_wallet` (and at `address`, for apps that hold the funds),
- its `to` is an `address` (to a wallet) or fiat at `user_account` (to cash).

`catalog()` gets `direction`, so an adapter can return sell legs for withdrawals only. In `quote()` and `start()`, `source` is the session's source asset, with the sender address when it is known (the user's wallet, or the app's treasury).

The `WALLET_TX` step needs a `SURFACE_RESULT` transition that expects `tx_hash`. The client fires it after the user's wallet sends. For `custody: 'app'`, the server sends the transactions through the app's treasury and fires the same transition itself. When a provider learns its deposit address later (for example in a webhook), return a `LegEvent` with `status: 'requires_action'` and `action: { kind: 'payment', surface: { kind: 'WALLET_TX', ... }, transitions }`.

## prepareDeposit()

Only for bridge legs. Before the server quotes a two-leg pathway, it asks the second leg's adapter for the address the first leg must deliver to. Relay returns an open deposit address.

## routes()

Serve pages at `{baseUrl}/adapters/{id}/*`: a return page, or a hosted page like the mock checkout. Return `undefined` to fall through to 404. Call `ctx.applyEvent(event)` to update a session from a route, with the same effect as a webhook.

## Rules

From the project's design notes:

- Adapters are pure server code. Do not read global environment variables; take all config from the factory options.
- Use web-standard APIs only (`fetch`, WebCrypto), so the adapter runs on Cloudflare Workers.
- Verify webhook signatures. Be idempotent on repeated webhooks.
- Return money as decimal strings, never floats. Fill every fee you know in `LegQuote.fees`. Use `amount: null` for a fee that the provider does not state. Do not invent an amount.
- Give every quote a `guarantee` and an `expiresAt`. Do not say `firm` when the provider sets the rate later.
- Do not store KYC data. Provider references (order id, customer id) are fine.
- Throw `OpenRampException` with a safe message for expected failures. Use `httpErrorToOpenRamp()` for failed provider calls.
- Naming: first-party packages are `@openrampkit/adapter-<id>`. Community packages should be `openrampkit-adapter-<id>`.

## Helpers

`@openrampkit/adapter` exports helpers the first-party adapters use:

| Helper | Description |
|---|---|
| `fetchJson(fetch, url, init)` | JSON fetch with a timeout (default 8000 ms). Errors carry `status`, `body` and `timeout`. |
| `httpErrorToOpenRamp(e, provider, opts)` | 429 to `RATE_LIMITED`; 400, 404, 409, 422 to `NO_QUOTES` with the provider's message; 401 and 403 to a setup error (not retryable, recovery `choose_other`, one error log); timeouts and other errors to `PROVIDER_UNAVAILABLE` |
| `httpStatus(e)`, `providerMessage(e)` | Read the HTTP status or the provider's message from an error |
| `findDeliverAsset(list, asset)`, `requireDeliverAsset(list, asset, provider)` | Find the token you deliver for the requested destination. No match gives `undefined` (or `NO_QUOTES`). Never quote another token in its place. |
| `POLL.onchain`, `POLL.checkout`, `POLL.dev` | Poll schedules for AWAIT transitions |
| `awaitPoll(poll, name = 'poll')` | An AWAIT transition |
| `awaitingPayment(ref, poll)` | A `requires_action` step with an AWAIT poll and no surface, while the user pays in a provider page |
| `legStepFromEvent(event, ref, poll)` | The `status()` answer for a mapped provider status: the event as a step (no event gives `awaitingPayment`) |
| `quoteExpiresAt(minutes, providerExpiry?)` | The required `LegQuote.expiresAt` |
| `statusMap(provider, table)` | A typed table of provider statuses. An unknown status gives `undefined` and one log, never a default. |
| `verifyTimestampedHmac(input)`, `parseSignatureHeader(header)` | Timestamped HMAC webhook signatures (Stripe, MoonPay, Coinbase, Peer and Meld use them) |
| `cachedJson(kv, key, ttlSec, load)` | Cache a provider catalog, a rate or token data |
| `decimalFrom(n, digits = 8)` | A JSON number from a provider to an exact decimal string |
| `hmacSha256(secret, message, 'hex' \| 'base64')`, `timingSafeEqual(a, b)`, `randomHex(bytes)` | Crypto helpers |
| `evmRpc`, `erc20TransferData`, `erc20PaidTo`, `ERC20_TRANSFER_TOPIC`, `topicAddress` | EVM JSON-RPC helpers for on-chain checks. See [EVM helpers](../api/adapter.md#evm-helpers). |
| `buildSettlementTxs`, `settlementIntentTypedData`, `verifySettlement` and more | `OpenRampSettlement` helpers. See [Settlement helpers](../api/adapter.md#settlement-helpers). |

## A complete example

```ts
// packages/adapter-acme/src/index.ts
import {
  POLL, createAdapter, fetchJson, httpErrorToOpenRamp, legStepFromEvent, quoteExpiresAt, randomHex, statusMap, verifyTimestampedHmac,
} from '@openrampkit/adapter'
import type { LegEvent } from '@openrampkit/adapter'
import { USDC, openRampError } from '@openrampkit/core'
import type { CryptoAsset, LegSpec, LegStatus, StepDetailCode } from '@openrampkit/core'

export type AcmeOptions = { apiKey: string; webhookSecret: string; apiUrl?: string }

const BASE_USDC: CryptoAsset = { kind: 'crypto', chain: 'eip155:8453', token: USDC['eip155:8453']!, symbol: 'USDC', decimals: 6 }

type AcmeOrder = { id: string; status: string; tx_hash?: string; usdc?: string; reference: string }

// Every Acme status that we know. An unknown status gives undefined and one log.
const STATUS = statusMap<{ status: LegStatus; detail?: StepDetailCode }>('Acme Pay', {
  open: { status: 'requires_action' },
  paid: { status: 'processing', detail: 'settling' },
  delivered: { status: 'succeeded' },
  failed: { status: 'failed' },
})

export function acme(opts: AcmeOptions) {
  const api = opts.apiUrl ?? 'https://api.acme.test'
  const headers = { authorization: `Bearer ${opts.apiKey}` }

  const legs: LegSpec[] = [
    {
      id: 'card',
      kind: 'fiat_onramp',
      methods: ['card'],
      from: { asset: { kind: 'fiat', currencies: ['USD'] }, location: ['user_account'] },
      to: { asset: { kind: 'crypto', chains: { [BASE_USDC.chain]: [BASE_USDC.token] } }, location: ['address'] },
      regions: { allow: ['US'], deny: [] },
      eta: { min: 60, max: 900 },
      surfaces: ['REDIRECT'],
    },
  ]

  function eventFrom(o: AcmeOrder, log?: { warn(msg: string, data?: Record<string, unknown>): void }): LegEvent | undefined {
    const m = STATUS(o.status, log)
    // Unknown status, or still paying: no event, so the leg keeps its step.
    if (!m || m.status === 'requires_action') return undefined
    return {
      ref: o.reference,
      providerRef: o.id,
      status: m.status,
      ...(m.detail ? { detail: { code: m.detail, providerStatus: o.status } } : {}),
      ...(o.usdc ? { output: { value: o.usdc, asset: BASE_USDC } } : {}),
      ...(o.tx_hash ? { transactions: [{ role: 'destination' as const, hash: o.tx_hash }] } : {}),
      ...(m.status === 'failed' ? { error: openRampError('PAYMENT_FAILED') } : {}),
    }
  }

  return createAdapter({
    id: 'acme',
    name: 'Acme Pay',
    legs,

    async quote({ leg, amountIn }, ctx) {
      if (amountIn?.asset.kind !== 'fiat') throw new Error('Acme quotes need a fiat amount')
      let q: { usdc: string; fee: string; expires_at?: string }
      try {
        q = await fetchJson(ctx.fetch, `${api}/quotes?usd=${amountIn.value}`, { headers })
      } catch (e) {
        throw httpErrorToOpenRamp(e, 'Acme Pay', { what: 'price this amount', log: ctx.log })
      }
      return {
        adapterId: 'acme',
        legId: leg.legId,
        input: amountIn,
        output: { value: q.usdc, asset: BASE_USDC },
        // Acme sets the rate when the card payment clears.
        guarantee: 'estimate',
        fees: [{ kind: 'provider', label: 'Acme fee', amount: { value: q.fee, asset: amountIn.asset }, included: true }],
        eta: { min: 60, max: 900 },
        expiresAt: quoteExpiresAt(5, q.expires_at),
      }
    },

    async start({ quote, deliverTo }, ctx) {
      const address = deliverTo?.address ?? (ctx.destination.type === 'crypto' ? ctx.destination.address : undefined)
      if (!address) throw new Error('Acme needs a wallet address')
      const reference = `ork_${randomHex(10)}`
      let order: { id: string; checkout_url: string }
      try {
        order = await fetchJson(ctx.fetch, `${api}/orders`, {
          method: 'POST',
          headers: { ...headers, 'idempotency-key': ctx.idempotencyKey(`acme:${reference}`) },
          body: JSON.stringify({ usd: quote.input.value, wallet: address, reference, return_url: ctx.urls.returnUrl, webhook_url: ctx.urls.webhookUrl }),
        })
      } catch (e) {
        throw httpErrorToOpenRamp(e, 'Acme Pay', { what: 'start the payment', log: ctx.log })
      }
      return {
        status: 'requires_action',
        ref: reference,
        providerRef: order.id,
        action: {
          kind: 'payment',
          surface: { kind: 'REDIRECT', url: order.checkout_url, popup: true, provider: 'Acme Pay' },
          transitions: [{ name: 'poll', kind: 'AWAIT', poll: POLL.checkout }],
        },
      }
    },

    async status({ ref }, ctx) {
      const o = await fetchJson<AcmeOrder>(ctx.fetch, `${api}/orders/by-reference/${ref}`, { headers })
      // No event: the user is still paying, and the UI keeps the checkout surface.
      return legStepFromEvent(eventFrom(o, ctx.log), ref, POLL.checkout)
    },

    webhook: {
      configured: !!opts.webhookSecret,
      async verify(req, rawBody) {
        // Acme signs `{t}.{body}` and sends `t=...,v1=...`
        return verifyTimestampedHmac({ secret: opts.webhookSecret, rawBody, header: req.headers.get('acme-signature') })
      },
      async parse(rawBody, ctx) {
        const ev = eventFrom(JSON.parse(rawBody) as AcmeOrder, ctx.log)
        return ev ? [ev] : []
      },
    },
  })
}
```

## Test it with the kit

`@openrampkit/adapter/testing` has test helpers that do not depend on a test runner:

| Helper | Description |
|---|---|
| `fakeFetch(routes)` | A scripted `fetch` that records every call. Routes match by substring or RegExp; unmatched calls get 404. A route can `hang` to test timeouts. |
| `makeCtx({ fetch, ... })` | An `AdapterContext` with test defaults: session `sess_1` in the US, a USDC on Base destination, fresh in-memory KVs |
| `makeWebhookCtx()` | A webhook or catalog context |
| `memoryKV()` | An in-memory `ScopedKV` with TTLs (works with fake timers) |
| `recordingLog()`, `silentLog` | Loggers that record warnings and errors |
| `TEST_DESTINATION` | USDC on Base to `0x...beef` |
| `runAdapterConformance(adapter, opts)` | The conformance run |

`runAdapterConformance` checks:

- the adapter shape: API version 2, at least one leg, `eta.min <= eta.max`, surfaces declared, a region policy that allows something, decimal limits. Declared capabilities and surfaces need their methods: `surface_after_processing` needs a webhook; a `FORM`, `OTP` or `WALLET_TX` surface needs `transition()`; an adapter needs a result channel (`status()` or a configured webhook);
- per fixture: the quote (decimal strings, ids, non-negative money, the output in the leg's `to` asset, an `expiresAt` in the future, a known `guarantee`, `minOutput` with `min_output`, `slippageBps` from 0 to 10000, fee amounts that are `null` or have a valid asset);
- per fixture: `start()` and every transition and `status()` step. The v2 step rules: a known status, an `action` only with `requires_action`, a `phase` only with `pending` or `processing`, a `detail.code` from the list, transaction roles and hashes, legal transitions, and a `ref`. The first `requires_action` step needs a surface. The kit flags v1 fields (`state`, `sub`, `txHash`, `sourceTxHash`, a top-level `surface` or `transitions`). `expect` is compared with `stateFor(step)`;
- per webhook: `verify()` gives the expected result, and `parse()` gives the same events twice (idempotent), each with a `ref`, a known status and the step rules;
- per error path (`errorPaths`): `quote()` against a provider that answers HTTP 400, 401, 429 or 500, or times out, throws the `httpErrorToOpenRamp` code with the right `retryable` value.

Errors thrown by the adapter are reported as problems. The report also returns every quote, step and event.

```ts
// packages/adapter-acme/src/acme.test.ts
import { describe, expect, it } from 'vitest'
import { fakeFetch, makeCtx, runAdapterConformance } from '@openrampkit/adapter/testing'
import { hmacSha256 } from '@openrampkit/adapter'
import { stateFor } from '@openrampkit/core'
import { acme } from './index.js'

const leg = {
  adapterId: 'acme',
  legId: 'card',
  from: { asset: { kind: 'fiat' as const, currency: 'USD' }, location: { kind: 'user_account' as const } },
  to: {
    asset: { kind: 'crypto' as const, chain: 'eip155:8453', token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
    location: { kind: 'address' as const, address: '0x000000000000000000000000000000000000beef' },
  },
}

describe('acme adapter', () => {
  it('passes conformance', async () => {
    const { fetch, calls } = fakeFetch([
      { method: 'GET', match: '/quotes', reply: () => ({ usdc: '97.5', fee: '2.5' }) },
      { method: 'POST', match: '/orders', reply: () => ({ checkout_url: 'https://pay.acme.test/c/1' }) },
      { method: 'GET', match: '/orders/by-reference/', reply: (c) => ({ id: 'o1', status: 'delivered', usdc: '97.5', tx_hash: '0xabc', reference: c.url.split('/').pop() }) },
    ])
    const adapter = acme({ apiKey: 'k', webhookSecret: 'whsec' })
    const body = JSON.stringify({ id: 'o1', status: 'delivered', usdc: '97.5', reference: 'ork_1' })
    const t = Math.floor(Date.now() / 1000)
    const sig = `t=${t},v1=${await hmacSha256('whsec', `${t}.${body}`, 'hex')}`

    const report = await runAdapterConformance(adapter, {
      ctx: () => makeCtx({ fetch }),
      fixtures: [
        {
          leg,
          quote: { amountIn: { value: '100', asset: { kind: 'fiat', currency: 'USD' } } },
          expect: { start: 'PAYMENT', status: 'COMPLETED' },
        },
      ],
      errorPaths: [{ leg, quote: { amountIn: { value: '100', asset: { kind: 'fiat', currency: 'USD' } } } }],
      webhooks: [
        { name: 'signed', request: () => new Request('https://x.test', { method: 'POST', headers: { 'acme-signature': sig } }), rawBody: body, events: 1 },
        { name: 'bad signature', request: () => new Request('https://x.test', { method: 'POST', headers: { 'acme-signature': 'nope' } }), rawBody: body, valid: false },
      ],
    })

    expect(report.problems).toEqual([])
    expect(report.steps[0]?.action?.surface?.kind).toBe('REDIRECT')
    expect(stateFor(report.steps[0]!)).toBe('PAYMENT')
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ wallet: '0x000000000000000000000000000000000000beef' })
  })
})
```

The lower-level checks are also exported from the main entry: `checkAdapterShape(adapter)`, `checkLegQuote(quote)` and `checkLegStep(step)`.

## Upgrade from version 1

Version 2 of the adapter contract changes the step, the event, the quote and the fee. `createAdapter` throws for `apiVersion: 1`. The server ignores v1 step fields and logs a warning. The conformance kit flags them.

| Version 1 | Version 2 |
|---|---|
| `LegStep.state` | Removed. The server uses `stateFor(step)`. For a review step, set `phase: 'kyc'` or `phase: 'auth'` with `processing`. |
| `surface` and `transitions` on the step | `action: { kind: 'auth' \| 'kyc' \| 'payment', surface?, transitions }`, only with `requires_action` |
| An AWAIT transition on a step that waits | Leave it out, or set `poll` |
| `sub` (`STEP_SUBS`, `StepSub`, `isStepSub`) | `detail: { code, providerStatus? }` (`STEP_DETAIL_CODES`, `StepDetailCode`, `isStepDetailCode`) |
| `providerStatus` on the step | `detail.providerStatus` |
| `txHash` | `transactions: [{ role: 'destination', hash }]` |
| `sourceTxHash` | `transactions: [{ role: 'source', hash }]` |
| No provider order id | `providerRef` |
| `LegEvent` with its own fields (`surface`, `transitions`, `txHash`) | `LegEvent = LegStep & { ref, eventId? }` |
| `legStepFromEvent` sets a state | `legStepFromEvent` returns the event as a step; `awaitingPayment(ref, poll)` for a user who still pays |
| `LegQuote.expiresAt?` | `expiresAt` is required: `quoteExpiresAt()` |
| No guarantee | `guarantee: 'firm' \| 'min_output' \| 'estimate'`, with `minOutput?` and `slippageBps?` |
| `Fee { amount: string; currency: string; inRate? }` | `Fee { kind, label, amount: Amount \| null, included }`. `inRate` with amount `'0'` is now `amount: null`. |
| A `switch` with a `default` status | `statusMap(provider, table)`: an unknown status gives `undefined` |
| Hand-written `t=,v1=` HMAC checks | `verifyTimestampedHmac` |

## Publish

1. Name the package `openrampkit-adapter-<id>` (community) and export the factory.
2. Depend on `@openrampkit/adapter` and `@openrampkit/core`.
3. Document the options, the legs, the webhook URL (`{baseUrl}/webhooks/<id>`), and anything you could not verify against the live API.
