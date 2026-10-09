// HTTP routes. Every route takes the runtime and returns a Response; errors are thrown as OpenRampException.

import { claimWebhook, releaseWebhook } from '@openrampkit/adapter'
import { OpenRampException, isFinalStatus, isTerminal, openRampError } from '@openrampkit/core'
import type { SurfaceKind } from '@openrampkit/core'
import { safeEqual } from './crypto.js'
import { MAX_WEBHOOK_BODY_BYTES } from './config.js'
import { clientIp, errorResponse, geoOf, json, readJson, readText, withIdempotency } from './http.js'
import { adapterMoveAllowed, applyEvent, archiveActive, beginPayment, refreshActive, setLegStep, startSignature } from './legs.js'
import { plan, quotes, boundsError } from './planning.js'
import type { QuotesBody } from './planning.js'
import { saveSession } from './outbox.js'
import { trackOpenSession } from './queue.js'
import { adapterContext, publicSession } from './runtime.js'
import type { Runtime } from './runtime.js'
import { createSession, loadAuthed } from './sessions.js'
import { createPayLink, isPayCredential, payRoute, revokeOn } from './pay.js'
import { sweep } from './tasks.js'
import { adminRoute } from './admin.js'
import { addTimeline } from './timeline.js'
import { scopedKV } from './store.js'
import type { SessionRecord } from './store.js'
import { CAIP2, checkAllowed, isValidToken, parseTarget, screenTarget, targetDestination } from './withdraw.js'

const RETURN_PAGE =
  '<!doctype html><meta charset="utf-8"><title>Payment</title><body style="font-family:system-ui;padding:32px">You can close this tab and go back to the app.<script>setTimeout(()=>window.close(),800)</script>'

const inProgress = () => errorResponse(openRampError('BAD_REQUEST', { message: 'A payment is already in progress.' }), 409)

const WALLET_ADDRESS = /^[\x21-\x7e]{8,128}$/
const AMOUNT = /^\d{1,30}(\.\d{1,36})?$/

/** A wallet address from the browser: optional, else a printable string of 8 to 128 characters. */
function walletAddressOf(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string' || !WALLET_ADDRESS.test(v)) throw new OpenRampException(openRampError('BAD_REQUEST', { message: '`walletAddress` is not valid.' }), 400)
  return v
}

/** Check the body of `POST /sessions/:id/quotes`. Throws a 400 when it is not valid. */
function checkQuotesBody(body: QuotesBody): void {
  const bad = (message: string) => new OpenRampException(openRampError('BAD_REQUEST', { message }), 400)
  if (typeof body?.method !== 'string' || !body.method || body.method.length > 64 || typeof body.amount !== 'string') throw bad('method and amount are required.')
  if (!AMOUNT.test(body.amount)) throw bad('`amount` must be a decimal string, e.g. "25.50".')
  if (body.amountSide !== undefined && body.amountSide !== 'source' && body.amountSide !== 'destination') throw bad('`amountSide` must be "source" or "destination".')
  if (body.source !== undefined) {
    const { chain, token } = (body.source ?? {}) as { chain?: unknown; token?: unknown }
    if (typeof chain !== 'string' || !CAIP2.test(chain) || typeof token !== 'string' || !isValidToken(chain, token)) throw bad('`source` must have a CAIP-2 `chain` and a token address or "native".')
  }
}

/** Why a session with a final status takes no change */
function finalMessage(rec: SessionRecord): string {
  switch (rec.status) {
    case 'succeeded':
      return rec.direction === 'withdraw' ? 'This withdrawal is complete.' : 'This deposit is complete.'
    case 'reversed':
      return 'This payment was reversed. Start a new session.'
    case 'refunded':
      return 'This payment was refunded. Start a new session.'
    case 'canceled':
      return 'This session was canceled. Start a new session.'
    case 'expired':
      return 'This session expired. Start a new session.'
    default:
      return 'This session failed. Start a new session.'
  }
}

/** Routes that change the session. They are refused after the session deadline (see `sessionRoute`). */
const CHANGES_BEFORE_PAYMENT = new Set(['plan', 'target', 'quotes', 'select'])

export async function route(rt: Runtime, req: Request): Promise<Response> {
  const url = new URL(req.url)
  const path = rt.basePath && url.pathname.startsWith(rt.basePath) ? url.pathname.slice(rt.basePath.length) : url.pathname
  const parts = path.split('/').filter(Boolean)
  const method = req.method.toUpperCase()
  const [head, id, action, arg] = parts

  if (head === 'sessions' && !id && method === 'POST') return createSessionRoute(rt, req)
  if (head === 'sessions' && id) return sessionRoute(rt, req, method, id, action, arg)
  if (head === 'start' && id && method === 'GET') return startRoute(rt, id)
  if (head === 'pay' && id && method === 'GET') return payRoute(rt, id)
  if (head === 'return' && method === 'GET') return new Response(RETURN_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } })
  if (head === 'webhooks' && id && method === 'POST') return webhookRoute(rt, req, id)
  if (head === 'adapters' && id) return adapterRoute(rt, req, id, parts.slice(2).join('/'))
  if (head === 'health' && method === 'GET') return healthRoute(rt, req)
  if (head === 'tasks' && id === 'sweep' && method === 'POST') return sweepRoute(rt, req)
  if (head === 'admin') return adminRoute(rt, req, method, parts.slice(1))
  return errorResponse(openRampError('NOT_FOUND'), 404)
}

/** POST /sessions: browser-created sessions, only through the app's `authorize` hook. */
async function createSessionRoute(rt: Runtime, req: Request): Promise<Response> {
  if (!rt.config.authorize) return errorResponse(openRampError('NOT_FOUND'), 404)
  const body = await readJson<unknown>(req, {})
  const input = await rt.config.authorize(req, body)
  if (!input) return errorResponse(openRampError('UNAUTHORIZED'), 401)
  return json(await createSession(rt, { ...geoOf(rt, req), ...input }), 201)
}

async function sessionRoute(rt: Runtime, req: Request, method: string, id: string, action?: string, arg?: string): Promise<Response> {
  const rec = await loadAuthed(rt, req, id)
  const ip = clientIp(req)
  if (ip) rec.ip = ip

  if (!action && method === 'GET') return json(publicSession(rec))

  // Past the deadline, a session cannot start (or restart) a payment. A payment in progress can still finish.
  const restart = action === 'transitions' && arg === 'restart'
  if (method === 'POST' && (CHANGES_BEFORE_PAYMENT.has(action ?? '') || restart) && Date.now() > rec.expiresAt) {
    return errorResponse(openRampError('SESSION_EXPIRED'), 410)
  }

  // An operator closed this session (`admin.resolve`): the browser cannot change it.
  if (method === 'POST' && rec.resolution && action !== 'pay-link') {
    return errorResponse(openRampError('BAD_REQUEST', { message: 'This session was closed by the operator.' }), 409)
  }

  // A final session (succeeded, failed, canceled, refunded or reversed) takes no new plan, quote, target,
  // payment or transition, with the client secret or a pay link. An expired session is refused above
  // (410) for the routes before payment; a late payment can still move it on.
  if (method === 'POST' && action !== 'pay-link' && isFinalStatus(rec.status) && rec.status !== 'expired') {
    return errorResponse(openRampError('BAD_REQUEST', { message: finalMessage(rec) }), 409)
  }

  if (action === 'step' && method === 'GET') {
    if (await refreshActive(rt, rec)) await saveSession(rt, rec)
    return json(publicSession(rec))
  }

  // These call provider APIs (quote, start, transition), so they count against the per-session limit.
  if (method === 'POST' && (action === 'plan' || action === 'quotes' || action === 'target' || action === 'select' || action === 'transitions')) await checkRate(rt, rec.id)

  if (action === 'plan' && method === 'POST') {
    const body = await readJson<{ walletConnected?: boolean; walletAddress?: string; surfaces?: SurfaceKind[] }>(req, {})
    const walletAddress = walletAddressOf(body.walletAddress)
    if (walletAddress) rec.walletAddress = walletAddress
    const result = await plan(rt, rec, body)
    await saveSession(rt, rec)
    return json(result)
  }

  if (action === 'target' && method === 'POST') return targetRoute(rt, req, rec)

  if (action === 'pay-link' && method === 'POST') {
    // A pay link cannot mint or revoke pay links: only the client secret can.
    if (isPayCredential((req.headers.get('authorization') ?? '').split('.')[1] ?? '')) return errorResponse(openRampError('UNAUTHORIZED'), 403)
    if (arg === 'revoke') {
      const body = await readJson<{ id?: unknown }>(req, {})
      revokeOn(rec, body.id)
      await saveSession(rt, rec)
      return json({ revoked: true })
    }
    if (arg) return errorResponse(openRampError('NOT_FOUND'), 404)
    const body = await readJson<{ ttlMinutes?: number }>(req, {})
    return json(await createPayLink(rt, rec, typeof body.ttlMinutes === 'number' ? body.ttlMinutes : undefined), 201)
  }

  if (action === 'quotes' && method === 'POST') {
    if (rec.active && !isTerminal(rec.step.state)) return inProgress()
    const body = await readJson<QuotesBody>(req)
    checkQuotesBody(body)
    const result = await quotes(rt, rec, body)
    await saveSession(rt, rec)
    return json(result)
  }

  if (action === 'select' && method === 'POST') return withIdempotency(rt, rec.id, 'select', req, () => selectRoute(rt, req, rec))

  if (action === 'transitions' && arg && method === 'POST') {
    const name = decodeURIComponent(arg)
    return withIdempotency(rt, rec.id, `transitions/${name}`, req, () => transitionRoute(rt, req, rec, name))
  }
  return errorResponse(openRampError('NOT_FOUND'), 404)
}

/**
 * POST /sessions/:id/target (withdraw only): the user picks where the funds go.
 * Body: `{ type: 'crypto', chain, token, address }` or `{ type: 'fiat', currency }`, plus the
 * optional plan fields of `/plan` (`walletConnected`, `walletAddress`, `surfaces`).
 * Checks the format, the app's `allowedTargets` and `screenAddress`, then returns the plan.
 * A target that the app locked at creation (`lockTarget`) cannot change: 409 `TARGET_LOCKED`.
 */
async function targetRoute(rt: Runtime, req: Request, rec: SessionRecord): Promise<Response> {
  if (rec.direction !== 'withdraw') return errorResponse(openRampError('BAD_REQUEST', { message: 'Only withdraw sessions take a target.' }), 409)
  if (rec.targetLocked) return errorResponse(openRampError('TARGET_LOCKED'), 409)
  if (rec.active && !isTerminal(rec.step.state)) return inProgress()
  if (rec.step.state === 'COMPLETED' || rec.step.state === 'REVERSED' || rec.status === 'expired') return errorResponse(openRampError('BAD_REQUEST', { message: 'This withdrawal can no longer be changed.' }), 409)
  const body = await readJson<Record<string, unknown>>(req)
  const target = parseTarget(body)
  checkAllowed(rec, target)
  await screenTarget(rt, target)
  rec.destination = targetDestination(target)
  rec.quotes = {}
  const walletAddress = walletAddressOf(body.walletAddress)
  if (walletAddress) rec.walletAddress = walletAddress
  const result = await plan(rt, rec, {
    walletConnected: typeof body.walletConnected === 'boolean' ? body.walletConnected : !!rec.walletConnected,
    ...(Array.isArray(body.surfaces) ? { surfaces: body.surfaces as SurfaceKind[] } : {}),
  })
  await saveSession(rt, rec)
  return json(result)
}

async function selectRoute(rt: Runtime, req: Request, rec: SessionRecord): Promise<Response> {
  const body = await readJson<{ quoteId: string; walletAddress?: string }>(req)
  // Own keys only: a quote id such as `__proto__` must not find an inherited value.
  const stored = typeof body?.quoteId === 'string' && Object.hasOwn(rec.quotes, body.quoteId) ? rec.quotes[body.quoteId] : undefined
  if (!stored) return errorResponse(openRampError('QUOTE_EXPIRED'), 410)
  if (stored.quote.expiresAt && Date.parse(stored.quote.expiresAt) < Date.now()) return errorResponse(openRampError('QUOTE_EXPIRED'), 410)
  if (rec.active && !isTerminal(rec.step.state)) return inProgress()
  // A completed (or completed, then reversed) payment stays the session's payment.
  if (rec.step.state === 'COMPLETED' || rec.step.state === 'REVERSED') return errorResponse(openRampError('BAD_REQUEST', { message: 'This session already has a completed payment.' }), 409)
  const bounds = boundsError(rec, stored.quote.input)
  if (bounds) return errorResponse(bounds, 422)
  const walletAddress = walletAddressOf(body.walletAddress)
  if (walletAddress) rec.walletAddress = walletAddress
  await beginPayment(rt, rec, body.quoteId, stored)
  await saveSession(rt, rec)
  return json(publicSession(rec))
}

async function transitionRoute(rt: Runtime, req: Request, rec: SessionRecord, name: string): Promise<Response> {
  const body = await readJson<{ inputs?: Record<string, unknown> }>(req, {})
  if (name === 'restart') {
    // Allowed when no payment is in progress (also after a failed attempt), or while the user still has
    // to pay (PAYMENT). Never after a final status: `session.failed` is never followed by success.
    if (isFinalStatus(rec.status)) return errorResponse(openRampError('BAD_REQUEST', { message: finalMessage(rec) }), 409)
    if (rec.status !== 'requires_payment_method' && rec.step.state !== 'PAYMENT') {
      return errorResponse(openRampError('BAD_REQUEST', { message: 'This payment can no longer be changed.' }), 409)
    }
    // Keep the left payment as an earlier attempt: the user may have paid it already (a bank transfer,
    // a QR code or a deposit address). A late provider event for it still applies (see `applyEvent`).
    archiveActive(rec)
    addTimeline(rec, 'payment.restarted')
    rec.status = 'requires_payment_method'
    rec.step = { sessionId: rec.id, state: 'SELECT_METHOD', transitions: [], expiresAt: new Date(rec.expiresAt).toISOString() }
    // The sweep polls the session again (it left the list when it reached a terminal state).
    await trackOpenSession(rt, rec.id)
    await saveSession(rt, rec)
    return json(publicSession(rec))
  }
  const act = rec.active
  if (!act) return errorResponse(openRampError('BAD_REQUEST', { message: 'Nothing to continue.' }), 409)
  if (!rec.step.transitions.some((t) => t.name === name && t.kind !== 'AWAIT')) {
    return errorResponse(openRampError('BAD_REQUEST', { message: `Transition ${name} is not allowed now.` }), 409)
  }
  const leg = act.legs[act.index]!
  const a = rt.adapter(leg.adapterId)
  if (!a.transition) return errorResponse(openRampError('BAD_REQUEST', { message: `Transition ${name} is not supported.` }), 409)
  const ls = await a.transition(
    { leg: act.pathway.legs[act.index]!, ref: leg.ref ?? '', name, ...(body.inputs ? { inputs: body.inputs } : {}) },
    adapterContext(rt, rec, a, act.pathway, act.index),
  )
  // A transition moves the leg only forward, like a provider event (see `adapterMoveAllowed`).
  if (leg.step && !adapterMoveAllowed(leg.step, ls)) {
    rt.log.warn('transition would move the leg back; refused', { sessionId: rec.id, adapter: a.id, name, from: leg.step.status, to: ls.status })
    return errorResponse(openRampError('BAD_REQUEST', { message: 'This step can no longer change.' }), 409)
  }
  await setLegStep(rt, rec, act.index, ls)
  await saveSession(rt, rec)
  return json(publicSession(rec))
}

/** GET /start/:sessionId.token.sig: verify the signed token, then 302 to the provider. */
async function startRoute(rt: Runtime, param: string): Promise<Response> {
  const [sid, token, sig] = param.split('.')
  if (!sid || !token || !sig) return errorResponse(openRampError('NOT_FOUND'), 404)
  if (!safeEqual(sig, await startSignature(rt, sid, token))) return errorResponse(openRampError('UNAUTHORIZED'), 401)
  const entry = (await rt.store.get(sid))?.startUrls[token]
  if (!entry || entry.exp < Date.now()) return new Response('This link expired. Go back to the app and try again.', { status: 410 })
  return new Response(null, {
    status: 302,
    headers: { location: entry.url, 'cache-control': 'no-store', 'referrer-policy': entry.keepReferrer ? 'strict-origin' : 'no-referrer' },
  })
}

/**
 * POST /webhooks/:adapterId: provider webhooks, verified by the adapter. Answers 200 when every event
 * was applied or is safe to ignore (for example a repeat). Answers 503 when an event could not be
 * applied (unknown ref, or the session kept changing), so the provider sends it again. Applying an
 * event twice is safe.
 */
async function webhookRoute(rt: Runtime, req: Request, adapterId: string): Promise<Response> {
  const a = rt.adapters.get(adapterId)
  if (!a?.webhook) return errorResponse(openRampError('NOT_FOUND'), 404)
  const raw = await readText(req, MAX_WEBHOOK_BODY_BYTES)
  const ctx = { log: rt.log, fetch: rt.fetch, shared: scopedKV(rt.store, `a:${a.id}`) }
  if (!(await a.webhook.verify(req, raw, ctx))) {
    rt.metric('webhook.verify_failed', 1, { adapter: a.id })
    return errorResponse(openRampError('UNAUTHORIZED'), 401)
  }
  // Replay protection for providers that sign with no timestamp: one delivery per key in 7 days.
  const key = a.webhook.replayKey ? await a.webhook.replayKey(req, raw, ctx) : undefined
  const claim = key ? await claimWebhook(ctx.shared, key) : undefined
  if (key && !claim) {
    rt.log.info('provider webhook already received; ignored as a replay', { adapter: a.id })
    rt.metric('webhook.replayed', 1, { adapter: a.id })
    return json({ received: true, duplicate: true })
  }
  let retry = false
  try {
    for (const ev of await a.webhook.parse(raw, { ...ctx, url: req.url })) {
      const r = await applyEvent(rt, a.id, ev)
      if (r === 'unknown' || r === 'conflict') retry = true
    }
  } catch (e) {
    if (key && claim) await releaseWebhook(ctx.shared, key, claim)
    throw e
  }
  if (retry) {
    // Give the key back, so the provider's retry of this body applies.
    if (key && claim) await releaseWebhook(ctx.shared, key, claim)
    return json({ error: openRampError('PROVIDER_UNAVAILABLE', { message: 'The event could not be applied yet. Send it again later.' }) }, 503, { 'retry-after': '30' })
  }
  return json({ received: true })
}

/** /adapters/:id/*: routes an adapter serves itself (return pages, hosted pages). */
async function adapterRoute(rt: Runtime, req: Request, adapterId: string, subpath: string): Promise<Response> {
  const a = rt.adapters.get(adapterId)
  const res = a?.routes
    ? await a.routes(req, subpath, {
        fetch: rt.fetch,
        log: rt.log,
        shared: scopedKV(rt.store, `a:${a.id}`),
        baseUrl: rt.base,
        applyEvent: async (ev) => {
          await applyEvent(rt, a.id, ev)
        },
      })
    : undefined
  return res ?? errorResponse(openRampError('NOT_FOUND'), 404)
}

/** Bearer check for operational routes. False when no `tasksToken` is configured. */
async function hasTasksToken(rt: Runtime, req: Request): Promise<boolean> {
  const token = rt.config.tasksToken
  const auth = req.headers.get('authorization') ?? ''
  return !!token && auth.startsWith('Bearer ') && safeEqual(auth.slice(7), token)
}

/** POST /tasks/sweep: retry webhooks, refresh open payments, expire sessions. Needs `tasksToken`. */
async function sweepRoute(rt: Runtime, req: Request): Promise<Response> {
  if (!rt.config.tasksToken) return errorResponse(openRampError('NOT_FOUND'), 404)
  if (!(await hasTasksToken(rt, req))) return errorResponse(openRampError('UNAUTHORIZED'), 401)
  const limit = Number(new URL(req.url).searchParams.get('limit') ?? '') || undefined
  return json(await sweep(rt, limit ? { limit } : {}))
}

/**
 * GET /health: a quick check with no provider calls. `?deep=1` with the tasks token also asks
 * every adapter's `health()` (these call provider APIs, so they are not public).
 */
async function healthRoute(rt: Runtime, req: Request): Promise<Response> {
  const deep = new URL(req.url).searchParams.get('deep') === '1'
  if (!deep) return json({ ok: true, adapters: [...rt.adapters.keys()] })
  if (!(await hasTasksToken(rt, req))) return errorResponse(openRampError('UNAUTHORIZED'), 401)
  const checks = await Promise.all(
    [...rt.adapters.values()].map(async (a) => ({
      id: a.id,
      ...(a.health ? await a.health({ fetch: rt.fetch, log: rt.log }).catch((e: unknown) => ({ ok: false, detail: String(e) })) : { ok: true }),
    })),
  )
  return json({ ok: checks.every((c) => c.ok), adapters: checks }, checks.every((c) => c.ok) ? 200 : 503)
}

/** Cap requests that call provider APIs, per session and minute. */
async function checkRate(rt: Runtime, sessionId: string): Promise<void> {
  const max = rt.config.limits?.providerCallsPerMinute ?? 60
  const key = `rl:${sessionId}:${Math.floor(Date.now() / 60_000)}`
  const n = ((await rt.store.kv.get<number>(key)) ?? 0) + 1
  await rt.store.kv.put(key, n, 120)
  if (n > max) throw new OpenRampException(openRampError('RATE_LIMITED'), 429)
}
