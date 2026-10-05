// OpenRampKit server. Web-standard Request/Response only: runs on Cloudflare Workers, Vercel/Next.js,
// Node 20+, Bun and Deno. It holds provider secrets, fixes the destination per session,
// plans pathways, runs legs, takes provider webhooks and sends signed webhooks to the app.

import { OrkException, orkError } from '@openrampkit/core'
import type { OpenRampConfig } from './config.js'
import { verifyWebhook } from './crypto.js'
import { corsHeaders, errorResponse, withCors } from './http.js'
import { refreshActive } from './legs.js'
import { route } from './routes.js'
import { replayDeadLetters, saveSession } from './outbox.js'
import { createRuntime, publicSession } from './runtime.js'
import { createSession } from './sessions.js'
import { createPayLink, revokePayLink } from './pay.js'
import { sweep } from './tasks.js'
import type { CreateSessionInput } from './config.js'
import { adminFindByRef, adminFindByTx, adminGet, adminList, adminReplay, adminResolve, adminStats } from './admin.js'
import type { AdminListOptions } from './admin.js'

export * from './store.js'
export * from './durable-object-store.js'
export { verifyWebhook } from './crypto.js'
export type { AdminConfig, CreateSessionInput, OpenRampConfig, Telemetry, TreasuryHook, TreasurySendInput } from './config.js'
export type { AdminLeg, AdminListOptions, AdminListResult, AdminOutboxEvent, AdminPayment, AdminSession, AdminSessionSummary, AdminStats } from './admin.js'
export { isValidAddress } from './withdraw.js'
export type { CreatedSession } from './sessions.js'
export type { PayLink } from './pay.js'
export type { SweepResult } from './tasks.js'

export function createOpenRamp(config: OpenRampConfig) {
  const rt = createRuntime(config)

  const adminPath = `${rt.basePath}/admin`

  async function handle(req: Request): Promise<Response> {
    // The admin routes are same-origin only: no CORS headers, whatever `cors` allows.
    const path = new URL(req.url).pathname
    const cors = path === adminPath || path.startsWith(`${adminPath}/`) ? {} : corsHeaders(rt, req)
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    let res: Response
    try {
      res = await route(rt, req)
    } catch (e) {
      if (e instanceof OrkException) res = errorResponse(e.error, e.status)
      // No message from the error: a parse error can quote a provider response.
      else if (e instanceof SyntaxError) res = errorResponse(orkError('BAD_REQUEST'), 400)
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
      /**
       * A signed, expiring link to a hosted page where a person completes this session
       * (`GET {baseUrl}/pay/:credential`). Default expiry: the session expiry plus 30 minutes.
       */
      async payLink(id: string, opts: { ttlMinutes?: number } = {}) {
        const rec = await rt.store.get(id)
        return rec ? createPayLink(rt, rec, opts.ttlMinutes) : null
      },
      /**
       * Make one pay link of a session stop working. `linkId` is the `id` that `payLink` returned.
       * The page and the API then refuse the link. Returns false when the session does not exist.
       */
      revokePayLink: (id: string, linkId: string) => revokePayLink(rt, id, linkId),
    },
    /**
     * Retry failed webhooks, refresh open payments and expire old sessions. Run it every minute or so
     * (Cloudflare Cron Trigger, Vercel Cron, or any scheduler), or call `POST {baseUrl}/tasks/sweep`.
     */
    sweep: (opts?: { limit?: number }) => sweep(rt, opts),
    webhooks: {
      /** Verify an OpenRampKit webhook your backend received */
      verify: (req: Request, body: string) => (config.webhooks ? verifyWebhook(config.webhooks.secret, req.headers, body) : Promise.resolve(false)),
      /**
       * Send the dead letters of one session again (events whose retries stopped). They keep their
       * event ids. Returns how many events were queued.
       */
      replay: (sessionId: string) => replayDeadLetters(rt, sessionId),
    },
    /**
     * Operator tools. They work without `admin.token` (that only turns on the HTTP routes), but `list`,
     * `stats` and `findByTx` read the time index, which the server keeps only when `config.admin` is set.
     */
    admin: {
      /** Recent sessions, newest first, with filters and a cursor */
      list: (opts?: AdminListOptions) => adminList(rt, opts),
      /** The full operator view of one session: legs, attempts, outbox, provider refs, timeline */
      get: (id: string) => adminGet(rt, id),
      /** The session that owns a provider reference (`provider` is the adapter id) */
      findByRef: (provider: string, ref: string) => adminFindByRef(rt, provider, ref),
      /** Sessions with this leg transaction hash, from the time index */
      findByTx: (chain: string | undefined, txHash: string) => adminFindByTx(rt, chain, txHash),
      /** Counts by state and direction, completed volume, stuck sessions, outbox and webhook failures */
      stats: (opts?: { since?: number | string | Date }) => adminStats(rt, opts),
      /** Force a final state with an audit note, and send the matching webhook */
      resolve: (id: string, state: 'COMPLETED' | 'FAILED' | 'REFUNDED' | 'EXPIRED', note: string) => adminResolve(rt, id, state, note),
      /** Send the dead letters of a session again (same as `webhooks.replay`) */
      replayWebhooks: (id: string) => adminReplay(rt, id),
    },
  }
}

export type OpenRamp = ReturnType<typeof createOpenRamp>
export * from './redis-store.js'
