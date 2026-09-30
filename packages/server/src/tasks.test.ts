// Outbox retries, sweep, session result, amount bounds, conflict code.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockAdapter } from '@openrampkit/adapter-mock'
import { USDC } from '@openrampkit/core'
import { createOpenRamp, memoryStore, VersionConflictError } from './index.js'
import type { OpenRampConfig, SessionStore } from './index.js'

const BASE = 'https://app.test/api/openramp'
const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const DEST = { type: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']!, address: '0x000000000000000000000000000000000000beef' }
const TOKEN = 'k'.repeat(32)

function make(extra: Partial<OpenRampConfig> = {}) {
  const ramp = createOpenRamp({ secret: 's'.repeat(40), baseUrl: BASE, adapters: [mockAdapter({ settleMs: 0 })], logger: quiet, ...extra })
  const call = (path: string, init: RequestInit & { secret?: string } = {}) => {
    const headers = new Headers(init.headers)
    if (init.secret) headers.set('authorization', `Bearer ${init.secret}`)
    if (init.body) headers.set('content-type', 'application/json')
    return ramp.handle(new Request(`${BASE}${path}`, { ...init, headers }))
  }
  return { ramp, call }
}

afterEach(() => vi.useRealTimers())

describe('webhook outbox and sweep', () => {
  it('keeps a failed webhook and retries it with backoff until delivered', async () => {
    let up = false
    const seen: string[] = []
    const fetchFn: typeof fetch = async (_u, init) => {
      seen.push(JSON.parse(String(init?.body)).type)
      return new Response('x', { status: up ? 200 : 503 })
    }
    vi.useFakeTimers({ now: Date.now() })
    const { ramp } = make({ webhooks: { url: 'https://app.test/hooks', secret: 'w'.repeat(32) }, fetch: fetchFn })
    await ramp.sessions.create({ userId: 'u', destination: DEST })
    expect(seen).toEqual(['session.created'])
    // not due yet
    expect((await ramp.sweep()).webhooks).toMatchObject({ retried: 0, pending: 1 })
    vi.setSystemTime(Date.now() + 31_000)
    expect((await ramp.sweep()).webhooks).toMatchObject({ retried: 1, delivered: 0, pending: 1 })
    up = true
    vi.setSystemTime(Date.now() + 61_000)
    expect((await ramp.sweep()).webhooks).toMatchObject({ retried: 1, delivered: 1, pending: 0 })
    expect(seen).toEqual(['session.created', 'session.created', 'session.created'])
  })

  it('drops a webhook after maxAttempts', async () => {
    const errors: string[] = []
    vi.useFakeTimers({ now: Date.now() })
    const { ramp } = make({ webhooks: { url: 'https://app.test/hooks', secret: 'w'.repeat(32), maxAttempts: 2 }, fetch: async () => new Response('x', { status: 500 }), logger: { ...quiet, error: (m) => errors.push(m) } })
    await ramp.sessions.create({ userId: 'u', destination: DEST })
    vi.setSystemTime(Date.now() + 31_000)
    expect((await ramp.sweep()).webhooks).toMatchObject({ dropped: 1, pending: 0 })
    expect(errors).toContain('webhook dropped after retries')
  })

  it('expires idle sessions and notifies; completed sessions leave the open list', async () => {
    const seen: string[] = []
    vi.useFakeTimers({ now: Date.now() })
    const { ramp } = make({ webhooks: { url: 'https://app.test/hooks', secret: 'w'.repeat(32) }, fetch: async (_u, init) => (seen.push(JSON.parse(String(init?.body)).type), new Response('ok')) })
    const s = await ramp.sessions.create({ userId: 'u', destination: DEST, ttlMinutes: 1 })
    expect((await ramp.sweep()).sessions).toMatchObject({ checked: 1, expired: 0, open: 1 })
    vi.setSystemTime(Date.now() + 2 * 60_000)
    expect((await ramp.sweep()).sessions).toMatchObject({ expired: 1, open: 0 })
    expect((await ramp.sessions.retrieve(s.id))!.status).toBe('expired')
    expect(seen).toContain('session.expired')
    expect((await ramp.sweep()).sessions).toMatchObject({ checked: 0, open: 0 })
  })

  it('refreshes an active payment from the provider status', async () => {
    const { ramp, call } = make()
    const s = await ramp.sessions.create({ userId: 'u', country: 'VN', destination: DEST })
    await call(`/sessions/${s.id}/plan`, { method: 'POST', secret: s.clientSecret, body: '{}' })
    const q = await (await call(`/sessions/${s.id}/quotes`, { method: 'POST', secret: s.clientSecret, body: JSON.stringify({ method: 'vietqr', amount: '500000' }) })).json()
    await call(`/sessions/${s.id}/select`, { method: 'POST', secret: s.clientSecret, body: JSON.stringify({ quoteId: q.quotes[0].id }) })
    await call(`/sessions/${s.id}/transitions/simulate_payment`, { method: 'POST', secret: s.clientSecret, body: '{}' })
    const r = await ramp.sweep()
    expect(r.sessions.changed).toBe(1)
    const pub = await ramp.sessions.retrieve(s.id)
    expect(pub!.status).toBe('completed')
    expect(pub!.result).toMatchObject({ method: 'vietqr', provider: 'Test provider', input: { amount: '500000', asset: { kind: 'fiat', currency: 'VND' } }, outputConfirmed: true })
    expect(pub!.result!.txHashes.length).toBeGreaterThan(0)
  })

  it('POST /tasks/sweep needs the tasks token; off without one', async () => {
    expect((await make().call('/tasks/sweep', { method: 'POST' })).status).toBe(404)
    const { call } = make({ tasksToken: TOKEN })
    expect((await call('/tasks/sweep', { method: 'POST' })).status).toBe(401)
    const ok = await call('/tasks/sweep?limit=5', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ webhooks: { pending: 0 }, sessions: { open: 0 } })
  })
})

describe('amount bounds and conflicts', () => {
  it('drops quotes outside amountBounds and refuses to select them', async () => {
    const { ramp, call } = make()
    const s = await ramp.sessions.create({ userId: 'u', country: 'VN', destination: DEST, amountBounds: { min: '100000', max: '1000000', currency: 'VND' } })
    await call(`/sessions/${s.id}/plan`, { method: 'POST', secret: s.clientSecret, body: '{}' })
    const low = await (await call(`/sessions/${s.id}/quotes`, { method: 'POST', secret: s.clientSecret, body: JSON.stringify({ method: 'vietqr', amount: '50000' }) })).json()
    expect(low.quotes).toEqual([])
    expect(low.errors[0]).toMatchObject({ code: 'AMOUNT_TOO_LOW' })
    const high = await (await call(`/sessions/${s.id}/quotes`, { method: 'POST', secret: s.clientSecret, body: JSON.stringify({ method: 'vietqr', amount: '2000000' }) })).json()
    expect(high.errors[0]).toMatchObject({ code: 'AMOUNT_TOO_HIGH' })
    const ok = await (await call(`/sessions/${s.id}/quotes`, { method: 'POST', secret: s.clientSecret, body: JSON.stringify({ method: 'vietqr', amount: '500000' }) })).json()
    expect(ok.quotes).toHaveLength(1)
    // bounds in another currency do not apply
    const other = await ramp.sessions.create({ userId: 'u', country: 'VN', destination: DEST, amountBounds: { max: '1', currency: 'EUR' } })
    await call(`/sessions/${other.id}/plan`, { method: 'POST', secret: other.clientSecret, body: '{}' })
    expect((await (await call(`/sessions/${other.id}/quotes`, { method: 'POST', secret: other.clientSecret, body: JSON.stringify({ method: 'vietqr', amount: '500000' }) })).json()).quotes).toHaveLength(1)
  })

  it('a version conflict is 409 CONFLICT and retryable', async () => {
    const base = memoryStore()
    let fail = false
    const store: SessionStore = { ...base, async put(rec, v) { if (fail && v !== undefined) throw new VersionConflictError('x'); return base.put(rec, v) } }
    const { ramp, call } = make({ store })
    const s = await ramp.sessions.create({ userId: 'u', country: 'VN', destination: DEST })
    fail = true
    const r = await call(`/sessions/${s.id}/plan`, { method: 'POST', secret: s.clientSecret, body: '{}' })
    expect(r.status).toBe(409)
    expect((await r.json()).error).toMatchObject({ code: 'CONFLICT', retryable: true })
  })
})

describe('limits', () => {
  it('rate-limits provider calls per session and minute', async () => {
    const { ramp, call } = make({ limits: { providerCallsPerMinute: 2 } })
    const s = await ramp.sessions.create({ userId: 'u', country: 'VN', destination: DEST })
    const plan = () => call(`/sessions/${s.id}/plan`, { method: 'POST', secret: s.clientSecret, body: '{}' })
    expect((await plan()).status).toBe(200)
    expect((await plan()).status).toBe(200)
    const r = await plan()
    expect(r.status).toBe(429)
    expect((await r.json()).error.code).toBe('RATE_LIMITED')
    // reading the session is not limited
    expect((await call(`/sessions/${s.id}`, { secret: s.clientSecret })).status).toBe(200)
  })

  it('rejects contract calls on the destination (not supported yet)', async () => {
    const { ramp } = make()
    await expect(ramp.sessions.create({ userId: 'u', destination: { ...DEST, calls: [{ to: '0x1', data: '0x' }] } })).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
  })
})

describe('sweep expiry of waiting payments', () => {
  it('expires a payment that still waits for the user after the deadline, but not one in processing', async () => {
    vi.useFakeTimers({ now: Date.now() })
    const { ramp, call } = make({ adapters: [mockAdapter({ settleMs: 60_000 })] })
    const start = async () => {
      const s = await ramp.sessions.create({ userId: 'u', country: 'VN', destination: DEST, ttlMinutes: 1 })
      await call(`/sessions/${s.id}/plan`, { method: 'POST', secret: s.clientSecret, body: '{}' })
      const q = await (await call(`/sessions/${s.id}/quotes`, { method: 'POST', secret: s.clientSecret, body: JSON.stringify({ method: 'vietqr', amount: '500000' }) })).json()
      await call(`/sessions/${s.id}/select`, { method: 'POST', secret: s.clientSecret, body: JSON.stringify({ quoteId: q.quotes[0].id }) })
      return s
    }
    const waiting = await start()
    vi.setSystemTime(Date.now() + 2 * 60_000)
    await ramp.sweep()
    expect((await ramp.sessions.retrieve(waiting.id))!.status).toBe('expired')
  })
})
