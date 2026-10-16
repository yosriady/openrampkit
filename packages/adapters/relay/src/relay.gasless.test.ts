// Gas abstraction for the wallet leg: Relay's permit flow (WALLET_SIGN, submit_signatures, /execute/permits).
import { describe, expect, it } from 'vitest'
import { checkLegStep } from '@openrampkit/adapter'
import { USDC, stateFor } from '@openrampkit/core'
import type { CryptoAsset, LegQuote, PathwayLeg, TypedDataRequest } from '@openrampkit/core'
import { erc20TransferData, relay } from './index.js'
import type { RelayQuoteResponse } from './index.js'
import { permitItems, permitProblem } from './wallet.js'
import { fakeFetch, makeCtx, recordingLog } from '@openrampkit/adapter/testing'
import type { FakeCall } from '@openrampkit/adapter/testing'

// The public anvil test account #1, and its signatures of the two messages below (made with viem 2).
const SIGNER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'
const OTHER = '0x03508bb71268bba25ecacc8f620e01866650532c'
const DEST = '0x000000000000000000000000000000000000beef'
const BASE_USDC: CryptoAsset = { kind: 'crypto', chain: 'eip155:8453', token: USDC['eip155:8453']! }
const ARB_USDC: CryptoAsset = { kind: 'crypto', chain: 'eip155:42161', token: USDC['eip155:42161']! }
const REQ = '0x1792147201626033656487ab40e61f2f83813e782034d86e267518be1f5e9eb3'

const eip3009Sign = {
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
  domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: BASE_USDC.token },
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
const EIP3009_SIG =
  '0x6278f304295ac5da322775502c6f9420758aa383c5a1bd480bdd41bb5213f39c4016e568a84c09e4b37dfe9689f6e9f83059dde59375be19ba50bf8525368b3e1c'

const multicallSign = {
  signatureKind: 'eip712',
  domain: { name: 'RelayApprovalProxy', version: '3.1', chainId: 8453, verifyingContract: '0x5567954cd026cebfe486062cb75848e0f1c12e58' },
  types: {
    MulticallAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'relayer', type: 'address' },
      { name: 'msgValue', type: 'uint256' },
      { name: 'refundTo', type: 'address' },
      { name: 'nftRecipient', type: 'address' },
      { name: 'metadata', type: 'bytes' },
      { name: 'fundingIndex', type: 'uint256' },
      { name: 'calls', type: 'Call3Value[]' },
      { name: 'funding', type: 'FundingAuthorization[]' },
    ],
    Call3Value: [
      { name: 'target', type: 'address' },
      { name: 'allowFailure', type: 'bool' },
      { name: 'value', type: 'uint256' },
      { name: 'callData', type: 'bytes' },
    ],
    FundingAuthorization: [
      { name: 'token', type: 'address' },
      { name: 'from', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
    ],
  },
  primaryType: 'MulticallAuthorization',
  value: {
    from: SIGNER,
    relayer: '0xf70da97812cb96acdf810712aa562db8dfa3dbef',
    msgValue: '0',
    refundTo: SIGNER,
    nftRecipient: SIGNER,
    metadata: '0xabcdef',
    fundingIndex: 0,
    calls: [{ target: BASE_USDC.token, allowFailure: false, value: '0', callData: '0xa9059cbb0000' }],
    funding: [{ token: BASE_USDC.token, from: SIGNER, value: '1000000', validAfter: 0, validBefore: 1764948419 }],
  },
}
const MULTICALL_SIG =
  '0x34618c2aa8f3d0f87e8dc8355040d1b4898c7b12021e0c8c2d32d415c38eecab595a5742a6fb33ef665651ca38ecedce4ca4e8890cce253d47ecb8be069698b41b'

const usdc = (chainId: number, address: string) => ({ chainId, address, symbol: 'USDC', name: 'USD Coin', decimals: 6 })
const details = {
  currencyIn: { currency: usdc(8453, BASE_USDC.token), amount: '5000000' },
  currencyOut: { currency: usdc(42161, ARB_USDC.token), amount: '4974221', minimumAmount: '4874737' },
  timeEstimate: 1,
}

/** Relay's normal quote: approve-free ERC-20 deposit transaction */
function txQuote(): RelayQuoteResponse {
  return {
    requestId: '0xtxreq',
    steps: [{ id: 'deposit', kind: 'transaction', items: [{ status: 'incomplete', data: { to: BASE_USDC.token, data: erc20TransferData(DEST, '5000000'), chainId: 8453 } }] }],
    details,
  } as RelayQuoteResponse
}

/** Relay's quote with `usePermit` (shape from a live keyless quote on 2026-10-16), optionally with the MulticallAuthorization item */
function permitQuote(opts: { multicall?: boolean; sign?: Record<string, unknown> } = {}): RelayQuoteResponse {
  const item = (sign: unknown, kind: string) => ({ status: 'incomplete', data: { sign, post: { endpoint: '/execute/permits', method: 'POST', body: { kind, requestId: REQ, api: 'swap' } } } })
  return {
    requestId: REQ,
    steps: [
      {
        id: 'authorize1',
        kind: 'signature',
        requestId: REQ,
        items: [...(opts.multicall ? [item(multicallSign, 'multicall-authorization')] : []), item(opts.sign ?? eip3009Sign, 'eip3009')],
      },
    ],
    details,
  } as unknown as RelayQuoteResponse
}

const walletLeg: PathwayLeg = {
  adapterId: 'relay',
  legId: 'wallet',
  from: { asset: { kind: 'crypto', chain: '*', token: '*' }, location: { kind: 'user_wallet' } },
  to: { asset: ARB_USDC, location: { kind: 'address', address: DEST } },
}

type Setup = { permit?: () => unknown; permitStatus?: number; post?: (call: FakeCall) => { status?: number; body?: unknown }; status?: string }

function setup(s: Setup = {}, opts: Parameters<typeof relay>[0] = {}) {
  const { fetch, calls } = fakeFetch([
    {
      method: 'POST',
      match: '/quote/v2',
      reply: (c) => {
        const body = c.body as Record<string, unknown>
        if (!body.usePermit) return txQuote()
        if (s.permitStatus) return new Response(JSON.stringify({ message: 'boom' }), { status: s.permitStatus })
        return s.permit ? s.permit() : permitQuote()
      },
    },
    {
      method: 'POST',
      match: '/execute/permits',
      reply: (c) => {
        const r = s.post?.(c) ?? {}
        return new Response(JSON.stringify(r.body ?? { message: 'Transaction submitted' }), { status: r.status ?? 200 })
      },
    },
    { method: 'GET', match: '/intents/status/v3', reply: () => ({ status: s.status ?? 'waiting', inTxHashes: s.status === 'success' ? ['0xsolver'] : [], txHashes: s.status === 'success' ? ['0xdest'] : [] }) },
    { method: 'GET', match: '/requests/', reply: () => ({ requests: [] }) },
  ])
  const log = recordingLog()
  const ctx = makeCtx({ fetch, log })
  const a = relay({ apiKey: 'k', ...opts })
  const source = { chain: BASE_USDC.chain, token: BASE_USDC.token, address: SIGNER }
  const quote = () => a.quote({ leg: walletLeg, amountIn: { value: '5', asset: BASE_USDC }, source, deliverTo: { address: DEST } }, ctx) as Promise<LegQuote>
  const start = async (gasless = true, q?: LegQuote) => a.start({ leg: walletLeg, quote: q ?? (await quote()), source, ...(gasless ? { gasless: true } : {}) }, ctx)
  const permitCalls = () => calls.filter((c) => c.url.includes('/execute/permits'))
  return { a, ctx, calls, log, start, quote, permitCalls, s }
}

describe('relay wallet: gas abstraction (permit)', () => {
  it('asks the wallet to sign, checks and posts the signatures in order, then follows Relay status', async () => {
    const h = setup({ permit: () => permitQuote({ multicall: true }) })
    const step = await h.start()
    expect(checkLegStep(step)).toEqual([])
    expect(stateFor(step)).toBe('PAYMENT')
    expect(step).toMatchObject({ status: 'requires_action', ref: REQ, providerRef: REQ, action: { kind: 'payment', transitions: [{ name: 'submit_signatures', kind: 'SURFACE_RESULT', expects: 'signatures' }] } })
    const surface = step.action!.surface
    expect(surface?.kind).toBe('WALLET_SIGN')
    if (surface?.kind !== 'WALLET_SIGN') throw new Error('no WALLET_SIGN')
    expect(surface.chain).toBe('eip155:8453')
    expect(surface.address).toBe(SIGNER)
    expect(surface.signatures.map((t: TypedDataRequest) => t.primaryType)).toEqual(['MulticallAuthorization', 'ReceiveWithAuthorization'])
    expect(surface.signatures[1]).toEqual({ domain: eip3009Sign.domain, types: eip3009Sign.types, primaryType: 'ReceiveWithAuthorization', message: eip3009Sign.value })
    // The permit quote: the same body with the user, usePermit and the two-signature EIP-3009 flow.
    const permitBody = h.calls.filter((c) => c.url.includes('/quote/v2'))[1]!.body as Record<string, unknown>
    expect(permitBody).toMatchObject({ user: SIGNER, usePermit: true, useMulticallAuthorization: true, originChainId: 8453, destinationChainId: 42161, amount: '5000000' })

    // Not signed yet: the user still pays (no surface, so the UI keeps WALLET_SIGN). Relay is not asked.
    const before = await h.a.status!({ leg: walletLeg, ref: REQ }, h.ctx)
    expect(before).toMatchObject({ status: 'requires_action', action: { transitions: [{ name: 'submit_signatures' }] } })
    expect(before.action?.surface).toBeUndefined()
    expect(h.calls.some((c) => c.url.includes('/intents/status'))).toBe(false)

    const t = await h.a.transition!({ leg: walletLeg, ref: REQ, name: 'submit_signatures', inputs: { signatures: [MULTICALL_SIG, EIP3009_SIG] } }, h.ctx)
    expect(checkLegStep(t)).toEqual([])
    expect(t).toMatchObject({ status: 'processing', ref: REQ, providerRef: REQ })
    const posts = h.permitCalls()
    expect(posts.map((c) => new URL(c.url).searchParams.get('signature'))).toEqual([MULTICALL_SIG, EIP3009_SIG])
    expect(posts.map((c) => c.body)).toEqual([
      { kind: 'multicall-authorization', requestId: REQ, api: 'swap' },
      { kind: 'eip3009', requestId: REQ, api: 'swap' },
    ])
    expect(posts[0]!.headers.get('x-api-key')).toBe('k')

    // A retry of the same transition posts nothing again.
    await h.a.transition!({ leg: walletLeg, ref: REQ, name: 'submit_signatures', inputs: { signatures: [MULTICALL_SIG, EIP3009_SIG] } }, h.ctx)
    expect(h.permitCalls()).toHaveLength(2)

    // Relay has not sent the origin transaction yet: processing (there is no wallet transaction to wait for).
    const waiting = await h.a.status!({ leg: walletLeg, ref: REQ }, h.ctx)
    expect(waiting).toMatchObject({ status: 'processing' })
    // Relay's solver sent the origin transaction and filled: only Relay's status completes the leg.
    h.s.status = 'success'
    const done = await h.a.status!({ leg: walletLeg, ref: REQ }, h.ctx)
    expect(done).toMatchObject({ status: 'succeeded', providerRef: REQ })
    expect(Object.fromEntries((done.transactions ?? []).map((x) => [x.role, x.hash]))).toEqual({ source: '0xsolver', destination: '0xdest' })
  })

  it('refuses a signature from another account or of the wrong count, and posts nothing', async () => {
    const h = setup()
    await h.start()
    const fire = (signatures: unknown) => h.a.transition!({ leg: walletLeg, ref: REQ, name: 'submit_signatures', inputs: { signatures } }, h.ctx)
    // MULTICALL_SIG is a valid signature by SIGNER, but of another message: it recovers to another address.
    await expect(fire([MULTICALL_SIG])).rejects.toMatchObject({ error: { code: 'BAD_REQUEST', message: expect.stringContaining('not from the paying wallet') } })
    await expect(fire([EIP3009_SIG, EIP3009_SIG])).rejects.toMatchObject({ error: { code: 'BAD_REQUEST', message: 'Send 1 signature as 65-byte hex strings.' } })
    await expect(fire(['0x1234'])).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
    await expect(fire(undefined)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
    expect(h.permitCalls()).toHaveLength(0)
    // A transaction payment does not take signatures.
    const tx = await h.start(false)
    await expect(h.a.transition!({ leg: walletLeg, ref: tx.ref!, name: 'submit_signatures', inputs: { signatures: [EIP3009_SIG] } }, h.ctx)).rejects.toMatchObject({ status: 409 })
  })

  it('keeps the count of posted items: a retry after a refused second item posts only that item', async () => {
    let refuse = true
    const h = setup({ permit: () => permitQuote({ multicall: true }), post: (c) => ((c.body as { kind: string }).kind === 'eip3009' && refuse ? { status: 400, body: { message: 'Invalid signature' } } : {}) })
    await h.start()
    const fire = () => h.a.transition!({ leg: walletLeg, ref: REQ, name: 'submit_signatures', inputs: { signatures: [MULTICALL_SIG, EIP3009_SIG] } }, h.ctx)
    await expect(fire()).rejects.toMatchObject({ error: { code: expect.any(String) } })
    expect(h.permitCalls().map((c) => (c.body as { kind: string }).kind)).toEqual(['multicall-authorization', 'eip3009'])
    refuse = false
    await expect(fire()).resolves.toMatchObject({ status: 'processing' })
    expect(h.permitCalls().map((c) => (c.body as { kind: string }).kind)).toEqual(['multicall-authorization', 'eip3009', 'eip3009'])
  })

  it('pays gas as before when the client does not ask, the app turns it off, or the token is native', async () => {
    const off = setup()
    expect((await off.start(false)).action?.surface?.kind).toBe('WALLET_TX')
    expect(off.calls.filter((c) => (c.body as { usePermit?: boolean } | undefined)?.usePermit)).toHaveLength(0)

    const disabled = setup({}, { gasless: false })
    expect((await disabled.start()).action?.surface?.kind).toBe('WALLET_TX')
    expect(disabled.calls.filter((c) => (c.body as { usePermit?: boolean } | undefined)?.usePermit)).toHaveLength(0)

    const native = setup()
    const nativeSource = { chain: 'eip155:8453', token: 'native', address: SIGNER }
    const q = await native.a.quote({ leg: walletLeg, amountIn: { value: '0.01', asset: { kind: 'crypto', chain: 'eip155:8453', token: 'native', decimals: 18 } }, source: nativeSource, deliverTo: { address: DEST } }, native.ctx)
    const st = await native.a.start({ leg: walletLeg, quote: q, source: nativeSource, gasless: true }, native.ctx)
    expect(st.action?.surface?.kind).toBe('WALLET_TX')
    expect(native.calls.filter((c) => (c.body as { usePermit?: boolean } | undefined)?.usePermit)).toHaveLength(0)
  })

  it('falls back to WALLET_TX when Relay has no permit route, the permit quote fails, or the permit does not match', async () => {
    // A token without permit support: Relay ignores usePermit and returns transactions.
    const noPermit = setup({ permit: () => txQuote() })
    expect((await noPermit.start()).action?.surface?.kind).toBe('WALLET_TX')

    const failing = setup({ permitStatus: 500 })
    expect((await failing.start()).action?.surface?.kind).toBe('WALLET_TX')
    expect(failing.log.warnings.some((w) => w.includes('permit quote failed'))).toBe(true)

    // Relay asks to sign for another account: never shown to the user.
    const other = setup({ permit: () => permitQuote({ sign: { ...eip3009Sign, value: { ...eip3009Sign.value, from: OTHER } } }) })
    expect((await other.start()).action?.surface?.kind).toBe('WALLET_TX')
    expect(other.log.warnings.some((w) => w.includes('refused the permit'))).toBe(true)
  })

  it('permitItems takes only pure EIP-712 permit steps for /execute/permits', () => {
    expect(permitItems(permitQuote({ multicall: true }).steps)).toHaveLength(2)
    expect(permitItems(txQuote().steps)).toBeUndefined()
    expect(permitItems([...permitQuote().steps, ...txQuote().steps])).toBeUndefined()
    const eip191 = { id: 'authorize', kind: 'signature', items: [{ status: 'incomplete', data: { sign: { signatureKind: 'eip191', message: '0x01' }, post: { endpoint: '/execute/permits', body: {} } } }] }
    expect(permitItems([eip191])).toBeUndefined()
    const elsewhere = permitQuote()
    elsewhere.steps[0]!.items![0]!.data!.post!.endpoint = '/somewhere'
    expect(permitItems(elsewhere.steps)).toBeUndefined()
    expect(permitItems([{ id: 'authorize1', kind: 'signature', items: [] }])).toBeUndefined()
    // EIP712Domain in `types` is dropped: the wallet derives it from the domain.
    const withDomain = permitQuote({ sign: { ...eip3009Sign, types: { ...eip3009Sign.types, EIP712Domain: [{ name: 'name', type: 'string' }] } } })
    expect(Object.keys(permitItems(withDomain.steps)![0]!.typedData.types)).toEqual(['ReceiveWithAuthorization'])
  })

  it('permitProblem checks the chain, the account, the token and the amount', () => {
    const items = permitItems(permitQuote({ multicall: true }).steps)!
    const p = { chainId: 8453, token: BASE_USDC.token, user: SIGNER, maxBase: 5_050_000n }
    expect(permitProblem(items, p)).toBeUndefined()
    expect(permitProblem(items, { ...p, chainId: 1 })).toBe('the permit is for another chain')
    expect(permitProblem(items, { ...p, user: OTHER })).toBe('the permit is for another account')
    expect(permitProblem(items, { ...p, token: ARB_USDC.token })).toMatch(/another token/)
    expect(permitProblem(items, { ...p, maxBase: 4_999_999n })).toBe('the permit moves more than the quoted amount')
    const bad = permitItems(permitQuote({ sign: { ...eip3009Sign, value: { ...eip3009Sign.value, value: 'lots' } } }).steps)!
    expect(permitProblem(bad, p)).toBe('the permit moves more than the quoted amount')
  })
})
