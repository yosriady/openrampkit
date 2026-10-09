// Stored-record schema 1 to 2: records written by the server before the 0.1.0 data model still load and work.
// `fixtures/records-v1.json` holds records and adapter KV written at SESSION_SCHEMA 1 (commit 2af9c31; do not edit).
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockAdapter } from '@openrampkit/adapter-mock'
import { createOpenRamp, memoryStore, migrateRecord, SESSION_SCHEMA } from './index.js'
import type { SessionRecord, SessionStore } from './index.js'

type Name = 'open' | 'awaitingUser' | 'completed' | 'withdrawLocked'
type Fixture = {
  capturedAt: string
  secret: string
  sessions: Record<Name, { clientSecret: string; record: SessionRecord }>
  kv: Record<string, unknown>
}
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/records-v1.json', import.meta.url), 'utf8')) as Fixture
const fresh = () => structuredClone(FIXTURE)
/** The raw record as schema 1 wrote it (old names are not in the current types) */
const raw = (rec: SessionRecord) => rec as unknown as Record<string, any>

const BASE = 'https://app.test/api/openramp'
const quiet = { debug() {}, info() {}, warn() {}, error() {} }

async function loadedStore(f: Fixture): Promise<SessionStore> {
  const store = memoryStore()
  for (const { record } of Object.values(f.sessions)) await store.put(record)
  for (const [k, v] of Object.entries(f.kv)) await store.kv.put(k, v)
  return store
}

function make(store: SessionStore) {
  const sent: Array<{ type: string }> = []
  const ramp = createOpenRamp({
    secret: FIXTURE.secret, baseUrl: BASE, adapters: [mockAdapter({ settleMs: 0, crypto: true, offramp: true })], logger: quiet, store,
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

describe('migrateRecord: schema 1 to 2', () => {
  it('the fixture records are schema 1, with the old names', () => {
    const s = FIXTURE.sessions
    for (const { record } of Object.values(s)) expect(record.schema).toBe(1)
    expect(raw(s.open.record).status).toBe('open')
    expect(raw(s.awaitingUser.record).status).toBe('awaiting_user')
    expect(raw(s.completed.record).status).toBe('completed')
    expect(raw(s.completed.record).notified).toContain('session.completed:{}')
    expect(raw(s.awaitingUser.record).active.legs[0].quote.input).toHaveProperty('amount')
  })

  it('renames the statuses, the leg status, Amount.amount and the notified event names', () => {
    const f = fresh()
    const open = migrateRecord(f.sessions.open.record)
    const wait = migrateRecord(f.sessions.awaitingUser.record)
    const done = migrateRecord(f.sessions.completed.record)
    expect(open.status).toBe('requires_payment_method')
    expect(wait.status).toBe('requires_action')
    expect(done.status).toBe('succeeded')
    for (const r of [open, wait, done]) expect(r.schema).toBe(SESSION_SCHEMA)
    expect(wait.active!.legs[0]!.step!.status).toBe('requires_action')
    const leg = wait.active!.legs[0]!.quote
    expect(leg.input).toEqual({ value: '500000', asset: { kind: 'fiat', currency: 'VND' } })
    expect(leg.output.value).toMatch(/^\d+(\.\d+)?$/)
    for (const q of Object.values(wait.quotes)) {
      expect(q.quote.input).toHaveProperty('value')
      expect(q.quote.input).not.toHaveProperty('amount')
      expect(q.quote.output).toHaveProperty('value')
      // Fees keep their `amount` (a Fee is not an Amount)
      for (const fee of q.quote.fees) expect(fee).toHaveProperty('amount')
    }
    expect(done.notified).toContain('session.succeeded:{}')
    expect(done.notified).not.toContain('session.completed:{}')
    // The QR surface keeps its own `amount` field.
    const surface = wait.active!.legs[0]!.step!.surface
    if (surface?.kind === 'QR') expect(surface.amount).toBeTruthy()
  })

  it('renames the withdraw fields allowedTargets and targetLocked', () => {
    const rec = migrateRecord(fresh().sessions.withdrawLocked.record)
    expect(raw(rec)).not.toHaveProperty('allowedTargets')
    expect(raw(rec)).not.toHaveProperty('targetLocked')
    expect(rec.allowedDestinations).toEqual({ crypto: { chains: ['eip155:42161'] }, fiat: { currencies: ['PHP'] } })
    expect(rec.destinationLocked).toBe(true)
    expect(rec.status).toBe('requires_payment_method')
  })

  it('is idempotent', () => {
    for (const { record } of Object.values(fresh().sessions)) {
      const once = structuredClone(migrateRecord(record))
      expect(migrateRecord(record)).toEqual(once)
    }
  })
})

describe('schema 1 records load and work', () => {
  const at = (ms: number) => vi.useFakeTimers({ now: Date.parse(FIXTURE.capturedAt) + ms, toFake: ['Date'] })

  it('an open session can quote and pay', async () => {
    at(60_000)
    const f = fresh()
    const store = await loadedStore(f)
    const { call } = make(store)
    const { clientSecret, record } = f.sessions.open
    const pub = await (await call(`/sessions/${record.id}`, clientSecret)).json()
    expect(pub.status).toBe('requires_payment_method')
    const q = await (await call(`/sessions/${record.id}/quotes`, clientSecret, { method: 'vietqr', amount: '500000' })).json()
    expect(q.quotes[0].input).toMatchObject({ value: '500000' })
    const sel = await (await call(`/sessions/${record.id}/select`, clientSecret, { quoteId: q.quotes[0].id })).json()
    expect(sel.status).toBe('requires_action')
    expect((await store.get(record.id))!.schema).toBe(SESSION_SCHEMA)
  })

  it('a payment that waits for the user finishes and sends session.succeeded', async () => {
    at(60_000)
    const f = fresh()
    const store = await loadedStore(f)
    const { call, sent } = make(store)
    const { clientSecret, record } = f.sessions.awaitingUser
    const pub = await (await call(`/sessions/${record.id}`, clientSecret)).json()
    expect(pub).toMatchObject({ status: 'requires_action', step: { state: 'PAYMENT' }, result: { input: { value: '500000' } } })
    expect((await call(`/sessions/${record.id}/transitions/simulate_payment`, clientSecret, {})).status).toBe(200)
    at(120_000)
    const done = await (await call(`/sessions/${record.id}/step`, clientSecret)).json()
    expect(done).toMatchObject({ status: 'succeeded', step: { state: 'COMPLETED' } })
    expect(sent.map((e) => e.type)).toContain('session.succeeded')
    expect(sent.map((e) => e.type)).not.toContain('session.completed')
  })

  it('a locked withdraw destination stays locked', async () => {
    at(60_000)
    const f = fresh()
    const { call } = make(await loadedStore(f))
    const { clientSecret, record } = f.sessions.withdrawLocked
    const pub = await (await call(`/sessions/${record.id}`, clientSecret)).json()
    expect(pub).toMatchObject({ direction: 'withdraw', destinationLocked: true, allowedDestinations: { crypto: { chains: ['eip155:42161'] } }, destination: { type: 'crypto', chain: 'eip155:42161' } })
    const r = await call(`/sessions/${record.id}/target`, clientSecret, { type: 'fiat', currency: 'PHP' })
    expect(r.status).toBe(409)
    expect((await r.json()).error.code).toBe('DESTINATION_LOCKED')
  })

  it('a completed payment is succeeded, and stays final with no second success event', async () => {
    at(60_000)
    const f = fresh()
    const { ramp, call, sent } = make(await loadedStore(f))
    const { clientSecret, record } = f.sessions.completed
    expect(await ramp.sessions.retrieve(record.id)).toMatchObject({ status: 'succeeded', result: { output: { value: expect.any(String) } } })
    expect((await call(`/sessions/${record.id}/plan`, clientSecret, {})).status).toBe(409)
    await ramp.sweep()
    expect(sent.map((e) => e.type)).not.toContain('session.succeeded')
  })
})
