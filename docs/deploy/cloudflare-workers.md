# Deploy on Cloudflare Workers

The server uses only web standards (`Request`, `Response`, `fetch`, WebCrypto), so it runs on Workers as is. [`examples/cloudflare-worker`](https://github.com/yosriady/openrampkit/tree/main/examples/cloudflare-worker) is a complete example.

In this setup the Worker is a separate service. Your app backend creates sessions over HTTP, and the browser talks to the Worker directly.

```
Browser --(client secret)--> Worker (OpenRampKit) <--(x-app-key)-- Your backend
                                   |
                                   +--> signed webhooks --> Your backend
```

## Try the example locally

The example runs with the mock adapter. You need no Cloudflare account and no provider key.

```bash
git clone https://github.com/yosriady/openrampkit
cd openrampkit
pnpm install
pnpm build
cd examples/cloudflare-worker
cp .dev.vars.example .dev.vars   # sets OPENRAMP_SECRET, APP_API_KEY=dev-app-key and MOCK=1
pnpm dev                         # wrangler dev on http://localhost:8787
```

In a second terminal, check the Worker and create a session as your backend would:

```bash
curl http://localhost:8787/health
# {"ok":true,"adapters":["mock"]}

curl -X POST http://localhost:8787/sessions \
  -H 'x-app-key: dev-app-key' -H 'content-type: application/json' \
  -d '{"userId":"u1","country":"VN","destination":{"type":"crypto","chain":"eip155:8453","token":"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913","address":"0x000000000000000000000000000000000000beef"}}'
# {"id":"ors_...","clientSecret":"ors_....","expiresAt":"..."}
```

`MOCK=1` uses `mockAdapter({ crypto: true, bridge: true })`. Without it, the Worker uses Relay and the mock adapter. The packages are not on npm yet; see [Try it before the npm release](../guide/installation.md#try-it-before-the-npm-release).

## The Worker

```ts
// src/index.ts
import { relay } from '@openrampkit/adapter-relay'
import { createOpenRamp, durableObjectStore } from '@openrampkit/server'
import type { CreateSessionInput, DurableObjectNamespaceLike } from '@openrampkit/server'

// The store's Durable Object class must be exported from the Worker entry.
export { OpenRampStore } from '@openrampkit/server'

type Env = {
  OPENRAMP_STORE: DurableObjectNamespaceLike
  PUBLIC_URL: string
  ALLOWED_ORIGINS: string
  OPENRAMP_SECRET: string
  APP_API_KEY: string
  WEBHOOK_URL?: string
  WEBHOOK_SECRET?: string
  RELAY_API_KEY?: string
  TASKS_TOKEN?: string
}

function build(env: Env) {
  return createOpenRamp({
    secret: env.OPENRAMP_SECRET,
    baseUrl: env.PUBLIC_URL, // the Worker's own URL; the handler is mounted at the root
    store: durableObjectStore(env.OPENRAMP_STORE),
    adapters: [relay({ apiKey: env.RELAY_API_KEY })],
    cors: { origins: env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()) },
    ...(env.WEBHOOK_URL && env.WEBHOOK_SECRET ? { webhooks: { url: env.WEBHOOK_URL, secret: env.WEBHOOK_SECRET } } : {}),
    ...(env.TASKS_TOKEN ? { tasksToken: env.TASKS_TOKEN } : {}),
    // Only your backend (holding APP_API_KEY) may create sessions and choose the destination.
    authorize: async (r, body) => {
      if (r.headers.get('x-app-key') !== env.APP_API_KEY) return null
      return body as CreateSessionInput
    },
  })
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return build(env).handle(req)
  },
  // Cron Trigger: retry webhooks, refresh open payments, expire sessions
  async scheduled(_event: unknown, env: Env): Promise<void> {
    const r = await build(env).sweep()
    console.log('openramp sweep', JSON.stringify(r))
  },
}
```

Creating the instance per request is cheap. All state lives in the store, so there is nothing to keep between requests.

This is the example without its `MOCK` switch. Set `RELAY_API_KEY` in production. Without a key, deposit-address status checks use Relay's deprecated `/requests/v2`, which Relay retires on 2026-11-24. See [Relay](../adapters/relay.md).

## wrangler.toml

```toml
name = "openramp-server"
main = "src/index.ts"
compatibility_date = "2026-09-01"
compatibility_flags = ["nodejs_compat"]

# Sessions live in a Durable Object: strongly consistent, built into Workers, no extra service.
[[durable_objects.bindings]]
name = "OPENRAMP_STORE"
class_name = "OpenRampStore"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["OpenRampStore"]

[triggers]
crons = ["* * * * *"]

[vars]
PUBLIC_URL = "https://openramp-server.your-account.workers.dev"
ALLOWED_ORIGINS = "https://app.example.com"
```

Nothing else to create: Wrangler creates the Durable Object class on the first deploy.

The example's `wrangler.toml` sets `PUBLIC_URL = "http://localhost:8787"` and `ALLOWED_ORIGINS = "http://localhost:3000"` for local development. Before you deploy, set them to the Worker's public URL and your app's origins (comma-separated). Then run `pnpm deploy` (`wrangler deploy`).

## Secrets

Never put secrets in `[vars]`. Set them with Wrangler:

```bash
npx wrangler secret put OPENRAMP_SECRET   # 32+ random characters
npx wrangler secret put APP_API_KEY       # shared with your backend
npx wrangler secret put WEBHOOK_URL       # e.g. https://app.example.com/api/hooks
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put RELAY_API_KEY     # and any other provider keys
npx wrangler secret put TASKS_TOKEN       # optional: for POST /tasks/sweep and GET /health?deep=1
```

For local development, put the same names in `.dev.vars` (the example has `.dev.vars.example`), then run `pnpm dev` (`wrangler dev --port 8787`).

## Create sessions from your backend

```ts
const res = await fetch('https://openramp-server.your-account.workers.dev/sessions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-app-key': process.env.APP_API_KEY! },
  body: JSON.stringify({
    userId: user.id,
    country: 'VN',
    destination: { type: 'crypto', chain: 'eip155:8453', token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', address: user.depositAddress },
  }),
})
const { clientSecret } = await res.json() // 201
```

`POST /sessions` fills `country` from Cloudflare's `cf-ipcountry` header of the request (or from your `geo` hook, when you set one). That is your backend's location, not the user's, so send `country` in the body (it wins).

In the browser, point the modal at the Worker:

```ts
openDeposit({ baseUrl: 'https://openramp-server.your-account.workers.dev', clientSecret })
```

## Cron trigger

The `[triggers]` block runs the Worker's `scheduled()` handler every minute. It calls [`openramp.sweep()`](../api/server.md#background-sweep), which:

- retries webhooks to your backend that failed,
- asks providers for the status of open payments (Relay legs have no provider webhooks, so they settle only through status checks after the user leaves),
- expires idle sessions and sends `session.expired`.

The cron needs no token: Cloudflare calls `scheduled()` directly. Check the runs in the Worker's logs (`openramp sweep {...}`), or with `npx wrangler tail`. `wrangler dev` does not run crons by itself. To test the sweep locally, call `curl http://localhost:8787/cdn-cgi/local/scheduled` while `pnpm dev` runs (Wrangler 4).

If you prefer HTTP (for example an external scheduler), set `tasksToken` and call `POST {PUBLIC_URL}/tasks/sweep` with `Authorization: Bearer {tasksToken}`. See [HTTP routes](../api/http.md#post-tasks-sweep).

::: tip Sweeps on Durable Objects
The outbox and the open-session list are single keys, each in its own Durable Object, so one sweep's reads and writes of a list are consistent. Two sweeps at the same time can still deliver a webhook twice (webhooks are at-least-once): your backend must deduplicate by event id.
:::

## Provider webhooks

Register `https://openramp-server.your-account.workers.dev/webhooks/{adapterId}` with each provider. Webhook calls carry no `Origin` header, so CORS does not affect them.

## Why not Workers KV

`cloudflareKvStore` exists for demos. KV reads can be stale for up to about 60 seconds across locations and KV has no atomic compare-and-set, so a webhook and a browser poll that change the same session at nearly the same time can overwrite each other. Durable Objects are strongly consistent and are part of Workers too, so there is no reason to use KV in production.

## Custom domain

Give the Worker a route on your domain (for example `ramp.example.com`) so start URLs and the return page are on your brand. Update `PUBLIC_URL` to match.

## Mount under a path

To serve the handler under a path of an existing Worker, set `baseUrl` to the full URL with that path (for example `https://example.com/openramp`). The handler strips the path part of `baseUrl` from each request.
