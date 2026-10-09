// Outgoing webhooks: Standard Webhooks signatures and the typed event envelope.
import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockAdapter } from '@openrampkit/adapter-mock'
import { API_VERSION, USDC, WEBHOOK_EVENT_TYPES } from '@openrampkit/core'
import type { WebhookEvent } from '@openrampkit/core'
import { createOpenRamp, generateWebhookSecret, signWebhook, verifyWebhook } from './index.js'

// The test vector of the Standard Webhooks libraries (libraries/python/tests/test_webhooks.py, test_sign_function)
const VECTOR = {
  secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
  id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
  timestamp: 1614265330,
  body: '{"test": 2432232314}',
  signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
}

const headersOf = (id: string, ts: number | string, sig: string) => new Headers({ 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': sig })

afterEach(() => {
  vi.useRealTimers()
})

describe('Standard Webhooks signatures', () => {
  it('signs the spec test vector', async () => {
    expect(await signWebhook(VECTOR.secret, VECTOR.id, VECTOR.timestamp, VECTOR.body)).toBe(VECTOR.signature)
  })

  it('verifies the spec test vector inside the tolerance, and refuses it outside', async () => {
    vi.useFakeTimers({ now: VECTOR.timestamp * 1000 + 60_000, toFake: ['Date'] })
    expect(await verifyWebhook(VECTOR.secret, headersOf(VECTOR.id, VECTOR.timestamp, VECTOR.signature), VECTOR.body)).toBe(true)
    vi.setSystemTime(VECTOR.timestamp * 1000 + 301_000)
    expect(await verifyWebhook(VECTOR.secret, headersOf(VECTOR.id, VECTOR.timestamp, VECTOR.signature), VECTOR.body)).toBe(false)
    expect(await verifyWebhook(VECTOR.secret, headersOf(VECTOR.id, VECTOR.timestamp, VECTOR.signature), VECTOR.body, 3600)).toBe(true)
  })

  it('accepts one good signature among several (key rotation), and refuses a changed body, id or secret', async () => {
    vi.useFakeTimers({ now: VECTOR.timestamp * 1000, toFake: ['Date'] })
    const h = (sig: string) => headersOf(VECTOR.id, VECTOR.timestamp, sig)
    expect(await verifyWebhook(VECTOR.secret, h(`v1,bm90IGl0 ${VECTOR.signature}`), VECTOR.body)).toBe(true)
    expect(await verifyWebhook(VECTOR.secret, h(VECTOR.signature), `${VECTOR.body} `)).toBe(false)
    expect(await verifyWebhook(VECTOR.secret, headersOf('msg_other', VECTOR.timestamp, VECTOR.signature), VECTOR.body)).toBe(false)
    expect(await verifyWebhook(generateWebhookSecret(), h(VECTOR.signature), VECTOR.body)).toBe(false)
    expect(await verifyWebhook('whsec_###', h(VECTOR.signature), VECTOR.body)).toBe(false)
    expect(await verifyWebhook(VECTOR.secret, new Headers({ 'webhook-id': VECTOR.id }), VECTOR.body)).toBe(false)
    expect(await verifyWebhook(VECTOR.secret, headersOf(VECTOR.id, 'soon', VECTOR.signature), VECTOR.body)).toBe(false)
  })

  it('matches a plain Node HMAC, so any Standard Webhooks library verifies it', async () => {
    const secret = generateWebhookSecret()
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/)
    const key = Buffer.from(secret.slice(6), 'base64')
    const expected = `v1,${createHmac('sha256', key).update('evt_1.1700000000.{}').digest('base64')}`
    expect(await signWebhook(secret, 'evt_1', 1700000000, '{}')).toBe(expected)
  })

  it('a raw secret (no whsec_ prefix) signs with its UTF-8 bytes', async () => {
    const expected = `v1,${createHmac('sha256', 'w'.repeat(32)).update('evt_1.1.{}').digest('base64')}`
    expect(await signWebhook('w'.repeat(32), 'evt_1', 1, '{}')).toBe(expected)
  })

  it('refuses a whsec_ secret that is not 24 to 64 bytes, and a short raw secret', () => {
    const base = { secret: 's'.repeat(40), baseUrl: 'https://app.test/api/openramp', adapters: [] }
    expect(() => createOpenRamp({ ...base, webhooks: { url: 'https://app.test/h', secret: 'whsec_c2hvcnQ=' } })).toThrow(/24 to 64 bytes/)
    expect(() => createOpenRamp({ ...base, webhooks: { url: 'https://app.test/h', secret: 'short' } })).toThrow(/16 characters/)
    expect(() => createOpenRamp({ ...base, webhooks: { url: 'https://app.test/h', secret: generateWebhookSecret() } })).not.toThrow()
  })
})

describe('the webhook envelope', () => {
  const BASE = 'https://app.test/api/openramp'
  const DEST = { type: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']!, address: '0x000000000000000000000000000000000000beef' }

  it('sends Standard Webhooks headers and a typed event: object, apiVersion, ISO createdAt, the backend session', async () => {
    const secret = generateWebhookSecret()
    const delivered: Array<{ headers: Headers; body: string }> = []
    const ramp = createOpenRamp({
      secret: 's'.repeat(40), baseUrl: BASE, adapters: [mockAdapter({ settleMs: 0 })], logger: { debug() {}, info() {}, warn() {}, error() {} },
      webhooks: { url: 'https://app.test/hooks', secret },
      fetch: async (_u, init) => {
        delivered.push({ headers: new Headers(init?.headers), body: String(init?.body) })
        return new Response('ok')
      },
    })
    const s = await ramp.sessions.create({ userId: 'user_1', destination: DEST, metadata: { order: 'A-1' } })
    const d = delivered[0]!
    expect(d.headers.get('webhook-id')).toMatch(/^evt_[0-9a-f]{32}$/)
    expect(d.headers.get('webhook-timestamp')).toMatch(/^\d+$/)
    expect(d.headers.get('webhook-signature')).toMatch(/^v1,[A-Za-z0-9+/]+=*$/)
    expect(d.headers.get('openramp-signature')).toBeNull()
    expect(await verifyWebhook(secret, d.headers, d.body)).toBe(true)
    expect(await ramp.webhooks.verify(new Request('https://app.test/hooks', { method: 'POST', headers: d.headers, body: d.body }), d.body)).toBe(true)

    const event = JSON.parse(d.body) as WebhookEvent
    expect(event).toMatchObject({ id: d.headers.get('webhook-id'), object: 'event', apiVersion: API_VERSION, type: 'session.created', livemode: false, sessionId: s.id })
    expect(new Date(event.createdAt).toISOString()).toBe(event.createdAt)
    expect(event.data.object.session).toMatchObject({ id: s.id, status: 'requires_payment_method', userId: 'user_1', metadata: { order: 'A-1' } })
    expect(event).not.toHaveProperty('created')
    expect(event.data.object).not.toHaveProperty('userId')
    // The backend view is what `sessions.retrieve()` returns too.
    expect(await ramp.sessions.retrieve(s.id)).toMatchObject({ userId: 'user_1', metadata: { order: 'A-1' } })
    // Every response says the wire version.
    const res = await ramp.handle(new Request(`${BASE}/health`))
    expect(res.headers.get('openramp-version')).toBe(String(API_VERSION))
  })

  it('narrows on type: each event type has its own data fields', () => {
    const handle = (e: WebhookEvent): string => {
      switch (e.type) {
        case 'session.succeeded':
          return e.data.object.session.result?.output.value ?? '?'
        case 'session.payment_failed':
          return `${e.data.object.error.code} on leg ${e.data.object.index}`
        case 'session.reversed':
          return e.data.object.legStatus
        case 'session.late_payment':
          return e.data.object.reason
        case 'session.canceled':
          return e.data.object.reason
        default:
          return e.type
      }
    }
    const session = { id: 'ors_1', userId: 'u', metadata: {} } as never
    const base = { id: 'evt_1', object: 'event', apiVersion: 1, createdAt: new Date(0).toISOString(), livemode: false, sessionId: 'ors_1' } as const
    expect(handle({ ...base, type: 'session.payment_failed', data: { object: { session, index: 0, adapterId: 'a', legId: 'l', error: { code: 'PAYMENT_FAILED', message: 'm', retryable: true } } } })).toBe('PAYMENT_FAILED on leg 0')
    expect(handle({ ...base, type: 'session.canceled', data: { object: { session, reason: 'requested_by_app' } } })).toBe('requested_by_app')
    expect(WEBHOOK_EVENT_TYPES).not.toContain('withdrawal.succeeded' as never)
    expect(WEBHOOK_EVENT_TYPES).toContain('session.payment_failed')
  })
})
