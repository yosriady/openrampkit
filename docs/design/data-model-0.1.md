# Data model for 0.1.0

Status: phase 1 done. Phase 2 (the adapter contract v2) is next. Date: 2026-10-09.

This record keeps the decisions about the public data model of OpenRampKit before the first npm release (0.1.0). It covers the public types of `@openrampkit/core`, the HTTP API and the webhooks of `@openrampkit/server`, and the adapter contract of `@openrampkit/adapter`.

## 1. Context

The model was already good: a server-driven `Step` with a typed `Surface` and transitions, exact decimal money, CAIP-2 chains, deterministic event ids and a transactional outbox. The problems were in the parts that an app integrates against:

1. Too many state names, and names that no comparable API uses (`open`, `awaiting_user`, `completed`).
2. `session.failed` was not final. A session could send `session.failed` and later `session.completed`.
3. Webhooks were not typed. One `OrkEvent<unknown>` served browser events and webhooks, the time was in Unix seconds, there was no version, and `withdrawal.*` repeated `session.*`.
4. The app had no id of its own on a session, no idempotency on create, and no cancel.
5. Transaction hashes were loose fields, fees had a free currency string, and quotes did not tell how firm they are (phase 2).

Nothing is on npm yet, so breaking changes are allowed now. They become expensive after 0.1.0.

## 2. Decisions

The owner approved these decisions.

| # | Question | Decision |
|---|---|---|
| 1 | Session status names | The Stripe and Daimo names: `requires_payment_method`, `requires_action`, `processing`, `succeeded`, `failed`, `canceled`, `expired`, `refunded`, `reversed`. `succeeded` for sessions, legs and events. The leg status `awaiting_user` is `requires_action`. `Step.state` keeps its upper case phase names, plus `CANCELED`. |
| 2 | Failed attempts | `failed` is final. A failed attempt sends `session.payment_failed`, sets `lastError`, and returns the session to `requires_payment_method`. `session.failed` only when the session ends. Nothing follows `session.failed`. |
| 3 | Renames | `Ork*` is `OpenRamp*` (`OpenRampError`, `OpenRampException`, `openRampError()`). `Amount.amount` is `Amount.value`. Internal ids (`ors_`, `evt_`, `ork_` provider refs) do not change. |
| 4 | Webhooks | Standard Webhooks headers and signatures. A typed `WebhookEvent` union, a separate `ClientEvent` union, `apiVersion` (an integer, 1) and an ISO `createdAt` on every event. One `session.*` catalog: no `withdrawal.*` events. Webhooks carry the backend session view. |
| 5 | Version format | An integer `apiVersion`, changed only on a breaking change of the wire format |
| 6 | `externalId` | Unique per app. See section 4.3 for the rules. |
| 7 | Idempotency | `Idempotency-Key` on every POST, with a stored body hash |
| 8 | Cancel | `POST /sessions/:id/cancel` and `openramp.sessions.cancel(id)`, with an optional `Adapter.cancel()` |
| 9 | Withdraw input | `destination`, `lockDestination`, `allowedDestinations` (were `target`, `lockTarget`, `allowedTargets`). The browser route `POST /sessions/:id/target` keeps its name. |
| 10 | `session.requires_action` webhook | On by default |
| 11 | Provider reference in the browser | Allowed (phase 2 adds it) |

## 3. State machine

| Status | When | Final |
|---|---|---|
| `requires_payment_method` | No payment is in progress: nothing started, or the last attempt failed (`lastError` is set) | no |
| `requires_action` | The active leg waits for the user. `step.surface` tells how. | no |
| `processing` | The provider or the chain works | no |
| `succeeded` | Every leg succeeded | yes (it can become `reversed`) |
| `failed` | Final failure, with `lastError` | yes |
| `canceled` | The app or the user canceled before money moved | yes |
| `expired` | The deadline passed with no payment, or the provider order expired | yes (a late payment can move it on) |
| `refunded` | The provider returned the funds before success | yes |
| `reversed` | The provider took the funds back after success | yes |

Rules as implemented:

- A FAILED step is a failed attempt while the session has attempts left. The failure is final when no attempts are left (`policy.maxAttempts`, default 10), when money arrived on a leg of the payment (a hop, or another asset than the quote), or when an operator resolves the session as `FAILED`.
- A session with a final status refuses `restart`, plans, quotes and new payments. A payment that a provider reports later on an earlier attempt, or after a cancel, sends `session.late_payment`. It never becomes `session.succeeded`.
- A session in `requires_payment_method` (also after a failed attempt) expires at its deadline and sends `session.expired`.
- `session.requires_action` and `session.processing` are sent once per leg and attempt.

## 4. Types as implemented

### 4.1 Money and errors

```ts
type Amount = { value: string; asset: Asset } // exact decimal string

type OpenRampError = {
  code: OpenRampErrorCode // a closed union, with PROVIDER_ERROR, CANCELED, IDEMPOTENCY_MISMATCH, EXTERNAL_ID_CONFLICT, CLOSED
  message: string         // safe to show
  retryable: boolean
  recovery?: 'requote' | 'retry_payment' | 'choose_other' | 'contact_support'
  legId?: string
}
```

### 4.2 Sessions

```ts
type SessionStatus =
  | 'requires_payment_method' | 'requires_action' | 'processing'
  | 'succeeded' | 'failed' | 'canceled' | 'expired' | 'refunded' | 'reversed'

type PublicSession = {
  id: string
  direction: 'deposit' | 'withdraw'
  destination?: Destination
  source?: WithdrawSource
  allowedDestinations?: AllowedDestinations
  destinationLocked?: boolean
  status: SessionStatus
  step: Step                 // state: StateName, with CANCELED
  result?: SessionResult
  lastError?: OpenRampError  // the last failed attempt, or the final failure
  canceled?: { at: string; reason: 'requested_by_app' | 'requested_by_user' | 'abandoned' }
  expiresAt: string
  livemode: boolean
  // country, currency, locale, amountBounds
}

// The backend view: webhooks, sessions.retrieve(), sessions.refresh(). Never sent to the browser.
type Session = PublicSession & { userId: string; externalId?: string; metadata: Record<string, string> }
```

### 4.3 Create, externalId, idempotency and cancel

```ts
type CreateSessionInput = {
  userId: string
  externalId?: string            // 1 to 256 printable characters, unique per app
  direction?: 'deposit' | 'withdraw'
  destination?: Destination      // deposit: required; withdraw: an optional preset
  lockDestination?: boolean      // withdraw only; a deposit destination is always locked
  allowedDestinations?: AllowedDestinations
  source?: WithdrawSource        // withdraw
  // country, region, email, locale, amountBounds, allowedMethods, metadata, ttlMinutes
}
type CreatedSession = { id: string; clientSecret: string; expiresAt: string }
type ExistingSession = { id: string; expiresAt: string; existing: true } // a repeated externalId
```

`externalId` rules. They keep a session, and its client secret, with the caller that made it:

- A repeat returns the session only when the session is not final, the `userId` is the same, and the input is the same (the record keeps a hash of the create input).
- A repeat returns no client secret. The server keeps only a hash of each secret, and never makes a second one. The app keeps the first secret, or makes a pay link from its server.
- Another user, other input, or a final session: `409 EXTERNAL_ID_CONFLICT`. The answer has no session id, status or secret.
- No public or admin route looks a session up by `externalId`.

`Idempotency-Key` on every POST: the server keeps the answer for 24 hours with a hash of the body. The same body replays the answer. Another body is `422 IDEMPOTENCY_MISMATCH`. A key that still runs is `409 CONFLICT`. For `POST /sessions`, the scope is the user that `authorize` returns.

Cancel never strands funds:

- Allowed in `requires_payment_method`, and in `requires_action` only before money moved: no transaction hash, no source transaction hash, no treasury send, no leg past `requires_action`, no later leg started. The `restart` transition has the same rule.
- When the adapter has `cancel()`, the server asks the provider to void the order first. A provider error refuses the cancel (`409`).
- The leg refs stay indexed, and the sweep polls an open leg of an adapter with `status()`. A payment that still arrives is recorded, and the server sends `session.late_payment` with `reason: 'after_cancel'`.

### 4.4 Webhooks

Headers: `webhook-id`, `webhook-timestamp`, and `webhook-signature: v1,<base64 HMAC-SHA256>` over `{id}.{timestamp}.{body}`. A `whsec_` secret is base64-decoded (24 to 64 bytes). `generateWebhookSecret()` makes one. A raw secret of 16 or more characters still works (its UTF-8 bytes). The test suite checks the signature against the test vector of the Standard Webhooks libraries.

```ts
type WebhookEventOf<T extends WebhookEventType> = {
  id: string            // deterministic evt_...
  object: 'event'
  apiVersion: 1
  type: T
  createdAt: string     // ISO 8601
  livemode: boolean
  sessionId: string
  data: { object: { session: Session } & WebhookEventFields[T] }
}
type WebhookEvent = { [T in WebhookEventType]: WebhookEventOf<T> }[WebhookEventType]

type WebhookEventFields = {
  'session.created': {}
  'session.requires_action': EventLeg
  'session.processing': EventLeg
  'session.succeeded': { resolution?: EventResolution }
  'session.payment_failed': EventLeg & { error: OpenRampError }
  'session.failed': { error?: OpenRampError; resolution?: EventResolution }
  'session.canceled': { reason: CancelReason }
  'session.expired': { resolution?: EventResolution }
  'session.refunded': { resolution?: EventResolution }
  'session.reversed': EventLeg & { legStatus: 'refunded' | 'reversed'; previous: StateName }
  'session.late_payment': EventLeg & { reason: 'after_expiry' | 'after_grace' | 'earlier_attempt' | 'after_cancel'; txHash?: string }
  'leg.succeeded': EventLeg
  'leg.failed': EventLeg & { error?: OpenRampError }
}
type EventLeg = { attempt?: number; index: number; adapterId: string; legId: string }
```

`ClientEvent` is a separate union for the browser UI (`modal.opened`, `target.selected`, `method.selected`, `quotes.shown`, `quote.selected`, `step.changed`, `surface.opened`, `surface.message`, `modal.closed`). It shares only `id`, `type`, `createdAt`, `livemode`, `sessionId` and `data.object` with `WebhookEvent`.

Every HTTP response has the header `openramp-version: 1`.

### 4.5 Stored records

`SESSION_SCHEMA` is 2. `migrateRecord()` runs on every read and brings a schema 1 record up to date: the status names, the leg status `requires_action`, `Amount.value`, the `notified` event names, and the withdraw names `allowedDestinations` and `destinationLocked`. Events already in an outbox keep the body that they were made with. The fixture `packages/server/src/fixtures/records-v1.json` was written by the server before this change, and the tests load it and finish its payments.

Known limit: adapter data in the KV space (for example a Bridge or mock order) keeps the old `amount` field. Only payments that are in flight during the upgrade have such data.

## 5. Phase 2: the adapter contract v2

Phase 2 changes the adapter contract once, with one `ADAPTER_API_VERSION` bump:

- `LegStep` loses `state`. `status` is the only state field, and a typed `action { kind, surface, transitions }` replaces the loose surface fields. The server derives `Step.state`.
- `Step.sub` becomes `Step.detail { code, providerStatus }`, a closed code union.
- Transactions become records with a role (`Transaction { role, chain, hash, legIndex }`), in place of `txHash`, `sourceTxHash`, `txHashes` and `sourceTxHashes`.
- `Session.payment.legs` with the provider, the provider reference (also in the browser view) and the amounts, in place of `Step.progress`.
- Quotes say how firm they are: `guarantee`, `minOutput`, `slippageBps`, and a required `expiresAt`.
- Typed fees: `Fee { type, label, amount: Amount | null, included }`.
- `Adapter.cancel()` in each provider adapter that can void an order.
- Optional: `delivery` in place of `amountMismatch`, `AmountRule`, `refundAddress`, CAIP-19 helpers, `OpenRampError.legIndex`, and required `symbol` and `decimals` in server outputs.

## 6. Sources

Fetched on 2026-10-09.

- Stripe: [PaymentIntent lifecycle](https://docs.stripe.com/payments/paymentintents/lifecycle), [idempotent requests](https://docs.stripe.com/api/idempotent_requests), [webhooks](https://docs.stripe.com/webhooks)
- Daimo: [sessions](https://docs.daimo.com/guides/sessions.md), [webhooks](https://docs.daimo.com/guides/webhooks.md)
- Standard Webhooks: [site](https://www.standardwebhooks.com), [specification](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md)
- Bridge: [transfer states](https://apidocs.bridge.xyz/platform/orchestration/transfers/transfer-states.md), [idempotence](https://apidocs.bridge.xyz/api-reference/introduction/idempotence.md)
- Meld: [transaction statuses](https://docs.meld.io/docs/stablecoins/for-all-products/transaction-statuses.md)
- Relay: [status](https://docs.relay.link/references/api/get-intents-status-v3.md); LI.FI: [status tracking](https://docs.li.fi/introduction/user-flows-and-examples/status-tracking)
- IETF: [The Idempotency-Key HTTP header field](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/) (422 for a reused key with another body, 409 for a key in progress)
- CAIP: [CAIP-2](https://standards.chainagnostic.org/CAIPs/caip-2), [CAIP-19](https://standards.chainagnostic.org/CAIPs/caip-19)

Related: [Spec](./spec.md), [Scope](./scope.md), [Events](../concepts/events.md), [Webhooks to your backend](../guide/webhooks.md).
