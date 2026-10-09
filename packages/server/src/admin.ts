// Admin tools for operators: a time index of sessions, list and lookup, stats, forced final states with
// an audit note, and webhook replay. `openramp.admin.*` calls these directly; the HTTP routes under
// `{baseUrl}/admin/*` need `admin.token`.
//
// The time index: stores have no queries, so each new session id goes on a day queue
// (`admin-index:YYYY-MM-DD`, UTC) with its creation time as the due time. A queue push is atomic in
// every built-in store, so sessions made at the same time are never lost. Nothing claims these queues;
// `StoreQueue.range` reads them, latest first. The sweep removes days older than `admin.indexDays`.

import { add, isTerminal, OpenRampException, openRampError } from '@openrampkit/core'
import type { Amount, AmountMismatch, Direction, Fee, OpenRampError, StateName } from '@openrampkit/core'
import { safeEqual, sha256Hex } from './crypto.js'
import { json, readJson } from './http.js'
import { sessionStatusFor } from './legs.js'
import { notify } from './notify.js'
import { replayDeadLetters, saveSession } from './outbox.js'
import { adminPage } from './admin-page.js'
import { claimToken, OPEN_QUEUE, OUTBOX_QUEUE, queueOf } from './queue.js'
import type { Runtime } from './runtime.js'
import type { ActivePayment, OutboxEvent, PaymentAttempt, QueueItem, Resolution, Reversal, SessionRecord, TimelineEntry } from './store.js'
import { addTimeline } from './timeline.js'

const DAY_MS = 24 * 60 * 60_000
const INDEX_PREFIX = 'admin-index:'
const INDEX_PRUNED_KEY = 'admin:index-pruned'
/** Entries read from the index per call */
const RANGE_BATCH = 100
/** Most sessions one `list` or `findByTx` call loads. Ask again with the cursor for more. */
export const MAX_SCAN = 1000
/** Most sessions one `stats` call loads. `truncated` is true when there were more. */
export const MAX_STATS_SCAN = 2000
/** Sessions loaded from the store at the same time */
const LOAD_CONCURRENCY = 20
const MAX_NOTE = 500
const FINAL_STATES = ['COMPLETED', 'FAILED', 'REFUNDED', 'EXPIRED'] as const
type FinalState = (typeof FINAL_STATES)[number]

const bad = (message: string) => new OpenRampException(openRampError('BAD_REQUEST', { message }), 400)
const notFound = () => new OpenRampException(openRampError('NOT_FOUND'), 404)

const dayOf = (ms: number) => Math.floor(ms / DAY_MS)
const indexName = (day: number) => `${INDEX_PREFIX}${new Date(day * DAY_MS).toISOString().slice(0, 10)}`
const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString())
const indexDays = (rt: Runtime) => Math.max(1, Math.floor(rt.config.admin?.indexDays ?? 8))
const stuckAfterMs = (rt: Runtime) => Math.max(1, rt.config.admin?.stuckAfterMinutes ?? 60) * 60_000

/** Add a new session to the time index. Only when `config.admin` is set. */
export async function indexSession(rt: Runtime, id: string, createdAt: number): Promise<void> {
  if (!rt.config.admin) return
  await queueOf(rt.store).push(indexName(dayOf(createdAt)), id, createdAt)
}

/**
 * Remove index days older than `admin.indexDays` (sweep only). It claims and acks the entries of the
 * old days in order, with at most 2000 entries and 40 days per run, and remembers the last empty day.
 * The first run starts 30 days before the cutoff.
 */
export async function pruneIndex(rt: Runtime): Promise<void> {
  if (!rt.config.admin) return
  const q = queueOf(rt.store)
  const cutoff = dayOf(Date.now()) - indexDays(rt)
  const done = (await rt.store.kv.get<number>(INDEX_PRUNED_KEY)) ?? cutoff - 31
  let removed = 0
  for (let day = done + 1, n = 0; day < cutoff && n < 40; day++, n++) {
    const token = claimToken()
    for (;;) {
      const ids = await q.claim(indexName(day), { now: Number.MAX_SAFE_INTEGER, limit: 500, leaseMs: 0, token })
      for (const id of ids) await q.ack(indexName(day), id, token)
      removed += ids.length
      if (ids.length < 500 || removed >= 2000) break
    }
    // Not empty yet: the next run goes on with this day.
    if (removed >= 2000) return
    await rt.store.kv.put(INDEX_PRUNED_KEY, day)
  }
}

type Cursor = { d: number; t: number; id: string }

function encodeCursor(c: Cursor): string {
  return `${c.d}.${c.t}.${c.id}`
}

function decodeCursor(s: string | undefined): Cursor | undefined {
  if (!s) return undefined
  const m = /^(\d{1,8})\.(\d{1,16})\.([\w-]{1,64})$/.exec(s)
  if (!m) throw bad('`cursor` is not valid.')
  return { d: Number(m[1]), t: Number(m[2]), id: m[3]! }
}

/** Index entries from `newest` back to `oldest` (creation times in ms), latest first, after `after`. */
async function* indexEntries(rt: Runtime, newest: number, oldest: number, after?: Cursor): AsyncGenerator<{ d: number; e: QueueItem }> {
  const q = queueOf(rt.store)
  if (!q.range) {
    throw new OpenRampException(openRampError('INTERNAL', { message: 'The store queue has no `range`. The admin index needs it (see Session stores).' }), 501)
  }
  for (let d = after ? Math.min(after.d, dayOf(newest)) : dayOf(newest); d >= dayOf(oldest); d--) {
    let last: Cursor | undefined = after && d === after.d ? after : undefined
    let max = last ? Math.min(last.t, newest) : newest
    for (;;) {
      const batch = await q.range(indexName(d), { max, limit: RANGE_BATCH })
      let fresh = 0
      for (const e of batch) {
        // Entries at the same time as the last one come in id order from high to low.
        if (last && e.dueAt === last.t && e.id >= last.id) continue
        if (e.dueAt < oldest) return
        fresh++
        last = { d, t: e.dueAt, id: e.id }
        yield { d, e }
      }
      // A short batch is the end of the day. A full batch with nothing new would loop: more than
      // RANGE_BATCH sessions in the same millisecond. Move on to the next day.
      if (batch.length < RANGE_BATCH || !fresh || !last) break
      max = last.t
    }
  }
}

/** Load the sessions of index entries, a few at a time, in order. Stops when `visit` returns false. */
async function visitSessions(
  rt: Runtime,
  entries: AsyncGenerator<{ d: number; e: QueueItem }>,
  max: number,
  visit: (rec: SessionRecord, at: Cursor) => boolean | void,
): Promise<{ last?: Cursor; scanned: number; done: boolean }> {
  let scanned = 0
  let last: Cursor | undefined
  for (;;) {
    const chunk: Array<{ d: number; e: QueueItem }> = []
    while (chunk.length < LOAD_CONCURRENCY && scanned + chunk.length < max) {
      const n = await entries.next()
      if (n.done) break
      chunk.push(n.value)
    }
    if (!chunk.length) return { ...(last ? { last } : {}), scanned, done: scanned < max }
    const recs = await Promise.all(chunk.map(({ e }) => rt.store.get(e.id)))
    for (let i = 0; i < chunk.length; i++) {
      const { d, e } = chunk[i]!
      scanned++
      last = { d, t: e.dueAt, id: e.id }
      const rec = recs[i]
      // A session past the store TTL is gone; its index entry stays until the day is pruned.
      if (rec && visit(rec, last) === false) return { last, scanned, done: false }
    }
    if (scanned >= max) return { ...(last ? { last } : {}), scanned, done: false }
  }
}

// ---------- Views ----------

export type AdminSessionSummary = {
  id: string
  direction: Direction
  status: SessionRecord['status']
  /** The step state, e.g. PAYMENT or COMPLETED */
  state: StateName
  amount?: string
  currency?: string
  method?: string
  provider?: string
  userId: string
  livemode: boolean
  createdAt: string
  updatedAt: string
  ageMs: number
  /** Not final after `admin.stuckAfterMinutes` */
  stuck: boolean
  deadLetters: number
  resolved: boolean
}

export type AdminLeg = {
  adapterId: string
  legId: string
  ref?: string
  status: string
  state?: StateName
  txHash?: string
  error?: Pick<OpenRampError, 'code' | 'message'>
  input: Amount
  output: Amount
  outputConfirmed: boolean
  /** The reported output is short of the quote beyond the tolerance, or not comparable with it */
  amountMismatch?: Omit<AmountMismatch, 'legIndex'>
  fees: Fee[]
  started: boolean
  lastCheckedAt?: string
}

export type AdminPayment = {
  attempt: number
  method: string
  provider: string
  pathwayId: string
  legIndex: number
  endedAt?: string
  legs: AdminLeg[]
}

export type AdminOutboxEvent = { id: string; type: string; attempts: number; firstAt: string; nextAt: string; deadAt?: string; dead: boolean }

export type AdminSession = AdminSessionSummary & {
  email?: string
  country?: string
  region?: string
  locale?: string
  metadata: Record<string, string>
  expiresAt: string
  destination?: SessionRecord['destination']
  source?: SessionRecord['source']
  allowedTargets?: SessionRecord['allowedTargets']
  targetLocked: boolean
  amountBounds?: SessionRecord['amountBounds']
  allowedMethods?: string[]
  revokedPayLinks: number
  step: { state: StateName; sub?: string; legIndex?: number; error?: Pick<OpenRampError, 'code' | 'message'> }
  payment?: AdminPayment
  attempts: AdminPayment[]
  outbox: AdminOutboxEvent[]
  providerRefs: Array<{ adapterId: string; ref: string; attempt: number; active: boolean }>
  txHashes: string[]
  /** The transactions that paid into the legs (`LegStep.sourceTxHash`), for example the user's origin chain transaction */
  sourceTxHashes: string[]
  timeline: Array<Omit<TimelineEntry, 'at'> & { at: string }>
  resolution?: Omit<Resolution, 'at'> & { at: string }
  /** Set when the provider refunded or reversed a leg after it succeeded */
  reversal?: Omit<Reversal, 'at'> & { at: string }
}

function currencyOf(a: Amount): string {
  return a.asset.kind === 'fiat' ? a.asset.currency : (a.asset.symbol ?? `${a.asset.chain}/${a.asset.token}`)
}

const isPositive = (v: string) => /^\d*\.?\d+$/.test(v) && /[1-9]/.test(v)

/**
 * The amount to show for a session: what the user pays in, from the first leg's quote. Some flows
 * have no amount up front (for example a transfer from an exchange quotes 0), so then the amount
 * that arrived is used: the last leg's confirmed output, else its quoted output.
 */
export function amountOf(rec: SessionRecord): Amount | undefined {
  const legs = rec.active?.legs ?? []
  const input = legs[0]?.quote.input
  if (input && isPositive(input.value)) return input
  const last = legs[legs.length - 1]
  const out = last?.step?.output ?? last?.quote.output
  if (out && isPositive(out.value)) return out
  return input
}

function summarize(rt: Runtime, rec: SessionRecord, now: number): AdminSessionSummary {
  const act = rec.active
  const input = amountOf(rec)
  return {
    id: rec.id,
    direction: rec.direction,
    status: rec.status,
    state: rec.step.state,
    ...(input ? { amount: input.value, currency: currencyOf(input) } : {}),
    ...(act ? { method: act.pathway.method, provider: act.pathway.provider } : {}),
    userId: rec.userId,
    livemode: rec.livemode,
    createdAt: iso(rec.createdAt)!,
    updatedAt: iso(rec.updatedAt ?? rec.createdAt)!,
    ageMs: now - rec.createdAt,
    stuck: isStuck(rt, rec, now),
    deadLetters: (rec.outbox ?? []).filter((e) => e.deadAt !== undefined).length,
    resolved: !!rec.resolution,
  }
}

function isStuck(rt: Runtime, rec: SessionRecord, now: number): boolean {
  return !isTerminal(rec.step.state) && now - rec.createdAt > stuckAfterMs(rt)
}

const errorView = (e?: OpenRampError) => (e ? { code: e.code, message: e.message } : undefined)

function paymentView(p: ActivePayment | PaymentAttempt): AdminPayment {
  return {
    attempt: p.n ?? 0,
    method: p.pathway.method,
    provider: p.pathway.provider,
    pathwayId: p.pathway.id,
    legIndex: p.index,
    ...('endedAt' in p ? { endedAt: iso(p.endedAt)! } : {}),
    legs: p.legs.map((l) => {
      const error = errorView(l.step?.error)
      return {
        adapterId: l.adapterId,
        legId: l.legId,
        ...(l.ref ? { ref: l.ref } : {}),
        status: l.step?.status ?? 'pending',
        ...(l.step ? { state: l.step.state } : {}),
        ...(l.step?.txHash ? { txHash: l.step.txHash } : {}),
        ...(error ? { error } : {}),
        input: l.quote.input,
        output: l.step?.output ?? l.quote.output,
        outputConfirmed: !!l.step?.output,
        ...(l.amountMismatch ? { amountMismatch: l.amountMismatch } : {}),
        fees: l.quote.fees,
        started: l.started,
        ...(l.lastCheckedAt ? { lastCheckedAt: iso(l.lastCheckedAt)! } : {}),
      }
    }),
  }
}

function outboxView(e: OutboxEvent): AdminOutboxEvent {
  return { id: e.id, type: e.type, attempts: e.attempts, firstAt: iso(e.firstAt)!, nextAt: iso(e.nextAt)!, ...(e.deadAt !== undefined ? { deadAt: iso(e.deadAt)! } : {}), dead: e.deadAt !== undefined }
}

/** The operator view of a session. It leaves out the secret hash, start URLs, stored quotes and the IP. */
export function adminView(rt: Runtime, rec: SessionRecord, now = Date.now()): AdminSession {
  const payments = [...(rec.attempts ?? []).map((p) => ({ p, active: false })), ...(rec.active ? [{ p: rec.active as ActivePayment, active: true }] : [])]
  const stepError = errorView(rec.step.error)
  return {
    ...summarize(rt, rec, now),
    ...(rec.email ? { email: rec.email } : {}),
    ...(rec.country ? { country: rec.country } : {}),
    ...(rec.region ? { region: rec.region } : {}),
    ...(rec.locale ? { locale: rec.locale } : {}),
    metadata: rec.metadata ?? {},
    expiresAt: iso(rec.expiresAt)!,
    ...(rec.destination ? { destination: rec.destination } : {}),
    ...(rec.source ? { source: rec.source } : {}),
    ...(rec.allowedTargets ? { allowedTargets: rec.allowedTargets } : {}),
    targetLocked: !!rec.targetLocked,
    ...(rec.amountBounds ? { amountBounds: rec.amountBounds } : {}),
    ...(rec.allowedMethods ? { allowedMethods: rec.allowedMethods } : {}),
    revokedPayLinks: rec.revokedPayLinks?.length ?? 0,
    step: {
      state: rec.step.state,
      ...(rec.step.sub ? { sub: rec.step.sub } : {}),
      ...(rec.step.legIndex !== undefined ? { legIndex: rec.step.legIndex } : {}),
      ...(stepError ? { error: stepError } : {}),
    },
    ...(rec.active ? { payment: paymentView(rec.active) } : {}),
    attempts: (rec.attempts ?? []).map(paymentView),
    outbox: (rec.outbox ?? []).map(outboxView),
    providerRefs: payments.flatMap(({ p, active }) => p.legs.filter((l) => l.ref).map((l) => ({ adapterId: l.adapterId, ref: l.ref!, attempt: p.n ?? 0, active }))),
    txHashes: payments.flatMap(({ p }) => p.legs.map((l) => l.step?.txHash).filter((h): h is string => !!h)),
    sourceTxHashes: payments.flatMap(({ p }) => p.legs.map((l) => l.step?.sourceTxHash).filter((h): h is string => !!h)),
    timeline: (rec.timeline ?? []).map((t) => ({ ...t, at: iso(t.at)! })),
    ...(rec.resolution ? { resolution: { ...rec.resolution, at: iso(rec.resolution.at)! } } : {}),
    ...(rec.reversal ? { reversal: { ...rec.reversal, at: iso(rec.reversal.at)! } } : {}),
  }
}

// ---------- Operations ----------

export type AdminListOptions = {
  direction?: Direction
  /** A session status (`open`, `awaiting_user`, `processing`, `completed`, `failed`, `expired`, `refunded`, `reversed`) or a step state (`PAYMENT`, ...) */
  state?: string
  /** Only sessions created at least this many minutes ago */
  olderThan?: number
  /** Only sessions that are not final after `admin.stuckAfterMinutes` */
  stuck?: boolean
  /** 1 to 200, default 50 */
  limit?: number
  /** `nextCursor` of the previous page */
  cursor?: string
}

export type AdminListResult = { sessions: AdminSessionSummary[]; nextCursor?: string; scanned: number }

/** Recent sessions from the time index, newest first. */
export async function adminList(rt: Runtime, opts: AdminListOptions = {}): Promise<AdminListResult> {
  if (opts.direction !== undefined && opts.direction !== 'deposit' && opts.direction !== 'withdraw') throw bad('`direction` must be "deposit" or "withdraw".')
  if (opts.olderThan !== undefined && !(Number.isFinite(opts.olderThan) && opts.olderThan >= 0)) throw bad('`olderThan` must be a number of minutes.')
  const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)))
  const now = Date.now()
  const newest = now - (opts.olderThan ?? 0) * 60_000
  const oldest = now - indexDays(rt) * DAY_MS
  const sessions: AdminSessionSummary[] = []
  const r = await visitSessions(rt, indexEntries(rt, newest, oldest, decodeCursor(opts.cursor)), MAX_SCAN, (rec) => {
    if (opts.direction && rec.direction !== opts.direction) return
    if (opts.state && rec.status !== opts.state && rec.step.state !== opts.state) return
    if (opts.stuck && !isStuck(rt, rec, now)) return
    sessions.push(summarize(rt, rec, now))
    return sessions.length < limit
  })
  return { sessions, ...(!r.done && r.last ? { nextCursor: encodeCursor(r.last) } : {}), scanned: r.scanned }
}

export async function adminGet(rt: Runtime, id: string): Promise<AdminSession | null> {
  const rec = typeof id === 'string' && id ? await rt.store.get(id) : null
  // The store also holds queue records (`__queue:*`): they are not sessions.
  return rec && typeof rec.secretHash === 'string' ? adminView(rt, rec) : null
}

/** The session that owns a provider reference, from the reference index (kept 30 days). */
export async function adminFindByRef(rt: Runtime, provider: string, ref: string): Promise<AdminSession | null> {
  if (!provider || !ref) throw bad('`provider` and `ref` are required.')
  const id = await rt.store.kv.get<string>(`ref:${provider}:${ref}`)
  return id ? adminGet(rt, id) : null
}

/**
 * Sessions with a leg transaction `txHash` or source transaction `sourceTxHash`. No store index has transaction hashes, so this reads the
 * time index (at most `MAX_SCAN` sessions of the last `admin.indexDays` days). `chain` (CAIP-2) is
 * optional; when set, the leg's input or output must be on that chain.
 */
export async function adminFindByTx(rt: Runtime, chain: string | undefined, txHash: string): Promise<AdminSessionSummary[]> {
  if (!txHash) throw bad('`tx` is required.')
  const want = txHash.toLowerCase()
  const now = Date.now()
  const out: AdminSessionSummary[] = []
  await visitSessions(rt, indexEntries(rt, now, now - indexDays(rt) * DAY_MS), MAX_SCAN, (rec) => {
    const legs = [...(rec.attempts ?? []), ...(rec.active ? [rec.active] : [])].flatMap((p) => p.legs)
    const hit = legs.some((l) => {
      if (l.step?.txHash?.toLowerCase() !== want && l.step?.sourceTxHash?.toLowerCase() !== want) return false
      if (!chain) return true
      return [l.quote.input.asset, l.quote.output.asset].some((a) => a.kind === 'crypto' && a.chain === chain)
    })
    if (hit) out.push(summarize(rt, rec, now))
  })
  return out
}

export type AdminStats = {
  since: string
  until: string
  /** Sessions read from the index */
  scanned: number
  /** True when there were more than `MAX_STATS_SCAN` sessions: the counts cover the newest ones only */
  truncated: boolean
  total: number
  byStatus: Record<string, number>
  byState: Record<string, number>
  byDirection: Record<Direction, { total: number; byStatus: Record<string, number> }>
  /** What users paid in completed sessions, per direction and currency */
  completedVolume: Array<{ direction: Direction; currency: string; amount: string; count: number }>
  stuck: { count: number; afterMinutes: number; oldest?: { id: string; ageMs: number } }
  /** `queued`: sessions on the outbox queue now (all time). The rest count events of the scanned sessions. */
  outbox: { queued: number; pendingEvents: number; deadLetters: number; sessionsWithDeadLetters: number }
  /** Webhook events of the scanned sessions with at least one failed delivery (retrying or dead) */
  webhookFailures: number
  /** Sessions on the open-session list now (all time) */
  openQueue: number
  resolved: number
}

/** Counts for the sessions created since `since` (default: the last 24 hours). */
export async function adminStats(rt: Runtime, opts: { since?: number | string | Date } = {}): Promise<AdminStats> {
  const now = Date.now()
  const since = opts.since === undefined ? now - DAY_MS : new Date(opts.since).getTime()
  if (!Number.isFinite(since)) throw bad('`since` must be a time (ISO 8601 or ms).')
  const from = Math.max(since, now - indexDays(rt) * DAY_MS)
  const stats: AdminStats = {
    since: iso(from)!,
    until: iso(now)!,
    scanned: 0,
    truncated: false,
    total: 0,
    byStatus: {},
    byState: {},
    byDirection: { deposit: { total: 0, byStatus: {} }, withdraw: { total: 0, byStatus: {} } },
    completedVolume: [],
    stuck: { count: 0, afterMinutes: stuckAfterMs(rt) / 60_000 },
    outbox: { queued: 0, pendingEvents: 0, deadLetters: 0, sessionsWithDeadLetters: 0 },
    webhookFailures: 0,
    openQueue: 0,
    resolved: 0,
  }
  const inc = (m: Record<string, number>, k: string) => void (m[k] = (m[k] ?? 0) + 1)
  const volume = new Map<string, { direction: Direction; currency: string; amount: string; count: number }>()
  const r = await visitSessions(rt, indexEntries(rt, now, from), MAX_STATS_SCAN, (rec) => {
    stats.total++
    inc(stats.byStatus, rec.status)
    inc(stats.byState, rec.step.state)
    const dir = stats.byDirection[rec.direction]
    dir.total++
    inc(dir.byStatus, rec.status)
    if (rec.resolution) stats.resolved++
    const input = amountOf(rec)
    if (rec.status === 'completed' && input) {
      const currency = currencyOf(input)
      const key = `${rec.direction}|${currency}`
      const v = volume.get(key) ?? { direction: rec.direction, currency, amount: '0', count: 0 }
      try {
        v.amount = add(v.amount, input.value)
        v.count++
      } catch {
        // An amount that is not a decimal string is left out.
      }
      volume.set(key, v)
    }
    if (isStuck(rt, rec, now)) {
      stats.stuck.count++
      const age = now - rec.createdAt
      if (!stats.stuck.oldest || age > stats.stuck.oldest.ageMs) stats.stuck.oldest = { id: rec.id, ageMs: age }
    }
    const events = rec.outbox ?? []
    const dead = events.filter((e) => e.deadAt !== undefined).length
    stats.outbox.deadLetters += dead
    stats.outbox.pendingEvents += events.length - dead
    if (dead) stats.outbox.sessionsWithDeadLetters++
    stats.webhookFailures += events.filter((e) => e.attempts > 0).length
  })
  stats.scanned = r.scanned
  stats.truncated = !r.done
  stats.completedVolume = [...volume.values()].sort((a, b) => b.count - a.count)
  const q = queueOf(rt.store)
  ;[stats.outbox.queued, stats.openQueue] = await Promise.all([q.size(OUTBOX_QUEUE), q.size(OPEN_QUEUE)])
  rt.metric('sessions.stuck', stats.stuck.count, {})
  return stats
}

function finalState(v: unknown): FinalState {
  const s = typeof v === 'string' ? v.toUpperCase() : ''
  if (!(FINAL_STATES as readonly string[]).includes(s)) throw bad('`state` must be COMPLETED, FAILED, REFUNDED or EXPIRED.')
  return s as FinalState
}

/**
 * Force a final state, with an audit note in the record (`resolution` and the timeline), and send the
 * matching webhook (`session.completed`, `session.failed`, ... and `withdrawal.*` for a withdrawal).
 * The webhook data has `resolution: { by: 'admin', state, note, at }`. Later provider events still
 * update the legs, but not the session state.
 */
export async function adminResolve(rt: Runtime, id: string, state: string, note: string): Promise<AdminSession> {
  const target = finalState(state)
  if (typeof note !== 'string' || !note.trim() || note.length > MAX_NOTE) throw bad(`\`note\` is required: 1 to ${MAX_NOTE} characters.`)
  const text = note.trim()
  for (let attempt = 0; attempt < 5; attempt++) {
    const rec = await rt.store.get(id)
    if (!rec || typeof rec.secretHash !== 'string') throw notFound()
    if (rec.step.state === target) throw new OpenRampException(openRampError('BAD_REQUEST', { message: `The session is already ${target}.` }), 409)
    const now = Date.now()
    const previous = rec.step.state
    rec.resolution = { state: target, note: text, at: now, previous }
    rec.step = {
      sessionId: rec.id,
      state: target,
      transitions: [],
      ...(rec.step.progress ? { progress: rec.step.progress } : {}),
      ...(rec.step.legIndex !== undefined ? { legIndex: rec.step.legIndex } : {}),
      ...(target === 'FAILED' ? { error: openRampError('PAYMENT_FAILED', { message: 'The operator closed this payment.', recovery: 'contact_support' }) } : {}),
      ...(target === 'EXPIRED' ? { error: openRampError('SESSION_EXPIRED') } : {}),
    }
    rec.status = sessionStatusFor(target, !!rec.active)
    addTimeline(rec, 'admin.resolved', { state: target, previous, note: text })
    const extra = { resolution: { by: 'admin', state: target, note: text, at: iso(now) } }
    await notify(rt, rec, `session.${rec.status}`, extra)
    if (rec.direction === 'withdraw' && (rec.status === 'completed' || rec.status === 'failed')) await notify(rt, rec, `withdrawal.${rec.status}`, extra)
    try {
      await saveSession(rt, rec)
      rt.log.info('admin resolved a session', { sessionId: rec.id, state: target, previous })
      return adminView(rt, rec)
    } catch (e) {
      if (!(e instanceof OpenRampException && e.status === 409)) throw e
    }
  }
  throw new OpenRampException(openRampError('CONFLICT'), 409)
}

/** Send the dead letters of a session again (`webhooks.replay`). */
export async function adminReplay(rt: Runtime, id: string): Promise<{ queued: number }> {
  const rec = await rt.store.get(id)
  if (!rec || typeof rec.secretHash !== 'string') throw notFound()
  return { queued: await replayDeadLetters(rt, id) }
}

// ---------- HTTP ----------

/**
 * True when `given` equals `token`. Both sides are hashed first, so the compare always runs over two
 * strings of 64 characters: its time does not depend on the token, nor on the length of `given`.
 */
export async function tokenMatches(token: string, given: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256Hex(given), sha256Hex(token)])
  return safeEqual(a, b) && given.length > 0
}

async function authorized(rt: Runtime, req: Request): Promise<boolean> {
  const token = rt.config.admin?.token
  const auth = req.headers.get('authorization') ?? ''
  if (!token || !auth.startsWith('Bearer ') || auth.length > 1024) return false
  return tokenMatches(token, auth.slice(7))
}

const NO_STORE = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' }
const send = (body: unknown, status = 200) => json(body, status, NO_STORE)

/** `/admin` and `/admin/*`. Off (404) without `admin.token`. */
export async function adminRoute(rt: Runtime, req: Request, method: string, rest: string[]): Promise<Response> {
  if (!rt.config.admin?.token) return send({ error: openRampError('NOT_FOUND') }, 404)
  const [head, id, action] = rest
  if (!head && method === 'GET') {
    if (rt.config.admin.page === false) return send({ error: openRampError('NOT_FOUND') }, 404)
    return adminPage(rt)
  }
  if (!(await authorized(rt, req))) return send({ error: openRampError('UNAUTHORIZED', { message: 'The admin token is missing or wrong.' }) }, 401)
  const url = new URL(req.url)
  const p = url.searchParams
  if (head === 'stats' && !id && method === 'GET') return send(await adminStats(rt, p.get('since') ? { since: /^\d+$/.test(p.get('since')!) ? Number(p.get('since')) : p.get('since')! } : {}))
  if (head === 'find' && !id && method === 'GET') {
    if (p.get('tx')) return send({ sessions: await adminFindByTx(rt, p.get('chain') ?? undefined, p.get('tx')!) })
    const found = await adminFindByRef(rt, p.get('provider') ?? '', p.get('ref') ?? '')
    return send({ sessions: found ? [found] : [] })
  }
  if (head === 'sessions' && !id && method === 'GET') {
    const num = (k: string) => (p.get(k) ? Number(p.get(k)) : undefined)
    const direction = p.get('direction') as Direction | null
    const olderThan = num('olderThan')
    const limit = num('limit')
    return send(
      await adminList(rt, {
        ...(direction ? { direction } : {}),
        ...(p.get('state') ? { state: p.get('state')! } : {}),
        ...(olderThan !== undefined ? { olderThan } : {}),
        ...(p.get('stuck') === '1' || p.get('stuck') === 'true' ? { stuck: true } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(p.get('cursor') ? { cursor: p.get('cursor')! } : {}),
      }),
    )
  }
  if (head === 'sessions' && id) {
    const sid = decodeURIComponent(id)
    if (!action && method === 'GET') {
      const s = await adminGet(rt, sid)
      return s ? send(s) : send({ error: openRampError('NOT_FOUND') }, 404)
    }
    if (action === 'resolve' && method === 'POST') {
      const body = await readJson<{ state?: unknown; note?: unknown }>(req)
      return send(await adminResolve(rt, sid, String(body?.state ?? ''), typeof body?.note === 'string' ? body.note : ''))
    }
    if (action === 'replay' && method === 'POST') return send(await adminReplay(rt, sid))
  }
  return send({ error: openRampError('NOT_FOUND') }, 404)
}
