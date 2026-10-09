// @openrampkit/adapter/testing: helpers for adapter test suites. Not part of the main entry.
//
// - memoryKV():  an in-memory ScopedKV with TTLs
// - fakeFetch(): a scripted `fetch` that records every call
// - makeCtx():   an AdapterContext with test defaults
// - runAdapterConformance(): the conformance run from the spec (§4.5)
//
// Framework-agnostic: nothing here imports a test runner.

import { checkAdapterShape, checkLegQuote, checkLegStep } from './testkit.js'
import type { ConformanceProblem } from './testkit.js'
import type { Adapter, AdapterContext, LegEvent, Logger, QuoteInput, ScopedKV, StartInput, WebhookContext } from './index.js'
import type { Destination, LegQuote, LegStatus, LegStep, PathwayLeg, StateName } from '@openrampkit/core'

const LEG_STATUSES: readonly LegStatus[] = ['pending', 'awaiting_user', 'processing', 'succeeded', 'failed', 'refunded', 'expired', 'reversed']

// ---------------- KV ----------------

export type MemoryKV = ScopedKV & { data: Map<string, unknown> }

/** In-memory ScopedKV. Entries expire after `ttlSec` (checked against Date.now(), so fake timers work). */
export function memoryKV(): MemoryKV {
  const entries = new Map<string, { v: unknown; exp?: number }>()
  const data = new Map<string, unknown>()
  return {
    data,
    async get<T>(key: string) {
      const e = entries.get(key)
      if (!e) return undefined
      if (e.exp !== undefined && e.exp <= Date.now()) {
        entries.delete(key)
        data.delete(key)
        return undefined
      }
      return e.v as T
    },
    async put(key: string, value: unknown, ttlSec?: number) {
      entries.set(key, { v: value, ...(ttlSec ? { exp: Date.now() + ttlSec * 1000 } : {}) })
      data.set(key, value)
    },
  }
}

// ---------------- fetch ----------------

export type FakeCall = { method: string; url: string; headers: Headers; body?: unknown; raw?: string }

export type FakeRoute = {
  method?: string
  /** Matches when the URL contains this string, or matches this RegExp */
  match: string | RegExp
  /**
   * The JSON reply. Return a `Response` to send it as is (e.g. an HTML error page).
   * Throw to simulate a network error.
   */
  reply?: (call: FakeCall) => unknown | Promise<unknown>
  /** HTTP status for JSON replies. Default 200. */
  status?: number
  /** Never answer; the request fails only when the caller aborts it (timeouts). */
  hang?: boolean
}

/** A fake fetch that answers from scripted routes (first match wins) and records every call. Unmatched calls get a 404. */
export function fakeFetch(routes: FakeRoute[]): { fetch: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const method = (init?.method ?? 'GET').toUpperCase()
    const raw = typeof init?.body === 'string' ? init.body : undefined
    let body: unknown
    try {
      body = raw ? JSON.parse(raw) : undefined
    } catch {
      body = raw
    }
    const call: FakeCall = { method, url, headers: new Headers(init?.headers), ...(body !== undefined ? { body } : {}), ...(raw ? { raw } : {}) }
    calls.push(call)
    const route = routes.find((r) => (!r.method || r.method === method) && (typeof r.match === 'string' ? url.includes(r.match) : r.match.test(url)))
    if (!route) return new Response(JSON.stringify({ message: `no fake route for ${method} ${url}` }), { status: 404 })
    if (route.hang) {
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal
        const abort = () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }))
        if (signal?.aborted) abort()
        signal?.addEventListener('abort', abort)
      })
    }
    const out = await route.reply?.(call)
    if (out instanceof Response) return out
    return new Response(out === undefined ? '' : JSON.stringify(out), { status: route.status ?? 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { fetch: f, calls }
}

// ---------------- context ----------------

export type RecordingLogger = Logger & { warnings: string[]; errors: string[] }

/** A logger that prints nothing and records warnings and errors */
export function recordingLog(): RecordingLogger {
  const warnings: string[] = []
  const errors: string[] = []
  return {
    warnings,
    errors,
    debug() {},
    info() {},
    warn(msg) {
      warnings.push(msg)
    },
    error(msg) {
      errors.push(msg)
    },
  }
}

/** A shared recording logger, used by makeCtx() when no `log` is given */
export const silentLog: RecordingLogger = recordingLog()

export const TEST_DESTINATION: Destination = {
  type: 'crypto',
  chain: 'eip155:8453',
  token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  address: '0x000000000000000000000000000000000000beef',
}

export type MakeCtxOptions = {
  fetch: typeof fetch
  destination?: Destination
  pathway?: { legs: PathwayLeg[]; index: number }
  shared?: ScopedKV
  store?: ScopedKV
  session?: Partial<AdapterContext['session']>
  urls?: Partial<AdapterContext['urls']>
  log?: Logger
}

/** An AdapterContext with test defaults: session `sess_1` in the US, USDC on Base destination, fresh in-memory KVs. */
export function makeCtx(opts: MakeCtxOptions): AdapterContext {
  const session = { id: 'sess_1', userId: 'user_1', direction: 'deposit' as const, locale: 'en', livemode: false, country: 'US', ...opts.session }
  return {
    session,
    destination: opts.destination ?? TEST_DESTINATION,
    pathway: opts.pathway ?? { legs: [], index: 0 },
    urls: { returnUrl: 'https://app.test/api/openramp/return', webhookUrl: 'https://app.test/api/openramp/webhooks/test', ...opts.urls },
    store: opts.store ?? memoryKV(),
    shared: opts.shared ?? memoryKV(),
    fetch: opts.fetch,
    log: opts.log ?? silentLog,
    idempotencyKey: (scope) => `${session.id}:${scope}`,
  }
}

/** A WebhookContext / catalog context with test defaults */
export function makeWebhookCtx(opts: { fetch?: typeof fetch; shared?: ScopedKV; log?: Logger } = {}): WebhookContext {
  return { fetch: opts.fetch ?? fakeFetch([]).fetch, shared: opts.shared ?? memoryKV(), log: opts.log ?? silentLog }
}

// ---------------- conformance ----------------

export type ConformanceFixture = {
  /** Label for problem reports. Default `${legId}`. */
  name?: string
  leg: PathwayLeg
  quote: Omit<QuoteInput, 'leg'>
  /** Start the leg with the quote. Default true. */
  start?: boolean | Omit<StartInput, 'leg' | 'quote'>
  /** Transitions to take after start, in order */
  transitions?: Array<{ name: string; inputs?: Record<string, unknown> }>
  /** Call status() after start and transitions. Default true when the adapter has status(). */
  status?: boolean
  /** Expected states, checked when set */
  expect?: { start?: StateName; status?: StateName }
  /** Context for this fixture. Default: `opts.ctx()`. */
  ctx?: AdapterContext
}

export type ConformanceWebhook = {
  name?: string
  request: () => Request
  rawBody: string
  /** Expected verify() result. Default true. */
  valid?: boolean
  /** Expected number of events from parse(), when set */
  events?: number
}

export type ConformanceOptions = {
  fixtures?: ConformanceFixture[]
  /** Builds a fresh context per fixture. Default: makeCtx({ fetch: opts.fetch }) */
  ctx?: () => AdapterContext
  /** Used by the default ctx(). Default: a fake fetch with no routes (every call gets a 404). */
  fetch?: typeof fetch
  webhooks?: ConformanceWebhook[]
  webhookCtx?: WebhookContext
}

export type ConformanceReport = {
  problems: ConformanceProblem[]
  quotes: LegQuote[]
  steps: LegStep[]
  events: LegEvent[][]
}

function errText(e: unknown): string {
  const ork = (e as { error?: { code?: string; message?: string } } | undefined)?.error
  if (ork?.code) return `${ork.code}: ${ork.message ?? ''}`
  return String((e as Error | undefined)?.message ?? e)
}

function checkStep(where: string, step: LegStep, expectRef: boolean): ConformanceProblem[] {
  const out = checkLegStep(step).map((p) => ({ where, problem: `${p.where}: ${p.problem}` }))
  if (!LEG_STATUSES.includes(step.status)) out.push({ where, problem: `unknown leg status ${step.status}` })
  if (expectRef && !step.ref && step.status !== 'failed') out.push({ where, problem: 'step has no ref, so webhooks and status checks cannot find it' })
  return out
}

/**
 * Run the adapter conformance checks (§4.5):
 * - checkAdapterShape()
 * - per fixture: quote() output (checkLegQuote, ids, non-negative money), start() and every
 *   transition/status step (checkLegStep, known leg status, ref present), expected states
 * - per webhook: verify() gives the expected result, and parse() is idempotent (same events twice)
 * Errors thrown by the adapter are reported as problems. Returns every quote, step and event.
 */
export async function runAdapterConformance(adapter: Adapter, opts: ConformanceOptions = {}): Promise<ConformanceReport> {
  const report: ConformanceReport = { problems: checkAdapterShape(adapter), quotes: [], steps: [], events: [] }
  const problem = (where: string, p: string) => report.problems.push({ where, problem: p })
  const fetchFn = opts.fetch ?? fakeFetch([]).fetch
  const ctxFor = (f: ConformanceFixture) => f.ctx ?? opts.ctx?.() ?? makeCtx({ fetch: fetchFn })

  const ids = new Set(adapter.legs.map((l) => l.id))
  for (const f of opts.fixtures ?? []) {
    const name = f.name ?? f.leg.legId
    const ctx = ctxFor(f)
    if (f.leg.adapterId !== adapter.id) problem(name, `fixture leg is for adapter ${f.leg.adapterId}, not ${adapter.id}`)
    if (!ids.has(f.leg.legId) && !adapter.catalog) problem(name, `adapter declares no leg ${f.leg.legId}`)

    let quote: LegQuote
    try {
      quote = await adapter.quote({ leg: f.leg, ...f.quote }, ctx)
    } catch (e) {
      problem(`${name} quote`, `threw ${errText(e)}`)
      continue
    }
    report.quotes.push(quote)
    for (const p of checkLegQuote(quote)) problem(`${name} ${p.where}`, p.problem)
    if (quote.adapterId !== adapter.id) problem(`${name} quote`, `adapterId ${quote.adapterId} is not ${adapter.id}`)
    if (quote.legId !== f.leg.legId) problem(`${name} quote`, `legId ${quote.legId} is not ${f.leg.legId}`)
    if (quote.eta.min > quote.eta.max) problem(`${name} quote`, 'eta.min > eta.max')
    for (const [label, amount] of [['input', quote.input.amount], ['output', quote.output.amount], ...quote.fees.map((x) => [`fee ${x.label}`, x.amount])] as const) {
      if (amount.startsWith('-')) problem(`${name} quote.${label}`, 'negative amount')
    }

    if (f.start === false) continue
    let step: LegStep
    try {
      step = await adapter.start({ leg: f.leg, quote, ...(typeof f.start === 'object' ? f.start : {}) }, ctx)
    } catch (e) {
      problem(`${name} start`, `threw ${errText(e)}`)
      continue
    }
    report.steps.push(step)
    report.problems.push(...checkStep(`${name} start`, step, true))
    if (f.expect?.start && step.state !== f.expect.start) problem(`${name} start`, `state ${step.state}, expected ${f.expect.start}`)
    const ref = step.ref
    if (!ref) continue

    for (const t of f.transitions ?? []) {
      if (!adapter.transition) {
        problem(`${name} transition ${t.name}`, 'adapter has no transition()')
        break
      }
      try {
        const s = await adapter.transition({ leg: f.leg, ref, name: t.name, ...(t.inputs ? { inputs: t.inputs } : {}) }, ctx)
        report.steps.push(s)
        report.problems.push(...checkStep(`${name} transition ${t.name}`, s, true))
      } catch (e) {
        problem(`${name} transition ${t.name}`, `threw ${errText(e)}`)
      }
    }

    if (adapter.status && f.status !== false) {
      try {
        const s = await adapter.status({ leg: f.leg, ref }, ctx)
        report.steps.push(s)
        report.problems.push(...checkStep(`${name} status`, s, false))
        if (f.expect?.status && s.state !== f.expect.status) problem(`${name} status`, `state ${s.state}, expected ${f.expect.status}`)
      } catch (e) {
        problem(`${name} status`, `threw ${errText(e)}`)
      }
    } else if (f.status === true) {
      problem(`${name} status`, 'adapter has no status()')
    }
  }

  const wctx = opts.webhookCtx ?? makeWebhookCtx({ fetch: fetchFn })
  for (const [i, w] of (opts.webhooks ?? []).entries()) {
    const name = `webhook ${w.name ?? i}`
    if (!adapter.webhook) {
      problem(name, 'adapter has no webhook handler')
      break
    }
    try {
      const ok = await adapter.webhook.verify(w.request(), w.rawBody, wctx)
      const want = w.valid ?? true
      if (ok !== want) problem(name, `verify() returned ${ok}, expected ${want}`)
      if (!want) continue
      const first = await adapter.webhook.parse(w.rawBody, wctx)
      const again = await adapter.webhook.parse(w.rawBody, wctx)
      report.events.push(first)
      if (JSON.stringify(first) !== JSON.stringify(again)) problem(name, 'parse() is not idempotent: a replay gave other events')
      if (w.events !== undefined && first.length !== w.events) problem(name, `parse() gave ${first.length} events, expected ${w.events}`)
      for (const ev of first) {
        if (!ev.ref) problem(name, 'event without ref')
        if (!LEG_STATUSES.includes(ev.status)) problem(name, `unknown leg status ${ev.status}`)
      }
    } catch (e) {
      problem(name, `threw ${errText(e)}`)
    }
  }
  return report
}
