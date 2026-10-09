// OpenRampKit server. Web-standard Request/Response only: runs on Cloudflare Workers, Vercel/Next.js,
// Node 20+, Bun and Deno. It holds provider secrets, fixes the destination per session,
// plans pathways, runs legs, takes provider webhooks and sends signed webhooks to the app.

import { API_VERSION, OpenRampException, openRampError } from '@openrampkit/core'
import type { CancelReason, Session } from '@openrampkit/core'
import type { OpenRampConfig } from './config.js'
import { verifyWebhook } from './crypto.js'
import { corsHeaders, errorResponse, withCors } from './http.js'
import { refreshActive } from './legs.js'
import { route } from './routes.js'
import { replayDeadLetters, saveSession } from './outbox.js'
import { backendSession, createRuntime } from './runtime.js'
import { cancelSession, createSession } from './sessions.js'
import { createPayLink, revokePayLink } from './pay.js'
import { sweep } from './tasks.js'
import type { CreateSessionInput } from './config.js'
import { adminFindByRef, adminFindByTx, adminGet, adminList, adminReplay, adminResolve, adminStats } from './admin.js'
import type { AdminListOptions } from './admin.js'

export * from './store.js'
export * from './durable-object-store.js'
export { generateWebhookSecret, signWebhook, verifyWebhook } from './crypto.js'
export type { ClientEvent, Session, WebhookEvent, WebhookEventOf, WebhookEventType } from '@openrampkit/core'
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
      if (e instanceof OpenRampException) res = errorResponse(e.error, e.status)
      // No message from the error: a parse error can quote a provider response.
      else if (e instanceof SyntaxError) res = errorResponse(openRampError('BAD_REQUEST'), 400)
      else {
        rt.log.error('unhandled error', { error: e instanceof Error ? (e.stack ?? e.message) : String(e) })
        res = errorResponse(openRampError('INTERNAL'), 500)
      }
    }
    // The wire format version (the same as `apiVersion` in webhook events)
    const h = new Headers(res.headers)
    h.set('openramp-version', String(API_VERSION))
    return withCors(new Response(res.body, { status: res.status, statusText: res.statusText, headers: h }), cors)
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
      /** The backend view of a session (`Session`: the browser view plus `userId` and `metadata`), or null */
      async retrieve(id: string): Promise<Session | null> {
        const rec = await rt.store.get(id)
        return rec ? backendSession(rec) : null
      },
      /** Server-side status refresh, e.g. from a cron job. Returns the backend view. */
      async refresh(id: string): Promise<Session | null> {
        const rec = await rt.store.get(id)
        if (!rec) return null
        if (await refreshActive(rt, rec, true)) await saveSession(rt, rec)
        return backendSession(rec)
      },
      /**
       * Cancel a session that has no payment under way (status `requires_payment_method` or
       * `requires_action`): the step becomes CANCELED, the status `canceled`, and the server sends
       * `session.canceled`. Returns the backend view, or null when the session does not exist. Throws a
       * `409` while a payment is processing or after another final status.
       */
      async cancel(id: string, opts: { reason?: CancelReason } = {}): Promise<Session | null> {
        for (let attempt = 0; attempt < 3; attempt++) {
          const rec = await rt.store.get(id)
          if (!rec) return null
          await cancelSession(rt, rec, opts.reason ?? 'requested_by_app')
          try {
            await saveSession(rt, rec)
            return backendSession(rec)
          } catch (e) {
            if (!(e instanceof OpenRampException && e.status === 409)) throw e
          }
        }
        throw new OpenRampException(openRampError('CONFLICT'), 409)
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
      /** Verify a webhook your backend received (Standard Webhooks headers; use the raw body text) */
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
