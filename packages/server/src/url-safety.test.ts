// Every URL that reaches the browser, the admin page or a webhook passes one check where adapter data
// enters the server (`sanitizeLegStep`). Explorer links come from the trusted chain table only.
import { describe, expect, it } from 'vitest'
import { createAdapter } from '@openrampkit/adapter'
import type { LegEvent } from '@openrampkit/adapter'
import { USDC, explorerTxUrl } from '@openrampkit/core'
import type { LegSpec } from '@openrampkit/core'
import { createOpenRamp, memoryStore } from './index.js'

const BASE = 'https://app.test/api/openramp'
const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const DEST = { type: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']!, address: '0x000000000000000000000000000000000000beef' }
const HASH = '0x' + 'ab'.repeat(32)
const SIG = '5'.repeat(88)

describe('explorerTxUrl', () => {
  it('builds a link from the chain table and a well formed hash only', () => {
    expect(explorerTxUrl('eip155:8453', HASH)).toBe(`https://basescan.org/tx/${HASH}`)
    expect(explorerTxUrl('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', SIG)).toBe(`https://explorer.solana.com/tx/${SIG}?cluster=devnet`)
    expect(explorerTxUrl('eip155:8453', 'javascript:alert(1)')).toBeUndefined()
    expect(explorerTxUrl('eip155:8453', `${HASH}/../../x`)).toBeUndefined()
    expect(explorerTxUrl('eip155:999999', HASH)).toBeUndefined()
  })
})

function make() {
  const spec: LegSpec = {
    id: 'card', kind: 'fiat_onramp', methods: ['card'],
    from: { asset: { kind: 'fiat', currencies: '*' }, location: ['user_account'] },
    to: { asset: { kind: 'crypto', chains: { 'eip155:8453': [USDC['eip155:8453']!] } }, location: ['address'] },
    regions: { allow: ['*'], deny: [] }, eta: { min: 1, max: 2 }, surfaces: ['REDIRECT'],
  }
  let n = 0
  const a = createAdapter({
    id: 'evil', name: 'Evil', legs: [spec],
    async quote({ leg, amountIn }) {
      return { adapterId: 'evil', legId: leg.legId, input: amountIn!, output: { value: '9', asset: { kind: 'crypto', chain: 'eip155:8453', token: USDC['eip155:8453']! } }, fees: [], eta: { min: 1, max: 2 }, guarantee: 'estimate', expiresAt: new Date(Date.now() + 60_000).toISOString() }
    },
    async start() {
      return { status: 'requires_action', ref: `e-${++n}`, action: { kind: 'payment', surface: { kind: 'REDIRECT', url: 'https://provider.test/pay', popup: true }, transitions: [] } }
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
  const store = memoryStore()
  const sent: string[] = []
  const ramp = createOpenRamp({
    secret: 's'.repeat(40), baseUrl: BASE, adapters: [a], logger: quiet, store, admin: { token: 't'.repeat(32) },
    webhooks: { url: 'https://app.test/hooks', secret: 'w'.repeat(32) },
    fetch: async (_u, init) => {
      sent.push(String(init?.body))
      return new Response('ok')
    },
  })
  const call = (path: string, secret: string, body?: unknown) =>
    ramp.handle(new Request(`${BASE}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
  const hook = (evs: unknown) => ramp.handle(new Request(`${BASE}/webhooks/evil`, { method: 'POST', body: JSON.stringify(evs) }))
  async function pay() {
    const s = await ramp.sessions.create({ userId: 'u', country: 'US', destination: DEST })
    await call(`/sessions/${s.id}/plan`, s.clientSecret, {})
    const q = await (await call(`/sessions/${s.id}/quotes`, s.clientSecret, { method: 'card', amount: '10' })).json()
    await call(`/sessions/${s.id}/select`, s.clientSecret, { quoteId: q.quotes[0].id })
    return { ...s, quoteId: q.quotes[0].id as string }
  }
  return { ramp, store, call, hook, pay, sent }
}

describe('adapter data with links', () => {
  it('drops an adapter explorer link and a hash that is not letters and digits; builds the link from the chain table', async () => {
    const t = make()
    const s = await t.pay()
    const r = await t.hook([
      {
        ref: 'e-1',
        status: 'succeeded',
        transactions: [
          { role: 'destination', hash: HASH, explorerUrl: 'javascript:alert(1)', url: 'data:text/html,x' },
          { role: 'source', hash: '<img src=x onerror=alert(1)>' },
          { role: 'source', hash: '0x' + 'cd'.repeat(32), chain: 'javascript:alert(1)' },
        ],
      },
    ])
    expect(r.status).toBe(200)
    const pub = await (await t.call(`/sessions/${s.id}`, s.clientSecret)).json()
    expect(pub.result.transactions).toEqual([{ role: 'destination', chain: 'eip155:8453', hash: HASH, legIndex: 0, explorerUrl: `https://basescan.org/tx/${HASH}` }])
    const all = JSON.stringify([pub, await t.ramp.admin.get(s.id), t.sent])
    expect(all).not.toContain('javascript:')
    expect(all).not.toContain('data:text')
    expect(all).not.toContain('<img')
  })

  it('a provider event with an unsafe surface URL fails the leg; the URL never reaches the browser', async () => {
    const t = make()
    const s = await t.pay()
    await t.hook([{ ref: 'e-1', status: 'requires_action', action: { kind: 'payment', surface: { kind: 'REDIRECT', url: 'javascript:alert(1)', popup: true }, transitions: [] } }])
    const text = await (await t.call(`/sessions/${s.id}`, s.clientSecret)).text()
    expect(text).not.toContain('javascript:')
    expect(JSON.parse(text).payment.legs[0].status).toBe('failed')
  })

  it('an event for an earlier attempt is checked too: the stored attempt keeps no unsafe URL', async () => {
    const t = make()
    const s = await t.pay()
    expect((await t.call(`/sessions/${s.id}/transitions/restart`, s.clientSecret, {})).status).toBe(200)
    await t.hook([{ ref: 'e-1', status: 'requires_action', action: { kind: 'payment', surface: { kind: 'DEEPLINK', url: 'javascript:alert(1)', appName: 'x' }, transitions: [] } }])
    const rec = (await t.store.get(s.id))!
    expect(JSON.stringify(rec.attempts)).not.toContain('javascript:')
    expect(JSON.stringify(await t.ramp.admin.get(s.id))).not.toContain('javascript:')
  })
})
