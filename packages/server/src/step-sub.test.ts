// Step.sub is a closed list. Raw provider statuses go to the timeline only, never to the browser.
import { describe, expect, it } from 'vitest'
import { createAdapter } from '@openrampkit/adapter'
import { mockAdapter } from '@openrampkit/adapter-mock'
import { STEP_SUBS, USDC, isStepSub } from '@openrampkit/core'
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

describe('Step.sub', () => {
  it('the closed list is lowercase, and isStepSub checks it', () => {
    for (const s of STEP_SUBS) expect(s).toMatch(/^[a-z_]+$/)
    expect(isStepSub('confirming')).toBe(true)
    expect(isStepSub('CONFIRMING')).toBe(false)
    expect(isStepSub(undefined)).toBe(false)
  })

  it('a known sub reaches the browser; providerStatus stays in the timeline only', async () => {
    const t = make({ state: 'PROCESSING', sub: 'bridging', providerStatus: 'pending', status: 'processing', transitions: [{ name: 'poll', kind: 'AWAIT', poll: { intervalMs: 1000, backoff: 1, maxIntervalMs: 1000, giveUpAfterMs: 60_000 } }] })
    const { id, text } = await t.select()
    const pub = JSON.parse(text)
    expect(pub.step.sub).toBe('bridging')
    expect(text).not.toContain('providerStatus')
    const rec = await t.store.get(id)
    expect(rec!.timeline!.find((e) => e.type === 'leg.provider_status')).toMatchObject({ detail: { index: 0, adapterId: 'subs', status: 'pending' } })
  })

  it('a sub that is not in the list (a third-party adapter) is dropped and logged', async () => {
    const t = make({ state: 'PROCESSING', sub: 'WAIT_DESTINATION_TRANSACTION' as never, status: 'processing', transitions: [{ name: 'poll', kind: 'AWAIT', poll: { intervalMs: 1000, backoff: 1, maxIntervalMs: 1000, giveUpAfterMs: 60_000 } }] })
    const { text } = await t.select()
    const pub = JSON.parse(text)
    expect(pub.step.state).toBe('PROCESSING')
    expect(pub.step.sub).toBeUndefined()
    expect(text).not.toContain('WAIT_DESTINATION_TRANSACTION')
    expect(t.warnings.some((w) => w.includes('not in STEP_SUBS'))).toBe(true)
  })
})
