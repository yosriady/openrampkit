// End-to-end: an MCP client (the agent) talks to the OpenRampKit MCP server, which drives an
// in-process OpenRampKit server with the mock adapter. A scripted "person" opens the pay link.
import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mockAdapter } from '@openrampkit/adapter-mock'
import { DepositController, createOpenRampClient } from '@openrampkit/client'
import { USDC } from '@openrampkit/core'
import { createOpenRamp } from '@openrampkit/server'
import type { CreateSessionInput } from '@openrampkit/server'
import { createMcpHttpHandler, createOpenRampMcpServer } from './index.js'
import type { OpenRampMcpConfig } from './index.js'

const BASE = 'https://ramp.test/api/openramp'
const SECRET = 'test-secret-test-secret-test-secret-123'
const TREASURY = '0x000000000000000000000000000000000000beef'
const BASE_USDC = USDC['eip155:8453']!
const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const CLIENT_SECRET = /ors_[0-9a-f]{24}\.[0-9a-f]{48}/

function setup(extra: Partial<OpenRampMcpConfig> = {}) {
  const ramp = createOpenRamp({ secret: SECRET, baseUrl: BASE, adapters: [mockAdapter({ settleMs: 30, crypto: true, bridge: true, offramp: true })], logger: quiet })
  const config: OpenRampMcpConfig = {
    connection: { openramp: ramp },
    deposit: { destinations: [{ name: 'treasury', description: 'Team wallet', chain: 'eip155:8453', token: BASE_USDC, address: TREASURY, symbol: 'USDC', decimals: 6 }] },
    withdraw: { source: { chain: 'eip155:8453', token: BASE_USDC, symbol: 'USDC', decimals: 6, custody: 'app' } },
    maxAmounts: { VND: '2000000', USDC: '50' },
    pollIntervalMs: 25,
    ...extra,
  }
  return { ramp, config }
}

async function connect(config: OpenRampMcpConfig) {
  const server = createOpenRampMcpServer(config)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-agent', version: '1.0.0' })
  await Promise.all([server.connect(a), client.connect(b)])
  return client
}

type ToolOut = Record<string, any>
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ data: ToolOut; isError: boolean; text: string }> {
  const r = await client.callTool({ name, arguments: args })
  const text = (r.content as Array<{ type: string; text: string }>)[0]!.text
  expect(text).not.toMatch(CLIENT_SECRET)
  expect(text).not.toContain(SECRET)
  let data: ToolOut
  try {
    data = JSON.parse(text)
  } catch {
    data = { raw: text }
  }
  return { data, isError: !!r.isError, text }
}

/** The person: opens the pay link, then pays with VietQR in the web component (the real controller). */
async function personPays(ramp: ReturnType<typeof setup>['ramp'], payUrl: string) {
  const page = await ramp.handle(new Request(payUrl))
  expect(page.status).toBe(200)
  const credential = payUrl.slice(`${BASE}/pay/`.length)
  expect(await page.text()).toContain(credential)
  const client = createOpenRampClient({ baseUrl: BASE, fetch: async (input, init) => ramp.handle(new Request(String(input), init)) })
  const c = new DepositController({ client, clientSecret: credential })
  await c.start()
  await c.selectMethod('vietqr')
  c.setAmount('500000')
  await c.submitAmount()
  await c.confirm()
  expect(c.getSnapshot().session!.step.surface!.kind).toBe('QR')
  await c.fire('simulate_payment')
  c.destroy()
}

describe('@openrampkit/mcp', () => {
  it('lists the tools, with guardrails in the descriptions', async () => {
    const client = await connect(setup().config)
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'create_deposit_session',
      'create_withdraw_session',
      'get_quotes',
      'get_session_status',
      'list_payment_methods',
      'wait_for_completion',
    ])
    const dep = tools.find((t) => t.name === 'create_deposit_session')!
    expect(dep.description).toContain('"treasury"')
    expect(dep.description).toContain('2000000 VND')
    expect(Object.keys(dep.inputSchema.properties!)).not.toContain('custom_destination')
    expect(tools.find((t) => t.name === 'get_quotes')!.annotations?.readOnlyHint).toBe(true)
  })

  it('lists methods and quotes for Vietnam', async () => {
    const client = await connect(setup().config)
    const methods = await call(client, 'list_payment_methods', { country: 'vn' })
    expect(methods.isError).toBe(false)
    expect(methods.data.currency).toBe('VND')
    expect(methods.data.methods.map((m: ToolOut) => m.method)).toContain('vietqr')

    const quotes = await call(client, 'get_quotes', { country: 'VN', amount: '500000', method: 'vietqr' })
    expect(quotes.data.quotes[0]).toMatchObject({ method: 'vietqr', pay: '500000 VND' })
    expect(quotes.data.quotes[0].receive).toMatch(/ USDC$/)

    const all = await call(client, 'get_quotes', { country: 'VN', amount: '500000' })
    expect(all.data.quotes.length).toBeGreaterThan(0)
  })

  it('full flow: create a deposit, the person pays with VietQR on the pay link, the agent waits until completed', async () => {
    const { ramp, config } = setup()
    const client = await connect(config)
    const created = await call(client, 'create_deposit_session', { country: 'VN', max_amount: '1000000', reference: 'order-42' })
    expect(created.isError).toBe(false)
    const d = created.data
    expect(d.session_id).toMatch(/^ors_/)
    expect(d.pay_url.startsWith(`${BASE}/pay/${d.session_id}.pay_`)).toBe(true)
    expect(d.bounds).toBe('up to 1000000 VND')
    expect(d.destination).toEqual({ chain: 'eip155:8453', token: 'USDC', address: TREASURY })

    const stored = (await ramp.sessions.retrieve(d.session_id))!
    expect(stored.destination).toMatchObject({ address: TREASURY })
    expect(stored.amountBounds).toEqual({ max: '1000000', currency: 'VND' })

    const before = await call(client, 'get_session_status', { session_id: d.session_id })
    expect(before.data).toMatchObject({ status: 'requires_payment_method', done: false })

    await personPays(ramp, d.pay_url)

    const done = await call(client, 'wait_for_completion', { session_id: d.session_id, timeout_seconds: 20 })
    expect(done.data).toMatchObject({ status: 'succeeded', state: 'COMPLETED', done: true, method: 'vietqr', paid: '500000 VND' })
    expect(done.data.received).toMatch(/ USDC$/)
  })

  it('direct payment: method and amount return a VietQR payload the agent can show', async () => {
    const { ramp, config } = setup()
    const client = await connect(config)
    const created = await call(client, 'create_deposit_session', { country: 'VN', method: 'vietqr', amount: '300000' })
    expect(created.data.payment).toMatchObject({ kind: 'QR', amount: '300000 VND' })
    expect(created.data.payment.qr_payload.length).toBeGreaterThan(10)
    // The person scans and pays: here the mock's test transition stands in for the bank app.
    const credential = created.data.pay_url.slice(`${BASE}/pay/`.length)
    const r = await ramp.handle(
      new Request(`${BASE}/sessions/${created.data.session_id}/transitions/simulate_payment`, { method: 'POST', headers: { authorization: `Bearer ${credential}` }, body: '{}' }),
    )
    expect(r.status).toBe(200)
    const done = await call(client, 'wait_for_completion', { session_id: created.data.session_id, timeout_seconds: 20 })
    expect(done.data.status).toBe('succeeded')
  })

  it('guardrails: caps, currencies, destinations and session scope', async () => {
    const { ramp, config } = setup()
    const client = await connect(config)
    expect((await call(client, 'create_deposit_session', { country: 'VN', max_amount: '9000000' })).data.error.code).toBe('AMOUNT_TOO_HIGH')
    expect((await call(client, 'create_deposit_session', { country: 'TH' })).data.error.code).toBe('CURRENCY_NOT_ALLOWED')
    expect((await call(client, 'create_deposit_session', { country: 'VN', method: 'vietqr', amount: '1500000', max_amount: '1000000' })).data.error.code).toBe('BAD_REQUEST')
    // A name outside the allowlist fails schema validation.
    expect((await call(client, 'create_deposit_session', { country: 'VN', destination: 'attacker' })).isError).toBe(true)
    // A custom address is not part of the schema when not allowed: it is dropped, and the funds still go to the treasury.
    const sneaky = await call(client, 'create_deposit_session', {
      country: 'VN',
      custom_destination: { chain: 'eip155:8453', token: BASE_USDC, address: '0x1111111111111111111111111111111111111111' },
    })
    expect((await ramp.sessions.retrieve(sneaky.data.session_id))!.destination).toMatchObject({ address: TREASURY })
    // Only sessions this server created
    expect((await call(client, 'get_session_status', { session_id: 'ors_000000000000000000000000' })).data.error.code).toBe('UNKNOWN_SESSION')
    const other = await ramp.sessions.create({ userId: 'x', destination: { type: 'crypto', chain: 'eip155:8453', token: BASE_USDC, address: TREASURY } })
    expect((await call(client, 'get_session_status', { session_id: other.id })).data.error.code).toBe('UNKNOWN_SESSION')
    // A config without caps is refused
    expect(() => createOpenRampMcpServer({ ...config, maxAmounts: {} })).toThrow(/maxAmounts/)
  })

  it('custom addresses only on allowed chains and tokens', async () => {
    const { ramp, config } = setup({})
    const client = await connect({ ...config, deposit: { ...config.deposit!, allowCustomAddress: { chains: ['eip155:8453'] } } })
    const wallet = '0x2222222222222222222222222222222222222222'
    const okRes = await call(client, 'create_deposit_session', { country: 'VN', custom_destination: { chain: 'eip155:8453', token: BASE_USDC, address: wallet } })
    expect((await ramp.sessions.retrieve(okRes.data.session_id))!.destination).toMatchObject({ address: wallet, symbol: 'USDC' })
    const badChain = await call(client, 'create_deposit_session', { country: 'VN', custom_destination: { chain: 'eip155:1', token: BASE_USDC, address: wallet } })
    expect(badChain.data.error.code).toBe('DESTINATION_NOT_ALLOWED')
    const badToken = await call(client, 'create_deposit_session', { country: 'VN', custom_destination: { chain: 'eip155:8453', token: '0x3333333333333333333333333333333333333333', address: wallet } })
    expect(badToken.data.error.code).toBe('DESTINATION_NOT_ALLOWED')
    const badAddr = await call(client, 'create_deposit_session', { country: 'VN', custom_destination: { chain: 'eip155:8453', token: BASE_USDC, address: '0x12' } })
    expect(badAddr.data.error.code).toBe('BAD_REQUEST')
  })

  it('payout: an exact amount, cash targets only, and the person picks how to receive', async () => {
    const { ramp, config } = setup()
    const client = await connect(config)
    const r = await call(client, 'create_withdraw_session', { country: 'PH', amount: '20' })
    expect(r.data).toMatchObject({ bounds: 'exactly 20 USDC', source: { token: 'USDC', custody: 'app' } })
    const s = (await ramp.sessions.retrieve(r.data.session_id))!
    expect(s.direction).toBe('withdraw')
    expect(s.allowedDestinations).toEqual({ fiat: {} })
    expect(s.amountBounds).toEqual({ min: '20', max: '20', currency: 'USDC' })
    const page = await (await ramp.handle(new Request(r.data.pay_url))).text()
    expect(page).toContain('"direction":"withdraw"')
    expect((await call(client, 'create_withdraw_session', { country: 'PH', amount: '51' })).data.error.code).toBe('AMOUNT_TOO_HIGH')

    const methods = await call(client, 'list_payment_methods', { country: 'PH', direction: 'withdraw' })
    expect(methods.data.currency).toBe('PHP')
    expect(methods.data.methods.map((m: ToolOut) => m.method)).toContain('gcash')
  })

  it('wait_for_completion is bounded', async () => {
    const client = await connect(setup().config)
    const created = await call(client, 'create_deposit_session', { country: 'VN' })
    const t0 = Date.now()
    const r = await call(client, 'wait_for_completion', { session_id: created.data.session_id, timeout_seconds: 1 })
    expect(r.data).toMatchObject({ status: 'requires_payment_method', timed_out: true, done: false })
    expect(Date.now() - t0).toBeLessThan(3000)
  })

  it('over HTTP: the app key creates sessions; Streamable HTTP needs the bearer token', async () => {
    const APP_KEY = 'app-key-123'
    const ramp = createOpenRamp({
      secret: SECRET,
      baseUrl: BASE,
      adapters: [mockAdapter({ settleMs: 30 })],
      logger: quiet,
      authorize: async (req, body) => (req.headers.get('x-app-key') === APP_KEY ? (body as CreateSessionInput) : null),
    })
    const toRamp = async (input: RequestInfo | URL, init?: RequestInit) => ramp.handle(input instanceof Request ? input : new Request(String(input), init))
    const { config } = setup({ connection: { baseUrl: BASE, appKey: APP_KEY, fetch: toRamp } })
    const handler = createMcpHttpHandler(config, { bearerToken: 'mcp-token-0123456789' })

    expect((await handler(new Request('http://mcp.test/mcp', { method: 'POST', body: '{}' }))).status).toBe(401)

    const client = new Client({ name: 'http-agent', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://mcp.test/mcp'), {
        requestInit: { headers: { authorization: 'Bearer mcp-token-0123456789' } },
        fetch: async (input, init) => handler(new Request(input, init)),
      }),
    )
    const created = await call(client, 'create_deposit_session', { country: 'VN', max_amount: '1000000' })
    expect(created.isError).toBe(false)
    // A later request (a new stateless MCP server) still knows the session.
    const status = await call(client, 'get_session_status', { session_id: created.data.session_id })
    expect(status.data.status).toBe('requires_payment_method')

    await personPays(ramp, created.data.pay_url)
    const done = await call(client, 'wait_for_completion', { session_id: created.data.session_id, timeout_seconds: 20 })
    expect(done.data.status).toBe('succeeded')
    await client.close()

    const bad = setup({ connection: { baseUrl: BASE, appKey: 'wrong', fetch: toRamp } })
    const c2 = await connect(bad.config)
    expect((await call(c2, 'create_deposit_session', { country: 'VN' })).data.error.code).toBe('UNAUTHORIZED')
  })
})
