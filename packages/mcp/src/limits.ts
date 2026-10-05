// Limits across sessions: how many sessions per hour, and how much per day. Counters live in the
// session registry, so all MCP server instances that share one registry share the limits.
// Windows are fixed UTC hours and UTC days. Each session counts its largest amount (its max bound).

import { cmp, sub } from '@openrampkit/core'
import { RampError } from './backend.js'
import type { SessionRegistry } from './registry.js'

export type Limits = {
  /**
   * Largest total per UTC day, by currency code or token symbol, e.g. `{ USDC: '500' }`.
   * Each session counts its largest amount. Payouts and deposits have separate totals.
   * When set, it must list every currency of `maxAmounts`.
   */
  maxTotalPerDay?: Record<string, string>
  /** Most sessions the agent can create in one UTC hour (deposits and payouts together). */
  maxSessionsPerHour?: number
}

const HOUR = 3_600_000
const DAY = 86_400_000

type Direction = 'deposit' | 'withdraw'

/** Undo a reservation. Safe to call more than once. */
export type Release = () => Promise<void>

export function createLimiter(limits: Limits | undefined, registry: SessionRegistry) {
  const perDay = limits?.maxTotalPerDay
  const perHour = limits?.maxSessionsPerHour
  const on = !!(perDay || perHour !== undefined)
  if (on && !registry.incr) throw new Error('OpenRamp MCP: `limits` needs a registry with `incr` (counters). `memoryRegistry()` has one.')

  /**
   * Count one session and its largest amount. Throws `LIMIT_REACHED` (429) and counts nothing
   * when a limit would be passed. Returns a function that undoes the count.
   */
  async function reserve(direction: Direction, currency: string, amount: string): Promise<Release> {
    if (!on) return async () => {}
    const incr = registry.incr!.bind(registry)
    const now = Date.now()
    const undo: Array<() => Promise<unknown>> = []
    const release: Release = async () => {
      const steps = undo.splice(0)
      for (const u of steps) await u().catch(() => {})
    }
    try {
      if (perHour !== undefined) {
        const key = `openrampkit_mcp:sessions:${new Date(now).toISOString().slice(0, 13)}`
        const n = await incr(key, '1', HOUR + 60_000)
        undo.push(() => incr(key, '-1', HOUR + 60_000))
        if (cmp(n, String(perHour)) > 0) {
          throw new RampError('LIMIT_REACHED', `The limit of ${perHour} sessions per hour is reached. Try again after ${nextHour(now)}. Do not retry before then.`, 429)
        }
      }
      if (perDay) {
        const capKey = Object.keys(perDay).find((k) => k.toUpperCase() === currency.toUpperCase())
        const cap = capKey ? perDay[capKey]! : undefined
        if (cap !== undefined) {
          const key = `openrampkit_mcp:total:${direction}:${new Date(now).toISOString().slice(0, 10)}:${capKey}`
          const total = await incr(key, amount, DAY + 60_000)
          undo.push(() => incr(key, `-${amount}`, DAY + 60_000))
          if (cmp(total, cap) > 0) {
            const left = sub(cap, sub(total, amount))
            const what = direction === 'withdraw' ? 'payouts' : 'deposits'
            throw new RampError(
              'LIMIT_REACHED',
              `The daily limit for ${what} is ${cap} ${capKey}. ${cmp(left, '0') > 0 ? `Only ${left} ${capKey} is left today.` : 'Nothing is left today.'} Try again after ${nextDay(now)}, or ask the operator.`,
              429,
            )
          }
        }
      }
    } catch (e) {
      await release()
      throw e
    }
    return release
  }

  return { reserve }
}

const nextHour = (now: number) => new Date(Math.floor(now / HOUR) * HOUR + HOUR).toISOString()
const nextDay = (now: number) => new Date(Math.floor(now / DAY) * DAY + DAY).toISOString()
