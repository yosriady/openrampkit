// OpenRampKit server as a Cloudflare Worker.
// The app backend creates sessions with `POST /sessions` and its API key, then passes the
// client secret to the browser. The browser talks to this worker with that secret only.

import { mockAdapter } from '@openrampkit/adapter-mock'
import { relay } from '@openrampkit/adapter-relay'
import { cloudflareKvStore, createOpenRamp } from '@openrampkit/server'
import type { CreateSessionInput, KVNamespaceLike } from '@openrampkit/server'

type Env = {
  SESSIONS: KVNamespaceLike
  PUBLIC_URL: string
  ALLOWED_ORIGINS: string
  OPENRAMP_SECRET: string
  /** Shared secret the app backend uses to create sessions */
  APP_API_KEY: string
  WEBHOOK_URL?: string
  WEBHOOK_SECRET?: string
  MOCK?: string
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const ramp = createOpenRamp({
      secret: env.OPENRAMP_SECRET,
      baseUrl: env.PUBLIC_URL,
      store: cloudflareKvStore(env.SESSIONS),
      adapters: env.MOCK === '1' ? [mockAdapter({ crypto: true, bridge: true })] : [relay(), mockAdapter()],
      cors: { origins: env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()) },
      ...(env.WEBHOOK_URL && env.WEBHOOK_SECRET ? { webhooks: { url: env.WEBHOOK_URL, secret: env.WEBHOOK_SECRET } } : {}),
      // Only the app backend (holding APP_API_KEY) may create sessions and choose the destination.
      authorize: async (r, body) => {
        if (r.headers.get('x-app-key') !== env.APP_API_KEY) return null
        return body as CreateSessionInput
      },
    })
    return ramp.handle(req)
  },
}
