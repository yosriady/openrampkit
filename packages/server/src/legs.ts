// The leg state machine: start legs, apply adapter steps and provider events, advance through the pathway.

import type { LegEvent } from '@openrampkit/adapter'
import { OrkException, isLegTerminal, isTerminal } from '@openrampkit/core'
import type { LegStatus, LegStep, SessionStatus, StateName, Step } from '@openrampkit/core'
import { DEFAULT_POLL, REF_INDEX_TTL_SEC, START_URL_TTL_MS, STATUS_CHECK_MIN_INTERVAL_MS } from './config.js'
import { hmacHex, randomHex } from './crypto.js'
import { notify } from './notify.js'
import { adapterContext, saveSession } from './runtime.js'
import type { Runtime } from './runtime.js'
import type { ActiveLeg, SessionRecord, StoredQuote } from './store.js'

const LEG_STATUS_TO_STATE: Record<LegStatus, StateName> = {
  pending: 'PROCESSING',
  awaiting_user: 'PAYMENT',
  processing: 'PROCESSING',
  succeeded: 'COMPLETED',
  failed: 'FAILED',
  refunded: 'REFUNDED',
  expired: 'EXPIRED',
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
  return hasActive ? 'processing' : 'open'
}

async function settleStatus(rt: Runtime, rec: SessionRecord) {
  const before = rec.status
  rec.status = sessionStatusFor(rec.step.state, !!rec.active)
  if (rec.status !== before && ['completed', 'failed', 'expired', 'refunded'].includes(rec.status)) {
    await notify(rt, rec, `session.${rec.status}`)
  }
}

/** Record a leg's new step, index its provider ref, notify, and start the next leg when this one succeeds. */
export async function setLegStep(rt: Runtime, rec: SessionRecord, i: number, ls: LegStep): Promise<void> {
  const act = rec.active!
  const leg = act.legs[i]!
  const wrapped = await wrapSurface(rt, rec, ls)
  leg.step = wrapped
  if (wrapped.ref && wrapped.ref !== leg.ref) {
    leg.ref = wrapped.ref
    await rt.store.kv.put(`ref:${leg.adapterId}:${wrapped.ref}`, rec.id, REF_INDEX_TTL_SEC)
  }
  if (wrapped.status === 'succeeded') await notify(rt, rec, 'leg.succeeded', { index: i, adapterId: leg.adapterId, legId: leg.legId })
  if (wrapped.status === 'failed') await notify(rt, rec, 'leg.failed', { index: i, adapterId: leg.adapterId, error: wrapped.error })
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
  const ls = await a.start(
    {
      leg: act.pathway.legs[i]!,
      quote: leg.quote,
      ...(leg.deliverTo ? { deliverTo: leg.deliverTo } : {}),
      ...(i === 0 && rec.walletAddress && input.kind === 'crypto' ? { source: { chain: input.chain, token: input.token, address: rec.walletAddress } } : {}),
    },
    adapterContext(rt, rec, a, act.pathway, i),
  )
  await setLegStep(rt, rec, i, ls)
}

/** Begin the payment for a stored quote. Rolls back the active pathway when the first leg fails to start. */
export async function beginPayment(rt: Runtime, rec: SessionRecord, quoteId: string, stored: StoredQuote): Promise<void> {
  rec.active = {
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
  try {
    await startLeg(rt, rec, 0)
  } catch (e) {
    rec.active = undefined
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

/** Build the leg step for a provider event, keeping the current surface until the leg ends. */
export function legStepFromEvent(cur: LegStep | undefined, ev: LegEvent): LegStep {
  const terminal = isLegTerminal(ev.status)
  const ls: LegStep = {
    ...(cur ?? { transitions: [] }),
    status: ev.status,
    state: LEG_STATUS_TO_STATE[ev.status],
    transitions: terminal ? [] : [{ name: 'poll', kind: 'AWAIT', poll: DEFAULT_POLL }],
    ...(ev.output ? { output: ev.output } : {}),
    ...(ev.txHash ? { txHash: ev.txHash } : {}),
    ...(ev.error ? { error: ev.error } : {}),
    ref: ev.ref,
  }
  if (terminal) delete ls.surface
  return ls
}

/** Apply a provider event (webhook or adapter route) to the session that owns `ev.ref`. Idempotent. */
export async function applyEvent(rt: Runtime, adapterId: string, ev: LegEvent): Promise<void> {
  const sid = await rt.store.kv.get<string>(`ref:${adapterId}:${ev.ref}`)
  if (!sid) {
    rt.log.warn('event for unknown ref', { adapterId, ref: ev.ref })
    return
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const rec = await rt.store.get(sid)
    if (!rec?.active) return
    const i = rec.active.legs.findIndex((l) => l.adapterId === adapterId && l.ref === ev.ref)
    if (i === -1) return
    const cur = rec.active.legs[i]!.step
    if (cur && isLegTerminal(cur.status)) return
    try {
      await setLegStep(rt, rec, i, legStepFromEvent(cur, ev))
      await saveSession(rt, rec)
      return
    } catch (e) {
      if (e instanceof OrkException && e.status === 409) continue
      throw e
    }
  }
  rt.log.warn('event dropped after retries', { adapterId, ref: ev.ref })
}
