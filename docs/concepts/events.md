# Events

OpenRampKit has two kinds of events, with two types:

- **Browser events** (`ClientEvent`): what the user does in the modal. For analytics and UI. Not trusted.
- **Webhook events** (`WebhookEvent`): what happened to the session, signed by your server and sent to your backend. Trusted after you verify the signature.

Both are unions on `type`: when you check `e.type`, TypeScript knows the fields of `e.data.object`. Both have `id`, `type`, an ISO 8601 `createdAt`, `livemode`, `sessionId` and `data.object`. Nothing else is shared.

```ts
type ClientEvent = {
  id: string            // 'evt_...' (made in the browser)
  type: ClientEventType // 'modal.opened' | 'method.selected' | ...
  createdAt: string     // ISO 8601
  livemode: boolean
  sessionId?: string
  data: { object: ClientEventFields[type] }
}

type WebhookEvent = {
  id: string            // 'evt_...' (deterministic)
  object: 'event'
  apiVersion: 1
  type: WebhookEventType // 'session.created' | 'session.succeeded' | ...
  createdAt: string     // ISO 8601
  livemode: boolean
  sessionId: string
  data: { object: { session: Session } & WebhookEventFields[type] }
}
```

`livemode` is `false` unless you pass `livemode: true` to `createOpenRamp`.

## Browser events

Receive them with `onEvent` on `OpenRampProvider`, `DepositButton`, `WithdrawButton`, `OpenRampEmbedded`, `openDeposit()`, `openWithdraw()` or the controller.

| Type | When | `data.object` |
|---|---|---|
| `modal.opened` | The controller starts for the first time | `{}` |
| `target.selected` | Withdraw: the server accepted the target | `{ type: 'crypto', chain, token }` or `{ type: 'fiat', currency }` |
| `method.selected` | The user picks a method | `{ method }` |
| `quotes.shown` | Quotes arrived | `{ method, count }` |
| `quote.selected` | The user confirms a quote | `{ quoteId }` |
| `step.changed` | The step's state or detail code changed | `{ state, detail? }` (`detail` is the `Step.detail.code`) |
| `surface.opened` | The user opened a surface (for example the redirect button) | `{ kind }` |
| `surface.message` | A provider iframe sent a recognized message | `{ kind, detail }` |
| `modal.closed` | The modal closed | `{ screen, state }` |

```tsx
<OpenRampProvider
  baseUrl="/api/openramp"
  onEvent={(e) => analytics.track(`deposit ${e.type}`, { sessionId: e.sessionId, ...e.data.object })}
>
  <DepositButton getClientSecret={getClientSecret} />
</OpenRampProvider>
```

Browser events are made in the browser. Their ids are not cryptographically random. Never credit anything from them.

## Webhook events

The server sends these to `webhooks.url`, signed with `webhooks.secret` (Standard Webhooks). See [Webhooks to your backend](../guide/webhooks.md) for the headers, the verification and the crediting rules. There is one catalog for deposits and withdrawals: `data.object.session.direction` tells which one it is.

| Type | When |
|---|---|
| `session.created` | A session was created |
| `session.requires_action` | A leg waits for the user. Once per leg and attempt. |
| `session.processing` | The user paid or acted, and a provider or the chain works. Once per leg and attempt. |
| `session.payment_failed` | A payment attempt failed, and the user can try again. The status is `requires_payment_method` again, with `lastError`. |
| `session.succeeded` | Every leg succeeded |
| `session.failed` | Final failure: no attempts are left, money already arrived on a leg, or an operator resolved the session as `FAILED`. No event follows it. |
| `session.canceled` | The app or the user canceled the session |
| `session.expired` | The deadline passed with no payment in progress, or the provider order expired (found by the sweep, or by a request) |
| `session.refunded` | The provider returned the payment before it succeeded |
| `session.reversed` | The payment succeeded, then the provider refunded it or took it back (a chargeback). Take back or freeze the credit. |
| `session.late_payment` | A payment arrived late. `reason: 'after_expiry'`: the session had expired, and the payment arrived after all; the session goes on and you also get `session.succeeded`. `reason: 'after_grace'`: the payment arrived after the grace window (`latePayments.graceHours`, default 72); the session stays expired, so refund or credit it by hand. `reason: 'earlier_attempt'`: a payment that the user left with `restart` succeeded, but the session already has a final status, or another payment is in progress; refund or credit it by hand. |
| `leg.succeeded` | One leg finished |
| `leg.failed` | One leg failed |

`data.object` for every webhook:

```ts
{
  session: Session // the backend view after the change: PublicSession plus userId and metadata
  // session.requires_action, session.processing: attempt, index, adapterId, legId
  // session.payment_failed: attempt, index, adapterId, legId, error
  // leg.succeeded: index, adapterId, legId
  // leg.failed: index, adapterId, legId, error
  // session.failed: error, and resolution when an operator resolved it
  // session.canceled: reason ('requested_by_app', 'requested_by_user' or 'abandoned')
  // session.late_payment: reason ('after_expiry', 'after_grace' or 'earlier_attempt'), index, adapterId, legId,
  //   transactions (the leg's transactions, when known), attempt (earlier_attempt only)
  // session.reversed: index, adapterId, legId,
  //   legStatus ('refunded' or 'reversed'), previous (the step state before, e.g. 'COMPLETED'),
  //   attempt (only for an earlier attempt; the session status does not change)
}
```

`WebhookEventFields` in `@openrampkit/core` has these fields per type. `WEBHOOK_EVENT_TYPES` lists the types.

`data.object.session.result` (a [`SessionResult`](../api/core.md#sessionresult)) tells what the user paid and what arrived, once a payment started. `result.transactions` has every transaction of the payment, each with a role: `source` (what paid into a leg, for example the user's wallet transaction), `hop` and `destination` (the deliveries), and more (see [Transactions](../api/core.md#transactions)). `result.delivery` tells if the reported output matches the quote. Credit the full amount only when `result.delivery.status` is `ok`. `session.payment` has the legs and the provider order ids (`providerRef`).

### Refunds and chargebacks after success

A provider can take back a payment after it completed: a refund, or a card chargeback. The adapter reports the leg as `refunded` or `reversed`. The server then:

- keeps the leg with its new status (and the session's `result`),
- adds `leg.refunded` (or `leg.reversed`) and `session.reversed` to the timeline,
- sets the step to `REVERSED` (with the error `PAYMENT_REVERSED`) and the session status to `reversed`,
- sends `session.reversed` one time, with a deterministic event id.

`REVERSED` is final. After it, the server moves no more funds for the session: it does not start a next leg, it does not call the treasury, and later provider events change only the leg data (no `leg.*` events, no other session state). An earlier attempt that the provider pays later does not become the session's payment: the server sends `session.late_payment`. The session refuses `restart` and a new payment. An operator can still set another final state with `admin.resolve` and an audit note.

A reversal also applies to a session that an operator closed with `admin.resolve`: the session becomes `REVERSED` and the server sends `session.reversed`.

A refund or a chargeback of an earlier attempt (one the user left with `restart`) does not change the session state. The server sends `session.reversed` once for it, with the extra field `attempt` (the attempt number). You may have credited that payment by hand after `session.late_payment`.

A refund that comes before the payment completed is not a reversal: the step becomes `REFUNDED` and the server sends `session.refunded`, as before.

The server learns a reversal from a provider event (a webhook). It does not poll a completed session.

Each event type (with its extra fields) is queued at most once per session. Leg events of a later payment attempt (after `restart`) are new events.

The event id is deterministic: it is a hash of the session id and the event (type and extra fields). The server saves the event in the session record in the same write as the change that caused it, and sends it only after that write succeeds. So a change that is not saved sends nothing, and a retry of the same change makes the same id. A failed delivery is retried by the [sweep](../api/server.md#background-sweep) with the same id, and a delivery can arrive more than once. Deduplicate by event id: it is safe.

## Build your own events

`createWebhookEvent(type, object, { id, sessionId, livemode })` and `createClientEvent(type, object, { sessionId, livemode })` from `@openrampkit/core` build the envelopes. `randomId(prefix)` makes ids of the same shape.
