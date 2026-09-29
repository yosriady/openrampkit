// Test helpers: an in-memory ScopedKV, a scripted fake `fetch`, and an AdapterContext builder.
// Used only by this package's tests (not exported from index.ts).

import type { AdapterContext, Logger, ScopedKV } from '@openrampkit/adapter'
import type { Destination, PathwayLeg } from '@openrampkit/core'

export function memoryKV(): ScopedKV & { data: Map<string, unknown> } {
  const data = new Map<string, { v: unknown; exp?: number }>()
  return {
    data: data as unknown as Map<string, unknown>,
    async get<T>(key: string) {
      const e = data.get(key)
      if (!e) return undefined
      if (e.exp && e.exp < Date.now()) {
        data.delete(key)
        return undefined
      }
      return e.v as T
    },
    async put(key: string, value: unknown, ttlSec?: number) {
      data.set(key, { v: value, ...(ttlSec ? { exp: Date.now() + ttlSec * 1000 } : {}) })
    },
  }
}

export type FakeCall = { method: string; url: string; headers: Headers; body?: unknown; raw?: string }
export type FakeRoute = {
  method?: string
  /** Matches when the URL contains this string, or matches this RegExp */
  match: string | RegExp
  reply: (call: FakeCall) => unknown | Promise<unknown>
  status?: number
}

/** A fake fetch that answers from scripted routes (first match wins) and records every call. */
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
    const out = await route.reply(call)
    return new Response(JSON.stringify(out), { status: route.status ?? 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { fetch: f, calls }
}

export const silentLog: Logger & { warnings: string[] } = Object.assign(
  { debug() {}, info() {}, error() {}, warn(msg: string) { silentLog.warnings.push(msg) } },
  { warnings: [] as string[] },
)

export function makeCtx(opts: {
  fetch: typeof fetch
  destination?: Destination
  pathway?: { legs: PathwayLeg[]; index: number }
  shared?: ScopedKV
  store?: ScopedKV
  session?: Partial<AdapterContext['session']>
}): AdapterContext {
  return {
    session: { id: 'sess_1', userId: 'user_1', direction: 'deposit', locale: 'en', livemode: false, country: 'US', ...opts.session },
    destination: opts.destination ?? {
      type: 'crypto',
      chain: 'eip155:8453',
      token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      address: '0x000000000000000000000000000000000000beef',
    },
    pathway: opts.pathway ?? { legs: [], index: 0 },
    urls: { returnUrl: 'https://app.test/api/openramp/return', webhookUrl: 'https://app.test/api/openramp/webhooks/test' },
    store: opts.store ?? memoryKV(),
    shared: opts.shared ?? memoryKV(),
    fetch: opts.fetch,
    log: silentLog,
    idempotencyKey: (scope) => `sess_1:${scope}`,
  }
}
