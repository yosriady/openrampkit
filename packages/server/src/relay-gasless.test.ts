// Gas abstraction end to end: a wallet with USDC and no native gas on Base pays a USDC deposit on
// Arbitrum through the real controller, server and Relay adapter (Relay's API stubbed). The wallet
// signs Relay's permit; the server checks the signature, posts it, and completes on Relay's fill.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { relay } from '@openrampkit/adapter-relay'
import { DepositController, createOpenRampClient } from '@openrampkit/client'
import { USDC } from '@openrampkit/core'
import type { TxRequest, TypedDataRequest, WalletAdapter, WalletBalance } from '@openrampkit/core'
import { createOpenRamp } from './index.js'

const BASE = 'https://app.test/api/openramp'
const quiet = { debug() {}, info() {}, warn() {}, error() {} }
// The public anvil test account #1, and its signature (viem 2) of the permit below.
const SIGNER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'
const SIG =
  '0x6278f304295ac5da322775502c6f9420758aa383c5a1bd480bdd41bb5213f39c4016e568a84c09e4b37dfe9689f6e9f83059dde59375be19ba50bf8525368b3e1c'
const DEST = '0x000000000000000000000000000000000000beef'
const BASE_USDC = USDC['eip155:8453']!
const ARB_USDC = USDC['eip155:42161']!
const REQ = '0x1792147201626033656487ab40e61f2f83813e782034d86e267518be1f5e9eb3'
const SOLVER_TX = `0x${'ab'.repeat(32)}`
const FILL_TX = `0x${'cd'.repeat(32)}`

const usdc = (chainId: number, address: string) => ({ chainId, address, symbol: 'USDC', name: 'USD Coin', decimals: 6 })
const details = {
  currencyIn: { currency: usdc(8453, BASE_USDC), amount: '5000000' },
  currencyOut: { currency: usdc(42161, ARB_USDC), amount: '4974221', minimumAmount: '4874737' },
  timeEstimate: 1,
}
const permitSign = {
  signatureKind: 'eip712',
  types: {
    ReceiveWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  },
  domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: BASE_USDC },
  primaryType: 'ReceiveWithAuthorization',
  value: {
    from: SIGNER,
    to: '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be',
    value: '5000000',
    validAfter: 0,
    validBefore: 1792147801,
    nonce: '0x5455db7556e8e306ce23fa44a6e805a777e573c2ab30c40a2d51ebab2f5fd33d',
  },
}

function relayApi() {
  const posted: Array<{ signature: string | null; body: unknown }> = []
  const quoteBodies: Array<Record<string, unknown>> = []
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/quote/v2') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      quoteBodies.push(body)
      if (!body.usePermit) {
        return Response.json({ requestId: '0xtx', steps: [{ id: 'deposit', kind: 'transaction', items: [{ status: 'incomplete', data: { to: BASE_USDC, data: '0x', chainId: 8453 } }] }], details })
      }
      const post = { endpoint: '/execute/permits', method: 'POST', body: { kind: 'eip3009', requestId: REQ, api: 'swap' } }
      return Response.json({ requestId: REQ, steps: [{ id: 'authorize1', kind: 'signature', requestId: REQ, items: [{ status: 'incomplete', data: { sign: permitSign, post } }] }], details })
    }
    if (url.pathname === '/execute/permits') {
      posted.push({ signature: url.searchParams.get('signature'), body: JSON.parse(String(init?.body)) })
      return Response.json({ message: 'Transaction submitted' })
    }
    if (url.pathname === '/intents/status/v3') {
      return Response.json(posted.length ? { status: 'success', inTxHashes: [SOLVER_TX], txHashes: [FILL_TX] } : { status: 'waiting' })
    }
    if (url.pathname === '/requests/v3') {
      return Response.json({ requests: [{ id: REQ, status: 'success', createdAt: new Date().toISOString(), data: { metadata: { currencyOut: { currency: usdc(42161, ARB_USDC), amount: '4974221' } } } }] })
    }
    return new Response('{}', { status: 404 })
  }
  return { fetchFn, posted, quoteBodies }
}

/** A wallet with 5 USDC and no ETH on Base. It signs with the test account (the known signature). */
function usdcOnlyWallet(opts: { native?: string } = {}) {
  const sent: TxRequest[][] = []
  const signed: TypedDataRequest[] = []
  const balances: WalletBalance[] = [
    { chain: 'eip155:8453', token: 'native', symbol: 'ETH', decimals: 18, amount: opts.native ?? '0' },
    { chain: 'eip155:8453', token: BASE_USDC, symbol: 'USDC', decimals: 6, amount: '5', usd: '5' },
  ]
  const wallet: WalletAdapter = {
    id: 'test',
    namespaces: ['eip155'],
    getAccounts: async () => [{ chain: 'eip155:8453', address: SIGNER }],
    getBalances: async () => balances,
    sendTransactions: async (_chain, txs) => {
      sent.push(txs)
      return { hash: `0x${'ef'.repeat(32)}` }
    },
    signTypedData: async (_chain, data) => {
      signed.push(data)
      return SIG
    },
  }
  return { wallet, sent, signed }
}

async function setup(native?: string) {
  const api = relayApi()
  const ramp = createOpenRamp({ secret: 's'.repeat(40), baseUrl: BASE, adapters: [relay({ apiKey: 'k' })], logger: quiet, fetch: api.fetchFn })
  const client = createOpenRampClient({ baseUrl: BASE, fetch: async (input, init) => ramp.handle(new Request(String(input), init)) })
  const s = await ramp.sessions.create({ userId: 'u', country: 'SG', destination: { type: 'crypto', chain: 'eip155:42161', token: ARB_USDC, address: DEST } })
  const w = usdcOnlyWallet(native !== undefined ? { native } : {})
  const c = new DepositController({ client, clientSecret: s.clientSecret, wallet: w.wallet })
  await c.start()
  await c.selectMethod('wallet')
  expect(c.getSnapshot().source).toMatchObject({ chain: 'eip155:8453', symbol: 'USDC' })
  c.setAmount('5')
  await c.submitAmount()
  await c.confirm()
  return { ramp, c, s, api, ...w }
}

// The signed permit is valid until 1792147801 (Unix seconds): run 5 minutes before that.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime((1792147801 - 300) * 1000)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('Relay wallet payment without native gas', () => {
  it('a wallet with only USDC signs a permit, and the deposit completes on Relay\'s fill', async () => {
    const { ramp, c, s, api, sent, signed } = await setup()
    const step = c.getSnapshot().session!.step
    expect(step).toMatchObject({ state: 'PAYMENT', surface: { kind: 'WALLET_SIGN', chain: 'eip155:8453', address: SIGNER } })
    expect(api.quoteBodies.at(-1)).toMatchObject({ usePermit: true, user: SIGNER })

    await c.signWalletMessages()
    expect(sent).toHaveLength(0) // no transaction, so no gas
    expect(signed.map((t) => t.primaryType)).toEqual(['ReceiveWithAuthorization'])
    expect(api.posted).toEqual([{ signature: SIG, body: { kind: 'eip3009', requestId: REQ, api: 'swap' } }])
    expect(c.getSnapshot().session!.step.state).toBe('PROCESSING')

    await ramp.sessions.refresh(s.id)
    const pub = (await ramp.sessions.retrieve(s.id))!
    expect(pub.status).toBe('succeeded')
    expect(pub.result).toMatchObject({
      transactions: [
        { role: 'source', chain: 'eip155:8453', hash: SOLVER_TX },
        { role: 'destination', chain: 'eip155:42161', hash: FILL_TX },
      ],
      output: { value: '4.974221' },
      outputConfirmed: true,
    })
    c.destroy()
  })

  it('a wallet with gas pays with transactions as before', async () => {
    const { c, api } = await setup('0.01')
    expect(c.getSnapshot().session!.step.surface!.kind).toBe('WALLET_TX')
    expect(api.quoteBodies.some((b) => b.usePermit)).toBe(false)
    c.destroy()
  })
})
