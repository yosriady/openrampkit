# Deploy on Node, Bun, Deno

`openramp.handle(req)` takes a web `Request` and returns a web `Response`. Any runtime or framework that speaks web standards can mount it. Node 20 or later is required (global `fetch` and WebCrypto).

In each example, the handler is mounted at `/api/openramp`, so `baseUrl` ends with `/api/openramp`. The handler strips that path from incoming requests.

## Shared setup

```ts
// openramp.ts
import { Redis } from 'ioredis'
import { relay } from '@openrampkit/adapter-relay'
import { createOpenRamp, fromNodeRedis, redisStore } from '@openrampkit/server'

export const openramp = createOpenRamp({
  secret: process.env.OPENRAMP_SECRET!,
  baseUrl: `${process.env.PUBLIC_URL}/api/openramp`,
  store: redisStore(fromNodeRedis(new Redis(process.env.REDIS_URL!))),
  adapters: [relay({ apiKey: process.env.RELAY_API_KEY })],
  webhooks: { url: `${process.env.PUBLIC_URL}/api/hooks`, secret: process.env.OPENRAMP_WEBHOOK_SECRET! },
})
```

This setup needs `ioredis` next to the OpenRampKit packages. The OpenRampKit packages are not on npm yet; see [Try it before the npm release](../guide/installation.md#try-it-before-the-npm-release).

## Runtimes

::: code-group

```ts [Hono (Node, Bun, Deno)]
import { Hono } from 'hono'
import { serve } from '@hono/node-server' // Node only; Bun and Deno use `export default app`
import { openramp } from './openramp'

const app = new Hono()

// OpenRampKit
app.all('/api/openramp/*', (c) => openramp.handle(c.req.raw))

// Your backend: create sessions
app.post('/api/deposit-session', async (c) => {
  const user = await getUser(c)
  return c.json(await openramp.sessions.create({ userId: user.id, destination: user.destination }))
})

// Your backend: webhooks
app.post('/api/hooks', async (c) => {
  const body = await c.req.text()
  if (!(await openramp.webhooks.verify(c.req.raw, body))) return c.text('bad signature', 401)
  await handleEvent(JSON.parse(body))
  return c.text('ok')
})

serve({ fetch: app.fetch, port: 3000 })
```

```ts [node:http]
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { openramp } from './openramp'

/** Node request -> web Request */
async function toRequest(req: IncomingMessage): Promise<Request> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x))
    else if (v !== undefined) headers.set(k, v)
  }
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const body = chunks.length ? Buffer.concat(chunks) : undefined
  return new Request(url, { method: req.method, headers, ...(body && req.method !== 'GET' && req.method !== 'HEAD' ? { body } : {}) })
}

/** web Response -> Node response */
async function send(res: ServerResponse, r: Response) {
  res.statusCode = r.status
  r.headers.forEach((v, k) => res.setHeader(k, v))
  res.end(Buffer.from(await r.arrayBuffer()))
}

createServer(async (req, res) => {
  if (req.url?.startsWith('/api/openramp/')) return send(res, await openramp.handle(await toRequest(req)))
  res.statusCode = 404
  res.end()
}).listen(3000)
```

```ts [Bun]
import { openramp } from './openramp'

Bun.serve({
  port: 3000,
  fetch(req) {
    const { pathname } = new URL(req.url)
    if (pathname.startsWith('/api/openramp/')) return openramp.handle(req)
    return new Response('Not found', { status: 404 })
  },
})
```

```ts [Deno]
import { openramp } from './openramp.ts'

Deno.serve({ port: 3000 }, (req) => {
  const { pathname } = new URL(req.url)
  if (pathname.startsWith('/api/openramp/')) return openramp.handle(req)
  return new Response('Not found', { status: 404 })
})
```

```ts [Express]
import express from 'express'
import { openramp } from './openramp'

const app = express()

// Mount before any body parser: the handler reads the raw body (webhooks need it).
// `app.use` matches every method and sub-path, in Express 4 and 5.
app.use('/api/openramp', async (req, res) => {
  const url = new URL(req.originalUrl, `${req.protocol}://${req.get('host')}`)
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const body = chunks.length ? Buffer.concat(chunks) : undefined
  const r = await openramp.handle(
    new Request(url, { method: req.method, headers: req.headers as Record<string, string>, ...(body ? { body } : {}) }),
  )
  res.status(r.status)
  r.headers.forEach((v, k) => res.setHeader(k, v))
  res.send(Buffer.from(await r.arrayBuffer()))
})

app.listen(3000)
```

:::

If the server runs on a subdomain or as the whole app, mount it at the root and set `baseUrl` to the origin. `openramp.fetch` is the same function as `handle`, so `export default openramp` also works on Bun and Deno when the handler owns the whole server.

## Behind a proxy

- The handler builds URLs from `baseUrl`, not from the `Host` header, so a proxy does not break start URLs or webhook URLs.
- For the end user's IP (passed to adapters as `ctx.session.ip`), the server reads `cf-connecting-ip`, then `x-real-ip`, then the first `x-forwarded-for` entry. Make sure your proxy sets one of them and strips values sent by clients.
- For the country on `POST /sessions`, pass a `geo` function if you are not behind Cloudflare or Vercel:

```ts
createOpenRamp({
  // ...
  geo: (req) => ({ country: req.headers.get('x-country-code') ?? undefined }),
})
```

## Timeouts

A quote request waits for up to 5 pathways in parallel, each with a 9 second limit (`timeouts.quote`). Give your HTTP server and proxy a request timeout above that (for example 15 seconds).

## Logging

Pass a `logger` with `debug`, `info`, `warn` and `error` to route messages into your logging stack. The default logs `info`, `warn` and `error` to the console with an `[openramp]` prefix, and drops `debug`.
