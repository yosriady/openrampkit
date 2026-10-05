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
}
```

`data.object.session.result` (a [`SessionResult`](../api/core.md#sessionresult)) tells what the user paid and what arrived, once a payment started.

Each event type (with its extra fields) is queued at most once per session. The server records what it sent in the session. A failed delivery is retried by the [sweep](../api/server.md#background-sweep), and a delivery can arrive more than once. Deduplicate by event id.

## Build your own events

`createEvent(type, object, { sessionId, livemode })` from `@openrampkit/core` builds an envelope with a random `evt_` id. `randomId(prefix)` makes ids of the same shape.
