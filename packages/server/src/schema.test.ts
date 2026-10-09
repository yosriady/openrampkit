// Stored-record schema: records written before `schema` existed still load and work.
// `fixtures/records-v0.json` holds records and adapter KV written by the server before this field (do not edit).
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockAdapter } from '@openrampkit/adapter-mock'
import { USDC } from '@openrampkit/core'
import { createOpenRamp, memoryStore, migrateRecord, SESSION_SCHEMA } from './index.js'
import type { SessionRecord, SessionStore } from './index.js'

type Fixture = {
  capturedAt: string
  secret: string
  sessions: Record<'awaitingPayment' | 'completed', { clientSecret: string; record: SessionRecord }>
  kv: Record<string, unknown>
}
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/records-v0.json', import.meta.url), 'utf8')) as Fixture
const fresh = () => structuredClone(FIXTURE)

const BASE = 'https://app.test/api/openramp'
const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const DEST = { type: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']!, address: '0x000000000000000000000000000000000000beef' }

/** A store that keeps the raw JSON, so a test can read what the server wrote */
async function loadedStore(f: Fixture): Promise<SessionStore> {
  const store = memoryStore()
  for (const { record } of Object.values(f.sessions)) await store.put(record)
  for (const [k, v] of Object.entries(f.kv)) await store.kv.put(k, v)
  return store
}

function make(store: SessionStore) {
  const sent: Array<{ type: string }> = []
  const ramp = createOpenRamp({
    secret: FIXTURE.secret, baseUrl: BASE, adapters: [mockAdapter({ settleMs: 0 })], logger: quiet, store,
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

describe('migrateRecord', () => {
  it('the fixture records have no schema (written before the field existed)', () => {
    for (const { record } of Object.values(FIXTURE.sessions)) expect(record.schema).toBeUndefined()
  })

  it('fills the defaults of an older record: updatedAt, ActivePayment.n, empty lists', () => {
    const rec = fresh().sessions.awaitingPayment.record
    // As an earlier version wrote it: no updatedAt, no attempt numbers, no lists
    delete rec.updatedAt
    delete rec.active!.n
    delete rec.attempts![0]!.n
    delete (rec as Partial<SessionRecord>).startUrls
    delete (rec as Partial<SessionRecord>).notified
    const out = migrateRecord(rec)
    expect(out).toBe(rec)
    expect(rec.schema).toBe(SESSION_SCHEMA)
    expect(rec.updatedAt).toBe(rec.createdAt)
    expect(rec.attempts![0]!.n).toBe(0)
    expect(rec.active!.n).toBe(1)
    expect(rec.startUrls).toEqual({})
    expect(rec.notified).toEqual([])
    expect(rec.outbox).toEqual([])
  })

  it('brings an old free-text Step.sub into the closed list (lower case), or removes it', () => {
    const rec = fresh().sessions.awaitingPayment.record
    ;(rec.step as { sub?: string }).sub = 'SETTLING'
    ;(rec.active!.legs[0]!.step as { sub?: string }).sub = 'WAIT_DESTINATION_TRANSACTION'
    ;(rec.attempts![0]!.legs[0]!.step as { sub?: string }).sub = 'CONFIRMING'
    migrateRecord(rec)
    expect(rec.step.sub).toBe('settling')
    expect(rec.active!.legs[0]!.step!.sub).toBeUndefined()
    expect(rec.attempts![0]!.legs[0]!.step!.sub).toBe('confirming')
  })

  it('keeps the values a record has, and is idempotent', () => {
    const rec = fresh().sessions.completed.record
    const before = structuredClone(rec)
    migrateRecord(rec)
    expect(rec).toEqual({ ...before, schema: 1, outbox: before.outbox ?? [] })
    const once = structuredClone(rec)
    migrateRecord(rec)
    expect(rec).toEqual(once)
  })

  it('leaves a newer schema and records that are not sessions as they are', () => {
    const newer = { ...fresh().sessions.completed.record, schema: SESSION_SCHEMA + 1 }
    delete newer.updatedAt
    expect(migrateRecord(structuredClone(newer))).toEqual(newer)
    const queueRecord = { id: '__queue:open', version: 3, writer: 'w', entries: {} }
    expect(migrateRecord(structuredClone(queueRecord))).toEqual(queueRecord)
    expect(migrateRecord(null)).toBeNull()
  })
})

describe('records written before schema still load and work', () => {
  const at = (ms: number) => vi.useFakeTimers({ now: Date.parse(FIXTURE.capturedAt) + ms, toFake: ['Date'] })

  it('a new session gets schema 1', async () => {
    const store = memoryStore()
    const { ramp } = make(store)
    const s = await ramp.sessions.create({ userId: 'u', destination: DEST })
    expect((await store.get(s.id))!.schema).toBe(1)
  })

  it('a payment that waits for the user: loads, finishes, and is saved with schema 1', async () => {
    at(60_000)
    const f = fresh()
    const store = await loadedStore(f)
    const { ramp, call, sent } = make(store)
    const { clientSecret, record } = f.sessions.awaitingPayment
    const pub = await (await call(`/sessions/${record.id}`, clientSecret)).json()
    expect(pub.step.state).toBe('PAYMENT')
    expect(pub.result).toMatchObject({ method: 'vietqr' })
    // The user pays; the leg completes on the next status check.
    expect((await call(`/sessions/${record.id}/transitions/simulate_payment`, clientSecret, {})).status).toBe(200)
    at(120_000)
    const done = await (await call(`/sessions/${record.id}/step`, clientSecret)).json()
    expect(done.status).toBe('completed')
    expect(done.step.state).toBe('COMPLETED')
    expect(sent.map((e) => e.type)).toContain('session.completed')
    const saved = await store.get(record.id)
    expect(saved!.schema).toBe(1)
    expect(saved!.version).toBeGreaterThan(record.version)
    // The operator view reads the attempt numbers.
    const admin = await ramp.admin.get(record.id)
    expect(admin).toBeTruthy()
    expect(JSON.stringify(admin)).toContain('"attempt":1')
  })

  it('a completed payment: loads with its result, and stays final', async () => {
    at(60_000)
    const f = fresh()
    const { ramp, call } = make(await loadedStore(f))
    const { clientSecret, record } = f.sessions.completed
    const pub = await ramp.sessions.retrieve(record.id)
    expect(pub).toMatchObject({ status: 'completed', step: { state: 'COMPLETED' }, result: { method: 'vietqr', outputConfirmed: true } })
    expect((await call(`/sessions/${record.id}/plan`, clientSecret, {})).status).toBe(409)
    expect(await ramp.sweep()).toMatchObject({ sessions: { checked: expect.any(Number) } })
  })
})
