// Flashnet payouts through the server: the Lightning target from /target, quotes, select, the
// WALLET_TX (user wallet or treasury), and completion. The provider answers come from a fake fetch.
import { describe, expect, it, vi } from 'vitest'
import { erc20TransferData } from '@openrampkit/adapter'
import { fakeFetch } from '@openrampkit/adapter/testing'
import type { FakeRoute } from '@openrampkit/adapter/testing'
import { USDC } from '@openrampkit/core'
import type { PlanResult, PublicSession, Quote } from '@openrampkit/core'
import { createOpenRamp } from '@openrampkit/server'
import type { CreateSessionInput, OpenRampConfig, TreasurySendInput } from '@openrampkit/server'
import { flashnet } from './index.js'

const BASE = 'https://app.test/api/openramp'
const WALLET = '0x1111111111111111111111111111111111111111'
const TREASURY = '0x9999999999999999999999999999999999999999'
const DEPOSIT = '0x7777777777777777777777777777777777777777'
const QID = 'q_7e450ab4-935b-4f8d-a6c4-4987a3cd2831'
const TX = `0x${'ab'.repeat(32)}`
const BASE_USDC = USDC['eip155:8453']!
const quiet = { debug() {}, info() {}, warn() {}, error() {} }

function setup(extra: Partial<OpenRampConfig> = {}) {
  const state = { funded: false, offramps: 0 }
  const routes: FakeRoute[] = [
    { match: '/v1/orchestration/estimate', reply: () => ({ estimatedOut: '49500', totalFeeAmountUsd: '0.25', destination: { chain: 'lightning', asset: 'BTC', decimals: 8 } }) },
    {
      method: 'POST',
      match: '/v1/orchestration/offramp',
      reply: () => {
        state.offramps++
        return { quoteId: QID, depositAddress: DEPOSIT, amountIn: '50000000', estimatedOut: '49500', amountMode: 'exact_in', expiresAt: new Date(Date.now() + 120_000).toISOString() }
      },
    },
    { method: 'POST', match: '/v1/orchestration/submit', reply: () => ({ orderId: 'ord_1', status: 'processing' }) },
    {
      match: '/v1/orchestration/status',
      reply: () =>
        state.funded
          ? { order: { id: 'ord_1', quoteId: QID, status: 'completed', sourceChain: 'base', sourceAsset: 'USDC', destinationChain: 'lightning', destinationAsset: 'BTC', recipientAddress: 'alice@cash.app', sourceTxHash: TX, amountIn: '50000000', amountOut: '49400' } }
          : new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 }),
    },
  ]
  const { fetch, calls } = fakeFetch(routes)
  const ramp = createOpenRamp({
    secret: 's'.repeat(40),
    baseUrl: BASE,
    adapters: [flashnet({ apiKey: 'fn_test', webhookSecret: 'whsec_x', legs: ['cash_app_payout', 'lightning_payout'] })],
    logger: quiet,
    fetch,
    ...extra,
  })
  const call = async <T = unknown>(path: string, secret: string, body?: unknown) => {
    const headers = new Headers({ authorization: `Bearer ${secret}` })
    if (body !== undefined) headers.set('content-type', 'application/json')
    const res = await ramp.handle(new Request(`${BASE}${path}`, { method: body === undefined ? 'GET' : 'POST', headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }))
    return { status: res.status, body: (await res.json()) as T & { error?: { code: string; message: string } } }
  }
  const create = (input: Partial<CreateSessionInput> = {}) =>
    ramp.sessions.create({
      userId: 'u1',
      direction: 'withdraw',
      source: { chain: 'eip155:8453', token: BASE_USDC, custody: 'user_wallet' },
      country: 'US',
      region: 'US-CA',
      allowedDestinations: { lightning: { domains: ['cash.app'] } },
      ...input,
    } as CreateSessionInput)
  return { ramp, call, create, calls, state }
}

describe('Flashnet payouts through the server', () => {
  it('$cashtag target, quote, select: the user signs our ERC-20 transfer, then the payout completes', async () => {
    const t = setup()
    const s = await t.create()
    const plan = await t.call<PlanResult>(`/sessions/${s.id}/target`, s.clientSecret, { type: 'lightning', address: '$alice', walletConnected: true, walletAddress: WALLET })
    expect(plan.status).toBe(200)
    expect(plan.body.methods.map((m) => [m.method, m.group])).toEqual([['cash_app', 'recommended']])
    const q = await t.call<{ quotes: Quote[] }>(`/sessions/${s.id}/quotes`, s.clientSecret, { method: 'cash_app', amount: '50' })
    expect(q.status).toBe(200)
    expect(q.body.quotes[0]!.output).toMatchObject({ value: '0.000495', asset: { symbol: 'BTC' } })
    const sel = await t.call<PublicSession>(`/sessions/${s.id}/select`, s.clientSecret, { quoteId: q.body.quotes[0]!.id })
    expect(sel.status).toBe(200)
    expect(sel.body.step).toMatchObject({ state: 'PAYMENT', surface: { kind: 'WALLET_TX', chain: 'eip155:8453', txs: [{ to: BASE_USDC, data: erc20TransferData(DEPOSIT, '50000000'), value: '0', chainId: 8453 }] } })
    // The recipient is the server's target, and the refund goes to the sender
    expect(t.calls.find((c) => c.url.endsWith('/offramp'))!.body).toMatchObject({ recipientAddress: '$alice', refundAddress: WALLET, amount: '50000000', sourceChain: 'base', sourceAsset: 'USDC' })

    // While the payout runs, the target cannot change and no second payout starts
    expect((await t.call(`/sessions/${s.id}/target`, s.clientSecret, { type: 'lightning', address: '$mallory' })).status).toBe(409)
    expect((await t.call(`/sessions/${s.id}/select`, s.clientSecret, { quoteId: q.body.quotes[0]!.id })).status).toBe(409)
    expect(t.state.offramps).toBe(1)

    const sent = await t.call<PublicSession>(`/sessions/${s.id}/transitions/submit_tx`, s.clientSecret, { inputs: { txHash: TX } })
    expect(sent.body.step.state).toBe('PROCESSING')
    t.state.funded = true
    const done = await t.call<PublicSession>(`/sessions/${s.id}/step`, s.clientSecret)
    expect(done.body.step.state).toBe('COMPLETED')
    expect(done.body.result).toMatchObject({ output: { value: '0.000494', asset: { symbol: 'BTC' } }, outputConfirmed: true })
    expect(done.body.destination).toEqual({ type: 'lightning', address: 'alice@cash.app', cashtag: '$alice' })
  })

  it('a Lightning address outside allowedDestinations domains never reaches Flashnet', async () => {
    const t = setup()
    const s = await t.create()
    const r = await t.call(`/sessions/${s.id}/target`, s.clientSecret, { type: 'lightning', address: 'bob@example.com', walletConnected: true, walletAddress: WALLET })
    expect(r.status).toBe(403)
    expect(t.calls).toHaveLength(0)
  })

  it('app custody: the treasury sends the transfer once, with the quoted amount to the deposit address', async () => {
    const sends: TreasurySendInput[] = []
    const treasury = { address: TREASURY, send: vi.fn(async (i: TreasurySendInput) => (sends.push(i), { hash: TX })) }
    const t = setup({ treasury })
    const s = await t.create({ source: { chain: 'eip155:8453', token: BASE_USDC, custody: 'app' }, allowedDestinations: { lightning: {} } })
    expect((await t.call(`/sessions/${s.id}/target`, s.clientSecret, { type: 'lightning', address: 'bob@example.com' })).status).toBe(200)
    const q = await t.call<{ quotes: Quote[] }>(`/sessions/${s.id}/quotes`, s.clientSecret, { method: 'lightning', amount: '50' })
    expect(q.status).toBe(200)
    const sel = await t.call<PublicSession>(`/sessions/${s.id}/select`, s.clientSecret, { quoteId: q.body.quotes[0]!.id })
    expect(sel.body.step.state).toBe('PROCESSING')
    expect(sends).toEqual([{ sessionId: s.id, userId: 'u1', chain: 'eip155:8453', txs: [{ to: BASE_USDC, data: erc20TransferData(DEPOSIT, '50000000'), value: '0', chainId: 8453 }], idempotencyKey: expect.any(String) }])
    // The refund goes to the treasury, and the recipient is the server's target
    expect(t.calls.find((c) => c.url.endsWith('/offramp'))!.body).toMatchObject({ recipientAddress: 'bob@example.com', refundAddress: TREASURY })
    // The treasury's hash went to Orchestra's /submit
    expect(t.calls.find((c) => c.url.endsWith('/submit'))!.body).toEqual({ quoteId: QID, txHash: TX })
    t.state.funded = true
    // The order names alice@cash.app, not bob@example.com: the payout is held, never completed
    const held = await t.call<PublicSession>(`/sessions/${s.id}/step`, s.clientSecret)
    expect(held.body.step.state).toBe('PROCESSING')
    expect(treasury.send).toHaveBeenCalledTimes(1)
  })
})
