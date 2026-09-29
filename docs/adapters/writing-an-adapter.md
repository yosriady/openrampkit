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

`createAdapter` checks the id format and that leg ids are unique, and sets `apiVersion` to `ADAPTER_API_VERSION` (1). The server refuses an adapter with another API version.

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
    capabilities: ['webhooks', 'polling'],
  },
]
```

Tips:

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

Return a `LegQuote` with decimal strings, every fee you know, an `eta`, and `expiresAt` when the price is time-limited. Put anything `start()` needs in `data`.

## start()

Create the order and return the first `LegStep`: a state, a surface, the transitions, the leg status, and a `ref`. The `ref` is how webhooks and status checks find the leg later. Always return one.

If the pathway has two legs and your leg is the first, deliver to `input.deliverTo.address` when it is set. Otherwise deliver to `ctx.destination.address`.

## status() and transition()

- `status({ leg, ref })` asks the provider for the current state. The server calls it when the browser polls (at most every 2 seconds per leg), from the background `sweep()`, and from `sessions.refresh()`.
- `transition({ leg, ref, name, inputs })` handles SUBMIT and SURFACE_RESULT transitions that your steps offer, for example an OTP form or `submit_tx` with `{ txHash }`.

## webhook

```ts
webhook: {
  verify(req: Request, rawBody: string, ctx): Promise<boolean>
  parse(rawBody: string, ctx): Promise<LegEvent[]>
}
type LegEvent = {
  ref: string; status: LegStatus; output?: Amount; txHash?: string; error?: OrkError
  surface?: Surface          // non-terminal events only: a new surface, e.g. a WALLET_TX once an offramp knows its deposit address
  transitions?: Transition[] // goes with surface; default: an AWAIT poll
}
```

The server calls `verify` first and answers 401 when it returns false. Then it applies each event to the session that owns `ref`. `parse` must be idempotent: the same body must give the same events.

## Withdraw legs

A leg can serve [withdrawals](../guide/withdraw.md) when:

- its kind is `bridge_swap`, `crypto_withdraw`, `crypto_offramp` or `wallet_transfer`,
- it declares the `WALLET_TX` surface, and it takes the funds with a `WALLET_TX` step,
- its `from` takes crypto at `user_wallet` (and at `address`, for apps that hold the funds),
- its `to` is an `address` (to a wallet) or fiat at `user_account` (to cash).

`catalog()` gets `direction`, so an adapter can return sell legs for withdrawals only. In `quote()` and `start()`, `source` is the session's source asset, with the sender address when it is known (the user's wallet, or the app's treasury).

The `WALLET_TX` step needs a `SURFACE_RESULT` transition that expects `tx_hash`. The client fires it after the user's wallet sends. For `custody: 'app'`, the server sends the transactions through the app's treasury and fires the same transition itself. When a provider learns its deposit address later (for example in a webhook), return a `LegEvent` with `status: 'awaiting_user'`, the `WALLET_TX` `surface` and its `transitions`.

## prepareDeposit()

Only for bridge legs. Before the server quotes a two-leg pathway, it asks the second leg's adapter for the address the first leg must deliver to. Relay returns an open deposit address.

## routes()

Serve pages at `{baseUrl}/adapters/{id}/*`: a return page, or a hosted page like the mock checkout. Return `undefined` to fall through to 404. Call `ctx.applyEvent(event)` to update a session from a route, with the same effect as a webhook.

## Rules

From the [spec](../design/spec.md):

- Adapters are pure server code. Do not read global environment variables; take all config from the factory options.
- Use web-standard APIs only (`fetch`, WebCrypto), so the adapter runs on Cloudflare Workers.
- Verify webhook signatures. Be idempotent on repeated webhooks.
- Return money as decimal strings, never floats. Fill every fee you know in `LegQuote.fees`.
- Do not store KYC data. Provider references (order id, customer id) are fine.
- Throw `OrkException` with a safe message for expected failures. Use `httpErrorToOrk()` for failed provider calls.
- Naming: first-party packages are `@openrampkit/adapter-<id>`. Community packages should be `openrampkit-adapter-<id>`.

## Helpers

`@openrampkit/adapter` exports helpers the first-party adapters use:

| Helper | Description |
|---|---|
| `fetchJson(fetch, url, init)` | JSON fetch with a timeout (default 8000 ms). Errors carry `status`, `body` and `timeout`. |
| `httpErrorToOrk(e, provider, opts)` | 429 to `RATE_LIMITED`; 400, 404, 409, 422 to `NO_QUOTES` with the provider's message; timeouts and other errors to `PROVIDER_UNAVAILABLE` |
| `httpStatus(e)`, `providerMessage(e)` | Read the HTTP status or the provider's message from an error |
| `POLL.onchain`, `POLL.checkout`, `POLL.dev` | Poll schedules for AWAIT transitions |
| `awaitPoll(poll, name = 'poll')` | An AWAIT transition |
| `legStepFromEvent(event, ref, poll)` | The `LegStep` for a mapped provider status (no event means `PAYMENT`, `awaiting_user`) |
| `decimalFrom(n, digits = 8)` | A JSON number from a provider to an exact decimal string |
| `hmacSha256(secret, message, 'hex' \| 'base64')`, `timingSafeEqual(a, b)`, `randomHex(bytes)` | Crypto helpers |

## A complete example

```ts
// packages/adapter-acme/src/index.ts
import {
  POLL, awaitPoll, createAdapter, fetchJson, hmacSha256, httpErrorToOrk, legStepFromEvent, randomHex, timingSafeEqual,
} from '@openrampkit/adapter'
import type { LegEvent } from '@openrampkit/adapter'
import { USDC, orkError } from '@openrampkit/core'
import type { CryptoAsset, LegSpec } from '@openrampkit/core'

export type AcmeOptions = { apiKey: string; webhookSecret: string; apiUrl?: string }

const BASE_USDC: CryptoAsset = { kind: 'crypto', chain: 'eip155:8453', token: USDC['eip155:8453']!, symbol: 'USDC', decimals: 6 }

type AcmeOrder = { id: string; status: 'open' | 'paid' | 'delivered' | 'failed'; tx_hash?: string; usdc?: string; reference: string }

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
      capabilities: ['webhooks', 'polling'],
    },
  ]

  function eventFrom(o: AcmeOrder): LegEvent | undefined {
    const ref = o.reference
    switch (o.status) {
      case 'delivered':
        return { ref, status: 'succeeded', ...(o.tx_hash ? { txHash: o.tx_hash } : {}), ...(o.usdc ? { output: { amount: o.usdc, asset: BASE_USDC } } : {}) }
      case 'paid':
        return { ref, status: 'processing' }
      case 'failed':
        return { ref, status: 'failed', error: orkError('PAYMENT_FAILED') }
      default:
        return undefined // still paying
    }
  }

  return createAdapter({
    id: 'acme',
    name: 'Acme Pay',
    legs,

    async quote({ leg, amountIn }, ctx) {
      if (amountIn?.asset.kind !== 'fiat') throw new Error('Acme quotes need a fiat amount')
      let q: { usdc: string; fee: string }
      try {
        q = await fetchJson(ctx.fetch, `${api}/quotes?usd=${amountIn.amount}`, { headers })
      } catch (e) {
        throw httpErrorToOrk(e, 'Acme Pay', { what: 'price this amount', log: ctx.log })
      }
      return {
        adapterId: 'acme',
        legId: leg.legId,
        input: amountIn,
        output: { amount: q.usdc, asset: BASE_USDC },
        fees: [{ kind: 'provider', label: 'Acme fee', amount: q.fee, currency: 'USD' }],
        eta: { min: 60, max: 900 },
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      }
    },

    async start({ quote, deliverTo }, ctx) {
      const address = deliverTo?.address ?? (ctx.destination.type === 'crypto' ? ctx.destination.address : undefined)
      if (!address) throw new Error('Acme needs a wallet address')
      const reference = `ork_${randomHex(10)}`
      let order: { checkout_url: string }
      try {
        order = await fetchJson(ctx.fetch, `${api}/orders`, {
          method: 'POST',
          headers: { ...headers, 'idempotency-key': ctx.idempotencyKey(`acme:${reference}`) },
          body: JSON.stringify({ usd: quote.input.amount, wallet: address, reference, return_url: ctx.urls.returnUrl, webhook_url: ctx.urls.webhookUrl }),
        })
      } catch (e) {
        throw httpErrorToOrk(e, 'Acme Pay', { what: 'start the payment', log: ctx.log })
      }
      return {
        state: 'PAYMENT',
        status: 'awaiting_user',
        ref: reference,
        surface: { kind: 'REDIRECT', url: order.checkout_url, popup: true, provider: 'Acme Pay' },
        transitions: [awaitPoll(POLL.checkout)],
      }
    },

    async status({ ref }, ctx) {
      const o = await fetchJson<AcmeOrder>(ctx.fetch, `${api}/orders/by-reference/${ref}`, { headers })
      return legStepFromEvent(eventFrom(o), ref, POLL.checkout)
    },

    webhook: {
      async verify(req, rawBody) {
        const sig = req.headers.get('acme-signature') ?? ''
        return timingSafeEqual(sig, await hmacSha256(opts.webhookSecret, rawBody, 'hex'))
      },
      async parse(rawBody) {
        const ev = eventFrom(JSON.parse(rawBody) as AcmeOrder)
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

- the adapter shape: API version, at least one leg, `eta.min <= eta.max`, surfaces declared, a region policy that allows something, decimal limits;
- per fixture: the quote (decimal strings, ids, non-negative money, ISO `expiresAt`), `start()` and every transition and `status()` step (legal states from the flow table, a known leg status, a `ref`, terminal states only with terminal leg statuses), and expected states;
- per webhook: `verify()` gives the expected result, and `parse()` gives the same events twice (idempotent), each with a `ref` and a known status.

Errors thrown by the adapter are reported as problems. The report also returns every quote, step and event.

```ts
// packages/adapter-acme/src/acme.test.ts
import { describe, expect, it } from 'vitest'
import { fakeFetch, makeCtx, runAdapterConformance } from '@openrampkit/adapter/testing'
import { hmacSha256 } from '@openrampkit/adapter'
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
    const sig = await hmacSha256('whsec', body, 'hex')

    const report = await runAdapterConformance(adapter, {
      ctx: () => makeCtx({ fetch }),
      fixtures: [
        {
          leg,
          quote: { amountIn: { amount: '100', asset: { kind: 'fiat', currency: 'USD' } } },
          expect: { start: 'PAYMENT', status: 'COMPLETED' },
        },
      ],
      webhooks: [
        { name: 'signed', request: () => new Request('https://x.test', { method: 'POST', headers: { 'acme-signature': sig } }), rawBody: body, events: 1 },
        { name: 'bad signature', request: () => new Request('https://x.test', { method: 'POST', headers: { 'acme-signature': 'nope' } }), rawBody: body, valid: false },
      ],
    })

    expect(report.problems).toEqual([])
    expect(report.steps[0]?.surface?.kind).toBe('REDIRECT')
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ wallet: '0x000000000000000000000000000000000000beef' })
  })
})
```

The lower-level checks are also exported from the main entry: `checkAdapterShape(adapter)`, `checkLegQuote(quote)` and `checkLegStep(step)`.

## Publish

1. Name the package `openrampkit-adapter-<id>` (community) and export the factory.
2. Depend on `@openrampkit/adapter` and `@openrampkit/core`.
3. Document the options, the legs, the webhook URL (`{baseUrl}/webhooks/<id>`), and anything you could not verify against the live API.
