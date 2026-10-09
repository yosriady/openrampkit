# Webhooks to your backend

The browser can lie. Credit balances only from a signed webhook that the OpenRampKit server sends to your backend, or from a server-side lookup.

## Turn them on

```ts
createOpenRamp({
  // ...
  webhooks: {
    url: 'https://app.example.com/api/hooks',
    secret: process.env.OPENRAMP_WEBHOOK_SECRET!,
    retryHours: 24, // optional: how long the sweep retries a failed event (the default)
    maxAttempts: 20, // optional: also stop after this many attempts in all
  },
})
```

Without `webhooks`, the server sends nothing and `openramp.webhooks.verify()` always returns `false`.

## Verify the signature

Each request is a `POST` with a JSON body and three headers:

| Header | Value |
|---|---|
| `openramp-id` | The event id, `evt_...`. The same change always has the same id, also on a retry. |
| `openramp-timestamp` | Unix seconds when it was sent |
| `openramp-signature` | `v1=` plus the hex HMAC-SHA256 of `{id}.{timestamp}.{body}` with your secret |

Verify with the raw body text. Do not parse and re-serialize the JSON first.

::: code-group

```ts [Same app (openramp.webhooks.verify)]
import { openramp } from '@/lib/openramp'

export async function POST(req: Request) {
  const body = await req.text()
  if (!(await openramp.webhooks.verify(req, body))) {
    return new Response('bad signature', { status: 401 })
  }
  const event = JSON.parse(body)
  await handle(event)
  return new Response('ok')
}
```

```ts [Other service (verifyWebhook)]
import { verifyWebhook } from '@openrampkit/server'

export async function POST(req: Request) {
  const body = await req.text()
  const ok = await verifyWebhook(process.env.OPENRAMP_WEBHOOK_SECRET!, req.headers, body)
  if (!ok) return new Response('bad signature', { status: 401 })
  await handle(JSON.parse(body))
  return new Response('ok')
}
```

```ts [Node without the package]
import { createHmac, timingSafeEqual } from 'node:crypto'

function verify(secret: string, headers: Record<string, string>, body: string, toleranceSec = 300) {
  const id = headers['openramp-id']
  const ts = Number(headers['openramp-timestamp'])
  const sig = headers['openramp-signature'] ?? ''
  if (!id || !ts || Math.abs(Date.now() / 1000 - ts) > toleranceSec) return false
  const expected = 'v1=' + createHmac('sha256', secret).update(`${id}.${ts}.${body}`).digest('hex')
  return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
}
```

:::

`verifyWebhook(secret, headers, body, toleranceSec = 300)` rejects a timestamp more than 5 minutes from your clock. `headers` is anything with `get(name)`, such as a `Headers` object.

## Event types

| Type | When | Extra fields in `data.object` |
|---|---|---|
| `session.created` | `sessions.create()` or `POST /sessions` made a session | |
| `leg.succeeded` | One leg finished | `index`, `adapterId`, `legId` |
| `leg.failed` | One leg failed | `index`, `adapterId`, `error` |
| `session.completed` | Every leg succeeded. **Credit here.** | |
| `session.failed` | The step became `FAILED` or `BLOCKED` | |
| `session.refunded` | The step became `REFUNDED`: the provider returned the payment before it completed | |
| `session.reversed` | The payment completed, then the provider refunded it or took it back (a chargeback). **Take back or freeze the credit.** | `index`, `adapterId`, `legId`, `legStatus`, `previous`, and `attempt` for an earlier attempt |
| `session.expired` | The session passed its expiry before the payment went on (no payment started, or the leg still waits for the user), or a leg expired. A late payment can still complete it (see `session.late_payment`). | |
| `session.late_payment` | A payment arrived late: after the session expired, or on an earlier attempt | `reason`, `index`, `adapterId`, `legId`, `txHash`, `attempt` |
| `withdrawal.completed` | Withdraw sessions: sent after `session.completed` | |
| `withdrawal.failed` | Withdraw sessions: sent after `session.failed` | |
| `withdrawal.reversed` | Withdraw sessions: sent after `session.reversed` | Same as `session.reversed` |

The [background sweep](../api/server.md#background-sweep) finds expired sessions and sends `session.expired`. A request that loads an expired session (for example a browser poll) also sends it. Without a scheduled sweep, a session that nobody loads again never sends `session.expired`.

## Event envelope

```json
{
  "id": "evt_4f0c9a1b2c3d4e5f60718293",
  "type": "session.completed",
  "created": 1790000000,
  "livemode": false,
  "sessionId": "ors_6a1f0c2b9d8e7f6a5b4c3d2e",
  "data": {
    "object": {
      "session": {
        "id": "ors_...",
        "status": "completed",
        "destination": { "...": "..." },
        "step": { "state": "COMPLETED", "progress": { "legs": [] } },
        "result": {
          "method": "vietqr",
          "provider": "Swapped",
          "input": { "amount": "500000", "asset": { "kind": "fiat", "currency": "VND" } },
          "output": { "amount": "18.92", "asset": { "kind": "crypto", "chain": "eip155:8453", "token": "0x8335...", "symbol": "USDC", "decimals": 6 } },
          "outputConfirmed": true,
          "fees": [{ "kind": "provider", "label": "Swapped fee", "amount": "9000", "currency": "VND" }],
          "txHashes": ["0x..."]
        }
      },
      "userId": "user_123",
      "metadata": { "orderId": "o_42" }
    }
  }
}
```

`data.object.session` is a [`PublicSession`](../api/core.md#publicsession). Once a payment started, it has `result` (a [`SessionResult`](../api/core.md#sessionresult)): the method, the provider, what the user paid (`input`), what arrived (`output`), whether `output` is confirmed, the fees and the transaction hashes. `userId` and `metadata` are what you passed to `sessions.create()`. See [Events](../concepts/events.md) for the full types.

The [webhooks flow](../concepts/flows.md#webhooks-to-your-backend) shows signing, the outbox and the retries as a diagram.

## Credit exactly once

Webhooks are delivered **at least once**. A retry after a timeout can send the same event twice. A repeat always has the same event id: the server makes the id from the session id and the event, not at random. Follow these rules:

1. **Credit only on `session.completed`.** `leg.succeeded` on the first leg of a two-leg pathway does not mean the funds arrived.
2. **Deduplicate by event id and by session id.** Store the event id (`openramp-id`, also `event.id`) and drop an event you already handled. Store the session id with a unique constraint when you credit, so a session is credited once.
3. **Handle `session.late_payment`.** It has a `reason`:
   - `after_expiry`: the session expired while the user still had to pay (for example a bank transfer), and the payment arrived later. The server keeps polling such a payment for `latePayments.graceHours` (default 72), and a provider webhook also counts. The session goes on, and you get `session.completed` when it completes. Credit on `session.completed` as usual, also after `session.expired`.
   - `after_grace`: the payment arrived after the grace window. The session stays `EXPIRED` and you get no `session.completed`. Refund or credit it by hand.
   - `earlier_attempt`: the user left a payment (the `restart` transition) after they paid it. When the provider reports that payment later, the session completes with it (you get `session.completed`). When the session already completed, expired or was reversed, or another payment is in progress, you get `session.late_payment` instead. Refund or credit it by hand.
4. **Check the session state.** For extra safety, call `openramp.sessions.retrieve(event.sessionId)` and confirm `status === 'completed'` before you credit.
5. **Credit `result.output` when it is confirmed.** `session.result.output` is what arrived. When `outputConfirmed` is `true`, the provider or the chain reported it. When it is `false`, it is the quote: check the amount yourself before you credit it (on chain with `result.txHashes`, or at the provider), or credit the amount you expected on your order. For merchant destinations, the provider's report is the source of truth.
6. **Check `result.amountMismatch`.** When it is set, a provider reported less than the quote by more than `policy.outputToleranceBps` (default 1%) (`reason: 'short'`), or an output in another asset (`asset_mismatch`) or with no valid amount (`invalid_amount`). `received` is what the provider reported, and `shortfall` is the difference. Credit what arrived, not the quote, or hold the credit for review. A shortfall on a leg before the last one can make the last leg deliver less too.

```ts
async function handle(event: { id: string; type: string; sessionId?: string; data: { object: any } }) {
  if (event.type !== 'session.completed' || !event.sessionId) return
  const { userId, session } = event.data.object
  const result = session.result
  await db.transaction(async (tx) => {
    // unique index on credits.session_id: a second insert fails and nothing is credited twice
    const inserted = await tx.credits.insertIfAbsent({ sessionId: event.sessionId, userId, eventId: event.id })
    if (!inserted) return
    const amount = result.outputConfirmed ? result.output.amount : await verifiedAmount(event.sessionId, result)
    await tx.balances.increment(userId, amount)
  })
}
```

For a withdrawal, `result.input` is what left, and `result.output` is what the user received (or the estimate). See [Withdrawals](./withdraw.md#events).

## Refunds and chargebacks after success

A provider can take back a payment after `session.completed`: a refund, or a card chargeback. Then you get `session.reversed`, and `session.status` is `reversed`. You credited the user on `session.completed`, so take the credit back, or freeze it until you check the case:

```ts
if (event.type === 'session.reversed' && event.sessionId) {
  const { userId, legStatus } = event.data.object
  await db.transaction(async (tx) => {
    // Once per session: a unique index on reversals.session_id
    const inserted = await tx.reversals.insertIfAbsent({ sessionId: event.sessionId, userId, eventId: event.id, legStatus })
    if (!inserted) return
    const credit = await tx.credits.find({ sessionId: event.sessionId })
    if (credit) await tx.balances.decrement(userId, credit.amount) // or freeze the balance and alert support
  })
}
```

- `session.reversed` comes at most once per session, with a stable event id. Deduplicate it like the other events.
- `legStatus` is `refunded` (the provider refunded the user) or `reversed` (a chargeback or a returned payout).
- When the data has `attempt`, the reversal is for an earlier attempt that the user left with `restart`. The session state does not change. Take back only a credit that you gave by hand for that attempt (after `session.late_payment`).
- For a withdrawal you also get `withdrawal.reversed`. The payout did not reach the user, so give the funds back to the user's balance, or contact the user.
- The modal shows "Payment reversed" when the user still has it open.

::: warning Same-chain wallet transfers
When the source token is the same as the destination token on the same chain, the Relay adapter sends a plain transfer without Relay. It checks the transaction receipt on chain: the transaction succeeded and paid the recipient at least the quoted amount. It does not check that the transaction is new or that the user sent it. Store `result.txHashes` with a unique constraint, so one transaction cannot complete two sessions.
:::

## Delivery

- The server writes each event into the session record (the outbox), in the same save as the change that caused it. When that save fails (for example a `409` conflict), the event does not exist, and nothing is sent.
- After the save, the server sends the new events at once, with a 4 second timeout (`timeouts.webhook`). A failed delivery (no 2xx answer, or a timeout) is logged as `webhook delivery failed` or `webhook delivery error`. The event stays in the outbox.
- The [background sweep](../api/server.md#background-sweep) retries the outbox. The wait starts at 30 seconds and doubles after each attempt, up to 2 hours. The sweep retries for `webhooks.retryHours` (default 24 hours), or until `webhooks.maxAttempts` attempts when you set it.
- Then the event becomes a **dead letter**: it stays in the session record, and the server logs `webhook moved to dead letter after retries` as an error. When your backend works again, call `openramp.webhooks.replay(sessionId)` to send the dead letters of that session again, with the same event ids.
- A retry sends the same body with the same `openramp-id`, and a new timestamp and signature.
- A delivery problem never breaks the user's flow.
- Return any 2xx status to acknowledge.

Retries happen only when something runs the sweep. Schedule it: see [Cloudflare Workers](../deploy/cloudflare-workers.md#cron-trigger) or [Next.js / Vercel](../deploy/nextjs.md#background-sweep). The sweep also refreshes open payments, so a session still completes (and sends its webhooks) after the user closes the tab.

## Provider webhooks

Provider webhooks are a different thing. Providers call your OpenRampKit server at `{baseUrl}/webhooks/{adapterId}`, and the adapter verifies them. See each [adapter page](../adapters/) for the URL and the secret to configure.
