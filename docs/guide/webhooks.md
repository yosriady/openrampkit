# Webhooks to your backend

The browser can lie. Credit balances only from a signed webhook that the OpenRampKit server sends to your backend, or from a server-side lookup.

The webhooks follow [Standard Webhooks](https://www.standardwebhooks.com): the headers, the signature and the secret format are the same. Any Standard Webhooks library can verify them.

## Turn them on

```ts
import { createOpenRamp, generateWebhookSecret } from '@openrampkit/server'

createOpenRamp({
  // ...
  webhooks: {
    url: 'https://app.example.com/api/hooks',
    secret: process.env.OPENRAMP_WEBHOOK_SECRET!, // whsec_... (make one with generateWebhookSecret())
    retryHours: 24, // optional: how long the sweep retries a failed event (the default)
    maxAttempts: 20, // optional: also stop after this many attempts in all
  },
})
```

- Use a Standard Webhooks secret: `whsec_` and the base64 of 24 to 64 random bytes. `generateWebhookSecret()` makes one (32 bytes). Keep it in your secret store.
- The server also accepts a raw secret of 16 or more characters. Then the key is the UTF-8 bytes of the string. A Standard Webhooks library needs the `whsec_` form, so use that form for new apps.
- Without `webhooks`, the server sends nothing and `openramp.webhooks.verify()` always returns `false`.

## Verify the signature

Each request is a `POST` with a JSON body and three headers:

| Header | Value |
|---|---|
| `webhook-id` | The event id, `evt_...`. The same change always has the same id, also on a retry. |
| `webhook-timestamp` | Unix seconds when the server sent it |
| `webhook-signature` | `v1,` and the base64 HMAC-SHA256 of `{webhook-id}.{webhook-timestamp}.{body}`. The key is the base64-decoded part of the secret after `whsec_`. |

The signature header can hold more than one signature, separated by spaces. Accept the request when one of them matches.

Verify with the raw body text. Do not parse and serialize the JSON again before you verify.

::: code-group

```ts [Same app (openramp.webhooks.verify)]
import type { WebhookEvent } from '@openrampkit/server'
import { openramp } from '@/lib/openramp'

export async function POST(req: Request) {
  const body = await req.text()
  if (!(await openramp.webhooks.verify(req, body))) {
    return new Response('bad signature', { status: 401 })
  }
  const event = JSON.parse(body) as WebhookEvent
  await handle(event)
  return new Response('ok')
}
```

```ts [Other service (verifyWebhook)]
import { verifyWebhook } from '@openrampkit/server'
import type { WebhookEvent } from '@openrampkit/server'

export async function POST(req: Request) {
  const body = await req.text()
  const ok = await verifyWebhook(process.env.OPENRAMP_WEBHOOK_SECRET!, req.headers, body)
  if (!ok) return new Response('bad signature', { status: 401 })
  await handle(JSON.parse(body) as WebhookEvent)
  return new Response('ok')
}
```

```ts [Standard Webhooks library]
import { Webhook } from 'standardwebhooks'

const wh = new Webhook(process.env.OPENRAMP_WEBHOOK_SECRET!) // whsec_...

export async function POST(req: Request) {
  const body = await req.text()
  try {
    const event = wh.verify(body, Object.fromEntries(req.headers))
    await handle(event)
  } catch {
    return new Response('bad signature', { status: 401 })
  }
  return new Response('ok')
}
```

```ts [Node without a package]
import { createHmac, timingSafeEqual } from 'node:crypto'

function verify(secret: string, headers: Record<string, string>, body: string, toleranceSec = 300) {
  const id = headers['webhook-id']
  const ts = Number(headers['webhook-timestamp'])
  const sigs = (headers['webhook-signature'] ?? '').split(' ')
  if (!id || !ts || Math.abs(Date.now() / 1000 - ts) > toleranceSec) return false
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const expected = Buffer.from('v1,' + createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64'))
  return sigs.some((s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), expected))
}
```

:::

`verifyWebhook(secret, headers, body, toleranceSec = 300)` refuses a timestamp more than 5 minutes from your clock. `headers` is anything with `get(name)`, such as a `Headers` object.

## Event envelope

Every event has the same envelope. `WebhookEvent` in `@openrampkit/server` (and `@openrampkit/core`) is a union of all event types. When you check `event.type`, TypeScript knows the fields of `data.object`.

```json
{
  "id": "evt_4f0c9a1b2c3d4e5f6071829304a5b6c7",
  "object": "event",
  "apiVersion": 1,
  "type": "session.succeeded",
  "createdAt": "2026-10-09T13:00:00.000Z",
  "livemode": false,
  "sessionId": "ors_6a1f0c2b9d8e7f6a5b4c3d2e",
  "data": {
    "object": {
      "session": {
        "id": "ors_6a1f0c2b9d8e7f6a5b4c3d2e",
        "direction": "deposit",
        "status": "succeeded",
        "userId": "user_123",
        "metadata": { "orderId": "o_42" },
        "destination": { "...": "..." },
        "step": { "state": "COMPLETED", "transitions": [] },
        "payment": {
          "attempt": 0, "quoteId": "q_...", "method": "vietqr", "provider": "Swapped", "activeLeg": 0,
          "legs": [{ "index": 0, "adapterId": "swapped", "legId": "...", "provider": "Swapped", "ref": "...", "providerRef": "ord_...", "status": "succeeded", "...": "..." }]
        },
        "result": {
          "method": "vietqr",
          "provider": "Swapped",
          "input": { "value": "500000", "asset": { "kind": "fiat", "currency": "VND" } },
          "output": { "value": "18.92", "asset": { "kind": "crypto", "chain": "eip155:8453", "token": "0x8335...", "symbol": "USDC", "decimals": 6 } },
          "outputConfirmed": true,
          "fees": [{ "kind": "provider", "label": "Swapped fee", "amount": { "value": "9000", "asset": { "kind": "fiat", "currency": "VND" } }, "included": true }],
          "transactions": [{ "role": "destination", "chain": "eip155:8453", "hash": "0x...", "legIndex": 0, "explorerUrl": "https://basescan.org/tx/0x..." }],
          "delivery": { "status": "ok", "legIndex": 0, "expected": { "...": "..." }, "minimum": { "...": "..." }, "received": { "...": "..." } }
        },
        "expiresAt": "2026-10-09T13:30:00.000Z",
        "livemode": false
      }
    }
  }
}
```

| Field | Meaning |
|---|---|
| `id` | The event id. It is also the `webhook-id` header. Deduplicate by it. |
| `object` | Always `event` |
| `apiVersion` | The version of the payload format, an integer. It is `1` now. It changes only on a breaking change of the wire format. The server also sends it in the `openramp-version` response header. |
| `type` | The event type (see below) |
| `createdAt` | ISO 8601 time when the server made the event. A retry keeps it. |
| `livemode` | `false` unless you pass `livemode: true` to `createOpenRamp` |
| `sessionId` | The session id |
| `data.object.session` | The backend view of the session after the change: a [`Session`](../api/core.md#session) (the [`PublicSession`](../api/core.md#publicsession) plus `userId` and `metadata`). It is the same object that `openramp.sessions.retrieve(id)` returns. |
| `data.object.*` | The other fields of the event type (see below) |

Once a payment started, `session.result` (a [`SessionResult`](../api/core.md#sessionresult)) has the method, the provider, what the user paid (`input`), what arrived (`output`), if `output` is confirmed, the fees, the transactions and the delivery check. `transactions` has every transaction of the payment, each with a `role`: `source` (what paid into a leg, for example the user's wallet transaction), `hop` and `destination` (the deliveries), `settlement`, `refund` or `approval`. `delivery` compares the reported output with the quote. `session.payment` has the legs, with the provider's own order id (`providerRef`) for support.

## Event types

There is one catalog for deposits and withdrawals. `data.object.session.direction` tells which one it is.

| Type | When | Other fields in `data.object` |
|---|---|---|
| `session.created` | `sessions.create()` or `POST /sessions` made a session | |
| `session.requires_action` | A leg of a payment waits for the user (to pay, to sign, to finish a provider step). Once per leg and attempt. | `attempt`, `index`, `adapterId`, `legId` |
| `session.processing` | The user paid or acted, and a provider or the chain works. Once per leg and attempt. | `attempt`, `index`, `adapterId`, `legId` |
| `session.payment_failed` | A payment attempt failed, and the user can try again. The status is `requires_payment_method` again, with `session.lastError`. **Do not close the order.** | `attempt`, `index`, `adapterId`, `legId`, `error` |
| `session.succeeded` | Every leg succeeded. **Credit here.** | `resolution` (operator only) |
| `session.failed` | Final failure: no attempts are left, money already arrived on a leg, or an operator resolved the session as `FAILED`. No event follows it. | `error`, `resolution` (operator only) |
| `session.canceled` | The app or the user canceled the session | `reason` |
| `session.expired` | The deadline passed with no payment in progress (nothing started, the last attempt failed, or the leg still waits for the user), or the provider order expired. A late payment can still complete it (see `session.late_payment`). | `resolution` (operator only) |
| `session.refunded` | The provider returned the payment before it succeeded | `resolution` (operator only) |
| `session.reversed` | The payment succeeded, then the provider refunded it or took it back (a chargeback). **Take back or freeze the credit.** | `index`, `adapterId`, `legId`, `legStatus`, `previous`, and `attempt` for an earlier attempt |
| `session.late_payment` | A payment arrived late: after the session expired, on an earlier attempt, or after a final status | `reason`, `index`, `adapterId`, `legId`, `transactions` (the leg's transactions, when known), `attempt` |
| `leg.succeeded` | One leg finished | `index`, `adapterId`, `legId` |
| `leg.failed` | One leg failed | `index`, `adapterId`, `legId`, `error` |

The [background sweep](../api/server.md#background-sweep) finds expired sessions and sends `session.expired`. A request that loads an expired session (for example a browser poll) also sends it. Without a scheduled sweep, a session that nobody loads again never sends `session.expired`.

```ts
import type { WebhookEvent } from '@openrampkit/server'

async function handle(event: WebhookEvent) {
  switch (event.type) {
    case 'session.succeeded':
      return credit(event.id, event.data.object.session)
    case 'session.payment_failed':
      return notifyUser(event.data.object.session.userId, event.data.object.error.message) // the user can try again
    case 'session.failed':
    case 'session.canceled':
    case 'session.expired':
      return closeOrder(event.data.object.session)
    case 'session.reversed':
      return takeBack(event.id, event.data.object.session, event.data.object.legStatus)
  }
}
```

## Credit exactly once

Webhooks are delivered **at least once**. A retry after a timeout can send the same event two times. A repeat always has the same event id: the server makes the id from the session id and the event, not at random. Obey these rules:

1. **Credit only on `session.succeeded`.** `leg.succeeded` on the first leg of a two-leg pathway does not mean that the funds arrived. `session.payment_failed` is not the end: the user can try again, and the same session can still succeed. Close the order only on a final event: `session.failed`, `session.canceled`, `session.expired` or `session.refunded`. Nothing follows `session.failed`.
2. **Deduplicate by event id and by session id.** Keep the event id (`webhook-id`, also `event.id`) and drop an event that you handled before. Keep the session id with a unique constraint when you credit, so you credit a session one time only.
3. **Handle `session.late_payment`.** It has a `reason`:
   - `after_expiry`: the session expired while the user still had to pay (for example a bank transfer), and the payment arrived later. The server keeps polling such a payment for `latePayments.graceHours` (default 72), and a provider webhook also counts. The session goes on, and you get `session.succeeded` when it completes. Credit on `session.succeeded` as usual, also after `session.expired`.
   - `after_grace`: the payment arrived after the grace window. The session stays expired and you get no `session.succeeded`. Refund or credit it by hand.
   - `earlier_attempt`: the user left a payment (the `restart` transition) after they paid it. When the provider reports that payment later, the session completes with it (you get `session.succeeded`). When the session already has a final status (for example `failed`, `canceled` or `succeeded`), or another payment is in progress, you get `session.late_payment` instead. You also get it for a withdrawal when the user picked another destination after the restart: the session does not complete with a destination that the payment did not pay to. Refund or credit it by hand.
4. **Check the session status.** For more safety, call `openramp.sessions.retrieve(event.sessionId)` and make sure that `status === 'succeeded'` before you credit.
5. **Credit `result.output` when it is confirmed.** `session.result.output` is what arrived. When `outputConfirmed` is `true`, the provider or the chain reported it. When it is `false`, it is the quote: check the amount yourself before you credit it (on chain with the `destination` transaction of `result.transactions`, or at the provider), or credit the amount that you expected on your order. For merchant destinations, the report of the provider is the source of truth.
6. **Check `result.delivery.status`.** Credit the full amount only when it is `ok`: the output is at least the quote's `minOutput` or, for a quote without one, at most `policy.outputToleranceBps` (default 1%) below the quote. `short` means that less arrived (`shortfall` is the difference). `asset_mismatch` means another asset arrived, and `invalid` means the amount is not valid. `received` is what the provider reported. For anything but `ok`, credit what arrived, not the quote, or hold the credit for a review. `delivery` is absent when no leg reported an output: then use rule 5.

```ts
async function credit(eventId: string, session: Session) {
  const result = session.result!
  await db.transaction(async (tx) => {
    // unique index on credits.session_id: a second insert fails and nothing is credited two times
    const inserted = await tx.credits.insertIfAbsent({ sessionId: session.id, userId: session.userId, eventId })
    if (!inserted) return
    // Full credit only for a confirmed output that matches the quote. Else check it, or hold it for a review.
    const ok = result.outputConfirmed && result.delivery?.status === 'ok'
    const amount = ok ? result.output.value : await verifiedAmount(session.id, result)
    await tx.balances.increment(session.userId, amount)
  })
}
```

For a withdrawal, `result.input` is what left, and `result.output` is what the user received (or the estimate). See [Withdrawals](./withdraw.md#events).

## Refunds and chargebacks after success

A provider can take back a payment after `session.succeeded`: a refund, or a card chargeback. Then you get `session.reversed`, and `session.status` is `reversed`. You credited the user on `session.succeeded`, so take the credit back, or freeze it until you examine the case:

```ts
async function takeBack(eventId: string, session: Session, legStatus: 'refunded' | 'reversed') {
  await db.transaction(async (tx) => {
    // One time per session: a unique index on reversals.session_id
    const inserted = await tx.reversals.insertIfAbsent({ sessionId: session.id, userId: session.userId, eventId, legStatus })
    if (!inserted) return
    const credit = await tx.credits.find({ sessionId: session.id })
    if (credit) await tx.balances.decrement(session.userId, credit.amount) // or freeze the balance and alert support
  })
}
```

- `session.reversed` comes one time per session at most, with a stable event id. Deduplicate it like the other events.
- `legStatus` is `refunded` (the provider refunded the user) or `reversed` (a chargeback or a returned payout).
- When the data has `attempt`, the reversal is for an earlier attempt that the user left with `restart`. The session status does not change. Take back only a credit that you gave by hand for that attempt (after `session.late_payment`).
- For a withdrawal, the payout did not reach the user. Give the funds back to the balance of the user, or speak to the user.
- The modal shows "Payment reversed" when the user still has it open.

::: warning Same-chain wallet transfers
When the source token is the same as the destination token on the same chain, the Relay adapter sends a plain transfer without Relay. It checks the transaction receipt on chain: the transaction succeeded and paid the recipient at least the quoted amount. It does not check that the transaction is new or that the user sent it. Keep the hash of the `destination` transaction in `result.transactions` with a unique constraint, so one transaction cannot complete two sessions.
:::

## Delivery

- The server writes each event into the session record (the outbox), in the same save as the change that caused it. When that save fails (for example a `409` conflict), the event does not exist, and the server sends nothing.
- After the save, the server sends the new events immediately, with a 4 second timeout (`timeouts.webhook`). A failed delivery (no 2xx answer, or a timeout) goes to the log as `webhook delivery failed` or `webhook delivery error`. The event stays in the outbox.
- The [background sweep](../api/server.md#background-sweep) tries the outbox again. The wait starts at 30 seconds and doubles after each attempt, up to 2 hours. The sweep tries again for `webhooks.retryHours` (default 24 hours), or until `webhooks.maxAttempts` attempts when you set it.
- Then the event becomes a **dead letter**: it stays in the session record, and the server logs `webhook moved to dead letter after retries` as an error. When your backend works again, call `openramp.webhooks.replay(sessionId)` to send the dead letters of that session again, with the same event ids.
- A retry sends the same body with the same `webhook-id`, and a new timestamp and signature.
- A delivery problem never stops the flow of the user.
- Return a 2xx status to acknowledge.
- The server does not send events in a guaranteed order. Use `session.status` in the event, not the order of arrival.

Retries occur only when something runs the sweep. Schedule it: see [Cloudflare Workers](../deploy/cloudflare-workers.md#cron-trigger) or [Next.js / Vercel](../deploy/nextjs.md#background-sweep). The sweep also refreshes open payments, so a session still completes (and sends its webhooks) after the user closes the tab.

## Provider webhooks

Provider webhooks are a different thing. Providers call your OpenRampKit server at `{baseUrl}/webhooks/{adapterId}`, and the adapter verifies them. See each [adapter page](../adapters/) for the URL and the secret to configure.
