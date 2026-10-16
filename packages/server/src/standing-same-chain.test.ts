// Standing addresses for the same token on the same chain, with no bridge provider: the chain-watch
// adapter gives the destination address itself, and each confirmed Transfer log becomes one session.
import { describe, expect, it } from 'vitest'
import { ERC20_TRANSFER_TOPIC, createAdapter, topicAddress } from '@openrampkit/adapter'
import { chainWatch } from '@openrampkit/adapter-chain-watch'
import { USDC } from '@openrampkit/core'
import type { LegSpec } from '@openrampkit/core'
import { createOpenRamp, memoryStore } from './index.js'

const BASE_URL = 'https://app.test/api/openramp'
const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const CHAIN = 'eip155:8453'
const TOKEN = USDC[CHAIN]!
const DEST = { type: 'crypto' as const, chain: CHAIN, token: TOKEN, address: '0x000000000000000000000000000000000000beef' }
const SAME = { chain: CHAIN, token: TOKEN }
const OTHER = { chain: 'eip155:42161', token: USDC['eip155:42161']! }
const HOOKS = { url: 'https://app.test/hooks', secret: 'w'.repeat(32) }
const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`

const transferSpec: LegSpec = {
  id: 'transfer',
  kind: 'bridge_swap',
  methods: ['transfer'],
  from: { asset: { kind: 'crypto', chains: '*' }, location: ['user_wallet'] },
  to: { asset: { kind: 'crypto', chains: '*' }, location: ['address'] },
  regions: { allow: ['*'], deny: [] },
  eta: { min: 10, max: 60 },
  surfaces: ['DEPOSIT_ADDRESS'],
}

/** A provider that converts (the default kind of route), like Relay */
function converter(extra: { address?: string; routes?: Array<'convert' | 'same'> } = {}) {
  return createAdapter({
    id: 'conv',
    name: 'Converter',
    legs: [transferSpec],
    ...(extra.routes ? { standingRoutes: extra.routes } : {}),
    async quote() {
      throw new Error('no quotes')
    },
    async start() {
      throw new Error('no starts')
    },
    async standingAddress() {
      return { address: extra.address ?? '0x00000000000000000000000000000000000000c1', ref: 'c1' }
    },
    async standingDeposits() {
      return []
    },
    async status({ ref }) {
      return { status: 'processing', ref }
    },
  })
}

type Log = { address: string; topics: string[]; data: string; transactionHash: string; blockNumber: string; logIndex: string }

/** A fake Base node behind the server's fetch, and the webhooks the server sends */
function world() {
  const chain = { head: 500n, logs: [] as Log[], receipts: new Map<string, unknown>() }
  const sent: Array<{ type: string; sessionId: string; object: Record<string, unknown> }> = []
  const fetchFn: typeof fetch = async (u, init) => {
    const url = String(u)
    const body = JSON.parse(String(init?.body))
    if (url.includes('rpc.base.test')) {
      const p = body.params as Array<Record<string, string>>
      let result: unknown = null
      if (body.method === 'eth_blockNumber') result = hex(chain.head)
      if (body.method === 'eth_getLogs') result = chain.logs.filter((l) => BigInt(l.blockNumber) >= BigInt(p[0]!.fromBlock!) && BigInt(l.blockNumber) <= BigInt(p[0]!.toBlock!))
      if (body.method === 'eth_getTransactionReceipt') result = chain.receipts.get(String(body.params[0])) ?? null
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { headers: { 'content-type': 'application/json' } })
    }
    sent.push({ type: body.type, sessionId: body.sessionId, object: body.data.object })
    return new Response('ok')
  }
  let n = 0
  const send = (amount: bigint) => {
    chain.head += 1n
    const log: Log = { address: TOKEN, topics: [ERC20_TRANSFER_TOPIC, topicAddress('0x2222222222222222222222222222222222222222'), topicAddress(DEST.address)], data: hex(amount), transactionHash: `0x${(++n).toString(16).padStart(64, 'f')}`, blockNumber: hex(chain.head), logIndex: '0x0' }
    chain.logs.push(log)
    chain.receipts.set(log.transactionHash, { status: '0x1', blockNumber: log.blockNumber, logs: [log] })
    return log
  }
  return { chain, sent, fetchFn, send }
}

function make(adapters = [converter(), chainWatch({ rpcUrls: { [CHAIN]: 'https://rpc.base.test' }, confirmations: 2 })]) {
  const w = world()
  const store = memoryStore()
  const ramp = createOpenRamp({ secret: 's'.repeat(40), baseUrl: BASE_URL, adapters, logger: quiet, webhooks: HOOKS, fetch: w.fetchFn, store })
  const get = (origin = SAME, adapterId?: string) => ramp.depositAddresses.get({ userId: 'u1', origin, destination: DEST, ...(adapterId ? { adapterId } : {}) })
  const depositSessions = () => w.sent.filter((s) => s.type === 'deposit_address.deposit').map((s) => s.sessionId)
  return { ramp, w, store, get, depositSessions }
}

describe('standing addresses: same chain and same token, with no bridge provider', () => {
  it('the route picks the adapter: chain-watch for the same token, the converter for another', async () => {
    const t = make()
    const same = await t.get()
    expect(same).toMatchObject({ adapterId: 'chain-watch', address: DEST.address, origin: SAME, destination: DEST })
    const other = await t.get(OTHER)
    expect(other).toMatchObject({ adapterId: 'conv', address: '0x00000000000000000000000000000000000000c1' })
    // An explicit adapter that does not serve the route is refused.
    await expect(t.get(SAME, 'conv')).rejects.toMatchObject({ status: 400, error: { message: expect.stringMatching(/does not watch the same token/) } })
    await expect(t.get(OTHER, 'chain-watch')).rejects.toMatchObject({ status: 400, error: { message: expect.stringMatching(/only for the same token on the same chain/) } })
  })

  it('without chain-watch, a same-chain route names the adapter to add', async () => {
    const t = make([converter()])
    await expect(t.get()).rejects.toMatchObject({ status: 400, error: { message: expect.stringMatching(/chainWatch\(\)/) } })
  })

  it('a same-chain adapter must give the destination itself', async () => {
    const t = make([converter({ routes: ['same'], address: '0x00000000000000000000000000000000000000c1' })])
    await expect(t.get()).rejects.toMatchObject({ status: 502, error: { code: 'PROVIDER_UNAVAILABLE' } })
  })

  it('widget: the same token gives the destination address; the chain-watch leg is never a plan method', async () => {
    const w = world()
    const ramp = createOpenRamp({
      secret: 's'.repeat(40),
      baseUrl: BASE_URL,
      adapters: [converter(), chainWatch({ rpcUrls: { [CHAIN]: 'https://rpc.base.test' } })],
      logger: quiet,
      fetch: w.fetchFn,
      store: memoryStore(),
      depositAddresses: { widget: true },
    })
    const s = await ramp.sessions.create({ userId: 'u1', country: 'SG', destination: DEST })
    const call = (path: string, body: unknown = {}) =>
      ramp.handle(new Request(`${BASE_URL}/sessions/${s.id}${path}`, { method: 'POST', headers: { authorization: `Bearer ${s.clientSecret}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    const plan = await (await call('/plan')).json()
    // The converter's own `transfer` method stays; chain-watch adds no method and no pathway.
    expect(plan.methods.map((m: { method: string }) => m.method)).toEqual(['transfer', 'deposit_address'])
    expect(plan.methods.find((m: { method: string }) => m.method === 'transfer').providers).toEqual(['Converter'])
    expect(plan.pathways.length).toBeGreaterThan(0)
    expect(plan.pathways.every((p: { legs: Array<{ adapterId: string }> }) => p.legs.every((l) => l.adapterId !== 'chain-watch'))).toBe(true)
    expect(await (await call('/deposit-address', SAME)).json()).toMatchObject({ address: DEST.address, origin: SAME })
    expect(await (await call('/deposit-address', OTHER)).json()).toMatchObject({ address: '0x00000000000000000000000000000000000000c1', origin: OTHER })
  })

  it('each confirmed transfer makes one session, never two, and the session completes on chain', async () => {
    const t = make()
    const addr = await t.get()
    expect((await t.ramp.sweep()).standing).toEqual({ checked: 1, deposits: 0 })
    const log = t.w.send(25_000_000n)
    // One block: not confirmed yet (2 needed).
    await t.get()
    expect((await t.ramp.sweep()).standing).toEqual({ checked: 1, deposits: 0 })
    t.w.chain.head += 2n
    await t.get()
    expect((await t.ramp.sweep()).standing).toEqual({ checked: 1, deposits: 1 })
    const [sid] = t.depositSessions()
    const depositId = `${CHAIN}:${log.transactionHash}:0`
    const s = await t.ramp.sessions.retrieve(sid!)
    expect(s).toMatchObject({
      userId: 'u1',
      standingAddressId: addr.id,
      metadata: { depositAddressId: addr.id, depositId },
      payment: { method: 'transfer', provider: 'On-chain transfer', legs: [{ adapterId: 'chain-watch', legId: 'transfer', input: { value: '25' } }] },
    })
    expect(t.w.sent.find((e) => e.type === 'deposit_address.deposit')!.object).toMatchObject({ depositAddressId: addr.id, sessionId: sid, depositId, input: { value: '25' } })

    // Polls again, also after the server forgot what it saw: no second session.
    await t.get()
    await t.ramp.sweep()
    await t.store.kv.put(`sda:${addr.id}:poll`, null)
    await t.get()
    expect((await t.ramp.sweep()).standing.deposits).toBe(0)
    expect(t.depositSessions()).toEqual([sid])

    // The open-session poll reads the receipt: the session succeeds with the amount on chain.
    await t.ramp.sweep()
    const done = await t.ramp.sessions.retrieve(sid!)
    expect(done).toMatchObject({ status: 'succeeded', result: { output: { value: '25' } } })
    expect(t.w.sent.filter((e) => e.sessionId === sid).map((e) => e.type)).toContain('session.succeeded')

    // A second transfer: a second session.
    t.w.send(1_000_000n)
    t.w.chain.head += 2n
    await t.get()
    expect((await t.ramp.sweep()).standing.deposits).toBe(1)
    expect(new Set(t.depositSessions()).size).toBe(2)
  })
})
