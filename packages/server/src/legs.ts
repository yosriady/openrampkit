// The leg state machine: start legs, apply adapter steps and provider events, advance through the pathway.

import type { LegEvent } from '@openrampkit/adapter'
import { OrkException, bps, cmp, isDecimal, isLegalLegMove, isLegTerminal, isSafeLinkUrl, isTerminal, isWebUrl, orkError, sub } from '@openrampkit/core'
import type { Amount, Asset, LegStatus, LegStep, SessionStatus, StateName, Step } from '@openrampkit/core'
import { DEFAULT_OUTPUT_TOLERANCE_BPS, DEFAULT_POLL, REF_INDEX_TTL_SEC, START_URL_TTL_MS, STATUS_CHECK_MIN_INTERVAL_MS } from './config.js'
import { hmacHex, randomHex, sha256Hex } from './crypto.js'
import { notify } from './notify.js'
import { saveSession } from './outbox.js'
import { trackOpenSession } from './queue.js'
import { adapterContext } from './runtime.js'
import { addTimeline } from './timeline.js'
import type { Runtime } from './runtime.js'
import type { ActiveLeg, ActivePayment, SessionRecord, StoredQuote } from './store.js'
import { withdrawSender } from './withdraw.js'

const LEG_STATUS_TO_STATE: Record<LegStatus, StateName> = {
  pending: 'PROCESSING',
  awaiting_user: 'PAYMENT',
  processing: 'PROCESSING',
  succeeded: 'COMPLETED',
  failed: 'FAILED',
  refunded: 'REFUNDED',
  expired: 'EXPIRED',
  reversed: 'REVERSED',
}

/** Build the session step from the active leg. A finished leg that is not the last shows as PROCESSING. */
export function composeStep(rt: Runtime, rec: SessionRecord): Step {
  const act = rec.active!
  const ls = act.legs[act.index]!.step!
  const progress = {
    legs: act.legs.map((l) => ({
      adapterId: l.adapterId,
      legId: l.legId,
      provider: rt.adapters.get(l.adapterId)?.name ?? l.adapterId,
      status: l.step?.status ?? ('pending' as const),
      ...(l.step?.txHash ? { txHash: l.step.txHash } : {}),
    })),
  }
  // A refund or a chargeback after success ends the session, whatever the other legs do.
  if (rec.reversal) {
    return { sessionId: rec.id, state: 'REVERSED', transitions: [], error: orkError('PAYMENT_REVERSED', { recovery: 'contact_support', legId: rec.reversal.legId }), progress, legIndex: act.index }
  }
  if (act.legs.every((l) => l.step?.status === 'succeeded')) {
    return { sessionId: rec.id, state: 'COMPLETED', transitions: [], progress, legIndex: act.index }
  }
  const legDone = ls.state === 'COMPLETED'
  return {
    sessionId: rec.id,
    state: legDone ? 'PROCESSING' : ls.state,
    ...(ls.sub ? { sub: ls.sub } : {}),
    legIndex: act.index,
    ...(ls.surface ? { surface: ls.surface } : {}),
    transitions: legDone ? [{ name: 'poll', kind: 'AWAIT', poll: DEFAULT_POLL }] : ls.transitions,
    ...(ls.error ? { error: ls.error } : {}),
    progress,
    expiresAt: new Date(rec.expiresAt).toISOString(),
  }
}

/**
 * A step whose surface URL is not safe for the browser becomes a failed step. REDIRECT, IFRAME and a
 * PROVIDER_SDK `redirectUrl` need `https:` (`http:` too in test mode); DEEPLINK may use an app scheme.
 * `javascript:`, `data:` and similar URLs never reach the client.
 */
export function checkSurfaceUrls(rt: Runtime, rec: SessionRecord, ls: LegStep): LegStep {
  const s = ls.surface
  if (!s) return ls
  const web = (u: unknown) => isWebUrl(u, { allowHttp: !rec.livemode }) || (typeof u === 'string' && u.startsWith(`${rt.base}/`))
  const ok =
    s.kind === 'REDIRECT'
      ? web(s.url)
      : s.kind === 'IFRAME'
        ? web(s.url) && web(s.origin)
        : s.kind === 'DEEPLINK'
          ? isSafeLinkUrl(s.url)
          : s.kind === 'PROVIDER_SDK' && s.params.redirectUrl !== undefined
            ? web(s.params.redirectUrl)
            : true
  if (ok) return ls
  rt.log.error('adapter returned a surface URL that is not safe; the leg fails', { sessionId: rec.id, kind: s.kind })
  const { surface: _unsafe, ...rest } = ls
  return { ...rest, state: 'FAILED', status: 'failed', transitions: [], error: orkError('PROVIDER_UNAVAILABLE', { recovery: 'choose_other' }) }
}

/** Replace a provider REDIRECT with a signed, popup-safe start URL on our own origin. */
export async function wrapSurface(rt: Runtime, rec: SessionRecord, ls: LegStep): Promise<LegStep> {
  if (ls.surface?.kind !== 'REDIRECT') return ls
  const now = Date.now()
  for (const [t, e] of Object.entries(rec.startUrls)) if (e.exp < now) delete rec.startUrls[t]
  const token = randomHex(12)
  rec.startUrls[token] = { url: ls.surface.url, exp: now + START_URL_TTL_MS, ...(ls.surface.keepReferrer ? { keepReferrer: true } : {}) }
  const sig = await startSignature(rt, rec.id, token)
  return { ...ls, surface: { ...ls.surface, url: `${rt.base}/start/${rec.id}.${token}.${sig}` } }
}

export async function startSignature(rt: Runtime, sessionId: string, token: string): Promise<string> {
  return (await hmacHex(rt.config.secret, `${sessionId}.${token}`)).slice(0, 32)
}

export function sessionStatusFor(state: StateName, hasActive: boolean): SessionStatus {
  if (state === 'COMPLETED') return 'completed'
  if (state === 'FAILED' || state === 'BLOCKED') return 'failed'
  if (state === 'EXPIRED') return 'expired'
  if (state === 'REFUNDED') return 'refunded'
  if (state === 'REVERSED') return 'reversed'
  return hasActive ? 'processing' : 'open'
}

async function settleStatus(rt: Runtime, rec: SessionRecord) {
  const before = rec.status
  rec.status = sessionStatusFor(rec.step.state, !!rec.active)
  if (rec.status !== before && ['completed', 'failed', 'expired', 'refunded', 'reversed'].includes(rec.status)) {
    const extra = rec.status === 'reversed' ? reversalDetail(rec) : undefined
    await notify(rt, rec, `session.${rec.status}`, extra)
    if (rec.direction === 'withdraw' && ['completed', 'failed', 'reversed'].includes(rec.status)) await notify(rt, rec, `withdrawal.${rec.status}`, extra)
  }
}

/** The extra fields of `session.reversed` and `withdrawal.reversed`. No time: the event id must not change. */
function reversalDetail(rec: SessionRecord): Record<string, unknown> | undefined {
  const r = rec.reversal
  return r ? { index: r.index, adapterId: r.adapterId, legId: r.legId, legStatus: r.status, previous: r.previous } : undefined
}

/** True when a leg's new status takes back money: a chargeback, or a refund after the leg succeeded. */
function isReversal(before: LegStatus | undefined, after: LegStatus): boolean {
  return after === 'reversed' || (after === 'refunded' && before === 'succeeded')
}

/**
 * Withdraw with `custody: 'app'`: when the first leg asks for a WALLET_TX, the app's treasury signs
 * it instead of the user, and the leg reports the hash at once. Returns the leg's next step, or
 * undefined when this step is not for the treasury (or it already sent this step).
 */
async function treasuryStep(rt: Runtime, rec: SessionRecord, i: number, ls: LegStep): Promise<LegStep | undefined> {
  if (rec.direction !== 'withdraw' || rec.source?.custody !== 'app' || i !== 0) return undefined
  if (ls.surface?.kind !== 'WALLET_TX' || ls.status !== 'awaiting_user') return undefined
  const act = rec.active!
  const leg = act.legs[i]!
  const { chain, txs } = ls.surface
  const key = `${rec.id}:${i}:${(await sha256Hex(`${leg.ref ?? ''}|${chain}|${JSON.stringify(txs)}`)).slice(0, 24)}`
  if (leg.treasurySent?.includes(key)) return undefined
  const failed = (message: string): LegStep => ({
    state: 'FAILED',
    status: 'failed',
    transitions: [],
    ...(ls.ref ? { ref: ls.ref } : {}),
    error: orkError('PAYMENT_FAILED', { message, recovery: 'contact_support', legId: leg.legId }),
  })
  const treasury = rt.config.treasury
  if (!treasury) return failed('Withdrawals are not set up for this app yet.')
  // Mark and save before sending: at most one send per step from our side. When two requests start
  // this step at the same time, the version check fails one of the saves (409), so only one sends.
  // The key lets the app dedupe retries.
  leg.treasurySent = [...(leg.treasurySent ?? []), key]
  await saveSession(rt, rec)
  let hash: string
  try {
    hash = (await treasury.send({ sessionId: rec.id, userId: rec.userId, chain, txs, idempotencyKey: key })).hash
  } catch (e) {
    rt.log.error('treasury send failed', { sessionId: rec.id, error: e instanceof Error ? e.message : String(e) })
    return failed('The withdrawal could not be sent. Contact support.')
  }
  const t = ls.transitions.find((x) => x.kind === 'SURFACE_RESULT' && x.expects === 'tx_hash')
  const a = rt.adapter(leg.adapterId)
  if (t && a.transition) {
    return a.transition(
      { leg: act.pathway.legs[i]!, ref: ls.ref ?? leg.ref ?? '', name: t.name, inputs: { txHash: hash } },
      adapterContext(rt, rec, a, act.pathway, i),
    )
  }
  // No transition to report the hash: wait for the provider to see the transfer.
  const { surface: _sent, ...rest } = ls
  return { ...rest, state: 'PROCESSING', status: 'processing', transitions: [{ name: 'poll', kind: 'AWAIT', poll: DEFAULT_POLL }], txHash: hash }
}

function sameAsset(a: Asset, b: Asset): boolean {
  if (a.kind === 'fiat' || b.kind === 'fiat') return a.kind === b.kind && (a as { currency: string }).currency.toUpperCase() === (b as { currency: string }).currency.toUpperCase()
  return a.chain === b.chain && a.token.toLowerCase() === b.token.toLowerCase()
}

/**
 * Compare a leg's reported output with its quote. When the provider reports less than the quote by
 * more than `policy.outputToleranceBps`, the leg keeps its result but gets `amountMismatch`, and the
 * timeline gets `leg.amount_mismatch`. `result.amountMismatch` then shows it in every webhook.
 */
function checkOutput(rt: Runtime, rec: SessionRecord, i: number, got: Amount): void {
  const leg = rec.active!.legs[i]!
  const expected = leg.quote.output
  if (!sameAsset(expected.asset, got.asset) || !isDecimal(expected.amount) || !isDecimal(got.amount)) {
    rt.log.debug('reported output is not comparable with the quote', { sessionId: rec.id, index: i })
    return
  }
  const tolerance = Math.max(0, rt.config.policy?.outputToleranceBps ?? DEFAULT_OUTPUT_TOLERANCE_BPS)
  const min = sub(expected.amount, bps(expected.amount, tolerance))
  if (cmp(got.amount, min) >= 0) {
    delete leg.amountMismatch
    return
  }
  const shortfall = sub(expected.amount, got.amount)
  leg.amountMismatch = { expected, received: got, shortfall }
  addTimeline(rec, 'leg.amount_mismatch', { index: i, adapterId: leg.adapterId, expected: expected.amount, received: got.amount })
  rt.log.warn('provider reported less output than the quote', { sessionId: rec.id, adapterId: leg.adapterId, index: i, expected: expected.amount, received: got.amount })
  rt.metric('leg.amount_mismatch', 1, { adapter: leg.adapterId })
}

/** Record a leg's new step, index its provider ref, notify, and start the next leg when this one succeeds. */
export async function setLegStep(rt: Runtime, rec: SessionRecord, i: number, ls: LegStep): Promise<void> {
  const act = rec.active!
  const leg = act.legs[i]!
  const wrapped = await wrapSurface(rt, rec, checkSurfaceUrls(rt, rec, ls))
  const before = leg.step?.status
  if (before !== wrapped.status) {
    addTimeline(rec, `leg.${wrapped.status}`, {
      index: i,
      adapterId: leg.adapterId,
      ...(wrapped.ref ? { ref: wrapped.ref } : {}),
      ...(wrapped.txHash ? { txHash: wrapped.txHash } : {}),
      ...(wrapped.error ? { error: wrapped.error.code } : {}),
    })
  }
  const prevOutput = leg.step?.output
  leg.step = wrapped
  if (wrapped.output && wrapped.output.amount !== prevOutput?.amount) checkOutput(rt, rec, i, wrapped.output)
  if (wrapped.ref && wrapped.ref !== leg.ref) {
    leg.ref = wrapped.ref
    await rt.store.kv.put(`ref:${leg.adapterId}:${wrapped.ref}`, rec.id, REF_INDEX_TTL_SEC)
  }
  // An operator closed this session (`admin.resolve`). Keep the leg data for the record, but do not
  // send from the treasury, start the next leg, notify or change the session state.
  if (rec.resolution) return
  if (!rec.reversal && isReversal(before, wrapped.status)) {
    rec.reversal = { at: Date.now(), index: i, adapterId: leg.adapterId, legId: leg.legId, status: wrapped.status as 'refunded' | 'reversed', previous: rec.step.state }
    rt.log.warn('the provider took back a payment; the session is REVERSED', { sessionId: rec.id, adapterId: leg.adapterId, ref: leg.ref, status: wrapped.status, previous: rec.step.state })
    rt.metric('payment.reversed', 1, { adapter: leg.adapterId, status: wrapped.status })
    rec.step = composeStep(rt, rec)
    await settleStatus(rt, rec)
    return
  }
  const sent = await treasuryStep(rt, rec, i, wrapped)
  if (sent) return setLegStep(rt, rec, i, sent)
  // Leg events of a later attempt get their own key (and so their own event id).
  const scope = act.n ? `a${act.n}` : undefined
  if (wrapped.status === 'succeeded') await notify(rt, rec, 'leg.succeeded', { index: i, adapterId: leg.adapterId, legId: leg.legId }, scope)
  if (wrapped.status === 'failed') await notify(rt, rec, 'leg.failed', { index: i, adapterId: leg.adapterId, error: wrapped.error }, scope)
  if (wrapped.status === 'succeeded' && i === act.index && i < act.legs.length - 1) {
    act.index = i + 1
    await startLeg(rt, rec, act.index)
    return
  }
  rec.step = composeStep(rt, rec)
  await settleStatus(rt, rec)
}

export async function startLeg(rt: Runtime, rec: SessionRecord, i: number): Promise<void> {
  const act = rec.active!
  const leg = act.legs[i]!
  const a = rt.adapter(leg.adapterId)
  leg.started = true
  const input = leg.quote.input.asset
  const source =
    i !== 0
      ? undefined
      : rec.direction === 'withdraw'
        ? withdrawSender(rt, rec)
        : rec.walletAddress && input.kind === 'crypto'
          ? { chain: input.chain, token: input.token, address: rec.walletAddress }
          : undefined
  const ls = await a.start(
    {
      leg: act.pathway.legs[i]!,
      quote: leg.quote,
      ...(leg.deliverTo ? { deliverTo: leg.deliverTo } : {}),
      ...(source ? { source } : {}),
    },
    adapterContext(rt, rec, a, act.pathway, i),
  )
  await setLegStep(rt, rec, i, ls)
}

/** Most attempts kept per session. The oldest one goes first. */
const MAX_ATTEMPTS_KEPT = 10

/**
 * Move the active payment to `rec.attempts`. Its provider refs stay indexed, so a late provider event
 * for it still finds this session (see `applyEvent`).
 */
export function archiveActive(rec: SessionRecord): void {
  if (!rec.active) return
  const attempts = [...(rec.attempts ?? []), { ...rec.active, endedAt: Date.now() }]
  rec.attempts = attempts.slice(-MAX_ATTEMPTS_KEPT)
  rec.active = undefined
}

/** Begin the payment for a stored quote. Rolls back the active pathway when the first leg fails to start. */
export async function beginPayment(rt: Runtime, rec: SessionRecord, quoteId: string, stored: StoredQuote): Promise<void> {
  const before = { active: rec.active, attempts: rec.attempts }
  const n = Math.max(0, ...[...(rec.attempts ?? []), ...(rec.active ? [rec.active] : [])].map((a) => (a.n ?? 0) + 1))
  archiveActive(rec)
  rec.active = {
    n,
    quoteId,
    pathway: stored.pathway,
    index: 0,
    legs: stored.pathway.legs.map(
      (l, i): ActiveLeg => ({
        adapterId: l.adapterId,
        legId: l.legId,
        quote: stored.quote.legs[i]!,
        ...(stored.deliverTo[i] ? { deliverTo: stored.deliverTo[i]! } : {}),
        started: false,
      }),
    ),
  }
  addTimeline(rec, 'payment.started', { attempt: n, method: stored.pathway.method, provider: stored.pathway.provider })
  try {
    await startLeg(rt, rec, 0)
  } catch (e) {
    const adapter = stored.pathway.legs[0]?.adapterId ?? 'unknown'
    rt.metric('start.error', 1, { adapter, code: e instanceof OrkException ? e.error.code : 'INTERNAL' })
    addTimeline(rec, 'payment.start_failed', { attempt: n, adapterId: adapter })
    rec.active = before.active
    if (before.attempts) rec.attempts = before.attempts
    else delete rec.attempts
    throw e
  }
}

/** Ask the active leg's adapter for status (rate-limited). Returns true when the session changed. */
export async function refreshActive(rt: Runtime, rec: SessionRecord, force = false): Promise<boolean> {
  const act = rec.active
  if (!act || isTerminal(rec.step.state)) return false
  const leg = act.legs[act.index]!
  if (!leg.ref || !leg.step || isLegTerminal(leg.step.status)) return false
  const a = rt.adapter(leg.adapterId)
  if (!a.status) return false
  if (!force && leg.lastCheckedAt && Date.now() - leg.lastCheckedAt < STATUS_CHECK_MIN_INTERVAL_MS) return false
  leg.lastCheckedAt = Date.now()
  try {
    const ls = await a.status({ leg: act.pathway.legs[act.index]!, ref: leg.ref }, adapterContext(rt, rec, a, act.pathway, act.index))
    if (ls.status !== leg.step.status || ls.state !== leg.step.state || ls.sub !== leg.step.sub) {
      await setLegStep(rt, rec, act.index, { ...ls, ...(ls.surface ? {} : leg.step.surface ? { surface: leg.step.surface } : {}) })
      return true
    }
  } catch (e) {
    rt.log.warn('status check failed', { adapter: a.id, error: String(e) })
  }
  return false
}

/**
 * Build the leg step for a provider event, keeping the current surface until the leg ends.
 * A non-terminal event may carry a new `surface` (and its `transitions`), e.g. an offramp that
 * learns its deposit address from a webhook and now needs a WALLET_TX.
 */
export function legStepFromEvent(cur: LegStep | undefined, ev: LegEvent): LegStep {
  const terminal = isLegTerminal(ev.status)
  const withSurface = !terminal && !!ev.surface
  const ls: LegStep = {
    ...(cur ?? { transitions: [] }),
    status: ev.status,
    state: LEG_STATUS_TO_STATE[ev.status],
    transitions: terminal ? [] : withSurface && ev.transitions ? ev.transitions : [{ name: 'poll', kind: 'AWAIT', poll: DEFAULT_POLL }],
    ...(withSurface ? { surface: ev.surface } : {}),
    ...(ev.output ? { output: ev.output } : {}),
    ...(ev.txHash ? { txHash: ev.txHash } : {}),
    ...(ev.error ? { error: ev.error } : {}),
    ref: ev.ref,
  }
  if (terminal) delete ls.surface
  return ls
}

/**
 * What happened to a provider event:
 * - `applied`: the session changed.
 * - `ignored`: verified, and nothing to do (for example a repeat of a terminal status, an event that
 *   would move the leg back, or an event id that the session already applied).
 * - `unknown`: no session for this ref yet (the ref index can lag), or the session is gone.
 * - `conflict`: the session changed at the same time on every try.
 * The webhook route answers 503 for `unknown` and `conflict`, so the provider sends the event again.
 */
export type ApplyResult = 'applied' | 'ignored' | 'unknown' | 'conflict'

/** Legs whose status shows that money moved */
const MONEY_MOVED: LegStatus[] = ['processing', 'succeeded', 'refunded']

/**
 * A status for a leg of an earlier attempt (one the user left with `restart`). When money moved on it
 * and the session has no other payment under way, that attempt becomes the active payment again, so
 * the session completes. When the session already completed or another payment is under way, a
 * succeeded leg sends `session.late_payment` instead, so the app can refund or credit by hand.
 */
async function applyToAttempt(rt: Runtime, rec: SessionRecord, k: number, i: number, ls: LegStep): Promise<void> {
  const att = rec.attempts![k]!
  const leg = att.legs[i]!
  const before = leg.step?.status
  if (before !== ls.status) addTimeline(rec, `attempt.leg.${ls.status}`, { attempt: att.n ?? 0, index: i, adapterId: leg.adapterId, ...(ls.txHash ? { txHash: ls.txHash } : {}) })
  leg.step = ls
  if (isReversal(before, ls.status)) {
    // The session moved on from this attempt, so its state stays. The timeline keeps the reversal.
    rt.log.warn('the provider took back a payment of an earlier attempt', { sessionId: rec.id, adapterId: leg.adapterId, ref: leg.ref, status: ls.status })
    rt.metric('payment.reversed', 1, { adapter: leg.adapterId, status: ls.status })
    return
  }
  if (!MONEY_MOVED.includes(ls.status)) return
  const underway = rec.active?.legs.some((l) => l.step && MONEY_MOVED.includes(l.step.status))
  if (rec.step.state === 'COMPLETED' || underway || rec.resolution) {
    rt.log.warn('payment on an earlier attempt after the session moved on', { sessionId: rec.id, adapterId: leg.adapterId, ref: leg.ref, status: ls.status })
    if (ls.status === 'succeeded') {
      await notify(rt, rec, 'session.late_payment', { attempt: att.n ?? 0, index: i, adapterId: leg.adapterId, legId: leg.legId, ...(ls.txHash ? { txHash: ls.txHash } : {}) })
    }
    return
  }
  rt.log.info('an earlier attempt was paid; it is the active payment again', { sessionId: rec.id, adapterId: leg.adapterId, ref: leg.ref })
  rec.attempts!.splice(k, 1)
  archiveActive(rec)
  const { endedAt: _ended, ...payment } = att
  rec.active = { ...payment, index: i }
  await setLegStep(rt, rec, i, ls)
}

/** Find the leg that owns a provider ref: in the active payment first, then in earlier attempts (newest first). */
function findLeg(rec: SessionRecord, adapterId: string, ref: string): { act: ActivePayment; k: number; i: number } | undefined {
  const owns = (l: ActiveLeg) => l.adapterId === adapterId && l.ref === ref
  const i = rec.active?.legs.findIndex(owns) ?? -1
  if (i !== -1) return { act: rec.active!, k: -1, i }
  const attempts = rec.attempts ?? []
  for (let k = attempts.length - 1; k >= 0; k--) {
    const j = attempts[k]!.legs.findIndex(owns)
    if (j !== -1) return { act: attempts[k]!, k, i: j }
  }
  return undefined
}

/** Poll the legs of earlier attempts that still wait (sweep only). Returns true when the session changed. */
export async function refreshAttempts(rt: Runtime, rec: SessionRecord): Promise<boolean> {
  const attempts = rec.attempts ?? []
  for (let k = attempts.length - 1; k >= 0; k--) {
    const att = attempts[k]!
    for (let i = 0; i < att.legs.length; i++) {
      const leg = att.legs[i]!
      if (!leg.ref || !leg.step || isLegTerminal(leg.step.status)) continue
      const a = rt.adapters.get(leg.adapterId)
      if (!a?.status) continue
      try {
        const ls = await a.status({ leg: att.pathway.legs[i]!, ref: leg.ref }, adapterContext(rt, rec, a, att.pathway, i))
        if (ls.status === leg.step.status) continue
        const { surface: _s, ...rest } = ls
        await applyToAttempt(rt, rec, k, i, { ...rest, ref: ls.ref ?? leg.ref })
        return true
      } catch (e) {
        rt.log.warn('status check failed', { adapter: a.id, error: String(e) })
      }
    }
  }
  return false
}

/**
 * True when a provider event may change the leg step `cur` (see `isLegalLegMove`). One move back is
 * allowed: from `processing` to `awaiting_user` with a new surface, before the leg has a transaction.
 * For example, an offramp learns its deposit address from a webhook and now needs a WALLET_TX.
 */
export function eventMoveAllowed(cur: LegStep, ev: LegEvent): boolean {
  if (isLegalLegMove(cur.status, ev.status)) return true
  return cur.status === 'processing' && ev.status === 'awaiting_user' && !!ev.surface && !cur.txHash
}

/** Most provider event ids kept per session (see `SessionRecord.providerEvents`) */
const MAX_PROVIDER_EVENTS = 50

/**
 * Apply a provider event (webhook or adapter route) to the session that owns `ev.ref`. Idempotent.
 * The leg moves only forward (see `isLegalLegMove`): an event that would move it back is ignored. An
 * event with an `eventId` that this session already applied is ignored too.
 */
export async function applyEvent(rt: Runtime, adapterId: string, ev: LegEvent): Promise<ApplyResult> {
  const sid = await rt.store.kv.get<string>(`ref:${adapterId}:${ev.ref}`)
  if (!sid) {
    rt.log.warn('event for unknown ref; the provider should send it again', { adapterId, ref: ev.ref })
    return 'unknown'
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const rec = await rt.store.get(sid)
    if (!rec) {
      rt.log.warn('event for a session that is not in the store', { adapterId, ref: ev.ref, sessionId: sid })
      return 'unknown'
    }
    const found = findLeg(rec, adapterId, ev.ref)
    if (!found) {
      rt.log.warn('event for a ref that no leg of the session has now; ignored', { adapterId, ref: ev.ref, sessionId: sid })
      return 'ignored'
    }
    const seen = ev.eventId ? `${adapterId}:${ev.ref}:${ev.eventId}` : undefined
    if (seen && rec.providerEvents?.includes(seen)) {
      rt.log.info('provider event already applied; ignored', { adapterId, ref: ev.ref, eventId: ev.eventId, sessionId: sid })
      return 'ignored'
    }
    const cur = found.act.legs[found.i]!.step
    if (cur && !eventMoveAllowed(cur, ev)) {
      // A repeat of a final status is normal (providers send events more than once). A move back is not.
      if (cur.status !== ev.status) {
        rt.log.warn('provider event would move the leg back; ignored', { adapterId, ref: ev.ref, sessionId: sid, from: cur.status, to: ev.status })
        rt.metric('event.out_of_order', 1, { adapter: adapterId })
      }
      return 'ignored'
    }
    try {
      const ls = legStepFromEvent(cur, ev)
      if (found.k === -1) await setLegStep(rt, rec, found.i, ls)
      else await applyToAttempt(rt, rec, found.k, found.i, ls)
      if (seen) rec.providerEvents = [...(rec.providerEvents ?? []), seen].slice(-MAX_PROVIDER_EVENTS)
      await saveSession(rt, rec)
      // A session that became active again (or was dropped from the list) must be polled by the sweep.
      if (!isTerminal(rec.step.state)) await trackOpenSession(rt, rec.id)
      return 'applied'
    } catch (e) {
      if (e instanceof OrkException && e.status === 409) continue
      throw e
    }
  }
  rt.log.warn('event not applied: the session kept changing; the provider should send it again', { adapterId, ref: ev.ref })
  return 'conflict'
}
