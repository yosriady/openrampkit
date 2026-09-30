import { ADAPTER_API_VERSION } from '@openrampkit/adapter'
import type { Adapter, AdapterContext, Logger } from '@openrampkit/adapter'
import { OrkException, orkError } from '@openrampkit/core'
import type { Destination, Pathway, PublicSession, SessionResult } from '@openrampkit/core'
import { consoleLogger } from './config.js'
import type { OpenRampConfig } from './config.js'
import { memoryStore, scopedKV, VersionConflictError } from './store.js'
import type { SessionRecord, SessionStore } from './store.js'

/** Everything the server modules share. Built once per `createOpenRamp` call. */
export type Runtime = {
  config: OpenRampConfig
  store: SessionStore
  log: Logger
  fetch: typeof fetch
  /** Public base URL without trailing slash */
  base: string
  /** Path part of `base`, stripped from incoming request paths */
  basePath: string
  adapters: Map<string, Adapter>
  livemode: boolean
  adapter(id: string): Adapter
}

export function createRuntime(config: OpenRampConfig): Runtime {
  if (!config.secret || config.secret.length < 32) throw new Error('OpenRamp: `secret` must be at least 32 characters')
  // An empty or short key makes a signature or a bearer token easy to guess.
  if (config.webhooks && (typeof config.webhooks.secret !== 'string' || config.webhooks.secret.length < 16)) {
    throw new Error('OpenRamp: `webhooks.secret` must be at least 16 characters')
  }
  if (config.tasksToken !== undefined && (typeof config.tasksToken !== 'string' || config.tasksToken.length < 16)) {
    throw new Error('OpenRamp: `tasksToken` must be at least 16 characters')
  }
  const ids = new Set<string>()
  for (const a of config.adapters) {
    if (a.apiVersion !== ADAPTER_API_VERSION) throw new Error(`OpenRamp: adapter ${a.id} targets API v${a.apiVersion}, server supports v${ADAPTER_API_VERSION}`)
    if (ids.has(a.id)) throw new Error(`OpenRamp: adapter id ${a.id} is configured twice`)
    ids.add(a.id)
  }
  if (config.treasury && !config.treasury.address) {
    ;(config.logger ?? consoleLogger).warn('treasury has no `address`: quotes for app-custody withdrawals use a placeholder sender. Set treasury.address.')
  }
  const base = config.baseUrl.replace(/\/$/, '')
  const adapters = new Map(config.adapters.map((a) => [a.id, a]))
  return {
    config,
    store: config.store ?? memoryStore(),
    log: config.logger ?? consoleLogger,
    fetch: config.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args)),
    base,
    basePath: new URL(base).pathname.replace(/\/$/, ''),
    adapters,
    livemode: config.livemode ?? false,
    adapter(id) {
      const a = adapters.get(id)
      if (!a) throw new OrkException(orkError('INTERNAL', { message: `Adapter ${id} is not configured` }), 500)
      return a
    },
  }
}

export function adapterContext(rt: Runtime, rec: SessionRecord, a: Adapter, pathway: Pathway, index: number): AdapterContext {
  return {
    session: {
      id: rec.id,
      userId: rec.userId,
      direction: rec.direction,
      ...(rec.country ? { country: rec.country } : {}),
      locale: rec.locale ?? 'en',
      livemode: rec.livemode,
      ...(rec.email ? { email: rec.email } : {}),
      ...(rec.region ? { region: rec.region } : {}),
      ...(rec.ip ? { ip: rec.ip } : {}),
    },
    destination: destinationOf(rec),
    pathway: { legs: pathway.legs, index },
    urls: { returnUrl: rt.config.returnUrl ?? `${rt.base}/return`, webhookUrl: `${rt.base}/webhooks/${a.id}` },
    store: scopedKV(rt.store, `a:${a.id}:${rec.id}`),
    shared: scopedKV(rt.store, `a:${a.id}`),
    fetch: rt.fetch,
    log: rt.log,
    idempotencyKey: (scope) => `${rec.id}:${scope}`,
  }
}

/** Persist with an optimistic version check. A concurrent change becomes a 409 the client can retry. */
export async function saveSession(rt: Runtime, rec: SessionRecord): Promise<void> {
  const expected = rec.version
  rec.version += 1
  try {
    await rt.store.put(rec, expected)
  } catch (e) {
    rec.version -= 1
    if (e instanceof VersionConflictError) throw new OrkException(orkError('CONFLICT'), 409)
    throw e
  }
}

export function publicSession(rec: SessionRecord): PublicSession {
  return {
    id: rec.id,
    direction: rec.direction,
    ...(rec.destination ? { destination: rec.destination } : {}),
    ...(rec.source ? { source: rec.source } : {}),
    ...(rec.allowedTargets ? { allowedTargets: rec.allowedTargets } : {}),
    status: rec.status,
    ...(rec.country ? { country: rec.country } : {}),
    ...(rec.plan ? { currency: rec.plan.currency } : {}),
    ...(rec.locale ? { locale: rec.locale } : {}),
    ...(rec.amountBounds ? { amountBounds: rec.amountBounds } : {}),
    step: rec.step,
    ...(rec.active ? { result: sessionResult(rec) } : {}),
    expiresAt: new Date(rec.expiresAt).toISOString(),
    livemode: rec.livemode,
  }
}

/** What was paid and delivered so far, from the active pathway's quotes and leg steps. */
export function sessionResult(rec: SessionRecord): SessionResult {
  const act = rec.active!
  const first = act.legs[0]!
  const last = act.legs[act.legs.length - 1]!
  const reported = last.step?.output
  return {
    method: act.pathway.method,
    provider: act.pathway.provider,
    input: first.quote.input,
    output: reported ?? last.quote.output,
    outputConfirmed: !!reported,
    fees: act.legs.flatMap((l) => l.quote.fees),
    txHashes: act.legs.map((l) => l.step?.txHash).filter((h): h is string => !!h),
  }
}

/** The session destination. A withdraw session has one only after the user picks a target. */
export function destinationOf(rec: SessionRecord): Destination {
  if (!rec.destination) throw new OrkException(orkError('BAD_REQUEST', { message: 'Choose where to send the funds first.' }), 409)
  return rec.destination
}

export function normalizeDestination(d: Destination): Destination {
  if (d.type === 'crypto') return { ...d, token: d.token.toLowerCase(), ...(d.settlement ? { settlement: { contract: d.settlement.contract.toLowerCase() } } : {}) }
  return { ...d, currency: d.currency.toUpperCase() }
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timed out after ${ms} ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}
