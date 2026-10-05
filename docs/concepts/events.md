# Events

OpenRampKit has two kinds of events with the same envelope:

- **Browser events**: what the user does in the modal. For analytics and UI. Not trusted.
- **Webhook events**: what happened to the session, signed by your server and sent to your backend. Trusted after you verify the signature.

## Envelope

```ts
type OrkEvent<T = unknown> = {
  id: string            // 'evt_...'
  type: OrkEventType
  created: number       // Unix seconds
  livemode: boolean
  sessionId?: string
  data: { object: T }
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
| `step.changed` | The step's state or sub-state changed | `{ state, sub }` |
| `surface.opened` | The user opened a surface (for example the redirect button) | `{ kind }` |
| `surface.message` | A provider iframe sent a recognized message | `{ kind, detail }` |
| `modal.closed` | The modal closed | `{ screen, state }` |

```tsx
<OpenRampProvider
  baseUrl="/api/openramp"
  onEvent={(e) => analytics.track(`deposit ${e.type}`, { sessionId: e.sessionId, ...(e.data.object as object) })}
>
  <DepositButton getClientSecret={getClientSecret} />
</OpenRampProvider>
```

Browser events are made in the browser. Their ids are not cryptographically random. Never credit anything from them.

## Webhook events

The server sends these to `webhooks.url`, signed with `webhooks.secret`. See [Webhooks to your backend](../guide/webhooks.md) for verification and crediting.

| Type | When |
|---|---|
| `session.created` | A session was created |
| `leg.succeeded` | One leg finished |
| `leg.failed` | One leg failed |
| `session.completed` | Every leg succeeded |
| `session.failed` | The step became `FAILED` or `BLOCKED` |
| `session.refunded` | The step became `REFUNDED` |
| `session.expired` | The session passed its expiry with no payment started, or with a leg that still waits for the user (found by the sweep, or by a request). Also sent when a leg ends as `expired`. |
| `session.late_payment` | A payment that the user left with `restart` succeeded, but the session already completed, or another payment is in progress. Refund or credit it by hand. |
| `withdrawal.completed` | Withdraw sessions: sent after `session.completed` |
| `withdrawal.failed` | Withdraw sessions: sent after `session.failed` |

`data.object` for every webhook:

```ts
{
  session: PublicSession            // the session after the change
  userId: string                    // from sessions.create()
  metadata: Record<string, string>  // from sessions.create(), or {}
  // leg.succeeded: index, adapterId, legId
  // leg.failed:    index, adapterId, error
  // session.late_payment: attempt, index, adapterId, legId, txHash (when known)
}
```

`data.object.session.result` (a [`SessionResult`](../api/core.md#sessionresult)) tells what the user paid and what arrived, once a payment started.

Each event type (with its extra fields) is queued at most once per session. Leg events of a later payment attempt (after `restart`) are new events.

The event id is deterministic: it is a hash of the session id and the event (type and extra fields). The server saves the event in the session record in the same write as the change that caused it, and sends it only after that write succeeds. So a change that is not saved sends nothing, and a retry of the same change makes the same id. A failed delivery is retried by the [sweep](../api/server.md#background-sweep) with the same id, and a delivery can arrive more than once. Deduplicate by event id: it is safe.

## Build your own events

`createEvent(type, object, { id, sessionId, livemode })` from `@openrampkit/core` builds an envelope. Without `id`, the id is a random `evt_` id. `randomId(prefix)` makes ids of the same shape.
