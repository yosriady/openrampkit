// HTTP routes. Every route takes the runtime and returns a Response; errors are thrown as OrkException.

import { OrkException, isTerminal, orkError } from '@openrampkit/core'
import type { SurfaceKind } from '@openrampkit/core'
import { safeEqual } from './crypto.js'
import { clientIp, errorResponse, geoOf, json, readJson, withIdempotency } from './http.js'
import { applyEvent, beginPayment, refreshActive, setLegStep, startSignature } from './legs.js'
import { plan, quotes } from './planning.js'
import type { QuotesBody } from './planning.js'
import { adapterContext, publicSession, saveSession } from './runtime.js'
import type { Runtime } from './runtime.js'
import { createSession, loadAuthed } from './sessions.js'
import { scopedKV } from './store.js'
import type { SessionRecord } from './store.js'

const RETURN_PAGE =
  '<!doctype html><meta charset="utf-8"><title>Payment</title><body style="font-family:system-ui;padding:32px">You can close this tab and go back to the app.<script>setTimeout(()=>window.close(),800)</script>'

const inProgress = () => errorResponse(orkError('BAD_REQUEST', { message: 'A payment is already in progress.' }), 409)

export async function route(rt: Runtime, req: Request): Promise<Response> {
  const url = new URL(req.url)
  const path = rt.basePath && url.pathname.startsWith(rt.basePath) ? url.pathname.slice(rt.basePath.length) : url.pathname
  const parts = path.split('/').filter(Boolean)
  const method = req.method.toUpperCase()
  const [head, id, action, arg] = parts

  if (head === 'sessions' && !id && method === 'POST') return createSessionRoute(rt, req)
  if (head === 'sessions' && id) return sessionRoute(rt, req, method, id, action, arg)
  if (head === 'start' && id && method === 'GET') return startRoute(rt, id)
  if (head === 'return' && method === 'GET') return new Response(RETURN_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } })
  if (head === 'webhooks' && id && method === 'POST') return webhookRoute(rt, req, id)
  if (head === 'adapters' && id) return adapterRoute(rt, req, id, parts.slice(2).join('/'))
  if (head === 'health' && method === 'GET') return healthRoute(rt)
  return errorResponse(orkError('NOT_FOUND'), 404)
}

/** POST /sessions: browser-created sessions, only through the app's `authorize` hook. */
async function createSessionRoute(rt: Runtime, req: Request): Promise<Response> {
  if (!rt.config.authorize) return errorResponse(orkError('NOT_FOUND'), 404)
  const body = await readJson<unknown>(req, {})
  const input = await rt.config.authorize(req, body)
  if (!input) return errorResponse(orkError('UNAUTHORIZED'), 401)
  return json(await createSession(rt, { ...geoOf(rt, req), ...input }), 201)
}

async function sessionRoute(rt: Runtime, req: Request, method: string, id: string, action?: string, arg?: string): Promise<Response> {
  const rec = await loadAuthed(rt, req, id)
  const ip = clientIp(req)
  if (ip) rec.ip = ip

  if (!action && method === 'GET') return json(publicSession(rec))

  if (action === 'step' && method === 'GET') {
    if (await refreshActive(rt, rec)) await saveSession(rt, rec)
    return json(publicSession(rec))
  }

  if (action === 'plan' && method === 'POST') {
    const body = await readJson<{ walletConnected?: boolean; walletAddress?: string; surfaces?: SurfaceKind[] }>(req, {})
    if (body.walletAddress) rec.walletAddress = body.walletAddress
    const result = await plan(rt, rec, body)
    await saveSession(rt, rec)
    return json(result)
  }

  if (action === 'quotes' && method === 'POST') {
    if (rec.active && !isTerminal(rec.step.state)) return inProgress()
    const body = await readJson<QuotesBody>(req)
    if (!body?.method || typeof body.amount !== 'string') throw new OrkException(orkError('BAD_REQUEST', { message: 'method and amount are required.' }), 400)
    const result = await quotes(rt, rec, body)
    await saveSession(rt, rec)
    return json(result)
  }

  if (action === 'select' && method === 'POST') return withIdempotency(rt, rec.id, req, () => selectRoute(rt, req, rec))

  if (action === 'transitions' && arg && method === 'POST') {
    return withIdempotency(rt, rec.id, req, () => transitionRoute(rt, req, rec, decodeURIComponent(arg)))
  }
  return errorResponse(orkError('NOT_FOUND'), 404)
}

async function selectRoute(rt: Runtime, req: Request, rec: SessionRecord): Promise<Response> {
  const body = await readJson<{ quoteId: string; walletAddress?: string }>(req)
  const stored = rec.quotes[body.quoteId]
  if (!stored) return errorResponse(orkError('QUOTE_EXPIRED'), 410)
  if (stored.quote.expiresAt && Date.parse(stored.quote.expiresAt) < Date.now()) return errorResponse(orkError('QUOTE_EXPIRED'), 410)
  if (rec.active && !isTerminal(rec.step.state)) return inProgress()
  if (body.walletAddress) rec.walletAddress = body.walletAddress
  await beginPayment(rt, rec, body.quoteId, stored)
  await saveSession(rt, rec)
  return json(publicSession(rec))
}

async function transitionRoute(rt: Runtime, req: Request, rec: SessionRecord, name: string): Promise<Response> {
  const body = await readJson<{ inputs?: Record<string, unknown> }>(req, {})
  if (name === 'restart') {
    // Allowed before payment starts, while waiting for payment, or after a terminal state.
    if (rec.active && !isTerminal(rec.step.state) && rec.step.state !== 'PAYMENT') {
      return errorResponse(orkError('BAD_REQUEST', { message: 'This payment can no longer be changed.' }), 409)
    }
    if (rec.step.state === 'COMPLETED') return errorResponse(orkError('BAD_REQUEST', { message: 'This deposit is complete.' }), 409)
    rec.active = undefined
    rec.status = 'open'
    rec.step = { sessionId: rec.id, state: 'SELECT_METHOD', transitions: [], expiresAt: new Date(rec.expiresAt).toISOString() }
    await saveSession(rt, rec)
    return json(publicSession(rec))
  }
  const act = rec.active
  if (!act) return errorResponse(orkError('BAD_REQUEST', { message: 'Nothing to continue.' }), 409)
  if (!rec.step.transitions.some((t) => t.name === name && t.kind !== 'AWAIT')) {
    return errorResponse(orkError('BAD_REQUEST', { message: `Transition ${name} is not allowed now.` }), 409)
  }
  const leg = act.legs[act.index]!
  const a = rt.adapter(leg.adapterId)
  if (!a.transition) return errorResponse(orkError('BAD_REQUEST', { message: `Transition ${name} is not supported.` }), 409)
  const ls = await a.transition(
    { leg: act.pathway.legs[act.index]!, ref: leg.ref ?? '', name, ...(body.inputs ? { inputs: body.inputs } : {}) },
    adapterContext(rt, rec, a, act.pathway, act.index),
  )
  await setLegStep(rt, rec, act.index, ls)
  await saveSession(rt, rec)
  return json(publicSession(rec))
}

/** GET /start/:sessionId.token.sig: verify the signed token, then 302 to the provider. */
async function startRoute(rt: Runtime, param: string): Promise<Response> {
  const [sid, token, sig] = param.split('.')
  if (!sid || !token || !sig) return errorResponse(orkError('NOT_FOUND'), 404)
  if (!safeEqual(sig, await startSignature(rt, sid, token))) return errorResponse(orkError('UNAUTHORIZED'), 401)
  const entry = (await rt.store.get(sid))?.startUrls[token]
  if (!entry || entry.exp < Date.now()) return new Response('This link expired. Go back to the app and try again.', { status: 410 })
  return new Response(null, {
    status: 302,
    headers: { location: entry.url, 'cache-control': 'no-store', 'referrer-policy': entry.keepReferrer ? 'strict-origin' : 'no-referrer' },
  })
}

/** POST /webhooks/:adapterId: provider webhooks, verified by the adapter. */
async function webhookRoute(rt: Runtime, req: Request, adapterId: string): Promise<Response> {
  const a = rt.adapters.get(adapterId)
  if (!a?.webhook) return errorResponse(orkError('NOT_FOUND'), 404)
  const raw = await req.text()
  const ctx = { log: rt.log, fetch: rt.fetch, shared: scopedKV(rt.store, `a:${a.id}`) }
  if (!(await a.webhook.verify(req, raw, ctx))) return errorResponse(orkError('UNAUTHORIZED'), 401)
  for (const ev of await a.webhook.parse(raw, { ...ctx, url: req.url })) await applyEvent(rt, a.id, ev)
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
        applyEvent: (ev) => applyEvent(rt, a.id, ev),
      })
    : undefined
  return res ?? errorResponse(orkError('NOT_FOUND'), 404)
}

async function healthRoute(rt: Runtime): Promise<Response> {
  const checks = await Promise.all(
    [...rt.adapters.values()].map(async (a) => ({
      id: a.id,
      ...(a.health ? await a.health({ fetch: rt.fetch, log: rt.log }).catch((e: unknown) => ({ ok: false, detail: String(e) })) : { ok: true }),
    })),
  )
  return json({ ok: checks.every((c) => c.ok), adapters: checks }, checks.every((c) => c.ok) ? 200 : 503)
}
