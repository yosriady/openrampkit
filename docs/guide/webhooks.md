# Webhooks to your backend

The browser can lie. Credit balances only from a signed webhook that the OpenRampKit server sends to your backend, or from a server-side lookup.

## Turn them on

```ts
createOpenRamp({
  // ...
  webhooks: {
    url: 'https://app.example.com/api/hooks',
    secret: process.env.OPENRAMP_WEBHOOK_SECRET!,
    maxAttempts: 8, // optional: attempts in all before the server drops an event
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
| `session.expired` | The session passed its expiry before the payment went on (no payment started, or the leg still waits for the user), or a leg expired | |
| `withdrawal.completed` | Withdraw sessions: sent after `session.completed` | |
| `withdrawal.failed` | Withdraw sessions: sent after `session.failed` | |

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

Webhooks are delivered **at least once**. A retry after a timeout, or two sweeps at the same time, can send the same event twice. Follow these rules:

1. **Credit only on `session.completed`.** `leg.succeeded` on the first leg of a two-leg pathway does not mean the funds arrived.
2. **Deduplicate by event id and by session id.** Store the event id (`openramp-id`, also `event.id`) and drop an event you already handled. Store the session id with a unique constraint when you credit, so a session is credited once.
3. **Check the session state.** For extra safety, call `openramp.sessions.retrieve(event.sessionId)` and confirm `status === 'completed'` before you credit.
4. **Credit `result.output` when it is confirmed.** `session.result.output` is what arrived. When `outputConfirmed` is `true`, the provider or the chain reported it. When it is `false`, it is the quote: check the amount yourself before you credit it (on chain with `result.txHashes`, or at the provider), or credit the amount you expected on your order. For merchant destinations, the provider's report is the source of truth.

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

::: warning Same-chain wallet transfers
When the source token is the same as the destination token on the same chain, the Relay adapter sends a plain transfer without Relay. It checks the transaction receipt on chain: the transaction succeeded and paid the recipient at least the quoted amount. It does not check that the transaction is new or that the user sent it. Store `result.txHashes` with a unique constraint, so one transaction cannot complete two sessions.
:::

## Delivery

- The server sends each webhook at once, with a 4 second timeout (`timeouts.webhook`). A failed delivery (no 2xx answer, or a timeout) is logged as `webhook delivery failed` or `webhook delivery error`, and goes to an outbox in the store.
- The [background sweep](../api/server.md#background-sweep) retries the outbox. The wait starts at 30 seconds and doubles after each attempt, up to 1 hour. After `webhooks.maxAttempts` attempts in all (default 8), the server drops the event and logs `webhook dropped after retries`.
- A retry sends the same body with the same `openramp-id`, and a new timestamp and signature.
- A delivery problem never breaks the user's flow.
- Return any 2xx status to acknowledge.

Retries happen only when something runs the sweep. Schedule it: see [Cloudflare Workers](../deploy/cloudflare-workers.md#cron-trigger) or [Next.js / Vercel](../deploy/nextjs.md#background-sweep). The sweep also refreshes open payments, so a session still completes (and sends its webhooks) after the user closes the tab.

## Provider webhooks

Provider webhooks are a different thing. Providers call your OpenRampKit server at `{baseUrl}/webhooks/{adapterId}`, and the adapter verifies them. See each [adapter page](../adapters/) for the URL and the secret to configure.
