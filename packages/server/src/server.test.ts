// End-to-end tests through the HTTP handler, with the mock adapter and the real client controller.
import { describe, expect, it } from 'vitest'
import { mockAdapter } from '@openrampkit/adapter-mock'
import { DepositController, createMockWallet, createOpenRampClient } from '@openrampkit/client'
import { USDC } from '@openrampkit/core'
import { createOpenRamp, verifyWebhook } from './index.js'

const BASE = 'http://localhost/api/openramp'
const SECRET = 'test-secret-test-secret-test-secret-123'
const MONAD_TOKEN = '0x00000000000000000000000000000000000000c0' // placeholder token on an unlisted chain

function setup(opts: { webhooks?: boolean } = {}) {
  const delivered: Array<{ headers: Headers; body: string }> = []
  const appFetch: typeof fetch = async (input, init) => {
    delivered.push({ headers: new Headers(init?.headers), body: String(init?.body) })
    return new Response('ok')
  }
  const ramp = createOpenRamp({
    secret: SECRET,
    baseUrl: BASE,
    adapters: [mockAdapter({ settleMs: 30, crypto: true, bridge: true })],
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...(opts.webhooks ? { webhooks: { url: 'http://app.local/hooks', secret: 'whsec_test' }, fetch: appFetch } : {}),
  })
  // The client calls the handler directly (no network).
  const fetchToHandler: typeof fetch = async (input, init) => ramp.handle(new Request(String(input), init))
  const client = createOpenRampClient({ baseUrl: BASE, fetch: fetchToHandler })
  return { ramp, client, delivered, fetchToHandler }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn: () => boolean, ms = 10000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timeout')
    await sleep(20)
  }
}

describe('server + controller, mock provider', () => {
  it('VietQR to Monad: two legs (local QR onramp, then bridge), completes', async () => {
    const { ramp, client } = setup()
    const s = await ramp.sessions.create({ userId: 'u1', country: 'VN', destination: { type: 'crypto', chain: 'eip155:143', token: MONAD_TOKEN, address: '0x000000000000000000000000000000000000beef', symbol: 'USDC', decimals: 6 } })
    const c = new DepositController({ client, clientSecret: s.clientSecret })
    await c.start()
    let snap = c.getSnapshot()
    expect(snap.screen).toBe('methods')
    expect(snap.tab).toBe('crypto')
    const cash = c.methodsForTab('cash')
    expect(cash[0]!.method).toBe('vietqr')
    expect(cash[0]!.group).toBe('recommended')

    await c.selectMethod('vietqr')
    c.setAmount('500000')
    await c.submitAmount()
    snap = c.getSnapshot()
    expect(snap.quotes).toHaveLength(1)
    expect(snap.quotes[0]!.legs.map((l) => l.legId)).toEqual(['local', 'bridge'])
    expect(snap.quotes[0]!.output.asset).toMatchObject({ chain: 'eip155:143' })

    await c.confirm()
    snap = c.getSnapshot()
    expect(snap.session!.step.state).toBe('PAYMENT')
    expect(snap.session!.step.surface!.kind).toBe('QR')

    await c.fire('simulate_payment')
    await waitFor(() => c.getSnapshot().screen === 'result')
    const done = await c.done
    expect(done.step.state).toBe('COMPLETED')
    expect(done.step.progress!.legs.map((l) => l.status)).toEqual(['succeeded', 'succeeded'])
    c.destroy()
  })

  it('card: popup-safe start URL redirects to the hosted checkout, which completes the order', async () => {
    const { ramp, client, fetchToHandler } = setup()
    const s = await ramp.sessions.create({ userId: 'u2', country: 'SG', destination: { type: 'crypto', chain: 'eip155:8453', token: USDC['eip155:8453']!, address: '0x000000000000000000000000000000000000beef' } })
    const c = new DepositController({ client, clientSecret: s.clientSecret })
    await c.start()
    await c.selectMethod('card')
    c.setAmount('100')
    await c.submitAmount()
    expect(c.getSnapshot().quotes[0]!.legs).toHaveLength(1)
    await c.confirm()
    const surface = c.getSnapshot().session!.step.surface!
    expect(surface.kind).toBe('REDIRECT')
    if (surface.kind !== 'REDIRECT') return
    expect(surface.url.startsWith(`${BASE}/start/`)).toBe(true)

    const r302 = await fetchToHandler(surface.url, { redirect: 'manual' })
    expect(r302.status).toBe(302)
    const checkout = r302.headers.get('location')!
    expect(checkout).toContain('/adapters/mock/checkout?ref=')
    const page = await (await fetchToHandler(checkout)).text()
    expect(page).toContain('Test mode')

    const ref = new URL(checkout).searchParams.get('ref')!
    const form = new FormData()
    form.set('ref', ref)
    form.set('outcome', 'success')
    const paid = await fetchToHandler(`${BASE}/adapters/mock/pay`, { method: 'POST', body: form })
    expect(paid.status).toBe(200)
    await waitFor(() => c.getSnapshot().screen === 'result')
    expect((await c.done).status).toBe('completed')
    c.destroy()
  })

  it('tampered start URL is refused', async () => {
    const { fetchToHandler } = setup()
    const r = await fetchToHandler(`${BASE}/start/ors_x.abc.0000000000000000000000000000000000`)
    expect(r.status).toBe(401)
  })

  it('wallet: mock wallet signs, then the leg settles', async () => {
    const { ramp, client } = setup()
    const wallet = createMockWallet({ delayMs: 10 })
    const s = await ramp.sessions.create({ userId: 'u3', country: 'US', destination: { type: 'crypto', chain: 'eip155:8453', token: USDC['eip155:8453']!, address: '0x000000000000000000000000000000000000beef' } })
    const c = new DepositController({ client, clientSecret: s.clientSecret, wallet })
    await c.start()
    const m = c.methodsForTab('crypto')
    expect(m[0]).toMatchObject({ method: 'wallet', group: 'connected' })
    expect(c.getSnapshot().source).toMatchObject({ chain: 'eip155:42161', symbol: 'USDC' })
    await c.selectMethod('wallet')
    c.setAmount('25')
    await c.submitAmount()
    await c.confirm()
    expect(c.getSnapshot().session!.step.surface!.kind).toBe('WALLET_TX')
    await c.sendWalletTransactions()
    expect(wallet.sent).toHaveLength(1)
    await waitFor(() => c.getSnapshot().screen === 'result')
    expect((await c.done).step.progress!.legs[0]!.txHash).toMatch(/^0x/)
    c.destroy()
  })

  it('merchant destination: IDR QRIS pay-in, no crypto involved', async () => {
    const { ramp, client } = setup()
    const s = await ramp.sessions.create({ userId: 'u4', country: 'ID', destination: { type: 'merchant', currency: 'IDR' } })
    const c = new DepositController({ client, clientSecret: s.clientSecret })
    await c.start()
    expect(c.getSnapshot().tab).toBe('cash')
    expect(c.methodsForTab('cash')[0]!.method).toBe('qris')
    expect(c.methodsForTab('crypto')).toHaveLength(0)
    await c.selectMethod('qris')
    c.setAmount('150000')
    await c.submitAmount()
    const q = c.getSnapshot().quotes[0]!
    expect(q.output.asset).toEqual({ kind: 'fiat', currency: 'IDR' })
    expect(q.output.amount).toBe('148950')
    await c.confirm()
    await c.fire('simulate_payment')
    await waitFor(() => c.getSnapshot().screen === 'result')
    c.destroy()
  })

  it('rejects a wrong session secret and replays idempotent requests', async () => {
    const { ramp, fetchToHandler } = setup()
    const s = await ramp.sessions.create({ userId: 'u5', country: 'VN', destination: { type: 'merchant', currency: 'VND' } })
    const bad = await fetchToHandler(`${BASE}/sessions/${s.id}`, { headers: { authorization: `Bearer ${s.id}.wrong` } })
    expect(bad.status).toBe(401)

    const auth = { authorization: `Bearer ${s.clientSecret}`, 'content-type': 'application/json' }
    await fetchToHandler(`${BASE}/sessions/${s.id}/plan`, { method: 'POST', headers: auth, body: '{}' })
    const qr = await (await fetchToHandler(`${BASE}/sessions/${s.id}/quotes`, { method: 'POST', headers: auth, body: JSON.stringify({ method: 'vietqr', amount: '200000' }) })).json()
    const body = JSON.stringify({ quoteId: qr.quotes[0].id })
    const a = await fetchToHandler(`${BASE}/sessions/${s.id}/select`, { method: 'POST', headers: { ...auth, 'idempotency-key': 'k1' }, body })
    const b = await fetchToHandler(`${BASE}/sessions/${s.id}/select`, { method: 'POST', headers: { ...auth, 'idempotency-key': 'k1' }, body })
    expect(a.status).toBe(200)
    expect(b.headers.get('idempotent-replay')).toBe('true')
    expect(await b.json()).toEqual(await a.json())
  })

  it('sends signed webhooks to the app that verify', async () => {
    const { ramp, client, delivered } = setup({ webhooks: true })
    const s = await ramp.sessions.create({ userId: 'u6', country: 'TH', destination: { type: 'merchant', currency: 'THB' }, metadata: { order: 'o1' } })
    const c = new DepositController({ client, clientSecret: s.clientSecret })
    await c.start()
    await c.selectMethod('promptpay')
    c.setAmount('1000')
    await c.submitAmount()
    await c.confirm()
    await c.fire('simulate_payment')
    await waitFor(() => c.getSnapshot().screen === 'result')
    const types = delivered.map((d) => JSON.parse(d.body).type)
    expect(types).toContain('session.created')
    expect(types).toContain('session.completed')
    const last = delivered.find((d) => JSON.parse(d.body).type === 'session.completed')!
    expect(await verifyWebhook('whsec_test', last.headers, last.body)).toBe(true)
    expect(await verifyWebhook('whsec_wrong', last.headers, last.body)).toBe(false)
    expect(JSON.parse(last.body).data.object.metadata).toEqual({ order: 'o1' })
    c.destroy()
  })
})
