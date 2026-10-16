// HTTP routes. Every route takes the runtime and returns a Response; errors are thrown as OpenRampException.

import { claimWebhook, releaseWebhook } from '@openrampkit/adapter'
import { OpenRampException, cmp, isFinalStatus, isLegTerminal, isTerminal, mulRatio, openRampError } from '@openrampkit/core'
import type { Amount } from '@openrampkit/core'
import type { SurfaceKind } from '@openrampkit/core'
import { safeEqual, sha256Hex } from './crypto.js'
import { MAX_WEBHOOK_BODY_BYTES } from './config.js'
import { clientIp, errorResponse, geoOf, json, readJson, readText, withIdempotency } from './http.js'
import { adapterMoveAllowed, applyEvent, archiveActive, beginPayment, moneyMayHaveMoved, refreshActive, setLegStep, startSignature, startThrew } from './legs.js'
import { canFailOver } from './health.js'
import { plan, quotes, boundsError } from './planning.js'
import type { QuotesBody } from './planning.js'
import { saveSession } from './outbox.js'
import { trackOpenSession } from './queue.js'
import { adapterContext, publicSession } from './runtime.js'
import type { Runtime } from './runtime.js'
import { cancelSession, createSession, loadAuthed } from './sessions.js'
import { sourcesRoute } from './sources.js'
import { DEPOSIT_ADDRESS_METHOD, sessionDepositAddress } from './standing.js'
import { userHistory } from './history.js'
import { createPayLink, isPayCredential, payRoute, revokeOn } from './pay.js'
import { sweep } from './tasks.js'
import { adminRoute } from './admin.js'
import { addTimeline } from './timeline.js'
import { scopedKV } from './store.js'
import type { SessionRecord, StoredQuote } from './store.js'
import { CAIP2, balanceError, checkAllowed, isValidToken, parseTarget, readSourceBalance, screenTarget, targetDestination } from './withdraw.js'

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

/**
 * POST /sessions: browser-created sessions, only through the app's `authorize` hook. An
 * `Idempotency-Key` is scoped to the user that `authorize` returns.
 */
async function createSessionRoute(rt: Runtime, req: Request): Promise<Response> {
  if (!rt.config.authorize) return errorResponse(openRampError('NOT_FOUND'), 404)
  const body = await readJson<unknown>(req.clone(), {})
  const input = await rt.config.authorize(req, body)
  if (!input) return errorResponse(openRampError('UNAUTHORIZED'), 401)
  const scopeId = `create:${(await sha256Hex(String(input.userId))).slice(0, 32)}`
  return withIdempotency(rt, scopeId, 'sessions', req, async () => {
    const created = await createSession(rt, { ...geoOf(rt, req), ...input })
    // A repeated externalId: the existing session, with no client secret
    return json(created, created.existing ? 200 : 201)
  })
}

/** True when the request uses a pay link credential, not the client secret */
const byPayLink = (req: Request) => isPayCredential((req.headers.get('authorization') ?? '').split('.')[1] ?? '')

async function sessionRoute(rt: Runtime, req: Request, method: string, id: string, action?: string, arg?: string): Promise<Response> {
  const rec = await loadAuthed(rt, req, id)
  const ip = clientIp(req)
  if (ip) rec.ip = ip
  // A pay link can go to another person: it never gets the user's standing deposit address or bank
  // account. Checked before the idempotency cache, so it cannot replay the user's earlier answer either.
  if (action === 'deposit-address' && byPayLink(req)) return errorResponse(openRampError('UNAUTHORIZED'), 403)
  // `Idempotency-Key` on every POST, scoped to the session and the route
  if (method === 'POST') return withIdempotency(rt, rec.id, [action ?? '', arg ?? ''].filter(Boolean).join('/'), req, () => sessionAction(rt, req, rec, method, action, arg))
  return sessionAction(rt, req, rec, method, action, arg)
}

async function sessionAction(rt: Runtime, req: Request, rec: SessionRecord, method: string, action?: string, arg?: string): Promise<Response> {

  if (!action && method === 'GET') return json(publicSession(rec))

  // Past the deadline, a session cannot start (or restart) a payment. A payment in progress can still finish.
  const restart = action === 'transitions' && arg === 'restart'
  // `deposit-address` too: a session past its deadline does not hand out the user's standing address.
  if (method === 'POST' && (CHANGES_BEFORE_PAYMENT.has(action ?? '') || restart || action === 'deposit-address') && Date.now() > rec.expiresAt) {
    return errorResponse(openRampError('SESSION_EXPIRED'), 410)
  }

  // The user cancels: allowed while no payment is under way.
  if (action === 'cancel' && method === 'POST' && !arg) {
    if (isPayCredential((req.headers.get('authorization') ?? '').split('.')[1] ?? '')) return errorResponse(openRampError('UNAUTHORIZED'), 403)
    await cancelSession(rt, rec, 'requested_by_user')
    await saveSession(rt, rec)
    return json(publicSession(rec))
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

  if (action === 'sources' && method === 'GET') return sourcesRoute(rt, req, rec)

  // The user's past sessions (option `history`). Only with the client secret: a pay link can go to
  // another person, so it does not show the user's other sessions.
  if (action === 'history' && method === 'GET' && !arg) {
    if (!rt.config.history) return errorResponse(openRampError('NOT_FOUND'), 404)
    if (isPayCredential((req.headers.get('authorization') ?? '').split('.')[1] ?? '')) return errorResponse(openRampError('UNAUTHORIZED'), 403)
    // One call reads up to 200 records, so it counts against the per-session limit too.
    await checkRate(rt, rec.id)
    return json({ items: await userHistory(rt, rec) })
  }

  if (action === 'step' && method === 'GET') {
    if (await refreshActive(rt, rec)) await saveSession(rt, rec)
    return json(publicSession(rec))
  }

  // These call provider APIs (quote, start, transition), so they count against the per-session limit.
  if (method === 'POST' && (action === 'plan' || action === 'quotes' || action === 'target' || action === 'select' || action === 'transitions' || action === 'deposit-address')) await checkRate(rt, rec.id)

  if (action === 'plan' && method === 'POST') {
    const body = await readJson<{ walletConnected?: boolean; walletAddress?: string; surfaces?: SurfaceKind[] }>(req, {})
    const walletAddress = walletAddressOf(body.walletAddress)
    if (walletAddress) rec.walletAddress = walletAddress
    const result = await plan(rt, rec, body)
    await saveSession(rt, rec)
    // A pay link gets no "Your deposit address" (the route refuses it, see above)
    if (byPayLink(req)) return json({ ...result, methods: result.methods.filter((x) => x.method !== DEPOSIT_ADDRESS_METHOD) })
    return json(result)
  }

  if (action === 'target' && method === 'POST') return targetRoute(rt, req, rec)

  if (action === 'deposit-address' && method === 'POST' && !arg) return json(await sessionDepositAddress(rt, rec, await readJson<{ chain?: unknown; token?: unknown; currency?: unknown }>(req, {})))

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

  if (action === 'select' && method === 'POST') return selectRoute(rt, req, rec)

  if (action === 'transitions' && arg && method === 'POST') return transitionRoute(rt, req, rec, decodeURIComponent(arg))
  return errorResponse(openRampError('NOT_FOUND'), 404)
}

/**
 * POST /sessions/:id/target (withdraw only): the user picks where the funds go.
 * Body: `{ type: 'crypto', chain, token, address }` or `{ type: 'fiat', currency }`, plus the
 * optional plan fields of `/plan` (`walletConnected`, `walletAddress`, `surfaces`).
 * Checks the format, the app's `allowedDestinations` and `screenAddress`, then returns the plan.
 * A target that the app locked at creation (`lockDestination`) cannot change: 409 `DESTINATION_LOCKED`.
 */
async function targetRoute(rt: Runtime, req: Request, rec: SessionRecord): Promise<Response> {
  if (rec.direction !== 'withdraw') return errorResponse(openRampError('BAD_REQUEST', { message: 'Only withdraw sessions take a target.' }), 409)
  if (rec.destinationLocked) return errorResponse(openRampError('DESTINATION_LOCKED'), 409)
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
  const body = await readJson<{ quoteId: string; walletAddress?: string; gasless?: boolean }>(req)
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
  // Gas abstraction is asked for each payment: a later select without it pays gas again.
  if (body.gasless === true && rec.direction !== 'withdraw') rec.gasless = true
  else delete rec.gasless
  if (rec.direction === 'withdraw') {
    // `withdraw.checkBalance`: read the balance again before the first leg starts (it can change after the quote).
    const low = balanceError(await readSourceBalance(rt, rec), stored.quote.input)
    if (low) return errorResponse(low, 422)
  }
  await screenDepositWallet(rt, rec, stored)
  await startWithFailover(rt, rec, body.quoteId, stored)
  await saveSession(rt, rec)
  return json(publicSession(rec))
}

/** `screenDepositWallets`: screen the wallet that pays a `wallet` deposit, on the chain it pays from. Throws when refused. */
async function screenDepositWallet(rt: Runtime, rec: SessionRecord, stored: StoredQuote): Promise<void> {
  if (!rt.config.screenDepositWallets || rec.direction === 'withdraw' || stored.pathway.method !== 'wallet') return
  const input = stored.quote.input.asset
  if (input.kind !== 'crypto') return
  if (!rec.walletAddress) throw new OpenRampException(openRampError('BAD_REQUEST', { message: 'Connect a wallet first.' }), 400)
  await screenTarget(rt, { type: 'crypto', chain: input.chain, token: input.token, address: rec.walletAddress })
}

/** Most other quotes that one select tries after the chosen quote failed to start */
const MAX_FAILOVERS = 2

/**
 * Begin the payment. When the first leg's `start()` throws a provider failure (see `canFailOver`), try
 * the next best quote of the same quote request and method, from another adapter, at most
 * `MAX_FAILOVERS` times. Each try is a full `beginPayment`, which rolls back when it fails, so a failed
 * try leaves nothing behind. Money safety: only an error that `start()` threw fails over. When `start()`
 * returned a step, the provider has an order, and the error goes to the caller as before. When every
 * try fails, the caller gets the first error.
 */
async function startWithFailover(rt: Runtime, rec: SessionRecord, quoteId: string, stored: StoredQuote): Promise<void> {
  try {
    await beginPayment(rt, rec, quoteId, stored)
    return
  } catch (first) {
    if (!startThrew(first) || !canFailOver(first)) throw first
    const tried = new Set([quoteId])
    const failed = new Set([stored.pathway.legs[0]!.adapterId])
    let from = stored.pathway.legs[0]!.adapterId
    for (let n = 0; n < MAX_FAILOVERS; n++) {
      const next = nextQuote(rec, stored, tried, failed)
      if (!next) break
      const to = next.stored.pathway.legs[0]!.adapterId
      tried.add(next.id)
      addTimeline(rec, 'payment.failover', { from, to, quoteId: next.id })
      rt.metric('payment.failover', 1, { from, to })
      rt.log.warn('payment start failed; trying the next quote', { sessionId: rec.id, from, to })
      try {
        await beginPayment(rt, rec, next.id, next.stored)
        return
      } catch (e) {
        if (!startThrew(e) || !canFailOver(e)) break
        failed.add(to)
        from = to
      }
    }
    throw first
  }
}

/** A failover quote may deliver at most this much less than the quote the user chose (1%) */
const FAILOVER_MIN_OUTPUT_RATIO = '0.99'

/** Same asset (kind, currency or chain and token) and the same value */
function sameAmount(a: Amount, b: Amount): boolean {
  return sameAssetOf(a, b) && cmp(a.value, b.value) === 0
}

function sameAssetOf(a: Amount, b: Amount): boolean {
  const x = a.asset
  const y = b.asset
  if (x.kind === 'fiat' && y.kind === 'fiat') return x.currency.toUpperCase() === y.currency.toUpperCase()
  if (x.kind === 'crypto' && y.kind === 'crypto') return x.chain === y.chain && (x.chain.startsWith('eip155:') ? x.token.toLowerCase() === y.token.toLowerCase() : x.token === y.token)
  return false
}

/**
 * Money safety of a failover: the user confirmed one quote, so another quote may only start when it
 * charges the same amount in the same asset, and delivers the same asset and at least 99% of the
 * chosen output. Else the user picks again.
 */
function failoverKeepsTerms(chosen: StoredQuote, next: StoredQuote): boolean {
  const a = chosen.quote
  const b = next.quote
  return sameAmount(a.input, b.input) && sameAssetOf(a.output, b.output) && cmp(b.output.value, mulRatio(a.output.value, FAILOVER_MIN_OUTPUT_RATIO)) >= 0
}

/**
 * The best quote left for a failover: same quote request (`round`) and method, a first leg from an
 * adapter that did not fail, not expired, inside the session's `amountBounds`, and with the terms the
 * user confirmed (see `failoverKeepsTerms`). Lowest `rank` first.
 */
function nextQuote(rec: SessionRecord, chosen: StoredQuote, tried: Set<string>, failed: Set<string>): { id: string; stored: StoredQuote } | undefined {
  if (chosen.round === undefined) return undefined
  const now = Date.now()
  return Object.entries(rec.quotes)
    .filter(([id, q]) =>
      !tried.has(id) &&
      q.round === chosen.round &&
      q.pathway.method === chosen.pathway.method &&
      !failed.has(q.pathway.legs[0]!.adapterId) &&
      !(q.quote.expiresAt && Date.parse(q.quote.expiresAt) < now) &&
      !boundsError(rec, q.quote.input) &&
      failoverKeepsTerms(chosen, q),
    )
    .sort(([, a], [, b]) => (a.rank ?? 0) - (b.rank ?? 0))
    .map(([id, q]) => ({ id, stored: q }))[0]
}

async function transitionRoute(rt: Runtime, req: Request, rec: SessionRecord, name: string): Promise<Response> {
  const body = await readJson<{ inputs?: Record<string, unknown> }>(req, {})
  if (name === 'restart') {
    // Allowed when no payment is in progress (also after a failed attempt), or while the user still has
    // to pay (PAYMENT). Never after a final status: `session.failed` is never followed by success.
    if (isFinalStatus(rec.status)) return errorResponse(openRampError('BAD_REQUEST', { message: finalMessage(rec) }), 409)
    // The user may have paid on a provider page (or by QR code or bank transfer) before the provider told
    // us. Ask the provider once, so that a payment it already knows about blocks the restart.
    if (rec.status !== 'requires_payment_method' && rec.step.state === 'PAYMENT' && (await refreshActive(rt, rec, true))) {
      await saveSession(rt, rec)
      if (isFinalStatus(rec.status)) return errorResponse(openRampError('BAD_REQUEST', { message: finalMessage(rec) }), 409)
    }
    if (rec.status !== 'requires_payment_method' && rec.step.state !== 'PAYMENT') {
      return errorResponse(openRampError('BAD_REQUEST', { message: 'This payment can no longer be changed.' }), 409)
    }
    // While the user still has to pay: only before any money moved (no submitted transaction, no
    // treasury send, no provider status past requires_action).
    if (rec.status !== 'requires_payment_method' && rec.active && moneyMayHaveMoved(rec.active)) {
      return errorResponse(openRampError('BAD_REQUEST', { message: 'Money of this payment may be on its way. It cannot be changed now.' }), 409)
    }
    // Void the provider order of the left payment when the adapter can, so the user cannot also pay it
    // later. Best effort: a payment that still arrives takes the late payment path.
    await cancelLeftLeg(rt, rec)
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

/** Ask the adapter to void the open provider order of the active leg (on `restart`). Never throws. */
async function cancelLeftLeg(rt: Runtime, rec: SessionRecord): Promise<void> {
  const act = rec.active
  const leg = act?.legs[act.index]
  if (!act || !leg?.ref || !leg.step || isLegTerminal(leg.step.status)) return
  const a = rt.adapters.get(leg.adapterId)
  if (!a?.cancel) return
  try {
    await a.cancel({ leg: act.pathway.legs[act.index]!, ref: leg.ref }, adapterContext(rt, rec, a, act.pathway, act.index))
    addTimeline(rec, 'payment.provider_canceled', { adapterId: a.id })
  } catch (e) {
    rt.log.warn('adapter cancel on restart failed; the attempt stays open for a late payment', { sessionId: rec.id, adapter: a.id, error: e instanceof Error ? e.message : String(e) })
  }
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
