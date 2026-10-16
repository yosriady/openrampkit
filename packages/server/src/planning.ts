import { OpenRampException, currencyForCountry, openRampError, planPathways, rankQuotes, cmp } from '@openrampkit/core'
import type { Amount, Fee, LegQuote, OpenRampError, Pathway, PlanResult, PublicLegQuote, PublicQuote, Quote, QuoteGuarantee, SurfaceKind } from '@openrampkit/core'
import { ALL_SURFACES, DEFAULT_QUOTE_TTL_MS, MAX_QUOTED_PATHWAYS, MAX_STORED_QUOTES } from './config.js'
import { randomHex } from './crypto.js'
import { adapterContext, destinationOf, withTimeout } from './runtime.js'
import type { Runtime } from './runtime.js'
import { scopedKV } from './store.js'
import { depositAddressMethod } from './standing.js'
import type { SessionRecord, StoredQuote } from './store.js'
import { balanceError, readSourceBalance, withdrawSender } from './withdraw.js'
import { breakerError, breakerGate, breakerProbeResult, isProviderFailure, recordHealth, routingOptions, successRates } from './health.js'
import type { HealthCounts } from './health.js'

export type PlanBody = { walletConnected?: boolean; surfaces?: SurfaceKind[] }
export type QuotesBody = { method: string; amount: string; amountSide?: 'source' | 'destination'; source?: { chain: string; token: string } }
type Source = { chain: string; token: string; address?: string }

/**
 * The quote outcomes of one quote request, per adapter, written to provider health once at the end.
 * `inFlight` is the adapter that a pathway is quoting now: when the pathway times out, that adapter
 * gets the failure. Outcomes that arrive after `closed` (a quote that ends after its timeout) are dropped.
 */
type QuoteTally = { counts: Map<string, Partial<HealthCounts>>; closed: boolean }
type PathwayTrack = { tally: QuoteTally; inFlight?: string }

function tallyAdd(t: QuoteTally, adapterId: string, key: 'quoteOk' | 'quoteFail'): void {
  if (t.closed) return
  const c = t.counts.get(adapterId) ?? {}
  c[key] = (c[key] ?? 0) + 1
  t.counts.set(adapterId, c)
}

/** Collect leg specs (live catalogs when available), run the planner, apply the session's method allow list. */
export async function plan(rt: Runtime, rec: SessionRecord, body: PlanBody): Promise<PlanResult> {
  const destination = destinationOf(rec)
  const currency = destination.type === 'crypto' ? currencyForCountry(rec.country) : destination.currency
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
    destination,
    ...(rec.direction === 'withdraw' && rec.source ? { withdraw: { source: rec.source, treasury: !!rt.config.treasury } } : {}),
    user: { ...(rec.country ? { country: rec.country } : {}), ...(rec.region ? { region: rec.region } : {}), walletConnected: !!body.walletConnected },
    legs,
    policy: { ...rt.config.policy, clientSurfaces: body.surfaces ?? ALL_SURFACES },
  })
  if (rec.allowedMethods) {
    const allowed = new Set(rec.allowedMethods)
    result.methods = result.methods.filter((m) => allowed.has(m.method))
    result.pathways = result.pathways.filter((p) => allowed.has(p.method))
  }
  // "Your deposit address" (option `depositAddresses.widget`): a method with no pathway; the widget shows the address.
  const standing = depositAddressMethod(rt, rec)
  if (standing) result.methods.push(standing)
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
  if (rec.destination?.type === 'crypto') deliverTo[p.legs.length - 1] = { address: rec.destination.address }
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
export async function quotePathway(rt: Runtime, rec: SessionRecord, p: Pathway, amount: string, side: 'source' | 'destination', source?: Source, track?: PathwayTrack): Promise<{ quote: Quote; stored: StoredQuote }> {
  const deliverTo = await deliveryAddresses(rt, rec, p)
  const legQuotes: LegQuote[] = []
  if (side === 'destination' && p.legs.length === 1) {
    const leg = p.legs[0]!
    const a = rt.adapter(leg.adapterId)
    legQuotes.push(
      await timed(rt, a.id, track, () => a.quote(
        { leg, amountOut: { value: amount, asset: leg.to.asset }, ...(deliverTo[0] ? { deliverTo: deliverTo[0] } : {}), ...(source ? { source } : {}) },
        adapterContext(rt, rec, a, p, 0),
      )),
    )
  } else {
    let nextIn: Amount | undefined
    for (let i = 0; i < p.legs.length; i++) {
      const leg = p.legs[i]!
      const a = rt.adapter(leg.adapterId)
      const amountIn: Amount =
        i === 0
          ? {
              value: amount,
              // An open-ended crypto source ('*', deposit from a wallet) takes the token the user picked.
              asset: source && leg.from.asset.kind === 'crypto' && leg.from.asset.chain === '*' ? { kind: 'crypto', chain: source.chain, token: source.token } : leg.from.asset,
            }
          : nextIn!
      const q = await timed(rt, a.id, track, () => a.quote(
        { leg, amountIn, ...(deliverTo[i] ? { deliverTo: deliverTo[i]! } : {}), ...(i === 0 && source ? { source } : {}) },
        adapterContext(rt, rec, a, p, i),
      ))
      legQuotes.push(q)
      nextIn = q.output
    }
  }
  const quote = combineLegQuotes(p, legQuotes)
  return { quote, stored: { quote, pathway: p, deliverTo } }
}

/**
 * Run one adapter quote and report its latency (`quote.latency_ms`, tags `adapter` and `ok`). With a
 * `track`, count the outcome for provider health: an error in `NOT_PROVIDER_FAILURE` (for example
 * AMOUNT_TOO_LOW) is an answer, not a failure, so it counts as neither.
 */
async function timed<T>(rt: Runtime, adapter: string, track: PathwayTrack | undefined, run: () => Promise<T>): Promise<T> {
  const t0 = Date.now()
  if (track) track.inFlight = adapter
  try {
    const out = await run()
    rt.metric('quote.latency_ms', Date.now() - t0, { adapter, ok: 'true' })
    if (track) tallyAdd(track.tally, adapter, 'quoteOk')
    return out
  } catch (e) {
    rt.metric('quote.latency_ms', Date.now() - t0, { adapter, ok: 'false' })
    if (track && isProviderFailure(e)) tallyAdd(track.tally, adapter, 'quoteFail')
    throw e
  } finally {
    if (track) track.inFlight = undefined
  }
}

/** The order of quote guarantees, weakest first */
const GUARANTEE_RANK: Record<QuoteGuarantee, number> = { estimate: 0, min_output: 1, firm: 2 }

/**
 * The expiry of a leg quote. A leg quote must have a valid `expiresAt` (adapter contract v2). When a
 * third-party adapter leaves it out or sends no valid date, the quote lives `DEFAULT_QUOTE_TTL_MS`.
 */
function legExpiry(q: LegQuote, now: number): number {
  const at = typeof q.expiresAt === 'string' ? Date.parse(q.expiresAt) : Number.NaN
  return Number.isFinite(at) ? at : now + DEFAULT_QUOTE_TTL_MS
}

/**
 * The pathway quote from its leg quotes. The guarantee is the weakest of the legs: a later leg
 * cannot promise more than the leg that feeds it. `minOutput` and `slippageBps` come from the last
 * leg, and only when the pathway guarantee is not `estimate`. `expiresAt` is the earliest leg expiry.
 */
export function combineLegQuotes(p: Pathway, legQuotes: LegQuote[]): Quote {
  const first = legQuotes[0]!
  const last = legQuotes[legQuotes.length - 1]!
  const fees: Fee[] = legQuotes.flatMap((q) => q.fees)
  const now = Date.now()
  const expiresAt = Math.min(...legQuotes.map((q) => legExpiry(q, now)))
  const guarantee = legQuotes.map((q) => q.guarantee ?? 'estimate').reduce((a, b) => (GUARANTEE_RANK[b] < GUARANTEE_RANK[a] ? b : a))
  const minOutput = guarantee === 'firm' ? last.output : guarantee === 'min_output' ? last.minOutput : undefined
  return {
    id: `q_${randomHex(8)}`,
    pathwayId: p.id,
    method: p.method,
    provider: p.provider,
    legs: legQuotes,
    input: first.input,
    output: last.output,
    guarantee,
    ...(minOutput ? { minOutput } : {}),
    ...(guarantee !== 'estimate' && last.slippageBps !== undefined ? { slippageBps: last.slippageBps } : {}),
    fees,
    eta: legQuotes.reduce((acc, q) => ({ min: acc.min + q.eta.min, max: acc.max + q.eta.max }), { min: 0, max: 0 }),
    expiresAt: new Date(expiresAt).toISOString(),
  }
}

/**
 * The browser view of a quote: each leg without its adapter `data`. That data can hold a provider
 * URL with a session token, a request body, or a nonce that is an idempotency key. It stays in the
 * server store (`StoredQuote`) and goes only to the adapter's `start()`.
 */
export function publicQuote(q: Quote): PublicQuote {
  return { ...q, legs: q.legs.map(publicLegQuote) }
}

function publicLegQuote(l: LegQuote): PublicLegQuote {
  const { data: _data, ...rest } = l
  return rest
}

/**
 * True for the first quote failure of `adapterId` in this session. Atomic with `putIfAbsent`; a store
 * without it (Workers KV) does a read, then a write, so two requests at the same moment can both count.
 */
async function firstFailureOfSession(rt: Runtime, sessionId: string, adapterId: string): Promise<boolean> {
  const key = `healthfail:${sessionId}:${adapterId}`
  const ttl = routingOptions(rt).windowHours * 3600
  try {
    if (rt.store.kv.putIfAbsent) return await rt.store.kv.putIfAbsent(key, 1, ttl)
    if (await rt.store.kv.get(key)) return false
    await rt.store.kv.put(key, 1, ttl)
    return true
  } catch {
    return false
  }
}

/**
 * Quote up to MAX_QUOTED_PATHWAYS pathways for a method in parallel. Failures become errors, not exceptions.
 * Returns the public view of each quote (see `publicQuote`); the full quotes go into `rec.quotes`.
 */
export async function quotes(rt: Runtime, rec: SessionRecord, body: QuotesBody): Promise<{ quotes: PublicQuote[]; errors: OpenRampError[] }> {
  if (!rec.plan) await plan(rt, rec, { walletConnected: rec.walletConnected ?? false })
  const candidates = rec.plan!.pathways.filter((p) => p.method === body.method && p.group !== 'unavailable')
  if (!candidates.length) throw new OpenRampException(openRampError('NO_QUOTES'), 422)
  // Withdraw: the source is fixed by the session. Deposit: the token the user picked in the client.
  const source =
    rec.direction === 'withdraw'
      ? withdrawSender(rt, rec)
      : body.source
        ? { ...body.source, ...(rec.walletAddress ? { address: rec.walletAddress } : {}) }
        : undefined
  // `withdraw.checkBalance`: an amount of the source token above the wallet balance gets no quotes
  // (no provider call). A destination amount is checked on each quote's input below.
  const balance = rec.direction === 'withdraw' ? await readSourceBalance(rt, rec) : undefined
  const low = (body.amountSide ?? 'source') === 'source' ? balanceError(balance, body.amount) : undefined
  if (low) throw new OpenRampException(low, 422)
  const timeout = rt.config.timeouts?.quote ?? 9000
  const errors: OpenRampError[] = []
  // The circuit breaker: skip pathways with an adapter that fails too often now (no network call).
  const gates = new Map<string, 'closed' | 'open' | 'probe'>()
  await Promise.all([...new Set(candidates.flatMap((p) => p.legs.map((l) => l.adapterId)))].map(async (id) => gates.set(id, await breakerGate(rt, id))))
  const open = candidates.filter((p) => p.legs.some((l) => gates.get(l.adapterId) === 'open'))
  for (const p of open) {
    errors.push(breakerError(p.provider))
    rt.metric('quote.skipped', 1, { adapter: p.legs.find((l) => gates.get(l.adapterId) === 'open')!.adapterId, reason: 'breaker' })
  }
  const quoted = candidates.filter((p) => !open.includes(p)).slice(0, MAX_QUOTED_PATHWAYS)
  const tally: QuoteTally = { counts: new Map(), closed: false }
  const tracks = quoted.map((): PathwayTrack => ({ tally }))
  const settled = await Promise.allSettled(
    quoted.map((p, i) => withTimeout(quotePathway(rt, rec, p, body.amount, body.amountSide ?? 'source', source, tracks[i]), timeout)),
  )
  // A pathway that timed out while an adapter quote was open: that adapter failed.
  for (const t of tracks) if (t.inFlight) tallyAdd(tally, t.inFlight, 'quoteFail')
  tally.closed = true
  // One session counts at most one quote failure per adapter, so the browser of one session (it picks
  // the amount and the token) cannot push an adapter's failure rate up and open the breaker for everyone.
  // The mark is an atomic claim in the store, so parallel quote requests of one session count once too.
  await Promise.all(
    [...tally.counts].map(async ([id, c]) => {
      if (c.quoteFail && !(await firstFailureOfSession(rt, rec.id, id))) c.quoteFail = 0
    }),
  )
  await Promise.all([
    ...[...tally.counts].map(([id, c]) => recordHealth(rt, id, c)),
    ...[...gates].filter(([, g]) => g === 'probe').map(async ([id]) => {
      const c = tally.counts.get(id)
      // No outcome (for example an earlier leg failed): the breaker stays as it is.
      if (c?.quoteOk || c?.quoteFail) await breakerProbeResult(rt, id, !!c.quoteOk)
    }),
  ])
  const out: Quote[] = []
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      const bounds = boundsError(rec, s.value.stored.quote.input) ?? balanceError(balance, s.value.stored.quote.input)
      if (bounds) {
        errors.push(bounds)
        continue
      }
      out.push(s.value.stored.quote)
      rec.quotes[s.value.stored.quote.id] = s.value.stored
    } else {
      const reason = s.reason as unknown
      const message = reason instanceof Error ? reason.message : String(reason)
      // Only OpenRampErrors reach the browser: a raw error can quote a provider response.
      errors.push(reason instanceof OpenRampException ? reason.error : openRampError('PROVIDER_UNAVAILABLE'))
      rt.log.warn('quote failed', { error: message })
    }
  }
  const ranked = await rankWithHealth(rt, rec, out)
  // Failover at start picks the next quote of the same request, in this order.
  const round = randomHex(6)
  ranked.forEach((q, i) => {
    const stored = rec.quotes[q.id]
    if (stored) Object.assign(stored, { round, rank: i })
  })
  pruneQuotes(rec)
  return { quotes: ranked.map(publicQuote), errors }
}

/**
 * Rank with `rankQuotes`, with the providers' recent success rates as the tie break after the output
 * and the ETA. A pathway's rate is the product of its legs' rates. An adapter with too few samples is
 * neutral: it takes the mean rate of the rated adapters in this list. With no rated adapter, no rates.
 */
async function rankWithHealth(rt: Runtime, rec: SessionRecord, out: Quote[]): Promise<Quote[]> {
  if (out.length < 2) return rankQuotes(out)
  // The adapters from the planner's pathway, not from the adapter's own quote.
  const adaptersOf = (q: Quote) => rec.quotes[q.id]?.pathway.legs.map((l) => l.adapterId) ?? []
  const ids = [...new Set(out.flatMap(adaptersOf))]
  const rates = await successRates(rt, ids)
  const known = [...rates.values()].filter((r): r is number => r !== undefined)
  if (!known.length) return rankQuotes(out)
  const neutral = known.reduce((a, b) => a + b, 0) / known.length
  return rankQuotes(out, { successRate: (q) => adaptersOf(q).reduce((acc, id) => acc * (rates.get(id) ?? neutral), 1) })
}

function pruneQuotes(rec: SessionRecord) {
  const keys = Object.keys(rec.quotes)
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_STORED_QUOTES))) delete rec.quotes[k]
}

/**
 * Enforce the session's `amountBounds` on what the user pays. Checked when the bounds currency
 * matches the input: a fiat currency code, or a token symbol (e.g. USDC). Other inputs pass.
 */
export function boundsError(rec: SessionRecord, input: Amount): OpenRampError | undefined {
  const b = rec.amountBounds
  if (!b) return undefined
  const code = input.asset.kind === 'fiat' ? input.asset.currency : input.asset.symbol
  if (!code || code.toUpperCase() !== b.currency.toUpperCase() || cmp(input.value, '0') <= 0) return undefined
  if (b.min && cmp(input.value, b.min) < 0) return openRampError('AMOUNT_TOO_LOW', { message: `The minimum is ${b.min} ${b.currency}.`, recovery: 'requote' })
  if (b.max && cmp(input.value, b.max) > 0) return openRampError('AMOUNT_TOO_HIGH', { message: `The maximum is ${b.max} ${b.currency}.`, recovery: 'requote' })
  return undefined
}
