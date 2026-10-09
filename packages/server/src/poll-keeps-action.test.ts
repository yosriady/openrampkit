// A status poll while the user acts must not take away the user's own transitions.
import { describe, expect, it } from 'vitest'
import { mockAdapter } from '@openrampkit/adapter-mock'
import { createOpenRamp, memoryStore } from './index.js'

const BASE = 'https://app.test/api/openramp'
const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const DEST = { type: 'crypto' as const, chain: 'eip155:143', token: '0x00000000000000000000000000000000000000c0', symbol: 'USDC', decimals: 6, address: '0x000000000000000000000000000000000000dEaD' }

describe('a status poll keeps the user action', () => {
  it('after select and a poll, the user can still simulate the QR payment (no 409)', async () => {
    const ramp = createOpenRamp({ secret: 's'.repeat(40), baseUrl: BASE, store: memoryStore(), adapters: [mockAdapter({ crypto: true, bridge: true, settleMs: 4000 })], logger: quiet })
    const s = await ramp.sessions.create({ userId: 'u1', country: 'VN', destination: DEST })
    const call = async (path: string, body?: unknown, method = 'POST') => {
      const r = await ramp.handle(new Request(`${BASE}/sessions/${s.id}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${s.clientSecret}` }, ...(body ? { body: JSON.stringify(body) } : {}) }))
      return { status: r.status, body: (await r.json()) as { quotes?: Array<{ id: string }>; step?: { transitions: Array<{ name: string }> } } }
    }
    await call('/plan', {})
    const q = await call('/quotes', { method: 'vietqr', amount: '500000' })
    const sel = await call('/select', { quoteId: q.body.quotes![0]!.id })
    expect(sel.body.step!.transitions.map((t) => t.name)).toContain('simulate_payment')
    // The client polls while the user scans the QR code.
    const polled = await call('/step', undefined, 'GET')
    expect(polled.status).toBe(200)
    expect(((polled.body as { step?: { transitions: Array<{ name: string }> } }).step ?? (polled.body as unknown as { transitions: Array<{ name: string }> })).transitions.map((t) => t.name)).toContain('simulate_payment')
    const sim = await call('/transitions/simulate_payment', {})
    expect(sim.status).toBe(200)
  })
})
