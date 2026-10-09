// Stored-record schema 2 to 3: records written before the adapter contract v2 still load and work.
// `fixtures/records-v2.json` holds records and adapter KV written at SESSION_SCHEMA 2 (commit e868d9f; do not edit).
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAdapter } from '@openrampkit/adapter'
import type { LegEvent } from '@openrampkit/adapter'
import { mockAdapter } from '@openrampkit/adapter-mock'
import { USDC } from '@openrampkit/core'
import type { LegSpec, LegStep } from '@openrampkit/core'
import { createOpenRamp, memoryStore, migrateRecord, SESSION_SCHEMA } from './index.js'
import type { SessionRecord, SessionStore } from './index.js'

type Name = 'open' | 'awaitingUser' | 'processing' | 'short' | 'failedAttempt'
type Fixture = {
  capturedAt: string
  secret: string
  sessions: Record<Name, { clientSecret: string; record: SessionRecord }>
  kv: Record<string, unknown>
}
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/records-v2.json', import.meta.url), 'utf8')) as Fixture
const fresh = () => structuredClone(FIXTURE)
/** The raw record as schema 2 wrote it (old names are not in the current types) */
const raw = (rec: unknown) => rec as Record<string, any>

const BASE = 'https://app.test/api/openramp'
const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const USDC_BASE = { kind: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']!, symbol: 'USDC', decimals: 6 }

/** The `fx` adapter of the fixture: a card provider that reports transactions. `status` answers from `statusOf`. */
function fx(statusOf: Record<string, LegStep>) {
  const spec: LegSpec = {
    id: 'card', kind: 'fiat_onramp', methods: ['card'],
    from: { asset: { kind: 'fiat', currencies: '*' }, location: ['user_account'] },
    to: { asset: { kind: 'crypto', chains: { 'eip155:8453': [USDC['eip155:8453']!] } }, location: ['address'] },
    regions: { allow: ['*'], deny: [] }, eta: { min: 1, max: 2 }, surfaces: ['REDIRECT'],
  }
  return createAdapter({
    id: 'fx', name: 'FX test', legs: [spec],
    async quote({ leg, amountIn }) {
      return { adapterId: 'fx', legId: leg.legId, input: amountIn!, output: { value: '20', asset: USDC_BASE }, fees: [], eta: { min: 1, max: 2 }, guarantee: 'estimate', expiresAt: new Date(Date.now() + 60_000).toISOString() }
    },
    async start() {
      return { state: 'PAYMENT', status: 'requires_action', ref: 'fx-new', surface: { kind: 'REDIRECT', url: 'https://provider.test/pay', popup: true }, transitions: [{ name: 'poll', kind: 'AWAIT', poll: { intervalMs: 1000, backoff: 1, maxIntervalMs: 1000, giveUpAfterMs: 60_000 } }] }
    },
    async status({ ref }) {
      return statusOf[ref] ?? { state: 'PROCESSING', status: 'processing', ref, transitions: [] }
    },
    webhook: {
      async verify() {
        return true
      },
      async parse(body) {
        return JSON.parse(body) as LegEvent[]
      },
    },
  })
}

async function loadedStore(f: Fixture): Promise<SessionStore> {
  const store = memoryStore()
  for (const { record } of Object.values(f.sessions)) await store.put(record)
  for (const [k, v] of Object.entries(f.kv)) await store.kv.put(k, v)
  return store
}

function make(store: SessionStore, statusOf: Record<string, LegStep> = {}) {
  const sent: Array<{ type: string; data: { object: Record<string, any> } }> = []
  const ramp = createOpenRamp({
    secret: FIXTURE.secret, baseUrl: BASE, adapters: [mockAdapter({ settleMs: 0 }), fx(statusOf)], logger: quiet, store,
    webhooks: { url: 'https://app.test/hooks', secret: 'w'.repeat(32) },
    fetch: async (_u, init) => {
      sent.push(JSON.parse(String(init?.body)))
      return new Response('ok')
    },
  })
  const call = (path: string, secret: string, body?: unknown) =>
    ramp.handle(new Request(`${BASE}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
  return { ramp, call, sent }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('migrateRecord: schema 2 to 3, quotes', () => {
  it('the fixture records are schema 2, with the old fee shape', () => {
    for (const { record } of Object.values(FIXTURE.sessions)) expect(record.schema).toBe(2)
    const q = Object.values(FIXTURE.sessions.open.record.quotes).find((s) => s.quote.legs[0]!.adapterId === 'fx')!
    expect(raw(q.quote.fees[0])).toMatchObject({ amount: '0', currency: 'USD', inRate: true })
  })

  it('types the fees: an amount in the rate that the provider did not give is null', () => {
    const rec = migrateRecord(fresh().sessions.open.record)
    expect(rec.schema).toBe(SESSION_SCHEMA)
    const q = Object.values(rec.quotes).find((s) => s.quote.legs[0]!.adapterId === 'fx')!.quote
    expect(q.fees).toEqual([
      { kind: 'provider', label: 'FX fee', amount: null, included: true },
      { kind: 'network', label: 'Network fee', amount: { value: '0.5', asset: { kind: 'fiat', currency: 'USD' } }, included: true },
    ])
    expect(q.legs[0]!.fees).toEqual(q.fees)
    expect(q.guarantee).toBe('estimate')
    expect(q.legs[0]!.guarantee).toBe('estimate')
    // A schema 2 quote with no expiry lives until the session deadline.
    expect(q.expiresAt).toBe(new Date(rec.expiresAt).toISOString())
    for (const s of Object.values(rec.quotes)) for (const f of s.quote.fees) expect(f).toHaveProperty('included')
  })

  it('is idempotent', () => {
    for (const { record } of Object.values(fresh().sessions)) {
      const once = structuredClone(migrateRecord(record))
      expect(migrateRecord(record)).toEqual(once)
    }
  })
})

describe('schema 2 records load and work', () => {
  const at = (ms: number) => vi.useFakeTimers({ now: Date.parse(FIXTURE.capturedAt) + ms, toFake: ['Date'] })

  it('an open session can pay with a quote that schema 2 stored', async () => {
    at(60_000)
    const f = fresh()
    const store = await loadedStore(f)
    const { call } = make(store)
    const { clientSecret, record } = f.sessions.open
    const quoteId = Object.entries(record.quotes).find(([, s]) => s.quote.legs[0]!.adapterId === 'fx')![0]
    const sel = await call(`/sessions/${record.id}/select`, clientSecret, { quoteId })
    expect(sel.status).toBe(200)
    expect((await sel.json()).status).toBe('requires_action')
    expect((await store.get(record.id))!.schema).toBe(SESSION_SCHEMA)
  })

  it('a payment that waits for the user finishes', async () => {
    at(60_000)
    const f = fresh()
    const store = await loadedStore(f)
    const { call, sent } = make(store)
    const { clientSecret, record } = f.sessions.awaitingUser
    expect((await call(`/sessions/${record.id}/transitions/simulate_payment`, clientSecret, {})).status).toBe(200)
    at(120_000)
    const done = await (await call(`/sessions/${record.id}/step`, clientSecret)).json()
    expect(done).toMatchObject({ status: 'succeeded', step: { state: 'COMPLETED' } })
    expect(sent.map((e) => e.type)).toContain('session.succeeded')
  })

  it('a failed attempt can try again', async () => {
    at(60_000)
    const f = fresh()
    const { call } = make(await loadedStore(f))
    const { clientSecret, record } = f.sessions.failedAttempt
    const pub = await (await call(`/sessions/${record.id}`, clientSecret)).json()
    expect(pub).toMatchObject({ status: 'requires_payment_method', lastError: { code: 'PAYMENT_FAILED' } })
    const q = await (await call(`/sessions/${record.id}/quotes`, clientSecret, { method: 'card', amount: '25' })).json()
    expect(q.quotes.length).toBeGreaterThan(0)
    for (const quote of q.quotes) expect(quote).toMatchObject({ guarantee: expect.any(String), expiresAt: expect.any(String) })
  })
})
