import { isEvmAddress, settlementCallsFrom } from '@openrampkit/adapter'
import { OrkException, isTerminal, orkError } from '@openrampkit/core'
import type { Destination } from '@openrampkit/core'
import type { CreateSessionInput } from './config.js'
import { randomHex, safeEqual, sha256Hex } from './crypto.js'
import { notify } from './notify.js'
import { checkPayCredential, isPayCredential } from './pay.js'
import { saveSession } from './outbox.js'
import { trackOpenSession } from './queue.js'
import { normalizeDestination } from './runtime.js'
import type { Runtime } from './runtime.js'
import type { SessionRecord } from './store.js'
import { CAIP2, isValidAddress, isValidToken, normalizeSource } from './withdraw.js'

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
  const bad = (message: string) => new OrkException(orkError('BAD_REQUEST', { message }), 400)
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
}

export async function createSession(rt: Runtime, input: CreateSessionInput): Promise<CreatedSession> {
  checkInput(input)
  const id = `ors_${randomHex(12)}`
  const secret = randomHex(24)
  const now = Date.now()
  const expiresAt = now + (input.ttlMinutes ?? 30) * 60_000
  const direction = input.direction ?? 'deposit'
  if (direction !== 'deposit' && direction !== 'withdraw') throw new OrkException(orkError('BAD_REQUEST', { message: '`direction` must be "deposit" or "withdraw".' }), 400)
  if (input.destination?.type === 'crypto') checkSettlement(input.destination)
  if (direction === 'deposit' && !input.destination) throw new OrkException(orkError('BAD_REQUEST', { message: 'A deposit session needs `destination`.' }), 400)
  if (direction === 'withdraw' && input.destination) {
    throw new OrkException(orkError('BAD_REQUEST', { message: 'A withdraw session takes `source`, not `destination`: the user picks the target.' }), 400)
  }
  const rec: SessionRecord = {
    id,
    secretHash: await sha256Hex(secret),
    version: 1,
    userId: input.userId,
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
    status: 'open',
    createdAt: now,
    expiresAt,
    quotes: {},
    step: { sessionId: id, state: 'SELECT_METHOD', transitions: [], expiresAt: new Date(expiresAt).toISOString() },
    startUrls: {},
    notified: [],
  }
  // On the open list before the write: a session is never stored without it.
  await trackOpenSession(rt, rec.id)
  await notify(rt, rec, 'session.created')
  await saveSession(rt, rec, { create: true })
  return { id, clientSecret: `${id}.${secret}`, expiresAt: new Date(expiresAt).toISOString() }
}

/**
 * `destination.calls` run inside an OpenRampSettlement contract, so they need `destination.settlement`.
 * The settlement contract must be on an EVM destination chain, and the recipient an EVM address.
 */
function checkSettlement(d: Extract<Destination, { type: 'crypto' }>): void {
  const bad = (message: string) => new OrkException(orkError('BAD_REQUEST', { message }), 400)
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

/** Load a session from a `Bearer <id>.<secret>` header. Expires an open session past its deadline. */
export async function loadAuthed(rt: Runtime, req: Request, id: string): Promise<SessionRecord> {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  const [sid, secret] = token.split('.')
  if (!sid || !secret || sid !== id) throw new OrkException(orkError('UNAUTHORIZED'), 401)
  if (isPayCredential(secret)) {
    const check = await checkPayCredential(rt, sid, secret)
    if (check !== 'ok') throw new OrkException(orkError('UNAUTHORIZED', check === 'expired' ? { message: 'This pay link expired.' } : {}), 401)
  }
  const rec = await rt.store.get(id)
  if (!rec || (!isPayCredential(secret) && !safeEqual(rec.secretHash, await sha256Hex(secret)))) throw new OrkException(orkError('UNAUTHORIZED'), 401)
  if (Date.now() > rec.expiresAt && !isTerminal(rec.step.state) && rec.status === 'open') {
    rec.status = 'expired'
    rec.step = { sessionId: rec.id, state: 'EXPIRED', transitions: [], error: orkError('SESSION_EXPIRED') }
    await notify(rt, rec, 'session.expired')
    await saveSession(rt, rec)
  }
  return rec
}
