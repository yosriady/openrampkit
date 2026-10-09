// Quote guarantees: the pathway takes the weakest leg guarantee, `expiresAt` is always set, and the
// output check uses `minOutput` when the quote has one.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAdapter } from '@openrampkit/adapter'
import type { LegEvent } from '@openrampkit/adapter'
import { USDC } from '@openrampkit/core'
import type { LegQuote, LegSpec, Pathway } from '@openrampkit/core'
import { createOpenRamp, memoryStore } from './index.js'
import { combineLegQuotes } from './planning.js'

const BASE = 'https://app.test/api/openramp'
const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const USDC_BASE = { kind: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']!, symbol: 'USDC', decimals: 6 }
const DEST = { type: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']!, address: '0x000000000000000000000000000000000000beef' }
const usdc = (value: string) => ({ value, asset: USDC_BASE })

afterEach(() => {
  vi.useRealTimers()
})

const legQuote = (over: Partial<LegQuote>): LegQuote => ({
  adapterId: 'a', legId: 'l', input: { value: '100', asset: { kind: 'fiat', currency: 'USD' } }, output: usdc('99'), fees: [],
  eta: { min: 1, max: 2 }, guarantee: 'firm', expiresAt: '2026-10-09T12:10:00.000Z', ...over,
})
const pathway = { id: 'p', legs: [], method: 'card', group: 'recommended', eta: { min: 0, max: 0 }, provider: 'P' } as unknown as Pathway

describe('combineLegQuotes', () => {
  it('takes the weakest guarantee, the last leg minimum and the earliest expiry', () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-09T12:00:00Z'), toFake: ['Date'] })
    const firm = legQuote({ expiresAt: '2026-10-09T12:03:00.000Z' })
    const min = legQuote({ guarantee: 'min_output', output: usdc('98'), minOutput: usdc('97.5'), slippageBps: 50 })
    expect(combineLegQuotes(pathway, [firm, min])).toMatchObject({ guarantee: 'min_output', minOutput: usdc('97.5'), slippageBps: 50, expiresAt: '2026-10-09T12:03:00.000Z' })
    expect(combineLegQuotes(pathway, [firm])).toMatchObject({ guarantee: 'firm', minOutput: usdc('99') })
    const est = combineLegQuotes(pathway, [legQuote({ guarantee: 'estimate' }), min])
    expect(est.guarantee).toBe('estimate')
    expect(est).not.toHaveProperty('minOutput')
    expect(est).not.toHaveProperty('slippageBps')
  })

  it('gives a quote with no valid leg expiry (a third-party adapter bug) 5 minutes', () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-09T12:00:00Z'), toFake: ['Date'] })
    const q = combineLegQuotes(pathway, [legQuote({ expiresAt: 'later' as string })])
    expect(q.expiresAt).toBe('2026-10-09T12:05:00.000Z')
  })
})

/** A bridge-like card provider with a guaranteed minimum. Webhooks report the delivered output. */
function minAdapter() {
  const spec: LegSpec = {
    id: 'card', kind: 'fiat_onramp', methods: ['card'],
    from: { asset: { kind: 'fiat', currencies: '*' }, location: ['user_account'] },
    to: { asset: { kind: 'crypto', chains: { 'eip155:8453': [USDC['eip155:8453']!] } }, location: ['address'] },
    regions: { allow: ['*'], deny: [] }, eta: { min: 1, max: 2 }, surfaces: ['REDIRECT'],
  }
  let n = 0
  return createAdapter({
    id: 'minout', name: 'Min out', legs: [spec],
    async quote({ leg, amountIn }) {
      return { adapterId: 'minout', legId: leg.legId, input: amountIn!, output: usdc('100'), minOutput: usdc('95'), guarantee: 'min_output', slippageBps: 500, fees: [], eta: { min: 1, max: 2 }, expiresAt: new Date(Date.now() + 60_000).toISOString() }
    },
    async start() {
      return { status: 'requires_action', ref: `m-${++n}`, action: { kind: 'payment', surface: { kind: 'REDIRECT', url: 'https://provider.test/pay', popup: true }, transitions: [{ name: 'poll', kind: 'AWAIT', poll: { intervalMs: 1000, backoff: 1, maxIntervalMs: 1000, giveUpAfterMs: 60_000 } }] } }
    },
    webhook: {
      async verify() {
        return true
      },
      async parse(raw) {
        return JSON.parse(raw) as LegEvent[]
      },
    },
  })
}

async function paid(received: string) {
  const store = memoryStore()
  const ramp = createOpenRamp({ secret: 's'.repeat(40), baseUrl: BASE, adapters: [minAdapter()], logger: quiet, store })
  const call = (path: string, secret: string, body?: unknown) =>
    ramp.handle(new Request(`${BASE}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
  const s = await ramp.sessions.create({ userId: 'u', country: 'US', destination: DEST })
  await call(`/sessions/${s.id}/plan`, s.clientSecret, {})
  const q = await (await call(`/sessions/${s.id}/quotes`, s.clientSecret, { method: 'card', amount: '100' })).json()
  expect(q.quotes[0]).toMatchObject({ guarantee: 'min_output', minOutput: usdc('95'), slippageBps: 500, expiresAt: expect.any(String) })
  await call(`/sessions/${s.id}/select`, s.clientSecret, { quoteId: q.quotes[0].id })
  const ref = (await store.get(s.id))!.active!.legs[0]!.ref
  const hook = await ramp.handle(new Request(`${BASE}/webhooks/minout`, { method: 'POST', body: JSON.stringify([{ ref, status: 'succeeded', output: usdc(received) }]) }))
  expect(hook.status).toBe(200)
  return (await ramp.sessions.retrieve(s.id))!
}

describe('the output check uses minOutput', () => {
  it('an output at or above the minimum is a full delivery, even below the default tolerance', async () => {
    const s = await paid('96')
    expect(s.status).toBe('succeeded')
    expect(s.result).toMatchObject({ output: usdc('96'), outputConfirmed: true })
    expect(s.result).not.toHaveProperty('amountMismatch')
  })

  it('an output below the minimum is short', async () => {
    const s = await paid('94.5')
    expect(s.result).toMatchObject({ amountMismatch: { reason: 'short', shortfall: '5.5' } })
  })
})
