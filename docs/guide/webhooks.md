# Webhooks to your backend

The browser can lie. Credit balances only from a signed webhook that the OpenRampKit server sends to your backend, or from a server-side lookup.

## Turn them on

```ts
createOpenRamp({
  // ...
  webhooks: {
    url: 'https://app.example.com/api/hooks',
    secret: process.env.OPENRAMP_WEBHOOK_SECRET!,
  },
})
```

Without `webhooks`, the server sends nothing and `openramp.webhooks.verify()` always returns `false`.

## Verify the signature

Each request is a `POST` with a JSON body and three headers:

| Header | Value |
|---|---|
| `openramp-id` | The event id, `evt_...` |
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
| `session.refunded` | The step became `REFUNDED` | |
| `session.expired` | An open session passed its expiry and was loaded again | |

`session.expired` is sent only when a request touches the expired session (the browser polls, or you call `sessions.retrieve`). There is no background timer.

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
      "session": { "id": "ors_...", "status": "completed", "destination": { "...": "..." }, "step": { "state": "COMPLETED", "progress": { "legs": [] } } },
      "userId": "user_123",
      "metadata": { "orderId": "o_42" }
    }
  }
}
```

`data.object.session` is a [`PublicSession`](../api/core.md#publicsession). `userId` and `metadata` are what you passed to `sessions.create()`. See [Events](../concepts/events.md) for the full types.

## Credit exactly once

Follow these rules:

1. **Credit only on `session.completed`.** `leg.succeeded` on the first leg of a two-leg pathway does not mean the funds arrived.
2. **Deduplicate by session id.** Store the session id with a unique constraint when you credit. The server sends each event type at most once per session, but your handler may still run twice (a retry on your side, a manual replay, a race between instances).
3. **Check the session state.** For extra safety, call `openramp.sessions.retrieve(event.sessionId)` and confirm `status === 'completed'` before you credit.
4. **Use your own records for the amount.** The event does not carry the delivered amount. For crypto destinations, read the transfer on chain: `session.step.progress.legs[].txHash` has the transaction hashes the providers reported. For merchant destinations, read the payment from the provider, or keep the expected amount on your order.

```ts
async function handle(event: { id: string; type: string; sessionId?: string; data: { object: any } }) {
  if (event.type !== 'session.completed' || !event.sessionId) return
  const { userId, metadata } = event.data.object
  await db.transaction(async (tx) => {
    // unique index on credits.session_id: a second insert fails and nothing is credited twice
    const inserted = await tx.credits.insertIfAbsent({ sessionId: event.sessionId, userId, eventId: event.id })
    if (!inserted) return
    await tx.balances.increment(userId, await amountFor(event.sessionId, metadata))
  })
}
```

::: warning Direct wallet transfers are not verified on chain
When the user pays with a connected wallet and the source token is the same as the destination token on the same chain, the Relay adapter sends a plain transfer and trusts the transaction hash that the browser reports. It does not check the chain. Before you credit such a deposit, confirm the transfer on chain (recipient, token and amount).
:::

## Delivery

- The server sends each webhook once, with a 4 second timeout (`timeouts.webhook`). It does not retry. A failed delivery is logged as `webhook delivery failed` or `webhook delivery error`.
- A delivery problem never breaks the user's flow.
- Return any 2xx status to acknowledge.

Because there are no retries, reconcile in the background. For example, a cron job that lists your open sessions and calls `openramp.sessions.refresh(id)`. `refresh()` asks the active leg's adapter for status (like the browser's poll does) and sends any events that are due.

## Provider webhooks

Provider webhooks are a different thing. Providers call your OpenRampKit server at `{baseUrl}/webhooks/{adapterId}`, and the adapter verifies them. See each [adapter page](../adapters/) for the URL and the secret to configure.
