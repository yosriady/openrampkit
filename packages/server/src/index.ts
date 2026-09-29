// OpenRampKit server. Web-standard Request/Response only: runs on Cloudflare Workers, Vercel/Next.js,
// Node 20+, Bun and Deno. It holds provider secrets, fixes the destination per session,
// plans pathways, runs legs, takes provider webhooks and sends signed webhooks to the app.

import { OrkException, orkError } from '@openrampkit/core'
import type { OpenRampConfig } from './config.js'
import { verifyWebhook } from './crypto.js'
import { corsHeaders, errorResponse, withCors } from './http.js'
import { refreshActive } from './legs.js'
import { route } from './routes.js'
import { createRuntime, publicSession, saveSession } from './runtime.js'
import { createSession } from './sessions.js'
import type { CreateSessionInput } from './config.js'

export * from './store.js'
export { verifyWebhook } from './crypto.js'
export type { CreateSessionInput, OpenRampConfig } from './config.js'
export type { CreatedSession } from './sessions.js'

export function createOpenRamp(config: OpenRampConfig) {
  const rt = createRuntime(config)

  async function handle(req: Request): Promise<Response> {
    const cors = corsHeaders(rt, req)
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    let res: Response
    try {
      res = await route(rt, req)
    } catch (e) {
      if (e instanceof OrkException) res = errorResponse(e.error, e.status)
      else if (e instanceof SyntaxError) res = errorResponse(orkError('BAD_REQUEST', { message: e.message }), 400)
      else {
        rt.log.error('unhandled error', { error: e instanceof Error ? (e.stack ?? e.message) : String(e) })
        res = errorResponse(orkError('INTERNAL'), 500)
      }
    }
    return withCors(res, cors)
  }

  return {
    /** Web-standard handler. Mount it at `baseUrl`. */
    handle,
    /** Cloudflare Workers / Bun / Deno style export: `export default openramp` */
    fetch: handle,
    /** Next.js App Router: `export const { GET, POST, OPTIONS } = openramp.nextHandlers()` */
    nextHandlers: () => ({ GET: handle, POST: handle, OPTIONS: handle }),
    sessions: {
      /** Create a session from your backend. Give `clientSecret` to the browser. */
      create: (input: CreateSessionInput) => createSession(rt, input),
      async retrieve(id: string) {
        const rec = await rt.store.get(id)
        return rec ? publicSession(rec) : null
      },
      /** Server-side status refresh, e.g. from a cron job */
      async refresh(id: string) {
        const rec = await rt.store.get(id)
        if (!rec) return null
        if (await refreshActive(rt, rec, true)) await saveSession(rt, rec)
        return publicSession(rec)
      },
    },
    webhooks: {
      /** Verify an OpenRampKit webhook your backend received */
      verify: (req: Request, body: string) => (config.webhooks ? verifyWebhook(config.webhooks.secret, req.headers, body) : Promise.resolve(false)),
    },
  }
}

export type OpenRamp = ReturnType<typeof createOpenRamp>
