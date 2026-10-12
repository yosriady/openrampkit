// Provider health: small counters per adapter in the store's KV space, for ranking, the circuit
// breaker, start failover and the admin view. All of it is best effort: a store error never fails or
// blocks a request, it only makes the numbers less complete.

import { OpenRampException, openRampError } from '@openrampkit/core'
import type { OpenRampError, OpenRampErrorCode } from '@openrampkit/core'
import type { Runtime } from './runtime.js'

/** The counts of one adapter in one hour, or summed over a window */
export type HealthCounts = {
  quoteOk: number
  /** Quotes that threw a provider error or timed out (not the codes in `NOT_PROVIDER_FAILURE`) */
  quoteFail: number
  startOk: number
  startFail: number
  legSucceeded: number
  legFailed: number
}

export type BreakerState = 'closed' | 'open' | 'half_open'

/** What the admin API shows for one adapter */
export type ProviderHealth = {
  adapterId: string
  windowHours: number
  counts: HealthCounts
  /** Share of starts and leg outcomes that went well, or null with fewer than `minSamples` of them */
  successRate: number | null
  /** Share of quotes and starts that failed in the breaker window, or null with fewer than `minSamples` */
  recentFailureRate: number | null
  breaker: { state: BreakerState; openedAt?: string }
}

/**
 * Error codes that are an answer from a working provider, not a provider failure: the amount, the
 * region, the user or the request is the problem. They do not count as failures, and a start that
 * throws one never fails over to another provider.
 */
export const NOT_PROVIDER_FAILURE: ReadonlySet<OpenRampErrorCode> = new Set<OpenRampErrorCode>([
  'REGION_UNSUPPORTED',
  'AMOUNT_TOO_LOW',
  'AMOUNT_TOO_HIGH',
  'NO_QUOTES',
  'QUOTE_EXPIRED',
  'PROVIDER_DECLINED',
  'KYC_REJECTED',
  'BAD_REQUEST',
  'ADDRESS_REJECTED',
  'DESTINATION_NOT_ALLOWED',
  'DESTINATION_LOCKED',
  'CLIENT_UPGRADE_REQUIRED',
  'SESSION_EXPIRED',
  'CANCELED',
  'CONFLICT',
])

/**
 * Leg failure codes that are about the user, not the provider: the codes above, and a payment that the
 * user's bank or card refused (`PAYMENT_FAILED`). A failed leg with one of them does not count as a
 * provider failure. A failed leg with no error counts.
 */
export const LEG_NOT_PROVIDER_FAILURE: ReadonlySet<OpenRampErrorCode> = new Set<OpenRampErrorCode>([...NOT_PROVIDER_FAILURE, 'PAYMENT_FAILED'])

/**
 * Count a leg's final outcome once. A save that is retried after a conflict runs `setLegStep` again, so
 * an atomic mark per session, attempt and leg keeps the count at one. A failure counts only when its
 * error points to the provider (see LEG_NOT_PROVIDER_FAILURE). Never throws.
 */
export async function recordLegOutcome(
  rt: Runtime,
  ids: { sessionId: string; attempt: number; index: number; adapterId: string },
  status: 'succeeded' | 'failed',
  error?: OpenRampError,
): Promise<void> {
  if (status === 'failed' && error && LEG_NOT_PROVIDER_FAILURE.has(error.code)) return
  try {
    const key = `healthleg:${ids.sessionId}:${ids.attempt}:${ids.index}`
    const ttl = routingOptions(rt).windowHours * 3600
    const kv = rt.store.kv
    if (kv.putIfAbsent) {
      if (!(await kv.putIfAbsent(key, status, ttl))) return
    } else {
      if (await kv.get(key)) return
      await kv.put(key, status, ttl)
    }
  } catch {
    return
  }
  await recordHealth(rt, ids.adapterId, status === 'succeeded' ? { legSucceeded: 1 } : { legFailed: 1 })
}

/** Defaults of `routing` */
export const DEFAULT_HEALTH_WINDOW_HOURS = 24
export const DEFAULT_MIN_SAMPLES = 20
export const DEFAULT_BREAKER_FAILURE_RATE = 0.8
export const DEFAULT_BREAKER_COOLDOWN_MINUTES = 10
/** The breaker reads the current and the previous hour, so it reacts to an outage in minutes, not in a day. */
const BREAKER_HOURS = 2
const HOUR_MS = 60 * 60_000

type Hourly = Partial<HealthCounts>
/** One KV value per adapter: the hourly buckets of the window, keyed by hour number (ms / 1 h). */
type HealthRecord = { hours: Record<string, Hourly> }
/** `openedAt`: open since then. `closedAt`: a probe closed it; `base` holds the counts of the breaker window at that time. */
type BreakerRecord = { openedAt?: number; closedAt?: number; base?: Record<string, { fail: number; total: number }> }

const healthKey = (id: string) => `health:${id}`
const breakerKey = (id: string) => `health:${id}:breaker`
const probeKey = (id: string) => `health:${id}:probe`
const hourOf = (t: number) => Math.floor(t / HOUR_MS)

export function routingOptions(rt: Runtime) {
  const r = rt.config.routing ?? {}
  const rate = r.breakerFailureRate ?? DEFAULT_BREAKER_FAILURE_RATE
  return {
    windowHours: Math.max(1, Math.floor(r.healthWindowHours ?? DEFAULT_HEALTH_WINDOW_HOURS)),
    minSamples: Math.max(1, r.minSamples ?? DEFAULT_MIN_SAMPLES),
    breakerFailureRate: rate,
    // A failure rate is never above 1, so `breakerFailureRate: 1` also turns the breaker off.
    breaker: r.breaker !== false && rate < 1,
    cooldownMs: Math.max(1, r.breakerCooldownMinutes ?? DEFAULT_BREAKER_COOLDOWN_MINUTES) * 60_000,
  }
}

/** True when an error from an adapter call counts as a provider failure (see `NOT_PROVIDER_FAILURE`). */
export function isProviderFailure(e: unknown): boolean {
  return !(e instanceof OpenRampException && NOT_PROVIDER_FAILURE.has(e.error.code))
}

/**
 * True when a failed start may try another provider: PROVIDER_UNAVAILABLE, or another OpenRampError
 * with `retryable: true`, and never a user error (see NOT_PROVIDER_FAILURE). A timeout never fails over:
 * the provider may have made the order (and, for a push payment, asked the user to approve it), so a
 * second provider could charge the user twice.
 */
export function canFailOver(e: unknown): boolean {
  // An adapter maps a provider timeout to PROVIDER_UNAVAILABLE with status 504 (`httpErrorToOpenRamp`).
  if (!(e instanceof OpenRampException) || e.status === 504) return false
  const err: OpenRampError = e.error
  if (NOT_PROVIDER_FAILURE.has(err.code)) return false
  return err.code === 'PROVIDER_UNAVAILABLE' || err.retryable === true
}

/**
 * Add counts to the adapter's current hour. One read and one write, with no lock: two writes at the
 * same time can lose one of the updates. That is acceptable for these numbers. Never throws.
 */
export async function recordHealth(rt: Runtime, adapterId: string, delta: Hourly): Promise<void> {
  try {
    const { windowHours } = routingOptions(rt)
    const now = hourOf(Date.now())
    const rec = (await rt.store.kv.get<HealthRecord>(healthKey(adapterId))) ?? { hours: {} }
    const hours: Record<string, Hourly> = {}
    // Keep only the hours of the window, so the value stays small.
    for (const [h, c] of Object.entries(rec.hours ?? {})) if (Number(h) > now - windowHours) hours[h] = c
    const cur: Hourly = { ...hours[now] }
    for (const [k, v] of Object.entries(delta) as Array<[keyof HealthCounts, number]>) cur[k] = (cur[k] ?? 0) + v
    hours[now] = cur
    await rt.store.kv.put(healthKey(adapterId), { hours } satisfies HealthRecord, (windowHours + 1) * 3600)
  } catch (e) {
    rt.log.debug('provider health write failed', { adapter: adapterId, error: String(e) })
  }
}

function emptyCounts(): HealthCounts {
  return { quoteOk: 0, quoteFail: 0, startOk: 0, startFail: 0, legSucceeded: 0, legFailed: 0 }
}

/** Read the adapter's hourly buckets. An error reads as no data. */
async function readHours(rt: Runtime, adapterId: string): Promise<Record<string, Hourly>> {
  try {
    return (await rt.store.kv.get<HealthRecord>(healthKey(adapterId)))?.hours ?? {}
  } catch {
    return {}
  }
}

async function readBreaker(rt: Runtime, adapterId: string): Promise<BreakerRecord | undefined> {
  try {
    return (await rt.store.kv.get<BreakerRecord>(breakerKey(adapterId))) ?? undefined
  } catch {
    return undefined
  }
}

/** Sum of the buckets of the last `n` hours */
function sumHours(hours: Record<string, Hourly>, n: number): HealthCounts {
  const now = hourOf(Date.now())
  const out = emptyCounts()
  for (const [h, c] of Object.entries(hours)) {
    if (Number(h) <= now - n || Number(h) > now) continue
    for (const k of Object.keys(out) as Array<keyof HealthCounts>) out[k] += c[k] ?? 0
  }
  return out
}

/** Starts and leg outcomes that went well, out of all of them. Undefined with too few samples. */
function successRateOf(c: HealthCounts, minSamples: number): number | undefined {
  const ok = c.startOk + c.legSucceeded
  const n = ok + c.startFail + c.legFailed
  return n >= minSamples ? ok / n : undefined
}

/** Quote and start counts per hour of the breaker window */
function breakerHours(hours: Record<string, Hourly>): Record<string, { fail: number; total: number }> {
  const now = hourOf(Date.now())
  const out: Record<string, { fail: number; total: number }> = {}
  for (let h = now - BREAKER_HOURS + 1; h <= now; h++) {
    const c = hours[h] ?? {}
    const fail = (c.quoteFail ?? 0) + (c.startFail ?? 0)
    out[h] = { fail, total: fail + (c.quoteOk ?? 0) + (c.startOk ?? 0) }
  }
  return out
}

/**
 * The failure rate of quotes and starts in the breaker window. After a probe closed the breaker, the
 * counts from before that time (`base`) do not count, so old failures cannot open it again at once.
 */
function recentFailureRate(hours: Record<string, Hourly>, b: BreakerRecord | undefined, minSamples: number): number | undefined {
  let fail = 0
  let total = 0
  for (const [h, c] of Object.entries(breakerHours(hours))) {
    const base = b?.closedAt ? b.base?.[h] : undefined
    fail += Math.max(0, c.fail - (base?.fail ?? 0))
    total += Math.max(0, c.total - (base?.total ?? 0))
  }
  return total >= minSamples ? fail / total : undefined
}

/**
 * The recent success rate of each adapter, for ranking (see `rankQuotes`). An adapter with fewer than
 * `routing.minSamples` starts and leg outcomes in the window has no rate (undefined).
 */
export async function successRates(rt: Runtime, adapterIds: string[]): Promise<Map<string, number | undefined>> {
  const { windowHours, minSamples } = routingOptions(rt)
  const out = new Map<string, number | undefined>()
  await Promise.all(adapterIds.map(async (id) => out.set(id, successRateOf(sumHours(await readHours(rt, id), windowHours), minSamples))))
  return out
}

/**
 * Circuit breaker gate for one adapter before a quote:
 * - `closed`: quote it.
 * - `open`: skip it (no network call). It opens when the recent failure rate of quotes and starts is above
 *   `breakerFailureRate` with at least `minSamples` samples, and stays open for the cool-down.
 * - `probe`: the cool-down is over. This request may quote it once (half open). Report the result with
 *   `breakerProbeResult`. Other requests skip it until the probe result closes or opens the breaker again,
 *   or until the probe claim ends after one cool-down.
 * Never throws: a store error reads as `closed`.
 */
export async function breakerGate(rt: Runtime, adapterId: string): Promise<'closed' | 'open' | 'probe'> {
  const o = routingOptions(rt)
  if (!o.breaker) return 'closed'
  try {
    const b = await readBreaker(rt, adapterId)
    if (b?.openedAt) {
      if (Date.now() - b.openedAt < o.cooldownMs) return 'open'
      return (await claimProbe(rt, adapterId, o.cooldownMs)) ? 'probe' : 'open'
    }
    const rate = recentFailureRate(await readHours(rt, adapterId), b, o.minSamples)
    if (rate !== undefined && rate > o.breakerFailureRate) {
      await rt.store.kv.put(breakerKey(adapterId), { openedAt: Date.now() } satisfies BreakerRecord, o.windowHours * 3600)
      rt.log.warn('provider circuit breaker opened: too many recent failures', { adapter: adapterId, failureRate: rate })
      rt.metric('breaker.opened', 1, { adapter: adapterId })
      return 'open'
    }
    return 'closed'
  } catch (e) {
    rt.log.debug('provider breaker check failed', { adapter: adapterId, error: String(e) })
    return 'closed'
  }
}

/** One probe per cool-down, across server instances where the store has `putIfAbsent`. */
async function claimProbe(rt: Runtime, adapterId: string, cooldownMs: number): Promise<boolean> {
  const kv = rt.store.kv
  const ttl = Math.max(60, Math.ceil(cooldownMs / 1000))
  if (kv.putIfAbsent) return kv.putIfAbsent(probeKey(adapterId), 1, ttl)
  // Workers KV has no atomic write: two instances may both probe. That is acceptable.
  if (await kv.get(probeKey(adapterId))) return false
  await kv.put(probeKey(adapterId), 1, ttl)
  return true
}

/**
 * The result of a half-open probe. A provider that answered closes the breaker. A provider failure
 * opens it again for one more cool-down. Never throws.
 */
export async function breakerProbeResult(rt: Runtime, adapterId: string, ok: boolean): Promise<void> {
  try {
    const { windowHours } = routingOptions(rt)
    if (ok) {
      const base = breakerHours(await readHours(rt, adapterId))
      await rt.store.kv.put(breakerKey(adapterId), { closedAt: Date.now(), base } satisfies BreakerRecord, (BREAKER_HOURS + 1) * 3600)
      rt.log.info('provider circuit breaker closed after a good probe', { adapter: adapterId })
      rt.metric('breaker.closed', 1, { adapter: adapterId })
    } else {
      await rt.store.kv.put(breakerKey(adapterId), { openedAt: Date.now() } satisfies BreakerRecord, windowHours * 3600)
    }
  } catch (e) {
    rt.log.debug('provider breaker write failed', { adapter: adapterId, error: String(e) })
  }
}

/** The health of every configured adapter, for operators (`admin.providers()`, `GET /admin/providers`). */
export async function providerHealth(rt: Runtime): Promise<ProviderHealth[]> {
  const o = routingOptions(rt)
  return Promise.all(
    [...rt.adapters.keys()].map(async (adapterId): Promise<ProviderHealth> => {
      const [hours, b] = await Promise.all([readHours(rt, adapterId), readBreaker(rt, adapterId)])
      const counts = sumHours(hours, o.windowHours)
      const open = o.breaker && !!b?.openedAt
      const state: BreakerState = !open ? 'closed' : Date.now() - b!.openedAt! < o.cooldownMs ? 'open' : 'half_open'
      return {
        adapterId,
        windowHours: o.windowHours,
        counts,
        successRate: successRateOf(counts, o.minSamples) ?? null,
        recentFailureRate: recentFailureRate(hours, b, o.minSamples) ?? null,
        breaker: { state, ...(open ? { openedAt: new Date(b!.openedAt!).toISOString() } : {}) },
      }
    }),
  )
}

/** The error a quote gets for an adapter that the breaker skipped */
export function breakerError(provider: string): OpenRampError {
  return openRampError('PROVIDER_UNAVAILABLE', { message: `${provider} is not available right now. Try another method.`, recovery: 'choose_other' })
}
