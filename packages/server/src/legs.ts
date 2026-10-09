// The leg state machine: start legs, apply adapter steps and provider events, advance through the pathway.

import type { LegEvent } from '@openrampkit/adapter'
import { OpenRampException, bps, cmp, isDecimal, isFinalStatus, isLegalLegMove, isLegTerminal, isSafeLinkUrl, isStepDetailCode, isTerminal, isWebUrl, openRampError, stateFor, sub } from '@openrampkit/core'
import type { Amount, AmountMismatch, Asset, LegStatus, LegStep, LegTransaction, SessionStatus, StateName, Step, StepDetail, Transaction, TransactionRole } from '@openrampkit/core'
import { DEFAULT_LATE_GRACE_HOURS, DEFAULT_MAX_ATTEMPTS, DEFAULT_OUTPUT_TOLERANCE_BPS, DEFAULT_POLL, REF_INDEX_TTL_SEC, START_URL_TTL_MS, STATUS_CHECK_MIN_INTERVAL_MS, isTreasuryRefused } from './config.js'
import { hmacHex, randomHex, sha256Hex } from './crypto.js'
import { notify } from './notify.js'
import { saveSession } from './outbox.js'
import { trackOpenSession } from './queue.js'
import { adapterContext } from './runtime.js'
import { addTimeline } from './timeline.js'
import type { Runtime } from './runtime.js'
import type { ActiveLeg, ActivePayment, SessionRecord, StoredQuote } from './store.js'
import { withdrawSender } from './withdraw.js'

/** The AWAIT transition of a step with no action: the client checks the status on this schedule */
const pollTransitions = (ls: LegStep) => [{ name: 'poll', kind: 'AWAIT' as const, poll: ls.poll ?? DEFAULT_POLL }]

/** Build the session step from the active leg. A finished leg that is not the last shows as PROCESSING. */
export function composeStep(rt: Runtime, rec: SessionRecord): Step {
  const act = rec.active!
  const ls = act.legs[act.index]!.step!
  // A refund or a chargeback after success ends the session, whatever the other legs do.
  if (rec.reversal) {
    return { sessionId: rec.id, state: 'REVERSED', transitions: [], error: openRampError('PAYMENT_REVERSED', { recovery: 'contact_support', legId: rec.reversal.legId }), legIndex: act.index }
  }
  // A leg before the last delivered another asset (or no valid amount): the next leg cannot take it,
  // so it does not start. An operator checks the funds (`admin.resolve`).
  const cur = act.legs[act.index]!
  if (act.index < act.legs.length - 1 && cur.step?.status === 'succeeded' && deliveredWrongAsset(cur)) {
    const error = openRampError('DELIVERY_FAILED', { message: 'The provider delivered another asset than the quote. Contact support.', recovery: 'contact_support', legId: cur.legId })
    return { sessionId: rec.id, state: 'FAILED', transitions: [], error, legIndex: act.index }
  }
  if (act.legs.every((l) => l.step?.status === 'succeeded')) {
    return { sessionId: rec.id, state: 'COMPLETED', transitions: [], legIndex: act.index }
  }
  const state = stateFor(ls)
  const legDone = state === 'COMPLETED'
  const action = ls.status === 'requires_action' ? ls.action : undefined
  return {
    sessionId: rec.id,
    state: legDone ? 'PROCESSING' : state,
    ...(ls.detail && !legDone ? { detail: ls.detail } : {}),
    legIndex: act.index,
    ...(action?.surface ? { surface: action.surface } : {}),
    transitions: action ? action.transitions : legDone ? pollTransitions({ status: 'processing' }) : isLegTerminal(ls.status) ? [] : pollTransitions(ls),
    ...(ls.error ? { error: ls.error } : {}),
    expiresAt: new Date(rec.expiresAt).toISOString(),
  }
}

/** The roles that an adapter may report (`hop` is set by the server) */
const LEG_ROLES: ReadonlySet<string> = new Set<TransactionRole>(['approval', 'source', 'destination', 'settlement', 'refund'])
/** Free provider status text that may reach the browser */
const PROVIDER_STATUS = /^[A-Za-z0-9_ .:-]{1,64}$/
/** Most transactions kept per leg */
const MAX_LEG_TRANSACTIONS = 20

/**
 * Check an adapter step before the server uses it (a third-party adapter may send anything): a step
 * detail code from the closed list and a short provider status, an action only with
 * `requires_action`, a phase only while pending or processing, and well formed transactions.
 */
export function sanitizeLegStep(rt: Runtime, adapterId: string, ls: LegStep): LegStep {
  const out: LegStep = { ...ls }
  // An adapter written for the version 1 contract: its `state`, `surface`, `transitions` and tx hash
  // fields have no effect now. Say so, so that the operator updates the adapter.
  const legacy = ['state', 'sub', 'surface', 'transitions', 'txHash', 'sourceTxHash'].filter((k) => k in ls)
  if (legacy.length) rt.log.warn('adapter step has fields of the adapter API version 1; they are ignored. Update the adapter to version 2', { adapter: adapterId, fields: legacy.join(',') })
  if (out.detail) {
    const code = out.detail.code
    if (!isStepDetailCode(code)) {
      rt.log.warn('adapter step has a detail code that is not in STEP_DETAIL_CODES; dropped', { adapter: adapterId, code: String(code).slice(0, 64) })
      delete out.detail
    } else {
      const ps = out.detail.providerStatus
      out.detail = { code, ...(typeof ps === 'string' && PROVIDER_STATUS.test(ps) ? { providerStatus: ps } : {}) } satisfies StepDetail
    }
  }
  if (out.action && out.status !== 'requires_action') {
    rt.log.warn('adapter step has an action but its status is not requires_action; the action is dropped', { adapter: adapterId, status: out.status })
    delete out.action
  }
  if (out.phase && out.status !== 'processing' && out.status !== 'pending') delete out.phase
  if (out.transactions !== undefined) {
    const ok = Array.isArray(out.transactions) ? out.transactions.filter((t) => !!t && LEG_ROLES.has(t.role) && typeof t.hash === 'string' && t.hash.length > 0 && t.hash.length <= 200) : []
    if (ok.length !== (Array.isArray(out.transactions) ? out.transactions.length : -1)) rt.log.warn('adapter step has transactions that are not well formed; dropped', { adapter: adapterId })
    out.transactions = ok
  }
  return out
}

const txKey = (t: LegTransaction) => `${t.role}:${t.hash.startsWith('0x') ? t.hash.toLowerCase() : t.hash}`

/**
 * The leg step after `next`, from the current one. The leg keeps what a later step leaves out: the
 * refs, the reported output, every transaction (merged by role and hash), and, while the user must
 * act, the surface of the current action. An action-less `requires_action` step (for example a status
 * poll while the user pays) keeps the current action.
 */
export function mergeLegStep(prev: LegStep | undefined, next: LegStep): LegStep {
  const out: LegStep = { status: next.status }
  if (next.status === 'requires_action') {
    const prevAction = prev?.status === 'requires_action' ? prev.action : undefined
    const action = next.action ?? prevAction ?? { kind: 'payment' as const, transitions: pollTransitions(next) }
    const surface = action.surface ?? prevAction?.surface
    out.action = { ...action, ...(surface ? { surface } : {}) }
  }
  if (next.phase) out.phase = next.phase
  if (next.poll) out.poll = next.poll
  if (next.detail) out.detail = next.detail
  if (next.error) out.error = next.error
  const ref = next.ref ?? prev?.ref
  if (ref) out.ref = ref
  const providerRef = next.providerRef ?? prev?.providerRef
  if (providerRef) out.providerRef = providerRef
  const output = next.output ?? prev?.output
  if (output) out.output = output
  const txs = new Map<string, LegTransaction>()
  for (const t of [...(prev?.transactions ?? []), ...(next.transactions ?? [])]) txs.set(txKey(t), { ...txs.get(txKey(t)), ...t })
  if (txs.size) out.transactions = [...txs.values()].slice(-MAX_LEG_TRANSACTIONS)
  return out
}

/** True when a leg reported a transaction that moves funds (any role but `approval`) */
export function hasFundsTransaction(ls: LegStep | undefined): boolean {
  return !!ls?.transactions?.some((t) => t.role !== 'approval')
}

/**
 * The public transactions of leg `i`: with the leg index, the chain from the leg when the adapter
 * left it out (the `to` chain for a delivery, else the `from` chain), and a `destination` of a leg
 * that is not the last one as a `hop`.
 */
export function legTransactions(p: ActivePayment, i: number): Transaction[] {
  const leg = p.legs[i]!
  const pl = p.pathway.legs[i]
  const last = i === p.legs.length - 1
  const chainOf = (a: Asset | undefined) => (a?.kind === 'crypto' && a.chain !== '*' ? a.chain : undefined)
  const toChain = chainOf(pl?.to.asset) ?? chainOf(leg.quote.output.asset)
  const fromChain = chainOf(pl?.from.asset) ?? chainOf(leg.quote.input.asset)
  const out: Transaction[] = []
  for (const t of leg.step?.transactions ?? []) {
    const delivery = t.role === 'destination' || t.role === 'settlement'
    const chain = t.chain ?? (delivery ? toChain : fromChain ?? toChain)
    if (!chain) continue
    out.push({
      role: t.role === 'destination' && !last ? 'hop' : t.role,
      chain,
      hash: t.hash,
      legIndex: i,
      ...(t.amount ? { amount: t.amount } : {}),
      ...(t.explorerUrl ? { explorerUrl: t.explorerUrl } : {}),
    })
  }
  return out
}

/**
 * A step whose surface URL is not safe for the browser becomes a failed step. REDIRECT, IFRAME and a
 * PROVIDER_SDK `redirectUrl` need `https:` (`http:` too in test mode); DEEPLINK may use an app scheme.
 * `javascript:`, `data:` and similar URLs never reach the client.
 */
export function checkSurfaceUrls(rt: Runtime, rec: SessionRecord, ls: LegStep): LegStep {
  const s = ls.action?.surface
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
  const { action: _unsafe, ...rest } = ls
  return { ...rest, status: 'failed', error: openRampError('PROVIDER_UNAVAILABLE', { recovery: 'choose_other' }) }
}

/** Replace a provider REDIRECT with a signed, popup-safe start URL on our own origin. */
export async function wrapSurface(rt: Runtime, rec: SessionRecord, ls: LegStep): Promise<LegStep> {
  const action = ls.action
  if (action?.surface?.kind !== 'REDIRECT') return ls
  const surface = action.surface
  const now = Date.now()
  for (const [t, e] of Object.entries(rec.startUrls)) if (e.exp < now) delete rec.startUrls[t]
  const token = randomHex(12)
  rec.startUrls[token] = { url: surface.url, exp: now + START_URL_TTL_MS, ...(surface.keepReferrer ? { keepReferrer: true } : {}) }
  const sig = await startSignature(rt, rec.id, token)
  return { ...ls, action: { ...action, surface: { ...surface, url: `${rt.base}/start/${rec.id}.${token}.${sig}` } } }
}

/**
 * The provider URL behind a REDIRECT surface that `wrapSurface` signed (`{base}/start/{id}.{token}.{sig}`),
 * else the URL as it is. A status poll that repeats the provider's REDIRECT is then no change.
 */
function providerUrl(rt: Runtime, rec: SessionRecord, url: string): string {
  const prefix = `${rt.base}/start/${rec.id}.`
  if (!url.startsWith(prefix)) return url
  const token = url.slice(prefix.length).split('.')[0] ?? ''
  return rec.startUrls[token]?.url ?? url
}

/** True when two leg steps are the same, with each signed REDIRECT compared by its provider URL */
export function sameLegStep(rt: Runtime, rec: SessionRecord, a: LegStep, b: LegStep | undefined): boolean {
  const plain = (ls: LegStep | undefined) => {
    const s = ls?.action?.surface
    return JSON.stringify(s?.kind === 'REDIRECT' ? { ...ls, action: { ...ls!.action!, surface: { ...s, url: providerUrl(rt, rec, s.url) } } } : ls)
  }
  return plain(a) === plain(b)
}

export async function startSignature(rt: Runtime, sessionId: string, token: string): Promise<string> {
  return (await hmacHex(rt.config.secret, `${sessionId}.${token}`)).slice(0, 32)
}

/**
 * The session status for a step state. With an active payment that is not final: `requires_action` when
 * the active leg waits for the user (`waitingForUser`), else `processing`. Without one:
 * `requires_payment_method`. A FAILED step gives `failed` here; `settleStatus` turns a failed attempt
 * that the user can retry into `requires_payment_method` (see `isFinalFailure`).
 */
export function sessionStatusFor(state: StateName, hasActive: boolean, waitingForUser = false): SessionStatus {
  if (state === 'COMPLETED') return 'succeeded'
  if (state === 'FAILED' || state === 'BLOCKED') return 'failed'
  if (state === 'CANCELED') return 'canceled'
  if (state === 'EXPIRED') return 'expired'
  if (state === 'REFUNDED') return 'refunded'
  if (state === 'REVERSED') return 'reversed'
  if (!hasActive) return 'requires_payment_method'
  return waitingForUser ? 'requires_action' : 'processing'
}

/** True when the active leg of the session waits for the user (to pay, sign, or finish a provider step) */
export function waitsForUser(rec: SessionRecord): boolean {
  const act = rec.active
  return !!act && act.legs[act.index]?.step?.status === 'requires_action'
}

/** The most payment attempts of one session (`policy.maxAttempts`) */
export function maxAttempts(rt: Runtime): number {
  return Math.max(1, Math.floor(rt.config.policy?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS))
}

/**
 * True when the FAILED step of the active payment ends the session (status `failed`), so the user cannot
 * start a new attempt:
 * - a leg of the payment succeeded: the funds are at a hop (or arrived in another asset than the
 *   quote), and a new attempt cannot use them;
 * - money left on this attempt (a later leg started, the treasury sent, or a transaction was
 *   submitted): a new attempt could pay out or pay in a second time;
 * - the session has no attempts left (`policy.maxAttempts`).
 * Else the failure ends only this attempt: the session goes back to `requires_payment_method`.
 */
export function isFinalFailure(rt: Runtime, rec: SessionRecord): boolean {
  if (rec.step.state === 'BLOCKED') return true
  if (rec.step.state !== 'FAILED') return false
  const act = rec.active
  if (!act) return true
  // Money arrived on a leg (a hop, or another asset than the quote): a new attempt cannot use it.
  if (act.legs.some((l) => l.step?.status === 'succeeded')) return true
  // Money left on this attempt: a later leg started, the treasury sent, or a transaction was submitted.
  // A new attempt could send a second payout (or a second deposit) for the same session, so the
  // failure is final and an operator resolves it. A failure before any money moved (for example a
  // declined card) stays retryable.
  if (act.index > 0 || act.legs.some((l) => !!l.treasurySent?.length || hasFundsTransaction(l.step))) return true
  return (act.n ?? 0) + 1 >= maxAttempts(rt)
}

/** The leg fields of a session event. No time: the event id must not change. */
function legDetail(rec: SessionRecord, i: number): Record<string, unknown> {
  const act = rec.active!
  const leg = act.legs[i]!
  return { attempt: act.n ?? 0, index: i, adapterId: leg.adapterId, legId: leg.legId }
}

/**
 * Set the session status from its step, and send the event for a new status once:
 * - a failed attempt (the user can try again): status `requires_payment_method`, `lastError`, and
 *   `session.payment_failed`;
 * - a final failure: status `failed`, `lastError`, and `session.failed`. Nothing follows it;
 * - `session.requires_action` and `session.processing` once per leg and attempt;
 * - `session.succeeded`, `session.expired`, `session.refunded` and `session.reversed`.
 */
async function settleStatus(rt: Runtime, rec: SessionRecord) {
  const before = rec.status
  let status = sessionStatusFor(rec.step.state, !!rec.active, waitsForUser(rec))
  const act = rec.active
  const scope = act?.n ? `a${act.n}` : undefined
  if (status === 'failed') {
    rec.lastError = rec.step.error ?? openRampError('PAYMENT_FAILED')
    if (!isFinalFailure(rt, rec)) {
      rec.status = 'requires_payment_method'
      // Once per attempt (the key has the attempt and the error).
      if (act) await notify(rt, rec, 'session.payment_failed', { ...legDetail(rec, act.index), error: rec.lastError }, scope)
      return
    }
  }
  rec.status = status
  // Once per leg and attempt: `notify` sends each key once.
  if (status === 'requires_action' || status === 'processing') {
    if (act) await notify(rt, rec, `session.${status}`, legDetail(rec, act.index), scope)
    return
  }
  if (status === before || status === 'requires_payment_method') return
  const extra = status === 'reversed' ? reversalDetail(rec) : status === 'failed' ? { error: rec.lastError } : undefined
  await notify(rt, rec, `session.${status as 'succeeded' | 'failed' | 'canceled' | 'expired' | 'refunded' | 'reversed'}`, extra)
}

/** The extra fields of `session.reversed`. No time: the event id must not change. */
function reversalDetail(rec: SessionRecord): Record<string, unknown> | undefined {
  const r = rec.reversal
  return r ? { index: r.index, adapterId: r.adapterId, legId: r.legId, legStatus: r.status, previous: r.previous } : undefined
}

/**
 * The provider took back the money of leg `i` of the active payment. The session becomes REVERSED (a
 * final state), and the server sends `session.reversed` once. The caller
 * saves the session with `saveSession`, so the events go out with the change.
 */
async function reverse(rt: Runtime, rec: SessionRecord, i: number, status: 'refunded' | 'reversed'): Promise<void> {
  const leg = rec.active!.legs[i]!
  rec.reversal = { at: Date.now(), index: i, adapterId: leg.adapterId, legId: leg.legId, status, previous: rec.step.state }
  rt.log.warn('the provider took back a payment; the session is REVERSED', { sessionId: rec.id, adapterId: leg.adapterId, ref: leg.ref, status, previous: rec.step.state })
  rt.metric('payment.reversed', 1, { adapter: leg.adapterId, status })
  rec.step = composeStep(rt, rec)
  rec.status = 'reversed'
  const extra = reversalDetail(rec)
  await notify(rt, rec, 'session.reversed', extra)
}

/** True when a leg's new status takes back money: a chargeback, or a refund after the leg succeeded. */
function isReversal(before: LegStatus | undefined, after: LegStatus): boolean {
  return after === 'reversed' || (after === 'refunded' && before === 'succeeded')
}

/**
 * Withdraw with `custody: 'app'`: when the first leg asks for a WALLET_TX, the app's treasury signs
 * it instead of the user, and the leg reports the hash at once. Returns the leg's next step, or
 * undefined when this step is not for the treasury. A step that the treasury already sent is never
 * sent again: it becomes a `processing` step that waits for the provider.
 */
async function treasuryStep(rt: Runtime, rec: SessionRecord, i: number, ls: LegStep): Promise<LegStep | undefined> {
  if (rec.direction !== 'withdraw' || rec.source?.custody !== 'app' || i !== 0 || rec.reversal) return undefined
  const surface = ls.action?.surface
  if (surface?.kind !== 'WALLET_TX' || ls.status !== 'requires_action') return undefined
  const act = rec.active!
  const leg = act.legs[i]!
  const { chain, txs } = surface
  const key = `${rec.id}:${i}:${(await sha256Hex(`${leg.ref ?? ''}|${chain}|${JSON.stringify(txs)}`)).slice(0, 24)}`
  // The funds of this step left (or may have left): no WALLET_TX for the user, wait for the provider.
  const { action: _sent, ...rest } = ls
  const sending: LegStep = { ...rest, status: 'processing' }
  // Already sent, but its result was not saved (a failure or a conflict after the send): do not send
  // again, and do not show the step to the user.
  if (leg.treasurySent?.includes(key)) return sending
  const failed = (message: string): LegStep => ({
    status: 'failed',
    ...(ls.ref ? { ref: ls.ref } : {}),
    error: openRampError('PAYMENT_FAILED', { message, recovery: 'contact_support', legId: leg.legId }),
  })
  const treasury = rt.config.treasury
  if (!treasury) return failed('Withdrawals are not set up for this app yet.')
  // Mark and save before sending: at most one send per step from our side. When two requests start
  // this step at the same time, the version check fails one of the saves (409), so only one sends.
  // The key lets the app dedupe retries. The saved session shows the leg as `processing`: when the
  // process stops or a later save fails after the send, the session cannot start a new payment (a
  // second send) and shows no WALLET_TX. The sweep then polls the provider.
  leg.treasurySent = [...(leg.treasurySent ?? []), key]
  if (leg.step?.status !== 'processing') addTimeline(rec, 'leg.processing', { index: i, adapterId: leg.adapterId, ...(leg.ref ? { ref: leg.ref } : {}) })
  leg.step = sending
  rec.step = composeStep(rt, rec)
  rec.status = sessionStatusFor(rec.step.state, true)
  await saveSession(rt, rec)
  let hash: string
  try {
    hash = (await treasury.send({ sessionId: rec.id, userId: rec.userId, chain, txs, idempotencyKey: key })).hash
  } catch (e) {
    // Fail closed: only an explicit `TreasuryRefusedError` proves that nothing was sent. Then the mark
    // goes, and the user may try again. Any other error (a timeout after a broadcast, an RPC error)
    // keeps the mark: the funds may have left, so the failure is final and an operator resolves it.
    const refused = isTreasuryRefused(e)
    if (refused) leg.treasurySent = (leg.treasurySent ?? []).filter((k) => k !== key)
    rt.log.error(refused ? 'treasury refused the payout' : 'treasury send failed; the funds may have left, the session needs an operator', { sessionId: rec.id, error: e instanceof Error ? e.message : String(e) })
    return failed('The withdrawal could not be sent. Contact support.')
  }
  // The treasury's transaction paid into the leg: keep it, also when the adapter does not report it.
  const sent: LegTransaction = { role: 'source', chain, hash }
  const t = ls.action?.transitions.find((x) => x.kind === 'SURFACE_RESULT' && x.expects === 'tx_hash')
  const a = rt.adapter(leg.adapterId)
  if (t && a.transition) {
    const next = await a.transition(
      { leg: act.pathway.legs[i]!, ref: ls.ref ?? leg.ref ?? '', name: t.name, inputs: { txHash: hash } },
      adapterContext(rt, rec, a, act.pathway, i),
    )
    return { ...next, transactions: [sent, ...(next.transactions ?? [])] }
  }
  // No transition to report the hash: wait for the provider to see the transfer.
  return { ...sending, transactions: [...(sending.transactions ?? []), sent] }
}

/** Same asset: the same currency, or the same chain and token. Provider data is not trusted to be well formed. */
function sameAsset(a: Asset, b: Asset): boolean {
  if (a.kind === 'fiat' && b.kind === 'fiat') return typeof a.currency === 'string' && typeof b.currency === 'string' && a.currency.toUpperCase() === b.currency.toUpperCase()
  if (a.kind === 'crypto' && b.kind === 'crypto') return typeof a.token === 'string' && typeof b.token === 'string' && a.chain === b.chain && a.token.toLowerCase() === b.token.toLowerCase()
  return false
}

/**
 * Compare a leg's reported output with its quote. When the provider reports less than the quote's
 * `minOutput` (or, without one, less than the quote by more than `policy.outputToleranceBps`), the
 * leg keeps its result but gets `amountMismatch`, and the
 * timeline gets `leg.amount_mismatch`. `result.amountMismatch` then shows it in every webhook.
 */
function checkOutput(rt: Runtime, rec: SessionRecord, i: number, got: Amount): void {
  const leg = rec.active!.legs[i]!
  const expected = leg.quote.output
  // Fail closed: an output that cannot be compared with the quote never counts as a full delivery.
  let reason: AmountMismatch['reason'] | undefined
  let shortfall = expected.value
  if (!got?.asset || !sameAsset(expected.asset, got.asset)) reason = 'asset_mismatch'
  else if (typeof got.value !== 'string' || !isDecimal(got.value) || !isDecimal(expected.value)) reason = 'invalid_amount'
  else {
    // A quote with a guaranteed minimum (`minOutput`, in the quote's asset) is short only below that
    // minimum. Else the reported output may be `policy.outputToleranceBps` below the quoted output.
    const min = leg.quote.minOutput
    const floor =
      min && sameAsset(min.asset, expected.asset) && typeof min.value === 'string' && isDecimal(min.value)
        ? min.value
        : sub(expected.value, bps(expected.value, Math.max(0, rt.config.policy?.outputToleranceBps ?? DEFAULT_OUTPUT_TOLERANCE_BPS)))
    if (cmp(got.value, floor) >= 0) {
      delete leg.amountMismatch
      return
    }
    reason = 'short'
    shortfall = sub(expected.value, got.value)
  }
  leg.amountMismatch = { reason, expected, received: got, shortfall }
  addTimeline(rec, 'leg.amount_mismatch', { index: i, adapterId: leg.adapterId, reason, expected: expected.value, received: String(got?.value) })
  rt.log.warn('provider reported an output that is not the quoted delivery', { sessionId: rec.id, adapterId: leg.adapterId, index: i, reason, expected: expected.value, received: String(got?.value) })
  rt.metric('leg.amount_mismatch', 1, { adapter: leg.adapterId, reason })
}

/** True when leg `l` delivered something that the next leg cannot take: another asset, or no valid amount. */
function deliveredWrongAsset(l: ActiveLeg): boolean {
  return !!l.amountMismatch && l.amountMismatch.reason !== 'short'
}

/** How long after expiry a late payment can still move a session on (`latePayments.graceHours`) */
export function lateGraceMs(rt: Runtime): number {
  return Math.max(0, rt.config.latePayments?.graceHours ?? DEFAULT_LATE_GRACE_HOURS) * 60 * 60_000
}

/** True when an expired session is still inside its grace window. `graceHours: 0` means never. */
export function inLateGrace(rt: Runtime, rec: SessionRecord): boolean {
  const grace = lateGraceMs(rt)
  return grace > 0 && Date.now() <= rec.expiresAt + grace
}

/**
 * True when an adapter step (a status poll or a transition) may replace the leg step `cur`. The leg
 * moves only forward (`isLegalLegMove`), with one exception: a review step (`processing` with phase
 * `kyc` or `auth`, for example Bridge's KYC review) can end with a step for the user, before any money moved.
 */
export function adapterMoveAllowed(cur: LegStep, next: LegStep): boolean {
  if (cur.status === next.status) return !isLegTerminal(cur.status)
  if (isLegalLegMove(cur.status, next.status)) return true
  return cur.status === 'processing' && next.status === 'requires_action' && (cur.phase === 'kyc' || cur.phase === 'auth') && !hasFundsTransaction(cur)
}

/** Record a leg's new step, index its provider ref, notify, and start the next leg when this one succeeds. */
export async function setLegStep(rt: Runtime, rec: SessionRecord, i: number, ls: LegStep): Promise<void> {
  const act = rec.active!
  const leg = act.legs[i]!
  // Keep what a later step leaves out: the refs, the output, the transactions and the action surface.
  const wrapped = mergeLegStep(leg.step, await wrapSurface(rt, rec, checkSurfaceUrls(rt, rec, sanitizeLegStep(rt, leg.adapterId, ls))))
  const before = leg.step?.status
  const wasExpired = rec.step.state === 'EXPIRED'
  if (before !== wrapped.status) {
    addTimeline(rec, `leg.${wrapped.status}`, {
      index: i,
      adapterId: leg.adapterId,
      ...(wrapped.ref ? { ref: wrapped.ref } : {}),
      ...(wrapped.error ? { error: wrapped.error.code } : {}),
    })
  }
  // Each new transaction goes to the timeline once.
  const known = new Set((leg.step?.transactions ?? []).map(txKey))
  for (const t of wrapped.transactions ?? []) {
    if (!known.has(txKey(t))) addTimeline(rec, 'leg.transaction', { index: i, adapterId: leg.adapterId, role: t.role, hash: t.hash.slice(0, 200) })
  }
  // The provider's own status: the timeline keeps each new value.
  const ps = wrapped.detail?.providerStatus
  if (ps && ps !== leg.step?.detail?.providerStatus) addTimeline(rec, 'leg.provider_status', { index: i, adapterId: leg.adapterId, status: ps })
  const prevOutput = leg.step?.output
  leg.step = wrapped
  // Check again when the amount or the asset changes (the same amount in another asset is not the quote).
  if (wrapped.output && JSON.stringify(wrapped.output) !== JSON.stringify(prevOutput)) checkOutput(rt, rec, i, wrapped.output)
  if (wrapped.ref && wrapped.ref !== leg.ref) {
    leg.ref = wrapped.ref
    await rt.store.kv.put(`ref:${leg.adapterId}:${wrapped.ref}`, rec.id, REF_INDEX_TTL_SEC)
  }
  // A refund or a chargeback after success. This also applies to a session that an operator closed:
  // the app must learn that the money went back.
  if (!rec.reversal && isReversal(before, wrapped.status)) {
    await reverse(rt, rec, i, wrapped.status === 'refunded' ? 'refunded' : 'reversed')
    return
  }
  // An operator closed this session (`admin.resolve`). Keep the leg data for the record, but do not
  // send from the treasury, start the next leg, notify or change the session state.
  if (rec.resolution) return
  // The session was canceled. Keep the leg data, and move no funds. A payment that arrives after all
  // is a late payment: the app refunds or credits it by hand.
  if (rec.step.state === 'CANCELED') {
    if (wrapped.status === 'succeeded' && before !== 'succeeded') {
      rt.log.warn('a payment arrived after the session was canceled; the session stays CANCELED', { sessionId: rec.id, adapterId: leg.adapterId, ref: leg.ref })
      const scope = act.n ? `a${act.n}` : undefined
      await notify(rt, rec, 'session.late_payment', { reason: 'after_cancel', index: i, adapterId: leg.adapterId, legId: leg.legId, ...txExtra(act, i) }, scope)
    }
    return
  }
  // The session is REVERSED, and that is final. Keep the leg data, but move no more funds: no
  // treasury send, no next leg, no leg events, no other session state.
  if (rec.reversal) {
    rec.step = composeStep(rt, rec)
    return
  }
  // The session EXPIRED. Only money that arrives on the leg that was waiting at expiry, inside the
  // grace window (`latePayments`), moves it on. Anything else changes the leg data only.
  if (wasExpired && (i !== act.index || !inLateGrace(rt, rec) || (wrapped.status !== 'processing' && wrapped.status !== 'succeeded'))) {
    if (wrapped.status === 'succeeded' && before !== 'succeeded') {
      rt.log.warn('a payment arrived after the grace window of an expired session; the session stays EXPIRED', { sessionId: rec.id, adapterId: leg.adapterId, ref: leg.ref })
      const scope = act.n ? `a${act.n}` : undefined
      await notify(rt, rec, 'session.late_payment', { reason: 'after_grace', index: i, adapterId: leg.adapterId, legId: leg.legId, ...txExtra(act, i) }, scope)
    }
    return
  }
  const sent = await treasuryStep(rt, rec, i, wrapped)
  if (sent) return setLegStep(rt, rec, i, sent)
  // Leg events of a later attempt get their own key (and so their own event id).
  const scope = act.n ? `a${act.n}` : undefined
  if (wrapped.status === 'succeeded') await notify(rt, rec, 'leg.succeeded', { index: i, adapterId: leg.adapterId, legId: leg.legId }, scope)
  // The session expired while the user still had to pay, and the payment arrived after all (a
  // webhook, or the grace poll of the sweep). The session goes on and can complete.
  if (wasExpired && wrapped.status === 'succeeded') {
    rt.log.warn('a payment arrived after the session expired; the session goes on', { sessionId: rec.id, adapterId: leg.adapterId, ref: leg.ref })
    await notify(rt, rec, 'session.late_payment', { reason: 'after_expiry', index: i, adapterId: leg.adapterId, legId: leg.legId, ...txExtra(act, i) }, scope)
  }
  if (wrapped.status === 'failed') await notify(rt, rec, 'leg.failed', { index: i, adapterId: leg.adapterId, legId: leg.legId, ...(wrapped.error ? { error: wrapped.error } : {}) }, scope)
  if (wrapped.status === 'succeeded' && i === act.index && i < act.legs.length - 1 && !deliveredWrongAsset(leg)) {
    act.index = i + 1
    await startLeg(rt, rec, act.index)
    return
  }
  rec.step = composeStep(rt, rec)
  await settleStatus(rt, rec)
}

export async function startLeg(rt: Runtime, rec: SessionRecord, i: number): Promise<void> {
  // A reversed session moves no more funds.
  if (rec.reversal) return
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
  if (n >= maxAttempts(rt)) {
    throw new OpenRampException(openRampError('BAD_REQUEST', { message: 'This session has no payment attempts left. Start a new session.' }), 409)
  }
  const lastError = rec.lastError
  delete rec.lastError
  archiveActive(rec)
  rec.active = {
    n,
    quoteId,
    pathway: stored.pathway,
    index: 0,
    ...(rec.destination ? { destination: rec.destination } : {}),
    legs: stored.pathway.legs.map(
      (l, i): ActiveLeg => ({
        adapterId: l.adapterId,
        legId: l.legId,
        provider: rt.adapters.get(l.adapterId)?.name ?? l.adapterId,
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
    rt.metric('start.error', 1, { adapter, code: e instanceof OpenRampException ? e.error.code : 'INTERNAL' })
    addTimeline(rec, 'payment.start_failed', { attempt: n, adapterId: adapter })
    rec.active = before.active
    if (before.attempts) rec.attempts = before.attempts
    else delete rec.attempts
    if (lastError) rec.lastError = lastError
    throw e
  }
}

/** Ask the active leg's adapter for status (rate-limited). Returns true when the session changed. */
export async function refreshActive(rt: Runtime, rec: SessionRecord, force = false, opts: { late?: boolean } = {}): Promise<boolean> {
  const act = rec.active
  // `late`: the sweep polls an EXPIRED or CANCELED session in its grace window (`latePayments`).
  const lateState = rec.step.state === 'EXPIRED' || rec.step.state === 'CANCELED'
  if (!act || (isTerminal(rec.step.state) && !(opts.late && lateState && !rec.resolution && !rec.reversal && inLateGrace(rt, rec)))) return false
  const leg = act.legs[act.index]!
  if (!leg.ref || !leg.step || isLegTerminal(leg.step.status)) return false
  const a = rt.adapter(leg.adapterId)
  if (!a.status) return false
  if (!force && leg.lastCheckedAt && Date.now() - leg.lastCheckedAt < STATUS_CHECK_MIN_INTERVAL_MS) return false
  leg.lastCheckedAt = Date.now()
  let ls: LegStep
  try {
    ls = await a.status({ leg: act.pathway.legs[act.index]!, ref: leg.ref }, adapterContext(rt, rec, a, act.pathway, act.index))
  } catch (e) {
    rt.log.warn('status check failed', { adapter: a.id, error: String(e) })
    return false
  }
  // Nothing new: the same step after the merge (status, phase, action, detail, refs, output, transactions).
  if (sameLegStep(rt, rec, mergeLegStep(leg.step, sanitizeLegStep(rt, leg.adapterId, ls)), leg.step)) return false
  if (!adapterMoveAllowed(leg.step, ls)) {
    rt.log.warn('status check would move the leg back; ignored', { sessionId: rec.id, adapter: a.id, from: leg.step.status, to: ls.status })
    rt.metric('event.out_of_order', 1, { adapter: a.id })
    return false
  }
  // Not inside the catch: when this fails half way (for example the next leg cannot start), the error
  // goes to the caller, so the half-changed record is never saved.
  await setLegStep(rt, rec, act.index, ls)
  return true
}

/** The leg step that a provider event carries (a `LegEvent` is a `LegStep` with a `ref` and an `eventId`) */
export function eventStep(ev: LegEvent): LegStep {
  const { eventId: _id, ...step } = ev
  return step
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

/** Leg statuses that can make an earlier attempt the payment again: money is under way or arrived */
const REVIVES: LegStatus[] = ['processing', 'succeeded']

/**
 * A status for a leg of an earlier attempt (one the user left with `restart`). When money is under way
 * or arrived on it and the session has no other payment under way, that attempt becomes the active
 * payment again, so the session completes. A refund before success only updates the attempt. When
 * the session already completed or another payment is under way, or the attempt paid to another
 * withdraw target than the current one, a succeeded leg sends `session.late_payment` instead, so the
 * app can refund or credit by hand.
 */
async function applyToAttempt(rt: Runtime, rec: SessionRecord, k: number, i: number, ls: LegStep): Promise<void> {
  const att = rec.attempts![k]!
  const leg = att.legs[i]!
  const before = leg.step?.status
  if (before !== ls.status) addTimeline(rec, `attempt.leg.${ls.status}`, { attempt: att.n ?? 0, index: i, adapterId: leg.adapterId })
  const prev = leg.step
  leg.step = mergeLegStep(prev, sanitizeLegStep(rt, leg.adapterId, ls))
  if (isReversal(before, ls.status)) {
    // The session moved on from this attempt, so its state stays. The app may have credited this
    // payment by hand (`session.late_payment`), so it gets `session.reversed` with `attempt`.
    rt.log.warn('the provider took back a payment of an earlier attempt', { sessionId: rec.id, adapterId: leg.adapterId, ref: leg.ref, status: ls.status })
    rt.metric('payment.reversed', 1, { adapter: leg.adapterId, status: ls.status })
    const extra = { attempt: att.n ?? 0, index: i, adapterId: leg.adapterId, legId: leg.legId, legStatus: ls.status, previous: rec.step.state }
    await notify(rt, rec, 'session.reversed', extra)
    return
  }
  if (!REVIVES.includes(ls.status)) return
  const underway = rec.active?.legs.some((l) => l.step && MONEY_MOVED.includes(l.step.status))
  // The user picked another withdraw target after the restart: the session must not complete with a
  // destination that this payment did not pay to.
  const otherTarget = !!att.destination && JSON.stringify(att.destination) !== JSON.stringify(rec.destination)
  // A final session (succeeded, failed, canceled, expired, refunded or reversed): an earlier attempt
  // never becomes its payment again. `session.failed` and `session.canceled` are never followed by success.
  if (isFinalStatus(rec.status) || rec.step.state === 'COMPLETED' || rec.step.state === 'EXPIRED' || rec.reversal || underway || rec.resolution || otherTarget) {
    rt.log.warn('payment on an earlier attempt after the session moved on', { sessionId: rec.id, adapterId: leg.adapterId, ref: leg.ref, status: ls.status })
    if (ls.status === 'succeeded') {
      await notify(rt, rec, 'session.late_payment', { reason: 'earlier_attempt', attempt: att.n ?? 0, index: i, adapterId: leg.adapterId, legId: leg.legId, ...txExtra(att, i) })
    }
    return
  }
  rt.log.info('an earlier attempt was paid; it is the active payment again', { sessionId: rec.id, adapterId: leg.adapterId, ref: leg.ref })
  rec.attempts!.splice(k, 1)
  archiveActive(rec)
  const { endedAt: _ended, ...payment } = att
  rec.active = { ...payment, index: i }
  // `setLegStep` records the new step itself, from the step before it: the output check, the ref index
  // and the timeline.
  if (prev) leg.step = prev
  else delete leg.step
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
      let ls: LegStep
      try {
        ls = await a.status({ leg: att.pathway.legs[i]!, ref: leg.ref }, adapterContext(rt, rec, a, att.pathway, i))
      } catch (e) {
        rt.log.warn('status check failed', { adapter: a.id, error: String(e) })
        continue
      }
      // Forward only, like a provider event (see `isLegalLegMove`).
      if (ls.status === leg.step.status || !isLegalLegMove(leg.step.status, ls.status)) continue
      // Not inside the catch: when this fails half way (for example the attempt became the payment
      // again and its next leg cannot start), the error goes to the caller and nothing is saved.
      await applyToAttempt(rt, rec, k, i, { ...ls, ref: ls.ref ?? leg.ref })
      return true
    }
  }
  return false
}

/**
 * The one move back that a provider event may make: from `processing` to `requires_action` with a new
 * surface. Only when the leg's spec opts in (capability `surface_after_processing`), the surface kind
 * is one the spec declares, the leg has no transaction yet, and the leg did not move back before.
 * For example, an offramp learns its deposit address from a webhook and now needs a WALLET_TX.
 */
export function surfaceMoveBack(rt: Runtime, leg: ActiveLeg, cur: LegStep, ev: LegEvent): boolean {
  const surface = ev.action?.surface
  if (cur.status !== 'processing' || ev.status !== 'requires_action' || !surface || hasFundsTransaction(cur) || leg.surfaceReopened) return false
  // Fail closed: a leg with no static spec (for example from a live catalog only) does not opt in.
  const spec = rt.adapters.get(leg.adapterId)?.legs.find((l) => l.id === leg.legId)
  return !!spec?.capabilities?.includes('surface_after_processing') && spec.surfaces.includes(surface.kind)
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
    const leg = found.act.legs[found.i]!
    const cur = leg.step
    const back = !!cur && surfaceMoveBack(rt, leg, cur, ev)
    // The same rule as a status poll (`adapterMoveAllowed`): forward only, or a review step (phase kyc
    // or auth, no transaction) that ends with a step for the user.
    if (cur && !back && !adapterMoveAllowed(cur, ev)) {
      // A repeat of a final status is normal (providers send events more than once). A move back is not.
      if (cur.status !== ev.status) {
        rt.log.warn('provider event would move the leg back; ignored', { adapterId, ref: ev.ref, sessionId: sid, from: cur.status, to: ev.status })
        rt.metric('event.out_of_order', 1, { adapter: adapterId })
      }
      return 'ignored'
    }
    if (back) {
      leg.surfaceReopened = true
      addTimeline(rec, 'leg.surface_after_processing', { index: found.i, adapterId, surface: ev.action!.surface!.kind })
    }
    try {
      const ls = eventStep(ev)
      if (found.k === -1) await setLegStep(rt, rec, found.i, ls)
      else await applyToAttempt(rt, rec, found.k, found.i, ls)
      if (seen) rec.providerEvents = [...(rec.providerEvents ?? []), seen].slice(-MAX_PROVIDER_EVENTS)
      await saveSession(rt, rec)
      // A session that became active again (or was dropped from the list) must be polled by the sweep.
      if (!isFinalStatus(rec.status)) await trackOpenSession(rt, rec.id)
      return 'applied'
    } catch (e) {
      if (e instanceof OpenRampException && e.status === 409) continue
      throw e
    }
  }
  rt.log.warn('event not applied: the session kept changing; the provider should send it again', { adapterId, ref: ev.ref })
  return 'conflict'
}

/**
 * True when money of the active payment may have moved or be on its way: a leg after the first
 * started, a leg went past `requires_action` (processing, succeeded, ...), a transaction that moves
 * funds was submitted (any role but `approval`), or the treasury sent. A leg that a provider event moved from
 * `processing` back to `requires_action` (`surface_after_processing`) has no transaction by rule, so it
 * counts as not moved. Cancel and restart refuse such a payment, so they never strand funds.
 */
export function moneyMayHaveMoved(act: ActivePayment): boolean {
  if (act.index > 0) return true
  return act.legs.some(
    (l) =>
      !!l.treasurySent?.length ||
      hasFundsTransaction(l.step) ||
      (l.step !== undefined && l.step.status !== 'pending' && l.step.status !== 'requires_action'),
  )
}

/** The `transactions` field of a late payment event: the public transactions of leg `i` */
function txExtra(p: ActivePayment, i: number): { transactions?: Transaction[] } {
  const transactions = legTransactions(p, i)
  return transactions.length ? { transactions } : {}
}
