import { isEvmAddress, settlementCallsFrom } from '@openrampkit/adapter'
import { OpenRampException, isFinalStatus, isLegTerminal, openRampError } from '@openrampkit/core'
import type { CancelReason } from '@openrampkit/core'
import type { Destination } from '@openrampkit/core'
import { EXTERNAL_ID_TTL_SEC } from './config.js'
import type { CreateSessionInput } from './config.js'
import { hmacHex, randomHex, safeEqual, sha256Hex } from './crypto.js'
import { notify } from './notify.js'
import { checkPayCredential, isPayCredential, isRevokedPayLink } from './pay.js'
import { saveSession } from './outbox.js'
import { trackOpenSession } from './queue.js'
import { indexSession } from './admin.js'
import { adapterContext, normalizeDestination } from './runtime.js'
import { addTimeline } from './timeline.js'
import type { Runtime } from './runtime.js'
import { SESSION_SCHEMA } from './store.js'
import type { SessionRecord } from './store.js'
import { CAIP2, checkAllowed, isValidAddress, isValidToken, normalizeSource, parseTarget, screenTarget, targetDestination } from './withdraw.js'

export type CreatedSession = { id: string; clientSecret: string; expiresAt: string }

/** Limits for `CreateSessionInput`. The input can come from the browser through the `authorize` hook. */
export const SESSION_LIMITS = {
  userIdLength: 256,
  metadataKeys: 50,
  metadataKeyLength: 40,
  metadataValueLength: 500,
  /** Longest session: 7 days, the default session TTL of the KV stores */
  ttlMinutes: 7 * 24 * 60,
} as const

const DECIMAL = /^\d{1,30}(\.\d{1,36})?$/

/** Check the parts of the input that are stored or sent to providers. Throws a 400 when one is not valid. */
function checkInput(input: CreateSessionInput): void {
  const bad = (message: string) => new OpenRampException(openRampError('BAD_REQUEST', { message }), 400)
  const L = SESSION_LIMITS
  if (typeof input.userId !== 'string' || !input.userId || input.userId.length > L.userIdLength) throw bad(`\`userId\` must be a string of 1 to ${L.userIdLength} characters.`)
  if (input.ttlMinutes !== undefined && (typeof input.ttlMinutes !== 'number' || !(input.ttlMinutes > 0) || input.ttlMinutes > L.ttlMinutes)) {
    throw bad(`\`ttlMinutes\` must be more than 0 and at most ${L.ttlMinutes}.`)
  }
  if (input.metadata !== undefined) {
    const entries = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? Object.entries(input.metadata) : undefined
    if (!entries || entries.length > L.metadataKeys) throw bad(`\`metadata\` must be an object with at most ${L.metadataKeys} keys.`)
    for (const [k, v] of entries) {
      if (k.length > L.metadataKeyLength || typeof v !== 'string' || v.length > L.metadataValueLength) {
        throw bad(`\`metadata\` keys must be at most ${L.metadataKeyLength} characters, and values strings of at most ${L.metadataValueLength} characters.`)
      }
    }
  }
  for (const [name, v, max] of [['email', input.email, 254], ['locale', input.locale, 35], ['region', input.region, 16]] as const) {
    if (v !== undefined && (typeof v !== 'string' || v.length > max)) throw bad(`\`${name}\` must be a string of at most ${max} characters.`)
  }
  if (input.country !== undefined && (typeof input.country !== 'string' || !/^[A-Za-z]{2}$/.test(input.country))) throw bad('`country` must be an ISO 3166-1 alpha-2 code, e.g. VN.')
  if (input.allowedMethods !== undefined && (!Array.isArray(input.allowedMethods) || !input.allowedMethods.every((m) => typeof m === 'string'))) {
    throw bad('`allowedMethods` must be an array of method ids.')
  }
  const b = input.amountBounds
  if (b !== undefined && (typeof b?.currency !== 'string' || (b.min !== undefined && !DECIMAL.test(b.min)) || (b.max !== undefined && !DECIMAL.test(b.max)))) {
    throw bad('`amountBounds` needs `currency`, and `min` and `max` must be decimal strings.')
  }
  const d = input.destination
  if (d?.type === 'crypto') {
    if (typeof d.chain !== 'string' || !CAIP2.test(d.chain)) throw bad('`destination.chain` must be a CAIP-2 chain id, e.g. eip155:8453.')
    if (typeof d.token !== 'string' || !isValidToken(d.chain, d.token)) throw bad('`destination.token` must be a token address or "native".')
    if (typeof d.address !== 'string' || !isValidAddress(d.chain, d.address)) throw bad('`destination.address` is not a valid address for this chain.')
  } else if (d && (typeof (d as { currency?: unknown }).currency !== 'string' || !/^[A-Za-z]{3}$/.test((d as { currency: string }).currency))) {
    throw bad('`destination.currency` must be an ISO 4217 code, e.g. PHP.')
  }
  if (input.lockTarget !== undefined && typeof input.lockTarget !== 'boolean') throw bad('`lockTarget` must be a boolean.')
  if ((input.target !== undefined || input.lockTarget) && input.direction !== 'withdraw') throw bad('Only a withdraw session takes `target` and `lockTarget`.')
  if (input.lockTarget && input.target === undefined) throw bad('`lockTarget` needs `target`.')
  if (input.externalId !== undefined && (typeof input.externalId !== 'string' || !EXTERNAL_ID.test(input.externalId))) {
    throw bad('`externalId` must be 1 to 256 printable characters.')
  }
}

const EXTERNAL_ID = /^[\x21-\x7e]{1,256}$/

/** The `externalId` index entry: the session id, and when the create claimed it (ms) */
type ExternalClaim = { id: string; at: number }
/** A claim with no session after this time belongs to a create that failed */
const EXTERNAL_CLAIM_MS = 30_000
const EXTERNAL_WAIT_TRIES = 40
const EXTERNAL_WAIT_MS = 50

/** The KV key of the `externalId` index */
const externalKey = async (externalId: string) => `ext:${(await sha256Hex(externalId)).slice(0, 40)}`

/**
 * The client secret of a session with an `externalId`. It comes from the server secret and the session
 * id, so a repeated create can give the same secret again. The record keeps only its hash.
 */
async function derivedSecret(rt: Runtime, id: string): Promise<string> {
  return (await hmacHex(rt.config.secret, `client-secret:${id}`)).slice(0, 48)
}

/**
 * A create that repeats an `externalId`: the existing session when it is not final, a `409` when it is
 * final. Undefined when no session has this `externalId` (or its record is gone).
 */
async function existingFor(rt: Runtime, externalId: string): Promise<CreatedSession | undefined> {
  const claim = await rt.store.kv.get<ExternalClaim>(await externalKey(externalId))
  const rec = claim?.id ? await rt.store.get(claim.id) : null
  if (!rec || rec.externalId !== externalId) return undefined
  if (isFinalStatus(rec.status)) {
    throw new OpenRampException(openRampError('CONFLICT', { message: `The session with this externalId is already ${rec.status}. Use a new externalId.`, retryable: false }), 409)
  }
  return { id: rec.id, clientSecret: `${rec.id}.${await derivedSecret(rt, rec.id)}`, expiresAt: new Date(rec.expiresAt).toISOString() }
}

export async function createSession(rt: Runtime, input: CreateSessionInput): Promise<CreatedSession> {
  checkInput(input)
  if (input.externalId) {
    const found = await existingFor(rt, input.externalId)
    if (found) return found
  }
  const id = `ors_${randomHex(12)}`
  const secret = input.externalId ? await derivedSecret(rt, id) : randomHex(24)
  const now = Date.now()
  const expiresAt = now + (input.ttlMinutes ?? 30) * 60_000
  const direction = input.direction ?? 'deposit'
  if (direction !== 'deposit' && direction !== 'withdraw') throw new OpenRampException(openRampError('BAD_REQUEST', { message: '`direction` must be "deposit" or "withdraw".' }), 400)
  if (input.destination?.type === 'crypto') checkSettlement(input.destination)
  if (direction === 'deposit' && !input.destination) throw new OpenRampException(openRampError('BAD_REQUEST', { message: 'A deposit session needs `destination`.' }), 400)
  if (direction === 'withdraw' && input.destination) {
    throw new OpenRampException(openRampError('BAD_REQUEST', { message: 'A withdraw session takes `source`, not `destination`: the user picks the target.' }), 400)
  }
  const rec: SessionRecord = {
    id,
    secretHash: await sha256Hex(secret),
    schema: SESSION_SCHEMA,
    version: 1,
    userId: input.userId,
    ...(input.externalId ? { externalId: input.externalId } : {}),
    direction,
    ...(input.destination ? { destination: normalizeDestination(input.destination) } : {}),
    ...(direction === 'withdraw' ? { source: normalizeSource(input.source) } : {}),
    ...(direction === 'withdraw' && input.allowedTargets ? { allowedTargets: input.allowedTargets } : {}),
    ...(input.country ? { country: input.country.toUpperCase() } : {}),
    ...(input.region ? { region: input.region.toUpperCase() } : {}),
    ...(input.email ? { email: input.email } : {}),
    ...(input.locale ? { locale: input.locale } : {}),
    ...(input.amountBounds ? { amountBounds: input.amountBounds } : {}),
    ...(input.allowedMethods ? { allowedMethods: input.allowedMethods } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    livemode: rt.livemode,
    status: 'requires_payment_method',
    createdAt: now,
    expiresAt,
    quotes: {},
    step: { sessionId: id, state: 'SELECT_METHOD', transitions: [], expiresAt: new Date(expiresAt).toISOString() },
    startUrls: {},
    notified: [],
    updatedAt: now,
  }
  if (direction === 'withdraw' && input.target !== undefined) {
    // The same checks as `POST /sessions/:id/target`: format, `allowedTargets`, then `screenAddress`.
    const target = parseTarget(input.target)
    checkAllowed(rec, target)
    await screenTarget(rt, target)
    rec.destination = targetDestination(target)
    if (input.lockTarget) rec.targetLocked = true
  }
  if (input.externalId) {
    // Claim the externalId. With an atomic store, two creates at the same time make one session.
    const key = await externalKey(input.externalId)
    const kv = rt.store.kv
    const mine: ExternalClaim = { id, at: now }
    const claimed = kv.putIfAbsent ? await kv.putIfAbsent(key, mine, EXTERNAL_ID_TTL_SEC) : (await kv.put(key, mine, EXTERNAL_ID_TTL_SEC), true)
    if (!claimed) {
      // Another create has the claim. Wait a short time for its session, then return it.
      for (let i = 0; i < EXTERNAL_WAIT_TRIES; i++) {
        const found = await existingFor(rt, input.externalId)
        if (found) return found
        const other = await kv.get<ExternalClaim>(key)
        if (!other || Date.now() - other.at > EXTERNAL_CLAIM_MS) break
        await new Promise((r) => setTimeout(r, EXTERNAL_WAIT_MS))
      }
      const found = await existingFor(rt, input.externalId)
      if (found) return found
      const other = await kv.get<ExternalClaim>(key)
      if (other && Date.now() - other.at <= EXTERNAL_CLAIM_MS) {
        throw new OpenRampException(openRampError('CONFLICT', { message: 'A session with this externalId is being created. Try again.' }), 409)
      }
      // The claim points to a session that is gone: take it over.
      await kv.put(key, mine, EXTERNAL_ID_TTL_SEC)
    }
  }
  // On the open list before the write: a session is never stored without it.
  await trackOpenSession(rt, rec.id)
  await indexSession(rt, rec.id, now)
  await notify(rt, rec, 'session.created')
  await saveSession(rt, rec, { create: true })
  return { id, clientSecret: `${id}.${secret}`, expiresAt: new Date(expiresAt).toISOString() }
}

/**
 * `destination.calls` run inside an OpenRampSettlement contract, so they need `destination.settlement`.
 * The settlement contract must be on an EVM destination chain, and the recipient an EVM address.
 */
function checkSettlement(d: Extract<Destination, { type: 'crypto' }>): void {
  const bad = (message: string) => new OpenRampException(openRampError('BAD_REQUEST', { message }), 400)
  if (!d.settlement) {
    if (d.calls?.length) throw bad('Contract calls after delivery (`destination.calls`) need `destination.settlement`.')
    return
  }
  if (!d.chain.startsWith('eip155:')) throw bad('`destination.settlement` needs an EVM destination chain.')
  if (!isEvmAddress(d.settlement.contract)) throw bad('`destination.settlement.contract` must be a contract address.')
  if (!isEvmAddress(d.address)) throw bad('A settlement destination needs an EVM `address` (the recipient).')
  if (!isEvmAddress(d.token)) throw bad('A settlement destination needs an ERC-20 `token` (not the native token).')
  settlementCallsFrom(d.calls)
}

/** Load a session from a `Bearer <id>.<secret>` header. Expires a session with no payment in progress past its deadline. */
export async function loadAuthed(rt: Runtime, req: Request, id: string): Promise<SessionRecord> {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  const [sid, secret] = token.split('.')
  if (!sid || !secret || sid !== id) throw new OpenRampException(openRampError('UNAUTHORIZED'), 401)
  if (isPayCredential(secret)) {
    const check = await checkPayCredential(rt, sid, secret)
    if (check !== 'ok') throw new OpenRampException(openRampError('UNAUTHORIZED', check === 'expired' ? { message: 'This pay link expired.' } : {}), 401)
  }
  const rec = await rt.store.get(id)
  if (!rec || (!isPayCredential(secret) && !safeEqual(rec.secretHash, await sha256Hex(secret)))) throw new OpenRampException(openRampError('UNAUTHORIZED'), 401)
  if (isRevokedPayLink(rec, secret)) throw new OpenRampException(openRampError('UNAUTHORIZED', { message: 'This pay link no longer works.' }), 401)
  // No payment in progress (also after a failed attempt): the session expires at its deadline.
  if (Date.now() > rec.expiresAt && rec.status === 'requires_payment_method') {
    rec.status = 'expired'
    rec.step = { sessionId: rec.id, state: 'EXPIRED', transitions: [], error: openRampError('SESSION_EXPIRED') }
    await notify(rt, rec, 'session.expired')
    await saveSession(rt, rec)
  }
  return rec
}

/** Statuses that a cancel accepts: no payment is under way */
const CANCELABLE = new Set(['requires_payment_method', 'requires_action'])

/**
 * Cancel a session that has no payment under way (status `requires_payment_method` or
 * `requires_action`). The server asks the adapter of a started leg to void its order (`cancel()`, best
 * effort), sets the step to CANCELED and the status to `canceled`, and sends `session.canceled`. A
 * session that is already canceled is returned as it is. A payment that arrives later takes the late
 * payment path (`session.late_payment` with `reason: 'after_cancel'`). The caller saves the session.
 */
export async function cancelSession(rt: Runtime, rec: SessionRecord, reason: CancelReason): Promise<void> {
  if (rec.status === 'canceled') return
  if (rec.resolution) throw new OpenRampException(openRampError('BAD_REQUEST', { message: 'This session was closed by the operator.' }), 409)
  if (!CANCELABLE.has(rec.status)) {
    const message = rec.status === 'processing' ? 'A payment is under way. It cannot be canceled now.' : `This session is already ${rec.status}.`
    throw new OpenRampException(openRampError('BAD_REQUEST', { message }), 409)
  }
  const act = rec.active
  const leg = act?.legs[act.index]
  if (act && leg?.ref && leg.step && !isLegTerminal(leg.step.status)) {
    const a = rt.adapters.get(leg.adapterId)
    if (a?.cancel) {
      try {
        await a.cancel({ leg: act.pathway.legs[act.index]!, ref: leg.ref }, adapterContext(rt, rec, a, act.pathway, act.index))
      } catch (e) {
        rt.log.error('adapter cancel failed; the session is canceled anyway', { sessionId: rec.id, adapter: a.id, error: e instanceof Error ? e.message : String(e) })
      }
    }
  }
  const now = Date.now()
  rec.canceled = { at: now, reason }
  rec.status = 'canceled'
  rec.step = { sessionId: rec.id, state: 'CANCELED', transitions: [], error: openRampError('CANCELED'), ...(rec.step.progress ? { progress: rec.step.progress } : {}) }
  addTimeline(rec, 'session.cancel_requested', { reason })
  await notify(rt, rec, 'session.canceled', { reason })
}
