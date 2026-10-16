// Standing deposit addresses: one permanent address per user and route (`openramp.depositAddresses`).
// An adapter with `standingAddress` gives the address, and `sweep()` polls its `standingDeposits`.
// Each new deposit becomes a normal deposit session with an observed payment (one `transfer` leg that
// is already `processing`), so the usual machinery takes over: status polls on the open-session list,
// session webhooks, the admin views and the reversal rules.
//
// Two kinds of route (`Adapter.standingRoutes`): `convert` (another token or chain: a provider such as
// Relay converts each deposit) and `same` (the destination token on the destination chain: the address
// is the destination itself, and an adapter such as chain-watch reports the transfers it sees on chain).
//
// Money safety:
// - One deposit, one session. The session id comes from the address id and the deposit id, an
//   atomic claim (`standingdep:...`) picks the sweep that makes it, and a leg ref that already
//   belongs to a session is never a new deposit.
// - No session without a deposit: only a deposit that the adapter reports makes a session.
//
// Store keys (all in the store KV): `sda:{id}` the address record (no TTL), `sda:{id}:get` the time of
// the last `get`, `sda:{id}:poll` the poll state. Queues: STANDING_QUEUE (the addresses to poll, with
// their next poll time) and one index queue per user (`list`).

import type { Adapter, StandingDeposit, StandingRoute } from '@openrampkit/adapter'
import { OpenRampException, isDecimal, normalizeToken, openRampError } from '@openrampkit/core'
import type { Amount, CryptoAsset, Destination, LegQuote, LegSpec, MethodOption, Pathway, StandingAddress } from '@openrampkit/core'
import type { CreateSessionInput } from './config.js'
import { sha256Hex } from './crypto.js'
import { indexSession } from './admin.js'
import { indexUserSession } from './history.js'
import { setLegStep } from './legs.js'
import { notify } from './notify.js'
import { saveSession } from './outbox.js'
import { STANDING_QUEUE, queueOf, trackOpenSession } from './queue.js'
import type { Runtime } from './runtime.js'
import { checkInput, draftSession } from './sessions.js'
import { scopedKV } from './store.js'
import type { SessionRecord } from './store.js'
import { addTimeline } from './timeline.js'
import { CAIP2, isValidAddress, isValidToken } from './withdraw.js'

/** The input of `openramp.depositAddresses.get` */
export type DepositAddressInput = {
  userId: string
  /** The asset the user sends: a CAIP-2 chain and a token address (or `native`) */
  origin: { chain: string; token: string; symbol?: string; decimals?: number }
  /** Where each deposit goes. Only a crypto destination, with no `settlement` and no `calls`. */
  destination: Destination
  /**
   * The adapter to use. Default: the first adapter with `standingAddress` and a `transfer` leg that
   * serves the route (see `Adapter.standingRoutes`).
   */
  adapterId?: string
}

/** The address record that the server keeps (no TTL) */
type StandingRecord = StandingAddress & {
  /** The adapter's `ref` for `standingDeposits` */
  ref: string
  data?: Record<string, unknown>
}

/** What the sweep keeps about one address between polls */
type PollState = {
  /** Start of the last poll that went through (ms) */
  checkedAt?: number
  /** When the sweep last made a session for a deposit here (ms) */
  lastDepositAt?: number
  /** The wait before the next poll (ms) */
  intervalMs: number
  /** Deposit ids already handled, newest last, so a repeat costs no store write */
  seen: string[]
}

/** The claim of one deposit: the session it makes, and when the claim was taken (ms) */
type DepositClaim = { sessionId: string; at: number }

/** Poll every 30 s while deposits come in (a deposit in the last hour), and after a `get` */
export const STANDING_FAST_MS = 30_000
/** The poll interval doubles while the address is idle, up to 10 minutes */
export const STANDING_IDLE_MAX_MS = 10 * 60_000
/** A deposit seen in this window keeps the fast poll */
export const STANDING_ACTIVE_MS = 60 * 60_000
/** No deposit and no `get` for 90 days: the sweep stops polling the address. The next `get` starts it again. */
export const STANDING_DORMANT_MS = 90 * 24 * 60 * 60_000
/** Each poll asks again for the last hour, so a deposit that the provider lists late is not missed */
const OVERLAP_MS = 60 * 60_000
/** A deposit can be listed a little before the address record time (clock skew) */
const SLACK_MS = 10 * 60_000
/** How long a deposit claim is kept: longer than any poll window */
const DEPOSIT_CLAIM_TTL_SEC = 400 * 24 * 60 * 60
/**
 * A claim with no session after this time belongs to a sweep that stopped half way. The next poll
 * makes the session with the same id. A sweep holds an address for 10 minutes (its lease), so a
 * running sweep is not overtaken in practice, and the same id keeps it to one session in any case.
 */
const CLAIM_STALE_MS = 2 * 60_000
const SEEN_MAX = 100
/** The deadline of a deposit session. A payment in progress never expires, so this shows only in the step. */
const DEPOSIT_SESSION_TTL_MIN = 24 * 60
/** How long a sweep holds the addresses it claimed (the same as the other sweep queues) */
const LEASE_MS = 10 * 60_000
/** Most addresses that `list` returns */
const LIST_LIMIT = 200

const bad = (message: string) => new OpenRampException(openRampError('BAD_REQUEST', { message }), 400)

/** An EVM address or token in lower case, so case variants are the same route. Other chains keep the case. */
const keyOf = (s: string) => (s.startsWith('0x') ? s.toLowerCase() : s)

/** The leg that the deposit sessions of an adapter use: its first leg with the method `transfer` */
export function transferLeg(a: Adapter): LegSpec | undefined {
  return a.legs.find((l) => l.methods?.includes('transfer'))
}

function supportsStanding(a: Adapter): boolean {
  return !!a.standingAddress && !!a.standingDeposits && !!a.status && !!transferLeg(a)
}

/** True when the adapter's standing addresses serve this kind of route (default: `convert` only) */
function servesRoute(a: Adapter, kind: StandingRoute): boolean {
  return (a.standingRoutes ?? ['convert']).includes(kind)
}

function adapterCtx(rt: Runtime, a: Adapter) {
  return { fetch: rt.fetch, log: rt.log, shared: scopedKV(rt.store, `a:${a.id}`) }
}

/** Check the input like a session create does. Returns the route with normalized tokens. */
function checkRoute(input: DepositAddressInput): { userId: string; origin: StandingAddress['origin']; destination: StandingAddress['destination']; kind: StandingRoute } {
  if (!input || typeof input !== 'object') throw bad('The input must be an object.')
  const d = input.destination
  if (!d || typeof d !== 'object' || d.type !== 'crypto') throw bad('A standing deposit address needs a crypto `destination`.')
  // The same checks as a session create: `userId`, and the destination chain, token and address.
  checkInput({ userId: input.userId, destination: d })
  if (d.settlement || d.calls?.length) throw bad('A standing deposit address cannot use `destination.settlement` or `destination.calls`.')
  const o = input.origin
  if (!o || typeof o !== 'object') throw bad('`origin` must be an object with `chain` and `token`.')
  if (typeof o.chain !== 'string' || !CAIP2.test(o.chain)) throw bad('`origin.chain` must be a CAIP-2 chain id, e.g. eip155:42161.')
  if (typeof o.token !== 'string' || !isValidToken(o.chain, o.token)) throw bad('`origin.token` must be a token address or "native".')
  if (o.symbol !== undefined && (typeof o.symbol !== 'string' || o.symbol.length > 20)) throw bad('`origin.symbol` must be a string of at most 20 characters.')
  if (o.decimals !== undefined && (!Number.isInteger(o.decimals) || o.decimals < 0 || o.decimals > 36)) throw bad('`origin.decimals` must be an integer from 0 to 36.')
  if (input.adapterId !== undefined && typeof input.adapterId !== 'string') throw bad('`adapterId` must be a string.')
  const origin = { chain: o.chain, token: normalizeToken(o.chain, o.token), ...(o.symbol ? { symbol: o.symbol } : {}), ...(o.decimals !== undefined ? { decimals: o.decimals } : {}) }
  const destination = { ...d, token: normalizeToken(d.chain, d.token) }
  // The same token on the same chain needs no conversion: an adapter that watches the chain serves it.
  const kind: StandingRoute = origin.chain === destination.chain && keyOf(origin.token) === keyOf(destination.token) ? 'same' : 'convert'
  return { userId: input.userId, origin, destination, kind }
}

const SAME_ROUTE_HINT = 'The origin and the destination are the same token on the same chain. Add chainWatch() from @openrampkit/adapter-chain-watch to watch such a route, or give the user the destination address itself.'

/** The adapter for a new address: `adapterId`, else the first adapter that gives standing addresses for this kind of route */
function pickAdapter(rt: Runtime, kind: StandingRoute, adapterId?: string): Adapter {
  if (adapterId !== undefined) {
    const a = rt.adapters.get(adapterId)
    if (!a) throw new OpenRampException(openRampError('NOT_FOUND', { message: `Adapter ${adapterId} is not configured.` }), 404)
    if (!supportsStanding(a)) throw bad(`Adapter ${adapterId} does not give standing deposit addresses (it needs standingAddress, standingDeposits, status and a transfer leg).`)
    if (!servesRoute(a, kind)) throw bad(kind === 'same' ? `Adapter ${adapterId} does not watch the same token on the same chain. ${SAME_ROUTE_HINT}` : `Adapter ${adapterId} gives standing addresses only for the same token on the same chain.`)
    return a
  }
  const a = [...rt.adapters.values()].find((x) => supportsStanding(x) && servesRoute(x, kind))
  if (!a) throw bad(kind === 'same' ? SAME_ROUTE_HINT : 'No configured adapter gives standing deposit addresses. Add one that does, for example relay().')
  return a
}

/** The address id: the same for the same user, adapter and route */
async function standingId(adapterId: string, r: ReturnType<typeof checkRoute>): Promise<string> {
  const d = r.destination
  const key = JSON.stringify([r.userId, adapterId, r.origin.chain, keyOf(r.origin.token), d.chain, keyOf(d.token), keyOf(d.address)])
  return `sda_${(await sha256Hex(key)).slice(0, 24)}`
}

/** The index queue of one user's addresses */
const userIndex = async (userId: string) => `standing-user:${(await sha256Hex(userId)).slice(0, 32)}`

function publicView(r: StandingRecord): StandingAddress {
  return { id: r.id, userId: r.userId, adapterId: r.adapterId, address: r.address, origin: r.origin, destination: r.destination, createdAt: r.createdAt }
}

/**
 * The standing address of a user and route, made on the first call. Two calls at the same time
 * return one address (an atomic write of the record, on stores with `putIfAbsent`). Each call starts
 * the watch again when it had stopped, and makes the next poll come soon.
 */
export async function getStandingAddress(rt: Runtime, input: DepositAddressInput): Promise<StandingAddress> {
  const route = checkRoute(input)
  const a = pickAdapter(rt, route.kind, input.adapterId)
  const id = await standingId(a.id, route)
  const key = `sda:${id}`
  const kv = rt.store.kv
  const q = queueOf(rt.store)
  let rec = await kv.get<StandingRecord>(key)
  if (!rec) {
    const got = await a.standingAddress!({ userId: route.userId, origin: { chain: route.origin.chain, token: route.origin.token }, destination: route.destination }, adapterCtx(rt, a))
    // A same-chain route has no conversion: its address must be the destination itself.
    const sameButOther = route.kind === 'same' && typeof got?.address === 'string' && keyOf(got.address) !== keyOf(route.destination.address)
    if (!got || typeof got.address !== 'string' || !isValidAddress(route.origin.chain, got.address) || typeof got.ref !== 'string' || !got.ref || got.ref.length > 500 || sameButOther) {
      rt.log.error('adapter returned a standing address that is not valid', { adapter: a.id })
      throw new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message: 'The provider did not return a valid deposit address.' }), 502)
    }
    const fresh: StandingRecord = {
      id,
      userId: route.userId,
      adapterId: a.id,
      address: got.address,
      origin: route.origin,
      destination: route.destination,
      createdAt: new Date().toISOString(),
      ref: got.ref,
      ...(got.data ? { data: got.data } : {}),
    }
    // On the watch list before the write (and again below), so an address is never stored unwatched.
    await q.push(STANDING_QUEUE, id, Date.now())
    let won: boolean
    if (kv.putIfAbsent) won = await kv.putIfAbsent(key, fresh, 0)
    else won = !(await kv.get(key)) && (await kv.put(key, fresh), true)
    rec = won ? fresh : ((await kv.get<StandingRecord>(key)) ?? fresh)
    if (won) {
      rt.log.info('standing deposit address created', { id, adapter: a.id })
      rt.metric('standing.created', 1, { adapter: a.id })
    }
  }
  const now = Date.now()
  await kv.put(`${key}:get`, now)
  await q.push(STANDING_QUEUE, id, now)
  // The user index: pushed on every call, so an index entry lost in a crash comes back.
  await q.push(await userIndex(rec.userId), id, Date.parse(rec.createdAt))
  return publicView(rec)
}

/** The id of the widget method for a standing deposit address */
export const DEPOSIT_ADDRESS_METHOD = 'deposit_address'

/** What the browser sees of a standing address: no user id and no adapter id */
export type DepositAddressView = Pick<StandingAddress, 'id' | 'address' | 'origin'> & { destination: { chain: string; token: string; symbol?: string } }

/**
 * The adapter for the widget method, or undefined when the method does not fit the session: the option
 * `depositAddresses.widget` is off, the session is a withdrawal, the destination is not a plain crypto
 * address, or no adapter gives standing addresses.
 */
export function widgetStandingAdapter(rt: Runtime, rec: SessionRecord): Adapter | undefined {
  if (!rt.config.depositAddresses?.widget || rec.direction === 'withdraw') return undefined
  const d = rec.destination
  if (!d || d.type !== 'crypto' || d.settlement || d.calls?.length) return undefined
  return [...rt.adapters.values()].find(supportsStanding)
}

/** The widget method for the plan, or undefined (see `widgetStandingAdapter`) */
export function depositAddressMethod(rt: Runtime, rec: SessionRecord): MethodOption | undefined {
  const a = widgetStandingAdapter(rt, rec)
  if (!a) return undefined
  if (rec.allowedMethods && !rec.allowedMethods.includes(DEPOSIT_ADDRESS_METHOD)) return undefined
  if (rt.config.policy?.disabledMethods?.includes(DEPOSIT_ADDRESS_METHOD)) return undefined
  return { method: DEPOSIT_ADDRESS_METHOD, name: 'Your deposit address', kind: 'crypto', group: 'more', providers: [a.name], pathwayIds: [], eta: transferLeg(a)?.eta ?? { min: 60, max: 600 } }
}

/** `POST /sessions/:id/deposit-address`: the session user's standing address for an origin and the session destination */
export async function sessionDepositAddress(rt: Runtime, rec: SessionRecord, body: { chain?: unknown; token?: unknown }): Promise<DepositAddressView> {
  if (!rt.config.depositAddresses?.widget) throw new OpenRampException(openRampError('NOT_FOUND'), 404)
  // The same gates as the plan: the session fits, and `allowedMethods` and `policy.disabledMethods` allow the method.
  const a = depositAddressMethod(rt, rec) ? widgetStandingAdapter(rt, rec) : undefined
  if (!a) throw new OpenRampException(openRampError('BAD_REQUEST', { message: 'This session cannot use a standing deposit address.' }), 409)
  if (typeof body?.chain !== 'string' || typeof body.token !== 'string') throw bad('`chain` and `token` are required.')
  // The adapter follows the route: a provider that converts, or a chain watcher for the destination token itself.
  const sa = await getStandingAddress(rt, { userId: rec.userId, origin: { chain: body.chain, token: body.token }, destination: rec.destination! })
  const d = sa.destination
  return { id: sa.id, address: sa.address, origin: sa.origin, destination: { chain: d.chain, token: d.token, ...(d.symbol ? { symbol: d.symbol } : {}) } }
}

/** The standing addresses of a user, newest first (at most 200) */
export async function listStandingAddresses(rt: Runtime, userId: string): Promise<StandingAddress[]> {
  checkInput({ userId } as CreateSessionInput)
  const q = queueOf(rt.store)
  if (!q.range) throw new OpenRampException(openRampError('INTERNAL', { message: 'depositAddresses.list needs a store queue with range(). All built-in stores have it.' }), 500)
  const items = await q.range(await userIndex(userId), { max: Number.MAX_SAFE_INTEGER, limit: LIST_LIMIT })
  const out: StandingAddress[] = []
  for (const { id } of items) {
    const rec = await rt.store.kv.get<StandingRecord>(`sda:${id}`)
    if (rec && rec.userId === userId) out.push(publicView(rec))
  }
  return out
}

/** A deposit from the adapter, checked. Undefined when it is not well formed. */
function checkDeposit(d: StandingDeposit, origin: StandingAddress['origin']): StandingDeposit | undefined {
  if (!d || typeof d !== 'object') return undefined
  if (typeof d.id !== 'string' || !d.id || d.id.length > 200) return undefined
  if (typeof d.legRef !== 'string' || !d.legRef || d.legRef.length > 500) return undefined
  const at = typeof d.at === 'number' && Number.isFinite(d.at) ? d.at : Date.now()
  const i = d.input
  const asset = i?.asset
  const input: Amount | undefined =
    i && typeof i.value === 'string' && isDecimal(i.value) && asset?.kind === 'crypto' && typeof asset.chain === 'string' && typeof asset.token === 'string'
      ? { value: i.value, asset: { ...asset, ...(asset.chain === origin.chain && keyOf(asset.token) === keyOf(origin.token) ? { token: origin.token } : {}) } }
      : undefined
  return { id: d.id, legRef: d.legRef, at, ...(input ? { input } : {}) }
}

/** The id of the session for one deposit: the same for the same address and deposit */
async function depositSessionId(addressId: string, depositId: string): Promise<string> {
  return `ors_${(await sha256Hex(`standing|${addressId}|${depositId}`)).slice(0, 24)}`
}

/**
 * Make the session for one deposit, once. Returns `created`, `exists` (a session has it), `skipped`
 * (its leg ref belongs to another session) or `pending` (another sweep holds the claim; try later).
 */
async function depositSession(rt: Runtime, addr: StandingRecord, a: Adapter, dep: StandingDeposit): Promise<'created' | 'exists' | 'skipped' | 'pending'> {
  const kv = rt.store.kv
  const sid = await depositSessionId(addr.id, dep.id)
  if (await rt.store.get(sid)) return 'exists'
  // A ref that already belongs to a session is not a new deposit (the provider gave it a new id).
  const owner = await kv.get<string>(`ref:${a.id}:${dep.legRef}`)
  if (owner && owner !== sid) {
    rt.log.warn('standing deposit: its leg ref belongs to another session; not a new deposit', { addressId: addr.id, adapter: a.id, sessionId: owner })
    return 'skipped'
  }
  const claimKey = `standingdep:${addr.id}:${(await sha256Hex(dep.id)).slice(0, 40)}`
  const mine: DepositClaim = { sessionId: sid, at: Date.now() }
  let won: boolean
  if (kv.putIfAbsent) won = await kv.putIfAbsent(claimKey, mine, DEPOSIT_CLAIM_TTL_SEC)
  else won = !(await kv.get(claimKey)) && (await kv.put(claimKey, mine, DEPOSIT_CLAIM_TTL_SEC), true)
  if (!won) {
    const cur = await kv.get<DepositClaim>(claimKey)
    // Another sweep may still be saving the session. Past CLAIM_STALE_MS it stopped: make the session
    // here, with the same id. One sweep only takes over a stale claim (a second atomic claim), and it
    // writes its own claim, so the stopped sweep sees that and does not write the session later.
    if (cur && Date.now() - cur.at < CLAIM_STALE_MS) return 'pending'
    if (await rt.store.get(sid)) return 'exists'
    const takeKey = `${claimKey}:take:${cur?.at ?? 0}`
    const took = kv.putIfAbsent ? await kv.putIfAbsent(takeKey, mine, DEPOSIT_CLAIM_TTL_SEC) : !(await kv.get(takeKey)) && (await kv.put(takeKey, mine, DEPOSIT_CLAIM_TTL_SEC), true)
    if (!took) return 'pending'
    await kv.put(claimKey, mine, DEPOSIT_CLAIM_TTL_SEC)
    rt.log.warn('standing deposit: a claim with no session; making the session now', { addressId: addr.id, sessionId: sid })
  }
  // Right before the write: the claim is still this sweep's, and no session has the id yet.
  const stillMine = async () => {
    const c = await kv.get<DepositClaim>(claimKey)
    return c?.at === mine.at && c.sessionId === sid && !(await rt.store.get(sid))
  }
  return (await createDepositSession(rt, addr, a, dep, sid, stillMine)) ? 'created' : 'pending'
}

/**
 * A deposit session with an observed payment: one `transfer` leg of the adapter, started, with the
 * deposit's `legRef` and the step `processing`. No quote was made before the deposit, so the leg quote
 * is an `estimate` with the deposit as input and an output of 0 in the destination asset. The open
 * session list then polls `status(legRef)` until the leg ends.
 */
async function createDepositSession(rt: Runtime, addr: StandingRecord, a: Adapter, dep: StandingDeposit, sid: string, stillMine: () => Promise<boolean>): Promise<boolean> {
  // Before any side effect (the open list, the indexes): the claim is this sweep's. The check runs again
  // right before the write. Every side effect uses the same session id, so a sweep that stops between
  // the two checks leaves entries that the session of the other sweep then owns.
  if (!(await stillMine())) return false
  const spec = transferLeg(a)
  if (!spec) throw new Error(`adapter ${a.id} has no transfer leg`)
  const input: CreateSessionInput = {
    userId: addr.userId,
    destination: addr.destination,
    ttlMinutes: DEPOSIT_SESSION_TTL_MIN,
    metadata: { depositAddressId: addr.id, depositId: dep.id },
  }
  checkInput(input)
  const { rec } = await draftSession(rt, input, sid, { standingAddressId: addr.id })
  const d = addr.destination
  const o = addr.origin
  const from: CryptoAsset = { kind: 'crypto', chain: o.chain, token: o.token, ...(o.symbol ? { symbol: o.symbol } : {}), ...(o.decimals !== undefined ? { decimals: o.decimals } : {}) }
  const to: CryptoAsset = { kind: 'crypto', chain: d.chain, token: d.token, ...(d.symbol ? { symbol: d.symbol } : {}), ...(d.decimals !== undefined ? { decimals: d.decimals } : {}) }
  const pathway: Pathway = {
    id: `standing:${addr.id}`,
    legs: [{ adapterId: a.id, legId: spec.id, from: { asset: from, location: { kind: 'user_wallet' } }, to: { asset: to, location: { kind: 'address', address: d.address } }, method: 'transfer' }],
    method: 'transfer',
    group: 'recommended',
    eta: spec.eta,
    provider: a.name,
  }
  const quote: LegQuote = {
    adapterId: a.id,
    legId: spec.id,
    input: dep.input ?? { value: '0', asset: from },
    output: { value: '0', asset: to },
    fees: [],
    guarantee: 'estimate',
    eta: spec.eta,
    expiresAt: new Date(rec.createdAt).toISOString(),
  }
  rec.active = {
    n: 0,
    quoteId: `sdq_${sid.slice(4)}`,
    pathway,
    index: 0,
    ...(rec.destination ? { destination: rec.destination } : {}),
    legs: [{ adapterId: a.id, legId: spec.id, provider: a.name, quote, started: true }],
  }
  // On the open list before the write: the sweep polls the leg until it ends.
  await trackOpenSession(rt, sid)
  await indexSession(rt, sid, rec.createdAt)
  await indexUserSession(rt, rec)
  await notify(rt, rec, 'session.created')
  await notify(rt, rec, 'deposit_address.deposit', { depositAddressId: addr.id, sessionId: sid, depositId: dep.id, ...(dep.input ? { input: dep.input } : {}) })
  addTimeline(rec, 'payment.started', { attempt: 0, method: 'transfer', provider: a.name })
  // Indexes the ref, records the step, and sends `session.processing`.
  await setLegStep(rt, rec, 0, { status: 'processing', detail: { code: 'processing' }, ref: dep.legRef })
  if (!(await stillMine())) {
    rt.log.warn('standing deposit: another sweep took the claim; not writing the session', { addressId: addr.id, sessionId: sid })
    return false
  }
  await saveSession(rt, rec, { create: true })
  rt.log.info('standing deposit: session created', { addressId: addr.id, sessionId: sid, adapter: a.id })
  rt.metric('standing.deposit', 1, { adapter: a.id })
  return true
}

/** The wait before the next poll */
function nextInterval(poll: PollState, lastGetAt: number, prevCheckedAt: number | undefined, now: number): number {
  if (poll.lastDepositAt !== undefined && now - poll.lastDepositAt < STANDING_ACTIVE_MS) return STANDING_FAST_MS
  // A `get` since the last poll: the user may be about to send, so start the backoff again.
  if (prevCheckedAt === undefined || lastGetAt > prevCheckedAt) return STANDING_FAST_MS
  return Math.min(STANDING_IDLE_MAX_MS, Math.max(STANDING_FAST_MS, poll.intervalMs * 2))
}

export type StandingSweepStats = { checked: number; deposits: number }

/** Sweep step: poll the standing addresses that are due, and make a session for each new deposit. */
export async function sweepStanding(rt: Runtime, opts: { now: number; limit: number; token: string }, stats: StandingSweepStats): Promise<void> {
  const q = queueOf(rt.store)
  const kv = rt.store.kv
  for (const id of await q.claim(STANDING_QUEUE, { now: opts.now, limit: opts.limit, leaseMs: LEASE_MS, token: opts.token })) {
    const addr = await kv.get<StandingRecord>(`sda:${id}`)
    if (!addr) {
      await q.ack(STANDING_QUEUE, id, opts.token)
      continue
    }
    const a = rt.adapters.get(addr.adapterId)
    if (!a?.standingDeposits) {
      // Keep the address: the adapter may come back in the config.
      rt.log.warn('standing address: its adapter is not configured or cannot list deposits', { id, adapter: addr.adapterId })
      await q.push(STANDING_QUEUE, id, Date.now() + STANDING_IDLE_MAX_MS)
      continue
    }
    const now = Date.now()
    const poll: PollState = (await kv.get<PollState>(`sda:${id}:poll`)) ?? { intervalMs: STANDING_FAST_MS, seen: [] }
    const lastGetAt = (await kv.get<number>(`sda:${id}:get`)) ?? 0
    const createdAt = Date.parse(addr.createdAt)
    if (now - Math.max(createdAt, poll.lastDepositAt ?? 0, lastGetAt) > STANDING_DORMANT_MS) {
      // Idle for 90 days: stop. A `get` pushes it again (and a push after this claim keeps it).
      await q.ack(STANDING_QUEUE, id, opts.token)
      rt.log.info('standing address idle for 90 days; the watch stops until the next get', { id })
      continue
    }
    stats.checked++
    const since = Math.max(createdAt - SLACK_MS, (poll.checkedAt ?? 0) - OVERLAP_MS)
    let deposits: StandingDeposit[]
    try {
      deposits = await a.standingDeposits({ ref: addr.ref, address: addr.address, origin: { chain: addr.origin.chain, token: addr.origin.token }, since }, adapterCtx(rt, a))
      if (!Array.isArray(deposits)) throw new Error('standingDeposits did not return an array')
    } catch (e) {
      rt.log.warn('standing address: deposit check failed', { id, adapter: a.id, error: String(e) })
      await q.push(STANDING_QUEUE, id, Date.now() + Math.min(STANDING_IDLE_MAX_MS, Math.max(STANDING_FAST_MS, poll.intervalMs)))
      continue
    }
    let complete = true
    for (const raw of deposits) {
      const dep = checkDeposit(raw, addr.origin)
      if (!dep) {
        rt.log.warn('standing address: the adapter listed a deposit that is not well formed; skipped', { id, adapter: a.id })
        continue
      }
      if (poll.seen.includes(dep.id)) continue
      try {
        const r = await depositSession(rt, addr, a, dep)
        if (r === 'pending') {
          complete = false
          continue
        }
        if (r === 'created') {
          stats.deposits++
          poll.lastDepositAt = Date.now()
        }
        poll.seen = [...poll.seen, dep.id].slice(-SEEN_MAX)
      } catch (e) {
        complete = false
        rt.log.warn('standing address: could not make the session for a deposit; the next poll tries again', { id, adapter: a.id, error: String(e) })
      }
    }
    const prevCheckedAt = poll.checkedAt
    // Move the window on only when every deposit was handled, so a deposit that failed is listed again.
    if (complete) poll.checkedAt = now
    poll.intervalMs = nextInterval(poll, lastGetAt, prevCheckedAt, Date.now())
    await kv.put(`sda:${id}:poll`, poll)
    await q.push(STANDING_QUEUE, id, Date.now() + poll.intervalMs)
  }
}
