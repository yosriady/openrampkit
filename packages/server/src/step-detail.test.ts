// Step.detail.code is a closed list. The provider status reaches the browser only when it is short plain text.
import { describe, expect, it } from 'vitest'
import { createAdapter } from '@openrampkit/adapter'
import { mockAdapter } from '@openrampkit/adapter-mock'
import { STEP_DETAIL_CODES, USDC, isStepDetailCode } from '@openrampkit/core'
import type { LegStep } from '@openrampkit/core'
import { createOpenRamp, memoryStore } from './index.js'

const BASE = 'https://app.test/api/openramp'
const DEST = { type: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']!, address: '0x000000000000000000000000000000000000beef' }

function make(step: LegStep) {
  const warnings: string[] = []
  const logger = { debug() {}, info() {}, error() {}, warn: (m: string) => void warnings.push(m) }
  const base = mockAdapter({ settleMs: 0 })
  const a = createAdapter({ ...base, id: 'subs', async start(input, ctx) {
    const s = await base.start(input, ctx)
    return { ...step, ref: s.ref! }
  } })
  const store = memoryStore()
  const ramp = createOpenRamp({ secret: 's'.repeat(40), baseUrl: BASE, adapters: [a], logger, store })
  const call = (path: string, secret: string, body?: unknown) =>
    ramp.handle(new Request(`${BASE}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
  async function select() {
    const s = await ramp.sessions.create({ userId: 'u', country: 'VN', destination: DEST })
    await call(`/sessions/${s.id}/plan`, s.clientSecret, {})
    const q = await (await call(`/sessions/${s.id}/quotes`, s.clientSecret, { method: 'vietqr', amount: '500000' })).json()
    const res = await call(`/sessions/${s.id}/select`, s.clientSecret, { quoteId: q.quotes[0].id })
    return { id: s.id, text: await res.text() }
  }
  return { select, store, warnings }
}

describe('Step.detail', () => {
  it('the closed list is lowercase, and isStepDetailCode checks it', () => {
    for (const s of STEP_DETAIL_CODES) expect(s).toMatch(/^[a-z_]+$/)
    expect(isStepDetailCode('confirming')).toBe(true)
    expect(isStepDetailCode('CONFIRMING')).toBe(false)
    expect(isStepDetailCode(undefined)).toBe(false)
  })

  it('a known code reaches the browser with its provider status; the timeline keeps the provider status', async () => {
    const t = make({ status: 'processing', detail: { code: 'bridging', providerStatus: 'pending' } })
    const { id, text } = await t.select()
    const pub = JSON.parse(text)
    expect(pub.step.state).toBe('PROCESSING')
    expect(pub.step.detail).toEqual({ code: 'bridging', providerStatus: 'pending' })
    const rec = await t.store.get(id)
    expect(rec!.timeline!.find((e) => e.type === 'leg.provider_status')).toMatchObject({ detail: { index: 0, adapterId: 'subs', status: 'pending' } })
  })

  it('a code that is not in the list (a third-party adapter) is dropped and logged', async () => {
    const t = make({ status: 'processing', detail: { code: 'WAIT_DESTINATION_TRANSACTION' as never, providerStatus: 'waiting' } })
    const { text } = await t.select()
    const pub = JSON.parse(text)
    expect(pub.step.state).toBe('PROCESSING')
    expect(pub.step.detail).toBeUndefined()
    expect(text).not.toContain('WAIT_DESTINATION_TRANSACTION')
    expect(t.warnings.some((w) => w.includes('not in STEP_DETAIL_CODES'))).toBe(true)
  })

  it('a provider status with other characters, or longer than 64, is dropped; the code stays', async () => {
    for (const providerStatus of ['<script>alert(1)</script>', 'a'.repeat(65), 'line\nbreak', '"quoted"']) {
      const t = make({ status: 'processing', detail: { code: 'confirming', providerStatus } })
      const { id, text } = await t.select()
      const pub = JSON.parse(text)
      expect(pub.step.detail).toEqual({ code: 'confirming' })
      expect(text).not.toContain(providerStatus)
      const rec = await t.store.get(id)
      expect(rec!.timeline!.some((e) => e.type === 'leg.provider_status')).toBe(false)
    }
    // The longest allowed value, with every allowed character
    const ok = 'Pending_1 .:-'.padEnd(64, 'x')
    const t = make({ status: 'processing', detail: { code: 'confirming', providerStatus: ok } })
    const pub = JSON.parse((await t.select()).text)
    expect(pub.step.detail).toEqual({ code: 'confirming', providerStatus: ok })
  })
})
