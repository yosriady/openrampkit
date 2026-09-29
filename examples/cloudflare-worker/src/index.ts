// OpenRampKit server as a Cloudflare Worker.
// The app backend creates sessions with `POST /sessions` and its API key, then passes the
// client secret to the browser. The browser talks to this worker with that secret only.

import { mockAdapter } from '@openrampkit/adapter-mock'
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
  /** Shared secret the app backend uses to create sessions */
  APP_API_KEY: string
  WEBHOOK_URL?: string
  WEBHOOK_SECRET?: string
  MOCK?: string
  /** Bearer token for POST /tasks/sweep and GET /health?deep=1 */
  TASKS_TOKEN?: string
}

function build(env: Env) {
  return createOpenRamp({
    secret: env.OPENRAMP_SECRET,
    baseUrl: env.PUBLIC_URL,
    store: durableObjectStore(env.OPENRAMP_STORE),
    adapters: env.MOCK === '1' ? [mockAdapter({ crypto: true, bridge: true })] : [relay(), mockAdapter()],
    cors: { origins: env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()) },
    ...(env.WEBHOOK_URL && env.WEBHOOK_SECRET ? { webhooks: { url: env.WEBHOOK_URL, secret: env.WEBHOOK_SECRET } } : {}),
    ...(env.TASKS_TOKEN ? { tasksToken: env.TASKS_TOKEN } : {}),
    // Only the app backend (holding APP_API_KEY) may create sessions and choose the destination.
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
  // Cron Trigger (wrangler.toml [triggers]): retry webhooks, refresh open payments, expire sessions.
  async scheduled(_event: unknown, env: Env): Promise<void> {
    const r = await build(env).sweep()
    console.log('openramp sweep', JSON.stringify(r))
  },
}
