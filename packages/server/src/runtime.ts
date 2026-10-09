import { ADAPTER_API_VERSION, resultChannels } from '@openrampkit/adapter'
import type { Adapter, AdapterContext, Logger } from '@openrampkit/adapter'
import { OrkException, normalizeToken, orkError } from '@openrampkit/core'
import type { Destination, Pathway, PublicSession, SessionResult } from '@openrampkit/core'
import { consoleLogger } from './config.js'
import type { OpenRampConfig } from './config.js'
import { memoryStore, migratingStore, scopedKV, VersionConflictError } from './store.js'
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
  /** Report one metric to `config.telemetry`. Never throws. */
  metric(name: string, value: number, tags?: Record<string, string>): void
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
  if (config.admin?.token !== undefined && (typeof config.admin.token !== 'string' || config.admin.token.length < 32)) {
    throw new Error('OpenRamp: `admin.token` must be at least 32 characters')
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
  warnNoResultChannel(config.adapters, config.logger ?? consoleLogger)
  checkAdapterEnvs(config.adapters, config.livemode ?? false, config.logger ?? consoleLogger)
  const base = config.baseUrl.replace(/\/$/, '')
  const adapters = new Map(config.adapters.map((a) => [a.id, a]))
  return {
    config,
    // Every read brings an older record up to the current schema (see `migrateRecord`).
    store: migratingStore(config.store ?? memoryStore()),
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
    metric(name, value, tags = {}) {
      const t = config.telemetry
      if (!t) return
      try {
        t.onMetric(name, value, tags)
      } catch {
        // A metrics failure must never break a payment.
      }
    },
  }
}

/**
 * Check each adapter's provider environment (`adapter.env`) against `livemode`:
 * - `livemode: true` with an adapter in `sandbox`: throw. Live sessions must never use test providers
 *   (a test payment would complete a live session).
 * - `livemode: false` with an adapter in `production`: warn. Test sessions then call providers that move real money.
 * An adapter with no `env` follows each session's `livemode` and is not checked.
 */
function checkAdapterEnvs(adapters: Adapter[], livemode: boolean, log: Logger): void {
  if (livemode) {
    const sandbox = adapters.filter((a) => a.env === 'sandbox').map((a) => a.id)
    if (sandbox.length) {
      throw new Error(`OpenRamp: livemode is true, but these adapters use their sandbox environment: ${sandbox.join(', ')}. Set env: 'production' with live keys, or remove them.`)
    }
    return
  }
  const production = adapters.filter((a) => a.env === 'production').map((a) => a.id)
  if (production.length) {
    log.warn(`OpenRamp: livemode is false, but these adapters use their production environment and can move real money: ${production.join(', ')}. Set env: 'sandbox' for tests, or livemode: true in production.`, { adapters: production })
  }
}

/**
 * Warn once at start for each adapter with legs that has no way to learn a leg's result: no `status()`
 * to poll and no webhook that can verify (for example Transak with no `status()`, or an adapter whose
 * webhook secret is not set). Its payments would wait in PAYMENT or PROCESSING until they expire.
 */
function warnNoResultChannel(adapters: Adapter[], log: Logger): void {
  for (const a of adapters) {
    if (!a.legs.length) continue
    const { polling, webhooks } = resultChannels(a)
    if (polling || webhooks) continue
    const why = a.webhook ? 'its webhook is not configured (set the webhook secret in its options)' : 'it has no webhook'
    log.warn(
      `OpenRamp: adapter ${a.id} cannot learn the result of its legs (${a.legs.map((l) => l.id).join(', ')}): it has no status() polling, and ${why}. Its payments will not complete.`,
      { adapter: a.id },
    )
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

/** Persist with an optimistic version check. A concurrent change becomes a 409 the client can retry. Use `saveSession` (outbox.ts), which also delivers new webhook events. */
export async function putVersioned(rt: Runtime, rec: SessionRecord): Promise<void> {
  const expected = rec.version
  const updatedAt = rec.updatedAt
  rec.version += 1
  rec.updatedAt = Date.now()
  try {
    await rt.store.put(rec, expected)
  } catch (e) {
    rec.version -= 1
    if (updatedAt === undefined) delete rec.updatedAt
    else rec.updatedAt = updatedAt
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
    ...(rec.targetLocked ? { targetLocked: true } : {}),
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
  // The last leg with a shortfall: what arrived at the end is what matters most.
  let k = act.legs.length - 1
  while (k >= 0 && !act.legs[k]!.amountMismatch) k--
  const mismatch = k === -1 ? undefined : act.legs[k]!.amountMismatch!
  const sourceTxHashes = act.legs.map((l) => l.step?.sourceTxHash).filter((h): h is string => !!h)
  return {
    method: act.pathway.method,
    provider: act.pathway.provider,
    input: first.quote.input,
    output: reported ?? last.quote.output,
    // An output in another asset (or not a number) is not a confirmed delivery of the quote.
    outputConfirmed: !!reported && (!last.amountMismatch || last.amountMismatch.reason === 'short'),
    fees: act.legs.flatMap((l) => l.quote.fees),
    txHashes: act.legs.map((l) => l.step?.txHash).filter((h): h is string => !!h),
    ...(sourceTxHashes.length ? { sourceTxHashes } : {}),
    ...(mismatch ? { amountMismatch: { legIndex: k, ...mismatch } } : {}),
  }
}

/** The session destination. A withdraw session has one only after the user picks a target. */
export function destinationOf(rec: SessionRecord): Destination {
  if (!rec.destination) throw new OrkException(orkError('BAD_REQUEST', { message: 'Choose where to send the funds first.' }), 409)
  return rec.destination
}

export function normalizeDestination(d: Destination): Destination {
  if (d.type === 'crypto') return { ...d, token: normalizeToken(d.chain, d.token), ...(d.settlement ? { settlement: { contract: d.settlement.contract.toLowerCase() } } : {}) }
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
