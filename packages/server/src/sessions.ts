import { OrkException, isTerminal, orkError } from '@openrampkit/core'
import type { CreateSessionInput } from './config.js'
import { randomHex, safeEqual, sha256Hex } from './crypto.js'
import { notify } from './notify.js'
import { trackOpenSession } from './tasks.js'
import { normalizeDestination, saveSession } from './runtime.js'
import type { Runtime } from './runtime.js'
import type { SessionRecord } from './store.js'
import { normalizeSource } from './withdraw.js'

export type CreatedSession = { id: string; clientSecret: string; expiresAt: string }

export async function createSession(rt: Runtime, input: CreateSessionInput): Promise<CreatedSession> {
  const id = `ors_${randomHex(12)}`
  const secret = randomHex(24)
  const now = Date.now()
  const expiresAt = now + (input.ttlMinutes ?? 30) * 60_000
  const direction = input.direction ?? 'deposit'
  if (direction !== 'deposit' && direction !== 'withdraw') throw new OrkException(orkError('BAD_REQUEST', { message: '`direction` must be "deposit" or "withdraw".' }), 400)
  if (input.destination?.type === 'crypto' && input.destination.calls?.length) {
    throw new OrkException(orkError('BAD_REQUEST', { message: 'Contract calls after delivery (`destination.calls`) are not supported yet.' }), 400)
  }
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
  await rt.store.put(rec)
  await trackOpenSession(rt, rec.id)
  await notify(rt, rec, 'session.created')
  return { id, clientSecret: `${id}.${secret}`, expiresAt: new Date(expiresAt).toISOString() }
}

/** Load a session from a `Bearer <id>.<secret>` header. Expires an open session past its deadline. */
export async function loadAuthed(rt: Runtime, req: Request, id: string): Promise<SessionRecord> {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  const [sid, secret] = token.split('.')
  if (!sid || !secret || sid !== id) throw new OrkException(orkError('UNAUTHORIZED'), 401)
  const rec = await rt.store.get(id)
  if (!rec || !safeEqual(rec.secretHash, await sha256Hex(secret))) throw new OrkException(orkError('UNAUTHORIZED'), 401)
  if (Date.now() > rec.expiresAt && !isTerminal(rec.step.state) && rec.status === 'open') {
    rec.status = 'expired'
    rec.step = { sessionId: rec.id, state: 'EXPIRED', transitions: [], error: orkError('SESSION_EXPIRED') }
    await saveSession(rt, rec)
    await notify(rt, rec, 'session.expired')
  }
  return rec
}
