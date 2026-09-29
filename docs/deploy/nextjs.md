# Deploy with Next.js / Vercel

With Next.js, the OpenRampKit server runs inside your app as a catch-all route handler. Your session route and your webhook route live next to it. The [quick start](../guide/quick-start-nextjs.md) builds this setup step by step.

## Route handler

```ts
// app/api/openramp/[...path]/route.ts
import { openramp } from '@/lib/openramp'

export const dynamic = 'force-dynamic'
export const { GET, POST, OPTIONS } = openramp.nextHandlers()
```

`nextHandlers()` returns the same web-standard handler for `GET`, `POST` and `OPTIONS`. It works on the Node.js runtime and on the Edge runtime (`export const runtime = 'edge'`), because the server and the adapters use only `fetch` and WebCrypto.

Keep the instance in a shared module (`lib/openramp.ts`), not in the route file: a route file may only export route handlers and route config.

## The instance

```ts
// lib/openramp.ts
import { Redis } from '@upstash/redis'
import { relay } from '@openrampkit/adapter-relay'
import { createOpenRamp, redisStore } from '@openrampkit/server'

const PUBLIC_URL = process.env.PUBLIC_URL!

const g = globalThis as unknown as { __openramp?: ReturnType<typeof createOpenRamp> }

export const openramp =
  g.__openramp ??
  (g.__openramp = createOpenRamp({
    secret: process.env.OPENRAMP_SECRET!,
    baseUrl: `${PUBLIC_URL}/api/openramp`,
    store: redisStore(Redis.fromEnv()),
    adapters: [relay({ apiKey: process.env.RELAY_API_KEY })],
    webhooks: { url: `${PUBLIC_URL}/api/hooks`, secret: process.env.OPENRAMP_WEBHOOK_SECRET! },
    livemode: process.env.VERCEL_ENV === 'production',
  }))
```

The `globalThis` cache keeps one instance per process during `next dev`, where modules reload.

## Vercel

1. Add the environment variables in the Vercel project settings: `OPENRAMP_SECRET`, `OPENRAMP_WEBHOOK_SECRET`, `PUBLIC_URL`, the provider keys, and the store's credentials (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` for `Redis.fromEnv()`).
2. Set `PUBLIC_URL` per environment. Preview deployments have their own URL; provider webhooks registered for production will not reach them.
3. Use a shared store. Serverless functions do not share memory, so the default memory store loses sessions between invocations.

::: warning Memory store on serverless
With the default memory store, one request may create a session and the next may land on another instance that does not know it. The user then sees `UNAUTHORIZED`. Always pass a `store` on Vercel.
:::

## Geo headers

Vercel sets `x-vercel-ip-country` and `x-vercel-ip-country-region` on requests. `sessions.create()` runs in your backend and does not read them, so pass the country from the request that reached your session route:

```ts
// app/api/deposit-session/route.ts
export async function POST(req: Request) {
  const user = await getUser()
  const country = req.headers.get('x-vercel-ip-country') ?? undefined
  const region = req.headers.get('x-vercel-ip-country-region')
  const session = await openramp.sessions.create({
    userId: user.id,
    destination: user.destination,
    ...(country ? { country } : {}),
    ...(country && region ? { region: `${country}-${region}` } : {}),
  })
  return Response.json(session)
}
```

The server's default `geo` (used only by `POST /sessions` with `authorize`) reads the same headers.

## Background reconciliation

Users close tabs. Adapters with webhooks settle on their own, but Relay legs settle only when someone asks for status. Add a [Vercel Cron Job](https://vercel.com/docs/cron-jobs) that calls `openramp.sessions.refresh(id)` for sessions you know are still processing:

```ts
// app/api/cron/openramp/route.ts
import { openramp } from '@/lib/openramp'

export async function GET(req: Request) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) return new Response('unauthorized', { status: 401 })
  for (const id of await db.deposits.processingSessionIds()) await openramp.sessions.refresh(id)
  return Response.json({ ok: true })
}
```

Keep your own list of session ids (for example from `session.created` webhooks). The store has no "list sessions" call.

## Other Next.js hosts

The same code runs on any Next.js host (Node server, Docker, Netlify, Cloudflare with OpenNext). Only the store and the geo headers change.
