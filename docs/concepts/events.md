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

Receive them with `onEvent` on `OpenRampProvider`, `DepositButton`, `OpenRampEmbedded`, `openDeposit()` or `DepositController`.

| Type | When | `data.object` |
|---|---|---|
| `modal.opened` | The controller starts for the first time | `{}` |
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
  onEvent={(e) => analytics.track(`deposit ${e.type}`, { sessionId: e.sessionId, ...e.data.object })}
>
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
| `session.expired` | An open session was loaded after its expiry |

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

Each event type (with its extra fields) is sent at most once per session. The server records what it sent in the session.

## Build your own events

`createEvent(type, object, { sessionId, livemode })` from `@openrampkit/core` builds an envelope with a random `evt_` id. `randomId(prefix)` makes ids of the same shape.
