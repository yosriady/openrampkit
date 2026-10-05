// Guardrails across sessions: limits (sessions per hour, total per day), the operator `approve`
// hook, and payouts to bound targets (no pay link, so nobody can send the funds elsewhere).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mockAdapter } from '@openrampkit/adapter-mock'
import { USDC } from '@openrampkit/core'
import { createOpenRamp } from '@openrampkit/server'
import type { TreasurySendInput } from '@openrampkit/server'
import pkg from '../package.json'
import { createMcpHttpHandler, createOpenRampMcpServer, createRampOps, memoryRegistry } from './index.js'
import type { OpenRampMcpConfig, PayoutApproval } from './index.js'

const BASE = 'https://ramp.test/api/openramp'
const SECRET = 'test-secret-test-secret-test-secret-123'
const TREASURY = '0x000000000000000000000000000000000000beef'
const OPS_WALLET = '0x2222222222222222222222222222222222222222'
const BASE_USDC = USDC['eip155:8453']!
const ARB_USDC = USDC['eip155:42161']!
const quiet = { debug() {}, info() {}, warn() {}, error() {} }

function setup(extra: Partial<OpenRampMcpConfig> = {}) {
  const sent: TreasurySendInput[] = []
  const ramp = createOpenRamp({
    secret: SECRET,
    baseUrl: BASE,
    adapters: [mockAdapter({ settleMs: 30, crypto: true, bridge: true, offramp: true })],
    logger: quiet,
    treasury: { address: '0x9999999999999999999999999999999999999999', send: async (i) => (sent.push(i), { hash: `0x${'ab'.repeat(32)}` }) },
  })
  const config: OpenRampMcpConfig = {
    connection: { openramp: ramp },
    deposit: { destinations: [{ name: 'treasury', chain: 'eip155:8453', token: BASE_USDC, address: TREASURY, symbol: 'USDC', decimals: 6 }] },
    withdraw: { source: { chain: 'eip155:8453', token: BASE_USDC, symbol: 'USDC', decimals: 6, custody: 'app' } },
    maxAmounts: { VND: '2000000', USDC: '30' },
    pollIntervalMs: 25,
    ...extra,
  }
  return { ramp, config, sent }
}

async function connect(config: OpenRampMcpConfig) {
  const server = createOpenRampMcpServer(config)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-agent', version: '1.0.0' })
  await Promise.all([server.connect(a), client.connect(b)])
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const r = await client.callTool({ name, arguments: args })
  const text = (r.content as Array<{ type: string; text: string }>)[0]!.text
  let data: Record<string, any>
  try {
    data = JSON.parse(text)
  } catch {
    data = { raw: text }
  }
  return { data, isError: !!r.isError }
}

const opsTarget = { name: 'ops', description: 'Ops wallet on Arbitrum', chain: 'eip155:42161', token: ARB_USDC, address: OPS_WALLET, symbol: 'USDC', decimals: 6 }

afterEach(() => {
  vi.useRealTimers()
})

describe('limits', () => {
  it('maxSessionsPerHour: refuses the next session in the same hour, and allows it in the next hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-05T10:15:00Z'))
    const { config } = setup({ limits: { maxSessionsPerHour: 2 } })
    const client = await connect(config)
    expect((await call(client, 'create_deposit_session', { country: 'VN' })).isError).toBe(false)
    expect((await call(client, 'create_withdraw_session', { country: 'PH', amount: '5' })).isError).toBe(false)
    const third = await call(client, 'create_deposit_session', { country: 'VN' })
    expect(third.isError).toBe(true)
    expect(third.data.error.code).toBe('LIMIT_REACHED')
    expect(third.data.error.message).toContain('2026-10-05T11:00:00.000Z')
    // Preview sessions (methods and quotes) do not count.
    expect((await call(client, 'list_payment_methods', { country: 'VN' })).isError).toBe(false)
    vi.setSystemTime(new Date('2026-10-05T11:00:01Z'))
    expect((await call(client, 'create_deposit_session', { country: 'VN' })).isError).toBe(false)
  })

  it('maxTotalPerDay: counts the largest amount of each session, per currency and direction', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-05T10:00:00Z'))
    const { config } = setup({ limits: { maxTotalPerDay: { USDC: '50', VND: '3000000' } } })
    const client = await connect(config)
    expect((await call(client, 'create_withdraw_session', { country: 'PH', amount: '30' })).isError).toBe(false)
    const over = await call(client, 'create_withdraw_session', { country: 'PH', amount: '25' })
    expect(over.data.error.code).toBe('LIMIT_REACHED')
    expect(over.data.error.message).toContain('Only 20 USDC is left today')
    // An open amount counts its max (the cap, 30 USDC): too much now.
    expect((await call(client, 'create_withdraw_session', { country: 'PH' })).data.error.code).toBe('LIMIT_REACHED')
    // A refused session counted nothing: 20 still fits, then nothing is left.
    expect((await call(client, 'create_withdraw_session', { country: 'PH', amount: '20' })).isError).toBe(false)
    expect((await call(client, 'create_withdraw_session', { country: 'PH', amount: '0.01' })).data.error.message).toContain('Nothing is left today')
    // Deposits have their own total.
    expect((await call(client, 'create_deposit_session', { country: 'VN', max_amount: '2000000' })).isError).toBe(false)
    expect((await call(client, 'create_deposit_session', { country: 'VN', max_amount: '1500000' })).data.error.code).toBe('LIMIT_REACHED')
    // A new UTC day starts a new total.
    vi.setSystemTime(new Date('2026-10-06T00:00:01Z'))
    expect((await call(client, 'create_withdraw_session', { country: 'PH', amount: '30' })).isError).toBe(false)
  })

  it('a session that the server refuses does not count', async () => {
    const ramp = createOpenRamp({ secret: SECRET, baseUrl: BASE, adapters: [mockAdapter({})], logger: quiet, authorize: async () => null })
    const { config } = setup({ connection: { openramp: ramp }, limits: { maxSessionsPerHour: 1 } })
    const ops = createRampOps({ ...config, connection: { baseUrl: BASE, appKey: 'wrong', fetch: async (input, init) => ramp.handle(input instanceof Request ? input : new Request(String(input), init)) } })
    for (let i = 0; i < 3; i++) await expect(ops.createDepositSession({ country: 'VN' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('checks the limits config at startup', () => {
    const { config } = setup()
    expect(() => createRampOps({ ...config, limits: { maxTotalPerDay: { USDC: '100' } } })).toThrow(/Missing: VND/)
    expect(() => createRampOps({ ...config, limits: { maxTotalPerDay: { USDC: '100', VND: '-1' } } })).toThrow(/positive decimal/)
    expect(() => createRampOps({ ...config, limits: { maxSessionsPerHour: 0 } })).toThrow(/positive integer/)
    const noCounters = { get: async () => undefined, set: async () => {} }
    expect(() => createRampOps({ ...config, registry: noCounters, limits: { maxSessionsPerHour: 5 } })).toThrow(/incr/)
    expect(() => createRampOps({ ...config, registry: noCounters })).not.toThrow()
  })

  it('memoryRegistry counters add exact decimals and expire', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const r = memoryRegistry()
    expect(await r.incr!('k', '0.1', 1000)).toBe('0.1')
    expect(await r.incr!('k', '0.2', 1000)).toBe('0.3')
    expect(await r.incr!('k', '-0.3', 1000)).toBe('0')
    vi.advanceTimersByTime(1001)
    expect(await r.incr!('k', '5', 1000)).toBe('5')
  })
})

describe('approve hook', () => {
  it('runs before each payout session, and fails closed', async () => {
    const seen: PayoutApproval[] = []
    let answer: unknown = false
    const { ramp, config } = setup({
      limits: { maxSessionsPerHour: 1 },
      approve: async (req) => {
        seen.push(req)
        if (answer === 'throw') throw new Error('approval service is down')
        return answer as boolean
      },
    })
    const client = await connect(config)
    const tool = (await client.listTools()).tools.find((t) => t.name === 'create_withdraw_session')!
    expect(tool.description).toContain('The operator must approve each payout')

    const denied = await call(client, 'create_withdraw_session', { country: 'PH', amount: '20', reference: 'invoice-7' })
    expect(denied.data.error.code).toBe('NOT_APPROVED')
    expect(seen[0]).toMatchObject({ direction: 'withdraw', country: 'PH', amount: { min: '20', max: '20', currency: 'USDC' }, reference: 'invoice-7', source: { custody: 'app' } })
    expect(seen[0]!.target).toBeUndefined()

    answer = 'throw'
    expect((await call(client, 'create_withdraw_session', { country: 'PH', amount: '20' })).data.error.code).toBe('NOT_APPROVED')
    answer = 'yes' // only `true` approves
    expect((await call(client, 'create_withdraw_session', { country: 'PH', amount: '20' })).data.error.code).toBe('NOT_APPROVED')

    // Refusals did not use the one session of this hour.
    answer = true
    const ok = await call(client, 'create_withdraw_session', { country: 'PH', amount: '20' })
    expect(ok.isError).toBe(false)
    expect((await ramp.sessions.retrieve(ok.data.session_id))!.direction).toBe('withdraw')
    // Deposits do not ask.
    const n = seen.length
    await call(client, 'create_deposit_session', { country: 'VN' })
    expect(seen.length).toBe(n)
  })
})

describe('bound payout targets', () => {
  it('pays out to the bound target with no pay link; the funds cannot go elsewhere', async () => {
    const approvals: PayoutApproval[] = []
    const { ramp, config, sent } = setup({
      withdraw: { source: { chain: 'eip155:8453', token: BASE_USDC, symbol: 'USDC', decimals: 6, custody: 'app' }, targets: [opsTarget] },
      approve: (req) => (approvals.push(req), true),
    })
    // Record the routes the MCP server calls.
    const paths: string[] = []
    const client = await connect({ ...config, connection: { openramp: { handle: (req) => (paths.push(new URL(req.url).pathname), ramp.handle(req)), sessions: ramp.sessions } } })
    const tool = (await client.listTools()).tools.find((t) => t.name === 'create_withdraw_session')!
    expect(Object.keys(tool.inputSchema.properties!)).toContain('target')
    expect(tool.annotations?.destructiveHint).toBe(true)

    const r = await call(client, 'create_withdraw_session', { country: 'SG', target: 'ops', amount: '20' })
    expect(r.isError).toBe(false)
    expect(r.data.pay_url).toBeUndefined()
    expect(r.data.target).toEqual({ name: 'ops', chain: 'eip155:42161', token: 'USDC', address: OPS_WALLET })
    expect(approvals[0]!.target).toMatchObject({ name: 'ops', address: OPS_WALLET })

    const s = (await ramp.sessions.retrieve(r.data.session_id))!
    expect(s.destination).toMatchObject({ type: 'crypto', chain: 'eip155:42161', address: OPS_WALLET })
    expect(s.allowedTargets).toEqual({ crypto: { chains: ['eip155:42161'] } })
    // The target is set and locked at creation: no /target call, and nobody can change it later.
    expect(s.targetLocked).toBe(true)
    expect(paths.some((p) => p.endsWith('/target'))).toBe(false)
    expect(paths.filter((p) => p.startsWith(`/sessions/${s.id}/`)).map((p) => p.split('/').pop())).toEqual(['plan', 'quotes', 'select'])
    const cred = (await ramp.sessions.payLink(s.id))!.url.split('/pay/')[1]!
    const change = await ramp.handle(
      new Request(`${BASE}/sessions/${s.id}/target`, {
        method: 'POST',
        headers: { authorization: `Bearer ${cred}`, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'crypto', chain: 'eip155:42161', token: ARB_USDC, address: '0x3333333333333333333333333333333333333333' }),
      }),
    )
    expect(change.status).toBe(409)
    expect(((await change.json()) as { error: { code: string } }).error.code).toBe('TARGET_LOCKED')
    expect(s.amountBounds).toEqual({ min: '20', max: '20', currency: 'USDC' })
    expect(sent).toHaveLength(1)
    expect(JSON.stringify(sent[0]!.txs).toLowerCase()).toContain(OPS_WALLET)

    const done = await call(client, 'wait_for_completion', { session_id: r.data.session_id, timeout_seconds: 20 })
    expect(done.data.status).toBe('completed')

    // Unknown names fail the schema; a target needs an exact amount.
    expect((await call(client, 'create_withdraw_session', { country: 'SG', target: 'attacker', amount: '5' })).isError).toBe(true)
    expect((await call(client, 'create_withdraw_session', { country: 'SG', target: 'ops' })).data.error.code).toBe('BAD_REQUEST')
    // Without requireBoundTarget, a pay link payout is still possible.
    expect((await call(client, 'create_withdraw_session', { country: 'PH', amount: '5' })).data.pay_url).toMatch(/\/pay\//)
  })

  it('requireBoundTarget: no pay link payouts at all', async () => {
    const { config } = setup({
      withdraw: { source: { chain: 'eip155:8453', token: BASE_USDC, symbol: 'USDC', decimals: 6, custody: 'app' }, targets: [opsTarget], requireBoundTarget: true },
    })
    const client = await connect(config)
    const tool = (await client.listTools()).tools.find((t) => t.name === 'create_withdraw_session')!
    expect(tool.inputSchema.required).toContain('target')
    expect(Object.keys(tool.inputSchema.properties!)).not.toContain('max_amount')
    expect((await call(client, 'create_withdraw_session', { country: 'PH', amount: '5' })).isError).toBe(true)
    await expect(createRampOps(config).createWithdrawSession({ country: 'PH', amount: '5' })).rejects.toMatchObject({ code: 'TARGET_REQUIRED' })
    expect((await call(client, 'create_withdraw_session', { country: 'SG', target: 'ops', amount: '5' })).isError).toBe(false)
  })

  it('checks the targets config at startup', () => {
    const { config } = setup()
    const src = config.withdraw!.source
    expect(() => createRampOps({ ...config, withdraw: { source: src, requireBoundTarget: true } })).toThrow(/requireBoundTarget/)
    expect(() => createRampOps({ ...config, withdraw: { source: { ...src, custody: 'user_wallet' }, targets: [opsTarget] } })).toThrow(/custody/)
    expect(() => createRampOps({ ...config, withdraw: { source: src, targets: [{ ...opsTarget, address: '0x12' }] } })).toThrow(/not valid/)
    expect(() => createRampOps({ ...config, withdraw: { source: src, targets: [opsTarget, opsTarget] } })).toThrow(/unique/)
  })
})

describe('pay link revocation', () => {
  it('revokePayLink makes the pay_url stop working; a bound payout has no pay link', async () => {
    const { ramp, config } = setup({
      withdraw: { source: { chain: 'eip155:8453', token: BASE_USDC, symbol: 'USDC', decimals: 6, custody: 'app' }, targets: [opsTarget] },
    })
    const ops = createRampOps(config)
    const w = await ops.createWithdrawSession({ country: 'PH', amount: '5' })
    const url = w.pay_url as string
    expect((await ramp.handle(new Request(url))).status).toBe(200)
    expect(await ops.revokePayLink(w.session_id)).toEqual({ session_id: w.session_id, revoked: true })
    expect((await ramp.handle(new Request(url))).status).toBe(410)
    // The MCP server still reads the session with its client secret.
    expect((await ops.getSessionStatus(w.session_id)).status).toBe('open')

    const bound = await ops.createWithdrawSession({ country: 'SG', target: 'ops', amount: '5' })
    await expect(ops.revokePayLink(bound.session_id)).rejects.toMatchObject({ code: 'NO_PAY_LINK' })
    await expect(ops.revokePayLink('ors_unknown')).rejects.toMatchObject({ code: 'UNKNOWN_SESSION' })
  })
})

describe('transport', () => {
  it('HTTP: refuses a body over the size limit', async () => {
    const handler = createMcpHttpHandler(setup().config, { bearerToken: 'mcp-token-0123456789', maxBodyBytes: 1000 })
    const auth = { authorization: 'Bearer mcp-token-0123456789', 'content-type': 'application/json' }
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(2000) } })
    expect((await handler(new Request('http://mcp.test/mcp', { method: 'POST', headers: auth, body: big }))).status).toBe(413)
    // A stream with no length header is also checked.
    const stream = new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode(big)), c.close()) })
    expect((await handler(new Request('http://mcp.test/mcp', { method: 'POST', headers: auth, body: stream, duplex: 'half' } as RequestInit))).status).toBe(413)
  })

  it('reports the package version in the MCP handshake', async () => {
    const client = await connect(setup().config)
    expect(client.getServerVersion()).toEqual({ name: 'openrampkit', version: pkg.version })
  })
})
