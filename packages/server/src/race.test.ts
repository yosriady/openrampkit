// Races: two parties that act on the same transfer, destination or leg at the same time. Each test runs
// the two operations with Promise.all, on the built-in stores with an atomic `putIfAbsent` (memory,
// Redis and Durable Object fakes), with a small random delay before each store call so that the
// operations interleave in many orders. Exactly one party may win.
import { describe, expect, it } from 'vitest'
import { ERC20_TRANSFER_TOPIC, TX_LOGS_OWNER, claimOnce, createAdapter, claimTransferLog, topicAddress, txUsedKey } from '@openrampkit/adapter'
import type { ScopedKV } from '@openrampkit/adapter'
import { fakeFetch, makeCtx, silentLog } from '@openrampkit/adapter/testing'
import type { FakeCall } from '@openrampkit/adapter/testing'
import { chainWatch } from '@openrampkit/adapter-chain-watch'
import { STRIPE_LINK_TRANSITIONS as T, stripeLink } from '@openrampkit/adapter-stripe-link'
import { USDC } from '@openrampkit/core'
import type { LegStep, PathwayLeg } from '@openrampkit/core'
import { OpenRampStore, durableObjectStore } from './durable-object-store.js'
import type { DurableObjectNamespaceLike } from './durable-object-store.js'
import { createOpenRamp } from './index.js'
import { KV_PUT_IF_ABSENT_SCRIPT, redisStore } from './redis-store.js'
import type { RedisLike } from './redis-store.js'
import { memoryStore, scopedKV } from './store.js'
import type { SessionStore } from './store.js'

const CHAIN = 'eip155:8453'
const TOKEN = USDC[CHAIN]!
const DEST = '0x000000000000000000000000000000000000beef'
const ROUNDS = 25
const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`
const pause = () => new Promise<void>((r) => setTimeout(r, Math.floor(Math.random() * 3)))

/** The store with a random delay before each kv call. The call itself stays as it is (atomic or not). */
function jitter(store: SessionStore): SessionStore {
  const kv = store.kv
  return {
    ...store,
    kv: {
      get: async (k) => (await pause(), kv.get(k)),
      put: async (k, v, ttl) => (await pause(), kv.put(k, v, ttl)),
      ...(kv.putIfAbsent ? { putIfAbsent: async (k: string, v: unknown, ttl: number) => (await pause(), kv.putIfAbsent!(k, v, ttl)) } : {}),
    },
  }
}

/** Redis fake: GET, SET and the SET NX script (enough for the kv calls). `eval` is Redis EVAL by script text, not JavaScript eval. */
function fakeRedis(): RedisLike {
  const data = new Map<string, string>()
  return {
    async get(k) {
      return data.get(k) ?? null
    },
    async set(k, v) {
      data.set(k, v)
      return 'OK'
    },
    async eval(script, keys, args) {
      if (script !== KV_PUT_IF_ABSENT_SCRIPT) throw new Error('script not in the fake')
      if (data.has(keys[0]!)) return 0
      data.set(keys[0]!, args[0]!)
      return 1
    },
  }
}

/** Durable Object namespace fake: one OpenRampStore per name, one request at a time per object */
function fakeNamespace(): DurableObjectNamespaceLike {
  const objects = new Map<string, { obj: OpenRampStore; queue: Promise<unknown> }>()
  return {
    idFromName: (name) => name,
    get: (id) => {
      const name = id as unknown as string
      let o = objects.get(name)
      if (!o) {
        const data = new Map<string, unknown>()
        const obj = new OpenRampStore({
          storage: {
            get: async <T,>(k: string) => data.get(k) as T | undefined,
            put: async (k, v) => void data.set(k, v),
            deleteAll: async () => data.clear(),
            setAlarm: async () => {},
            list: async <T,>({ prefix }: { prefix: string }) => new Map([...data].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1))) as Map<string, T>,
            delete: async (k: string) => data.delete(k),
          },
        })
        objects.set(name, (o = { obj, queue: Promise.resolve() }))
      }
      const target = o
      return { fetch: (url, init) => (target.queue = target.queue.then(() => target.obj.fetch(new Request(url, init)))) as Promise<Response> }
    },
  }
}

/** The stores with an atomic putIfAbsent. Workers KV has none (see the docs): it is not in this list. */
const STORES: Array<[string, () => SessionStore]> = [
  ['memory', () => memoryStore()],
  ['redis', () => redisStore(fakeRedis())],
  ['durable object', () => durableObjectStore(fakeNamespace())],
]
/** The stores that also run a full server here (the Redis fake has no queue scripts) */
const SERVER_STORES = STORES.filter(([name]) => name !== 'redis')

/**
 * A same-chain wallet payment, as the Relay wallet leg decides it (packages/adapters/relay/src/wallet.ts,
 * `settleDirect`): the `:log` marker, then one claim of the whole transaction with its own ref.
 */
async function walletPayment(shared: ScopedKV, hash: string, ref: string): Promise<boolean> {
  const key = txUsedKey(CHAIN, hash)
  if (await shared.get<string>(`${key}:log`)) return false
  return claimOnce(shared, key, ref, 60)
}

describe('race: a Transfer log and a wallet payment of the same transaction', () => {
  for (const [name, make] of STORES) {
    it(`${name}: claimTransferLog and a wallet claim at the same time, exactly one wins`, async () => {
      for (let i = 0; i < ROUNDS; i++) {
        const store = jitter(make())
        const hash = hex(0x1000 + i).padEnd(66, '0')
        const [log, wallet] = await Promise.all([
          claimTransferLog(scopedKV(store, 'a:chain-watch'), CHAIN, hash, 0n, 'standing:x', 60),
          walletPayment(scopedKV(store, 'a:relay'), hash, 'relay-ref'),
        ])
        expect(Number(log) + Number(wallet)).toBe(1)
        // The transaction key says who won, for every adapter.
        expect(await scopedKV(store, 'a:mock').get(txUsedKey(CHAIN, hash))).toBe(log ? TX_LOGS_OWNER : 'relay-ref')
      }
    })

    it(`${name}: two logs of one transaction for two owners both count; one log for two owners, only one`, async () => {
      const store = jitter(make())
      const hash = `0x${'ab'.repeat(32)}`
      const a = scopedKV(store, 'a:chain-watch')
      const b = scopedKV(store, 'a:relay')
      // Two logs of one transaction (a batch that pays two addresses): both owners keep their log.
      expect(await Promise.all([claimTransferLog(a, CHAIN, hash, 0n, 'standing:a', 60), claimTransferLog(b, CHAIN, hash, 1n, 'relay:b', 60)])).toEqual([true, true])
      // One log for two owners: exactly one.
      const hash2 = `0x${'cd'.repeat(32)}`
      const two = await Promise.all([claimTransferLog(a, CHAIN, hash2, 0n, 'standing:a', 60), claimTransferLog(b, CHAIN, hash2, 0n, 'relay:b', 60)])
      expect(two.filter(Boolean)).toHaveLength(1)
      // A wallet payment of either transaction now fails.
      expect(await walletPayment(b, hash, 'relay-ref')).toBe(false)
      expect(await walletPayment(b, hash2, 'relay-ref')).toBe(false)
    })

    it(`${name}: a chain-watch poll and a wallet payment of the same transfer, never both`, async () => {
      for (let i = 0; i < ROUNDS; i++) {
        const store = jitter(make())
        const head = { n: 100n }
        const hash = `0x${(0x2000 + i).toString(16).padStart(64, '0')}`
        const log = { address: TOKEN, topics: [ERC20_TRANSFER_TOPIC, topicAddress('0x1111111111111111111111111111111111111111'), topicAddress(DEST)], data: hex(5_000_000n), transactionHash: hash, blockNumber: hex(101n), logIndex: '0x0' }
        const { fetch } = fakeFetch([
          {
            method: 'POST',
            match: 'rpc.base.test',
            reply: (c: FakeCall) => {
              const body = c.body as { method: string; params: Array<Record<string, string>> }
              if (body.method === 'eth_blockNumber') return { result: hex(head.n) }
              if (body.method === 'eth_getLogs') return { result: BigInt(body.params[0]!.fromBlock!) <= 101n && BigInt(body.params[0]!.toBlock!) >= 101n ? [log] : [] }
              return { result: null }
            },
          },
        ])
        const a = chainWatch({ rpcUrls: { [CHAIN]: 'https://rpc.base.test' }, confirmations: 2 })
        const ctx = { fetch, log: silentLog, shared: scopedKV(store, 'a:chain-watch') }
        const destination = { type: 'crypto' as const, chain: CHAIN, token: TOKEN, address: DEST }
        const { ref } = await a.standingAddress!({ userId: 'u1', origin: { chain: CHAIN, token: TOKEN }, destination }, ctx)
        head.n = 110n
        // The wallet starts a little later at random, so its claim lands before, inside or after the poll.
        const [deposits, wallet] = await Promise.all([
          a.standingDeposits!({ ref, address: DEST, origin: { chain: CHAIN, token: TOKEN }, since: 0 }, ctx),
          (async () => {
            await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 12)))
            return walletPayment(scopedKV(store, 'a:relay'), hash, 'relay-ref')
          })(),
        ])
        expect(deposits.length + Number(wallet)).toBe(1)
      }
    })
  }
})

const HOOKS = { url: 'https://app.test/hooks', secret: 'w'.repeat(32) }
const quiet = { debug() {}, info() {}, warn() {}, error() {} }

/** A server with chain-watch and a converting adapter, on `store`, with a fake Base node */
function server(store: SessionStore) {
  const chain = { head: 500n, logs: [] as unknown[] }
  const fetchFn: typeof fetch = async (u, init) => {
    const url = String(u)
    if (url.includes('rpc.base.test')) {
      const body = JSON.parse(String(init?.body))
      const p = body.params as Array<Record<string, string>>
      let result: unknown = null
      if (body.method === 'eth_blockNumber') result = hex(chain.head)
      if (body.method === 'eth_getLogs') result = (chain.logs as Array<{ blockNumber: string }>).filter((l) => BigInt(l.blockNumber) >= BigInt(p[0]!.fromBlock!) && BigInt(l.blockNumber) <= BigInt(p[0]!.toBlock!))
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { headers: { 'content-type': 'application/json' } })
    }
    return new Response('ok')
  }
  const converter = createAdapter({
    id: 'conv',
    name: 'Converter',
    legs: [
      {
        id: 'transfer',
        kind: 'bridge_swap' as const,
        methods: ['transfer'],
        from: { asset: { kind: 'crypto' as const, chains: '*' as const }, location: ['user_wallet' as const] },
        to: { asset: { kind: 'crypto' as const, chains: '*' as const }, location: ['address' as const] },
        regions: { allow: ['*'], deny: [] },
        eta: { min: 10, max: 60 },
        surfaces: ['DEPOSIT_ADDRESS' as const],
      },
    ],
    async quote() {
      throw new Error('no quotes')
    },
    async start() {
      throw new Error('no starts')
    },
    async standingAddress() {
      return { address: '0x00000000000000000000000000000000000000c1', ref: 'c1' }
    },
    async standingDeposits() {
      return []
    },
    async status({ ref }) {
      return { status: 'processing', ref }
    },
  })
  const ramp = createOpenRamp({
    secret: 's'.repeat(40),
    baseUrl: 'https://app.test/api/openramp',
    adapters: [converter, chainWatch({ rpcUrls: { [CHAIN]: 'https://rpc.base.test' }, confirmations: 2 })],
    logger: quiet,
    webhooks: HOOKS,
    fetch: fetchFn,
    store,
  })
  return { ramp, chain }
}

describe('race: a watched destination and a converting address to it, made at the same time', () => {
  const dest = { type: 'crypto' as const, chain: CHAIN, token: TOKEN, address: DEST }
  const same = { chain: CHAIN, token: TOKEN }
  const other = { chain: 'eip155:42161', token: USDC['eip155:42161']! }
  for (const [name, make] of SERVER_STORES) {
    it(`${name}: exactly one kind holds the destination, and the winner can get its address again`, async () => {
      for (let i = 0; i < ROUNDS; i++) {
        const { ramp } = server(jitter(make()))
        const watch = () => ramp.depositAddresses.get({ userId: 'u1', origin: same, destination: dest, dedicatedDestination: true })
        const convert = () => ramp.depositAddresses.get({ userId: 'u1', origin: other, destination: dest })
        const [w, c] = await Promise.allSettled([watch(), convert()])
        expect([w.status, c.status].filter((s) => s === 'fulfilled')).toHaveLength(1)
        const loser = (w.status === 'rejected' ? w : c) as PromiseRejectedResult
        expect(loser.reason).toMatchObject({ status: 409 })
        // No mark of the loser: the winner still works, the loser stays refused.
        if (w.status === 'fulfilled') {
          await expect(watch()).resolves.toMatchObject({ address: DEST })
          await expect(convert()).rejects.toMatchObject({ status: 409 })
        } else {
          await expect(convert()).resolves.toMatchObject({ origin: other })
          await expect(watch()).rejects.toMatchObject({ status: 409 })
        }
      }
    })

    it(`${name}: two users claim one watched destination at the same time, exactly one wins`, async () => {
      for (let i = 0; i < 10; i++) {
        const { ramp } = server(jitter(make()))
        const get = (userId: string) => ramp.depositAddresses.get({ userId, origin: same, destination: dest, dedicatedDestination: true })
        const r = await Promise.allSettled([get('u1'), get('u2')])
        expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
      }
    })

    it(`${name}: two sweeps at the same time make one session per deposit`, async () => {
      const { ramp, chain } = server(jitter(make()))
      await ramp.depositAddresses.get({ userId: 'u1', origin: same, destination: dest, dedicatedDestination: true })
      chain.head += 1n
      chain.logs.push({ address: TOKEN, topics: [ERC20_TRANSFER_TOPIC, topicAddress('0x2222222222222222222222222222222222222222'), topicAddress(DEST)], data: hex(7_000_000n), transactionHash: `0x${'ef'.repeat(32)}`, blockNumber: hex(chain.head), logIndex: '0x0' })
      chain.head += 3n
      await ramp.depositAddresses.get({ userId: 'u1', origin: same, destination: dest, dedicatedDestination: true })
      const [a, b] = await Promise.all([ramp.sweep(), ramp.sweep()])
      expect(a.standing.deposits + b.standing.deposits).toBe(1)
      await ramp.depositAddresses.get({ userId: 'u1', origin: same, destination: dest, dedicatedDestination: true })
      expect((await ramp.sweep()).standing.deposits).toBe(0)
    })
  }
})

// ---------- Stripe Link: stage changes and the client key ----------

const SK = 'sk_test_51abc'
const VERIFIED = { id: 'crc_1', object: 'crypto.customer', kyc_tiers: [{ tier: 'l1', verification_status: 'verified' }] }
const SESSION = (status: string) => ({ id: 'cos_123', client_secret: 'cos_123_secret', status, transaction_details: { destination_amount: '100.00', destination_currency: 'usdc', destination_network: 'base' } })
const KEY_A = 'a'.repeat(43)
const KEY_B = 'b'.repeat(43)
const stripeLeg: PathwayLeg = {
  adapterId: 'stripe-link',
  legId: 'card',
  from: { asset: { kind: 'fiat', currency: 'USD' }, location: { kind: 'user_account' } },
  to: { asset: { kind: 'crypto', chain: CHAIN, token: TOKEN }, location: { kind: 'address', address: 'deposit' } },
}

async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** A Stripe Link leg on `store`, started for a session with an email (stage `authenticate`) */
async function linkLeg(store: SessionStore, wallets: unknown[] = [{ wallet_address: DEST, network: 'base' }]) {
  const { fetch, calls } = fakeFetch([
    { method: 'GET', match: '/v1/crypto/onramp_quotes', reply: () => ({ destination_network_quotes: { base: [{ destination_currency: 'usdc', destination_amount: '100.00', source_total_amount: '103.01' }] } }) },
    { method: 'POST', match: /login\.link\.com\/v1\/link_auth_intent$/, reply: () => ({ id: 'lai_1' }) },
    { method: 'POST', match: '/v1/link_auth_intent/lai_1/tokens', reply: () => ({ access_token: 'liwl_token', expires_in: 3600 }) },
    { method: 'GET', match: '/crypto_consumer_wallets', reply: () => ({ data: wallets }) },
    { method: 'GET', match: '/v1/crypto/customers/crc_1', reply: () => VERIFIED },
    { method: 'POST', match: '/v1/crypto/onramp_sessions/cos_123/checkout', reply: () => SESSION('requires_payment') },
    { method: 'POST', match: /\/v1\/crypto\/onramp_sessions$/, reply: () => SESSION('initialized') },
  ])
  const a = stripeLink({ secretKey: SK, publishableKey: 'pk_test_1', webhookSecret: 'whsec_1', oauthClientId: 'lcid_1' })
  const kv = scopedKV(store, 'a:stripe-link')
  const ctx = makeCtx({ fetch, store: kv, shared: scopedKV(store, 'a:stripe-link:shared'), session: { email: 'user@example.com', ip: '203.0.113.9' } })
  const quote = await a.quote({ leg: stripeLeg, amountIn: { value: '100', asset: { kind: 'fiat', currency: 'USD' } } }, ctx)
  const step = await a.start({ leg: stripeLeg, quote, deliverTo: { address: DEST } }, ctx)
  const ref = step.ref!
  const go = (name: string, inputs: Record<string, unknown>): Promise<LegStep> => a.transition!({ leg: stripeLeg, ref, name, inputs }, ctx)
  const record = () => kv.get<{ stage: string; keyHash?: string; onrampSessionId?: string; authIntentId?: string }>(`r:${ref}`)
  return { a, ctx, calls, ref, go, record }
}

describe('race: Stripe Link stage changes', () => {
  for (const [name, make] of STORES) {
    it(`${name}: two link_authenticated calls with their own keys, exactly one binds its key`, async () => {
      for (let i = 0; i < 10; i++) {
        const t = await linkLeg(jitter(make()))
        const r = await Promise.allSettled([
          t.go(T.authenticated, { cryptoCustomerId: 'crc_1', clientKey: KEY_A }),
          t.go(T.authenticated, { cryptoCustomerId: 'crc_1', clientKey: KEY_B }),
        ])
        const won = r.findIndex((x) => x.status === 'fulfilled')
        expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
        expect((r[1 - won] as PromiseRejectedResult).reason).toMatchObject({ status: 409 })
        // The bound key is the winner's, and only one token exchange ran.
        expect((await t.record())?.keyHash).toBe(await sha256Hex(won === 0 ? KEY_A : KEY_B))
        expect(t.calls.filter((c) => c.url.includes('/tokens'))).toHaveLength(1)
      }
    })

    it(`${name}: two checkouts at the same time, Stripe gets one checkout call`, async () => {
      for (let i = 0; i < 10; i++) {
        const t = await linkLeg(jitter(make()))
        await t.go(T.authenticated, { cryptoCustomerId: 'crc_1', clientKey: KEY_A })
        await t.go(T.paymentMethod, { paymentToken: 'cpt_1', clientKey: KEY_A })
        expect((await t.record())?.stage).toBe('checkout')
        const r = await Promise.allSettled([t.go(T.checkout, { clientKey: KEY_A }), t.go(T.checkout, { clientKey: KEY_A })])
        expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
        expect(t.calls.filter((c) => c.url.endsWith('/checkout'))).toHaveLength(1)
        // A later checkout (the SDK calls again after 3DS) runs, with a new idempotency key.
        await t.go(T.checkout, { clientKey: KEY_A })
        const keys = t.calls.filter((c) => c.url.endsWith('/checkout')).map((c) => c.headers.get('idempotency-key'))
        expect(keys).toHaveLength(2)
        expect(new Set(keys).size).toBe(2)
      }
    })

    it(`${name}: the payment method and a new sign-in from another client at the same time, one runs`, async () => {
      for (let i = 0; i < 10; i++) {
        const t = await linkLeg(jitter(make()))
        await t.go(T.authenticated, { cryptoCustomerId: 'crc_1', clientKey: KEY_A })
        const r = await Promise.allSettled([
          t.go(T.paymentMethod, { paymentToken: 'cpt_1', clientKey: KEY_A }),
          // Another client (wrong key): before the onramp session exists, that starts a new sign-in.
          t.go(T.paymentMethod, { paymentToken: 'cpt_2', clientKey: KEY_B }),
        ])
        expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
        const rec = (await t.record())!
        // Never a mix: the purchase with the owner's key, or a new sign-in with no key and no purchase.
        if (rec.stage === 'checkout') {
          expect(rec.keyHash).toBe(await sha256Hex(KEY_A))
          expect(rec.onrampSessionId).toBe('cos_123')
        } else {
          expect(rec).toMatchObject({ stage: 'authenticate', authIntentId: 'lai_1' })
          expect(rec.keyHash).toBeUndefined()
          expect(rec.onrampSessionId).toBeUndefined()
        }
      }
    })
  }
})
