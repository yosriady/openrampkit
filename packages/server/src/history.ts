// The user's past sessions (`GET /sessions/:id/history`, option `history`). With the option on, each new
// session id goes on one index queue per user (`sessions-user:{hash of the user id}`) with its creation
// time as the due time. `StoreQueue.range` reads them, latest first. Each new entry also prunes the
// entries older than the retention period (`history.retentionDays`, default 90): `claim` with
// `now` = the cutoff picks the oldest entries (due at or before the cutoff), and `ack` removes them.
//
// Privacy: the route answers only for the user of the session that the client secret opens, and each
// item is a small view: no client secret, user id, IP, provider id, or address.

import { OpenRampException, openRampError } from '@openrampkit/core'
import type { Destination, HistoryItem } from '@openrampkit/core'
import { paymentAmount } from './admin.js'
import { sha256Hex } from './crypto.js'
import { legTransactions } from './legs.js'
import { claimToken, queueOf } from './queue.js'
import type { Runtime } from './runtime.js'
import type { SessionRecord } from './store.js'

/** Most items that one call returns */
export const HISTORY_LIMIT = 50
/** Most index entries that one call reads. Sessions with no payment are left out, so it reads more than it returns. */
const HISTORY_SCAN = 200
/** Sessions loaded from the store at the same time */
const LOAD_BATCH = 25

/** Default days that an entry stays in a user's index */
export const HISTORY_RETENTION_DAYS = 90
/** Most old entries that one new session removes */
export const HISTORY_PRUNE_LIMIT = 20
/** The lease of a prune claim. The `ack` follows at once; a lost `ack` leaves an old entry for the next prune. */
const PRUNE_LEASE_MS = 1000
const DAY_MS = 86_400_000

/** Days that an index entry stays, from `config.history`. Throws when `retentionDays` is not a positive number. */
export function historyRetentionDays(history: boolean | { retentionDays?: number } | undefined): number {
  const days = typeof history === 'object' && history ? history.retentionDays : undefined
  if (days === undefined) return HISTORY_RETENTION_DAYS
  if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) throw new Error('OpenRamp: `history.retentionDays` must be a positive number')
  return days
}

/** The index queue of one user's sessions */
const userSessions = async (userId: string) => `sessions-user:${(await sha256Hex(userId)).slice(0, 32)}`

/**
 * Add a new session to its user's index, then remove up to `HISTORY_PRUNE_LIMIT` entries older than the
 * retention period. Only when `config.history` is on.
 */
export async function indexUserSession(rt: Runtime, rec: SessionRecord): Promise<void> {
  if (!rt.config.history) return
  const q = queueOf(rt.store)
  const name = await userSessions(rec.userId)
  await q.push(name, rec.id, rec.createdAt)
  // Nothing else claims an index queue, so a claim here only picks entries due at or before the cutoff.
  const cutoff = Date.now() - historyRetentionDays(rt.config.history) * DAY_MS
  const token = claimToken()
  for (const id of await q.claim(name, { now: cutoff, limit: HISTORY_PRUNE_LIMIT, leaseMs: PRUNE_LEASE_MS, token })) {
    // The new session stays, even with a `createdAt` before the cutoff (a clock that moved back).
    // A push clears the claim and puts its due time back.
    if (id === rec.id) await q.push(name, rec.id, rec.createdAt)
    else await q.ack(name, id, token)
  }
}

/** The asset that arrives, with no address. A merchant destination shows only its currency. */
function destinationView(d: Destination | undefined): HistoryItem['destination'] {
  if (!d) return undefined
  if (d.type === 'crypto') return { type: 'crypto', chain: d.chain, token: d.token, ...(d.symbol ? { symbol: d.symbol } : {}), ...(d.decimals !== undefined ? { decimals: d.decimals } : {}) }
  return { type: 'fiat', currency: d.currency }
}

/** The browser view of one past session */
export function historyItem(rec: SessionRecord): HistoryItem {
  // The payment in progress, else the last attempt (a session that expired after a restart).
  const p = rec.active ?? rec.attempts?.[rec.attempts.length - 1]
  const amount = paymentAmount(p)
  const txs = p ? p.legs.flatMap((_, i) => legTransactions(p, i)) : []
  // The delivery is what the user looks for. Else the transaction that paid in.
  const tx = txs.find((t) => t.role === 'settlement') ?? txs.find((t) => t.role === 'destination') ?? txs.find((t) => t.role === 'source')
  const destination = destinationView(p?.destination ?? rec.destination)
  return {
    id: rec.id,
    kind: rec.standingAddressId ? 'standing' : 'session',
    direction: rec.direction,
    status: rec.status,
    createdAt: new Date(rec.createdAt).toISOString(),
    ...(amount ? { amount } : {}),
    ...(destination ? { destination } : {}),
    ...(tx ? { tx: { chain: tx.chain, hash: tx.hash, ...(tx.explorerUrl ? { explorerUrl: tx.explorerUrl } : {}) } } : {}),
  }
}

/** A session that shows in the history: a payment started, or a deposit came to a standing address */
const hasPayment = (rec: SessionRecord) => !!rec.active || !!rec.attempts?.length || !!rec.standingAddressId

/**
 * The sessions of `rec`'s user, newest first, at most `HISTORY_LIMIT`. Sessions where no payment
 * started are left out. A session whose record is gone (the store TTL) is skipped.
 */
export async function userHistory(rt: Runtime, rec: SessionRecord): Promise<HistoryItem[]> {
  const q = queueOf(rt.store)
  if (!q.range) {
    throw new OpenRampException(openRampError('INTERNAL', { message: 'The store queue has no `range`. The history needs it (see Session stores).' }), 501)
  }
  const entries = await q.range(await userSessions(rec.userId), { max: Number.MAX_SAFE_INTEGER, limit: HISTORY_SCAN })
  const out: HistoryItem[] = []
  for (let i = 0; i < entries.length && out.length < HISTORY_LIMIT; i += LOAD_BATCH) {
    const batch = await Promise.all(entries.slice(i, i + LOAD_BATCH).map((e) => (e.id === rec.id ? rec : rt.store.get(e.id))))
    // The same user only (the index name is a hash, so check the record too), and the same mode.
    for (const r of batch) if (r && r.userId === rec.userId && r.livemode === rec.livemode && hasPayment(r) && out.length < HISTORY_LIMIT) out.push(historyItem(r))
  }
  return out
}
