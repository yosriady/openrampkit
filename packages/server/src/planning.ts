import { OrkException, currencyForCountry, orkError, planPathways, rankQuotes } from '@openrampkit/core'
import type { Amount, Fee, LegQuote, OrkError, Pathway, PlanResult, Quote, SurfaceKind } from '@openrampkit/core'
import { ALL_SURFACES, MAX_QUOTED_PATHWAYS, MAX_STORED_QUOTES } from './config.js'
import { randomHex } from './crypto.js'
import { adapterContext, withTimeout } from './runtime.js'
import type { Runtime } from './runtime.js'
import { scopedKV } from './store.js'
import type { SessionRecord, StoredQuote } from './store.js'

export type PlanBody = { walletConnected?: boolean; surfaces?: SurfaceKind[] }
export type QuotesBody = { method: string; amount: string; amountSide?: 'source' | 'destination'; source?: { chain: string; token: string } }
type Source = { chain: string; token: string; address?: string }

/** Collect leg specs (live catalogs when available), run the planner, apply the session's method allow list. */
export async function plan(rt: Runtime, rec: SessionRecord, body: PlanBody): Promise<PlanResult> {
  const currency = rec.destination.type === 'merchant' ? rec.destination.currency : currencyForCountry(rec.country)
  const legs = []
  for (const a of rt.adapters.values()) {
    let specs = a.legs
    if (a.catalog) {
      try {
        specs = await a.catalog(
          { ...(rec.country ? { country: rec.country } : {}), currency, direction: rec.direction },
          { fetch: rt.fetch, log: rt.log, shared: scopedKV(rt.store, `a:${a.id}`) },
        )
      } catch (e) {
        rt.log.warn(`catalog failed for ${a.id}, using static legs`, { error: String(e) })
      }
    }
    for (const spec of specs) legs.push({ adapterId: a.id, provider: a.name, spec })
  }
  const result = planPathways({
    direction: rec.direction,
    destination: rec.destination,
    user: { ...(rec.country ? { country: rec.country } : {}), ...(rec.region ? { region: rec.region } : {}), walletConnected: !!body.walletConnected },
    legs,
    policy: { ...rt.config.policy, clientSurfaces: body.surfaces ?? ALL_SURFACES },
  })
  if (rec.allowedMethods) {
    const allowed = new Set(rec.allowedMethods)
    result.methods = result.methods.filter((m) => allowed.has(m.method))
    result.pathways = result.pathways.filter((p) => allowed.has(p.method))
  }
  rec.plan = result
  rec.walletConnected = !!body.walletConnected
  return result
}

/**
 * Where each leg must deliver. The last leg delivers to the destination. A bridge leg with
 * `prepareDeposit` gives the address the previous leg must deliver to (e.g. a Relay open deposit address).
 */
async function deliveryAddresses(rt: Runtime, rec: SessionRecord, p: Pathway): Promise<Array<{ address: string } | undefined>> {
  const deliverTo: Array<{ address: string } | undefined> = p.legs.map(() => undefined)
  if (rec.destination.type === 'crypto') deliverTo[p.legs.length - 1] = { address: rec.destination.address }
  for (let i = p.legs.length - 1; i > 0; i--) {
    const a = rt.adapter(p.legs[i]!.adapterId)
    if (a.prepareDeposit) {
      const d = await a.prepareDeposit({ leg: p.legs[i]! }, adapterContext(rt, rec, a, p, i))
      deliverTo[i - 1] = { address: d.address }
    }
  }
  return deliverTo
}

/**
 * Quote every leg of a pathway in order; the output of leg n is the input of leg n+1.
 * `destination` amounts are only supported on one-leg pathways (a chained exact-output quote
 * would need a reverse pass); multi-leg pathways quote the given amount as the source amount.
 */
export async function quotePathway(rt: Runtime, rec: SessionRecord, p: Pathway, amount: string, side: 'source' | 'destination', source?: Source): Promise<{ quote: Quote; stored: StoredQuote }> {
  const deliverTo = await deliveryAddresses(rt, rec, p)
  const legQuotes: LegQuote[] = []
  if (side === 'destination' && p.legs.length === 1) {
    const leg = p.legs[0]!
    const a = rt.adapter(leg.adapterId)
    legQuotes.push(
      await a.quote(
        { leg, amountOut: { amount, asset: leg.to.asset }, ...(deliverTo[0] ? { deliverTo: deliverTo[0] } : {}), ...(source ? { source } : {}) },
        adapterContext(rt, rec, a, p, 0),
      ),
    )
  } else {
    let nextIn: Amount | undefined
    for (let i = 0; i < p.legs.length; i++) {
      const leg = p.legs[i]!
      const a = rt.adapter(leg.adapterId)
      const amountIn: Amount =
        i === 0 ? { amount, asset: source && leg.from.asset.kind === 'crypto' ? { kind: 'crypto', chain: source.chain, token: source.token } : leg.from.asset } : nextIn!
      const q = await a.quote(
        { leg, amountIn, ...(deliverTo[i] ? { deliverTo: deliverTo[i]! } : {}), ...(i === 0 && source ? { source } : {}) },
        adapterContext(rt, rec, a, p, i),
      )
      legQuotes.push(q)
      nextIn = q.output
    }
  }
  const quote = combineLegQuotes(p, legQuotes)
  return { quote, stored: { quote, pathway: p, deliverTo } }
}

export function combineLegQuotes(p: Pathway, legQuotes: LegQuote[]): Quote {
  const first = legQuotes[0]!
  const last = legQuotes[legQuotes.length - 1]!
  const fees: Fee[] = legQuotes.flatMap((q) => q.fees)
  const expiries = legQuotes.map((q) => q.expiresAt).filter((x): x is string => !!x).sort()
  return {
    id: `q_${randomHex(8)}`,
    pathwayId: p.id,
    method: p.method,
    provider: p.provider,
    legs: legQuotes,
    input: first.input,
    output: last.output,
    fees,
    eta: legQuotes.reduce((acc, q) => ({ min: acc.min + q.eta.min, max: acc.max + q.eta.max }), { min: 0, max: 0 }),
    ...(expiries.length ? { expiresAt: expiries[0]! } : {}),
  }
}

/** Quote up to MAX_QUOTED_PATHWAYS pathways for a method in parallel. Failures become errors, not exceptions. */
export async function quotes(rt: Runtime, rec: SessionRecord, body: QuotesBody): Promise<{ quotes: Quote[]; errors: OrkError[] }> {
  if (!rec.plan) await plan(rt, rec, { walletConnected: rec.walletConnected ?? false })
  const candidates = rec.plan!.pathways.filter((p) => p.method === body.method && p.group !== 'unavailable')
  if (!candidates.length) throw new OrkException(orkError('NO_QUOTES'), 422)
  const source = body.source ? { ...body.source, ...(rec.walletAddress ? { address: rec.walletAddress } : {}) } : undefined
  const timeout = rt.config.timeouts?.quote ?? 9000
  const settled = await Promise.allSettled(
    candidates.slice(0, MAX_QUOTED_PATHWAYS).map((p) => withTimeout(quotePathway(rt, rec, p, body.amount, body.amountSide ?? 'source', source), timeout)),
  )
  const out: Quote[] = []
  const errors: OrkError[] = []
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      out.push(s.value.stored.quote)
      rec.quotes[s.value.stored.quote.id] = s.value.stored
    } else {
      const reason = s.reason as unknown
      const message = reason instanceof Error ? reason.message : String(reason)
      errors.push(reason instanceof OrkException ? reason.error : orkError('PROVIDER_UNAVAILABLE', { message: message.slice(0, 200) }))
      rt.log.warn('quote failed', { error: message })
    }
  }
  pruneQuotes(rec)
  return { quotes: rankQuotes(out), errors }
}

function pruneQuotes(rec: SessionRecord) {
  const keys = Object.keys(rec.quotes)
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_STORED_QUOTES))) delete rec.quotes[k]
}
