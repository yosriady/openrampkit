// Gas abstraction for the wallet leg: Relay's permit flow (WALLET_SIGN, submit_signatures, /execute/permits).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkLegStep } from '@openrampkit/adapter'
import { USDC, stateFor } from '@openrampkit/core'
import type { CryptoAsset, LegQuote, PathwayLeg, TypedDataRequest } from '@openrampkit/core'
import { erc20TransferData, relay } from './index.js'
import type { RelayQuoteResponse } from './index.js'
import { PERMIT_MAX_TTL_SEC, permitItems, permitProblem } from './permit.js'
import type { PermitCheck, PermitItem } from './permit.js'
import type { RelayStep } from './types.js'
import { fakeFetch, makeCtx, recordingLog } from '@openrampkit/adapter/testing'
import type { FakeCall } from '@openrampkit/adapter/testing'

// The public anvil test account #1, and its signatures (made with viem 2) of the messages below.
const SIGNER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'
const OTHER = '0x03508bb71268bba25ecacc8f620e01866650532c'
const DEST = '0x000000000000000000000000000000000000beef'
const BASE_USDC: CryptoAsset = { kind: 'crypto', chain: 'eip155:8453', token: USDC['eip155:8453']! }
const ARB_USDC: CryptoAsset = { kind: 'crypto', chain: 'eip155:42161', token: USDC['eip155:42161']! }
const REQ = '0x1792147201626033656487ab40e61f2f83813e782034d86e267518be1f5e9eb3'
const PROXY_V3 = '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be'
const PROXY_V32 = '0x5567954cd026cebfe486062cb75848e0f1c12e58'
const ROUTER_V32 = '0x0729e2a4716d9f7dd17858d5d504426d228697f7'
const SOLVER = '0xf70da97812cb96acdf810712aa562db8dfa3dbef'
/** `validBefore` of the signed messages; the tests run 5 minutes before it */
const VALID_BEFORE = 1792147801
const NOW_SEC = VALID_BEFORE - 300

const EIP3009_TYPES = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
}
const USDC_DOMAIN = { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: BASE_USDC.token }

/** Relay's single EIP-3009 permit (approval proxy v3), as a live keyless quote returned it on 2026-10-16 */
const eip3009Sign = {
  signatureKind: 'eip712',
  types: EIP3009_TYPES,
  domain: USDC_DOMAIN,
  primaryType: 'ReceiveWithAuthorization',
  value: { from: SIGNER, to: PROXY_V3, value: '5000000', validAfter: 0, validBefore: VALID_BEFORE, nonce: '0x5455db7556e8e306ce23fa44a6e805a777e573c2ab30c40a2d51ebab2f5fd33d' },
}
const EIP3009_SIG =
  '0x6278f304295ac5da322775502c6f9420758aa383c5a1bd480bdd41bb5213f39c4016e568a84c09e4b37dfe9689f6e9f83059dde59375be19ba50bf8525368b3e1c'

/** The approval proxy 3.2 pair: a MulticallAuthorization, then the EIP-3009 permit that funds it */
const TRANSFER_TO_ROUTER = `0xa9059cbb${ROUTER_V32.slice(2).padStart(64, '0')}${(5_000_000).toString(16).padStart(64, '0')}`
const multicallSign = {
  signatureKind: 'eip712',
  domain: { name: 'RelayApprovalProxy', version: '3.1', chainId: 8453, verifyingContract: PROXY_V32 },
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
    relayer: SOLVER,
    msgValue: '0',
    refundTo: SIGNER,
    nftRecipient: SIGNER,
    metadata: '0x',
    fundingIndex: 0,
    calls: [
      { target: BASE_USDC.token, allowFailure: false, value: '0', callData: TRANSFER_TO_ROUTER },
      { target: ROUTER_V32, allowFailure: false, value: '0', callData: '0x12345678' },
    ],
    funding: [{ token: BASE_USDC.token, from: SIGNER, value: '5000000', validAfter: 0, validBefore: VALID_BEFORE }],
  },
}
const MULTICALL_SIG =
  '0xe6ca2a975438bb3837c871276398898f00ea90f4e4d82f36fc34ae20a7a30df3446c89ce55b6f6693c41ac649dab032f21a6f4241a5b58d8bf4f536f2ce9b9761b'
const pairedSign = {
  ...eip3009Sign,
  value: { from: SIGNER, to: PROXY_V32, value: '5000000', validAfter: 0, validBefore: VALID_BEFORE, nonce: '0x9a3c5d1b6e8f0a2c4e6a8c0e2a4c6e8a0c2e4a6c8e0a2c4e6a8c0e2a4c6e8a0c' },
}
const PAIRED_SIG =
  '0xb09ec02c9e086f5467409e0bfb54f749ad5c37bef8f1ff2ae1d9617d31c4446b55d64620faa86c7c4d067b0b1257f4678fa974eb1ed1e79f3620c2c47999402a1b'

const usdc = (chainId: number, address: string) => ({ chainId, address, symbol: 'USDC', name: 'USD Coin', decimals: 6 })
const details = {
  currencyIn: { currency: usdc(8453, BASE_USDC.token), amount: '5000000' },
  currencyOut: { currency: usdc(42161, ARB_USDC.token), amount: '4974221', minimumAmount: '4874737' },
  timeEstimate: 1,
}

/** Relay's normal quote: an ERC-20 deposit transaction */
function txQuote(): RelayQuoteResponse {
  return {
    requestId: '0xtxreq',
    steps: [{ id: 'deposit', kind: 'transaction', items: [{ status: 'incomplete', data: { to: BASE_USDC.token, data: erc20TransferData(DEST, '5000000'), chainId: 8453 } }] }],
    details,
  } as RelayQuoteResponse
}

type Item = { sign: Record<string, unknown>; kind: string; status?: string; requestId?: string }
const item = (sign: Record<string, unknown>, kind = 'eip3009'): Item => ({ sign, kind })

/** Relay's quote with `usePermit`: one `authorize1` step with these items (default: the single EIP-3009 permit) */
function permitQuote(items: Item[] = [item(eip3009Sign)]): RelayQuoteResponse {
  return {
    requestId: REQ,
    steps: [
      {
        id: 'authorize1',
        kind: 'signature',
        requestId: REQ,
        items: items.map((i) => ({
          status: i.status ?? 'incomplete',
          data: { sign: i.sign, post: { endpoint: '/execute/permits', method: 'POST', body: { kind: i.kind, requestId: i.requestId ?? REQ, api: 'swap' } } },
        })),
      },
    ],
    details,
  } as unknown as RelayQuoteResponse
}
const pairQuote = () => permitQuote([item(multicallSign, 'multicall-authorization'), item(pairedSign)])

const walletLeg: PathwayLeg = {
  adapterId: 'relay',
  legId: 'wallet',
  from: { asset: { kind: 'crypto', chain: '*', token: '*' }, location: { kind: 'user_wallet' } },
  to: { asset: ARB_USDC, location: { kind: 'address', address: DEST } },
}

type Setup = { permit?: () => unknown; permitStatus?: number; post?: (call: FakeCall) => { status?: number; body?: unknown }; status?: string; requests?: number }

function setup(s: Setup = {}, opts: Parameters<typeof relay>[0] = {}, shared?: ReturnType<typeof makeCtx>['shared'], sessionId?: string) {
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
    {
      method: 'GET',
      match: '/requests/',
      reply: () =>
        s.requests === 500
          ? new Response('{}', { status: 500 })
          : { requests: [{ id: REQ, status: 'success', createdAt: new Date().toISOString(), data: { metadata: { currencyOut: { currency: usdc(42161, ARB_USDC.token), amount: '4974221' } } } }] },
    },
  ])
  const log = recordingLog()
  const ctx = makeCtx({ fetch, log, ...(shared ? { shared } : {}), ...(sessionId ? { session: { id: sessionId } } : {}) })
  const a = relay({ apiKey: 'k', ...opts })
  const source = { chain: BASE_USDC.chain, token: BASE_USDC.token, address: SIGNER }
  const quote = () => a.quote({ leg: walletLeg, amountIn: { value: '5', asset: BASE_USDC }, source, deliverTo: { address: DEST } }, ctx) as Promise<LegQuote>
  const start = async (gasless = true, q?: LegQuote) => a.start({ leg: walletLeg, quote: q ?? (await quote()), source, ...(gasless ? { gasless: true } : {}) }, ctx)
  const fire = (signatures: unknown) => a.transition!({ leg: walletLeg, ref: REQ, name: 'submit_signatures', inputs: { signatures } }, ctx)
  const permitCalls = () => calls.filter((c) => c.url.includes('/execute/permits'))
  return { a, ctx, calls, log, start, fire, quote, permitCalls, s }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW_SEC * 1000)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('relay wallet: gas abstraction (permit)', () => {
  it('asks the wallet to sign, checks and posts the signatures in order, then follows Relay status', async () => {
    const h = setup({ permit: pairQuote })
    const step = await h.start()
    expect(checkLegStep(step)).toEqual([])
    expect(stateFor(step)).toBe('PAYMENT')
    expect(step).toMatchObject({ status: 'requires_action', ref: REQ, providerRef: REQ, action: { kind: 'payment', transitions: [{ name: 'submit_signatures', kind: 'SURFACE_RESULT', expects: 'signatures' }] } })
    const surface = step.action!.surface
    if (surface?.kind !== 'WALLET_SIGN') throw new Error('no WALLET_SIGN')
    expect(surface.chain).toBe('eip155:8453')
    expect(surface.address).toBe(SIGNER)
    expect(surface.signatures.map((t: TypedDataRequest) => t.primaryType)).toEqual(['MulticallAuthorization', 'ReceiveWithAuthorization'])
    expect(surface.signatures[1]).toEqual({ domain: pairedSign.domain, types: pairedSign.types, primaryType: 'ReceiveWithAuthorization', message: pairedSign.value })
    // The permit quote: the same body with the user, usePermit and the two-signature EIP-3009 flow.
    const permitBody = h.calls.filter((c) => c.url.includes('/quote/v2'))[1]!.body as Record<string, unknown>
    expect(permitBody).toMatchObject({ user: SIGNER, usePermit: true, useMulticallAuthorization: true, originChainId: 8453, destinationChainId: 42161, amount: '5000000' })

    // Not signed yet: the user still pays (no surface, so the UI keeps WALLET_SIGN). Relay is not asked.
    const before = await h.a.status!({ leg: walletLeg, ref: REQ }, h.ctx)
    expect(before).toMatchObject({ status: 'requires_action', action: { transitions: [{ name: 'submit_signatures' }] } })
    expect(before.action?.surface).toBeUndefined()
    expect(h.calls.some((c) => c.url.includes('/intents/status'))).toBe(false)

    const t = await h.fire([MULTICALL_SIG, PAIRED_SIG])
    expect(checkLegStep(t)).toEqual([])
    expect(t).toMatchObject({ status: 'processing', ref: REQ, providerRef: REQ })
    const posts = h.permitCalls()
    expect(posts.map((c) => new URL(c.url).searchParams.get('signature'))).toEqual([MULTICALL_SIG, PAIRED_SIG])
    expect(posts.map((c) => c.body)).toEqual([
      { kind: 'multicall-authorization', requestId: REQ, api: 'swap' },
      { kind: 'eip3009', requestId: REQ, api: 'swap' },
    ])
    expect(posts[0]!.headers.get('x-api-key')).toBe('k')

    // A retry of the same transition posts nothing again.
    await h.fire([MULTICALL_SIG, PAIRED_SIG])
    expect(h.permitCalls()).toHaveLength(2)

    // Relay has not sent the origin transaction yet: processing (there is no wallet transaction to wait for).
    expect(await h.a.status!({ leg: walletLeg, ref: REQ }, h.ctx)).toMatchObject({ status: 'processing' })
    // Relay's solver sent the origin transaction and filled: only Relay's status completes the leg.
    h.s.status = 'success'
    const done = await h.a.status!({ leg: walletLeg, ref: REQ }, h.ctx)
    expect(done).toMatchObject({ status: 'succeeded', providerRef: REQ, output: { value: '4.974221' } })
    expect(Object.fromEntries((done.transactions ?? []).map((x) => [x.role, x.hash]))).toEqual({ source: '0xsolver', destination: '0xdest' })
  })

  it('the single EIP-3009 permit of approval proxy v3 works too', async () => {
    const h = setup()
    expect((await h.start()).action?.surface?.kind).toBe('WALLET_SIGN')
    await expect(h.fire([EIP3009_SIG])).resolves.toMatchObject({ status: 'processing' })
    expect(h.permitCalls()).toHaveLength(1)
  })

  it('refuses a signature from another account or of the wrong count, and posts nothing', async () => {
    const h = setup()
    await h.start()
    // MULTICALL_SIG is a valid signature by SIGNER, but of another message: it recovers to another address.
    await expect(h.fire([MULTICALL_SIG])).rejects.toMatchObject({ error: { code: 'BAD_REQUEST', message: expect.stringContaining('not from the paying wallet') } })
    await expect(h.fire([EIP3009_SIG, EIP3009_SIG])).rejects.toMatchObject({ error: { code: 'BAD_REQUEST', message: 'Send 1 signature as 65-byte hex strings.' } })
    await expect(h.fire([])).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
    await expect(h.fire(['0x1234'])).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
    await expect(h.fire(undefined)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
    // Every signature is checked, not only the first: a good first and a bad second posts nothing.
    const pair = setup({ permit: pairQuote })
    await pair.start()
    await expect(pair.fire([MULTICALL_SIG, EIP3009_SIG])).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
    expect(h.permitCalls()).toHaveLength(0)
    expect(pair.permitCalls()).toHaveLength(0)
    // A transaction payment does not take signatures.
    const tx = await h.start(false)
    await expect(h.a.transition!({ leg: walletLeg, ref: tx.ref!, name: 'submit_signatures', inputs: { signatures: [EIP3009_SIG] } }, h.ctx)).rejects.toMatchObject({ status: 409 })
  })

  it('checks the messages again before posting: an expired permit is refused and nothing goes to Relay', async () => {
    const h = setup()
    await h.start()
    vi.setSystemTime((VALID_BEFORE + 1) * 1000)
    await expect(h.fire([EIP3009_SIG])).rejects.toMatchObject({ status: 409, error: { message: expect.stringContaining('the permit has expired'), recovery: 'choose_other' } })
    expect(h.permitCalls()).toHaveLength(0)
  })

  it('a stored permit without its check is never posted', async () => {
    const h = setup()
    await h.start()
    const rec = (await h.ctx.store.get<Record<string, unknown>>(`w:${REQ}`))!
    const { check: _check, ...permit } = rec.permit as Record<string, unknown>
    await h.ctx.store.put(`w:${REQ}`, { ...rec, permit })
    await expect(h.fire([EIP3009_SIG])).rejects.toMatchObject({ status: 409 })
    expect(h.permitCalls()).toHaveLength(0)
  })

  it('keeps the count of posted items: a retry after a refused second item posts only that item', async () => {
    let refuse = true
    const h = setup({ permit: pairQuote, post: (c) => ((c.body as { kind: string }).kind === 'eip3009' && refuse ? { status: 400, body: { message: 'Invalid signature' } } : {}) })
    await h.start()
    await expect(h.fire([MULTICALL_SIG, PAIRED_SIG])).rejects.toMatchObject({ error: { code: expect.any(String) } })
    expect(h.permitCalls().map((c) => (c.body as { kind: string }).kind)).toEqual(['multicall-authorization', 'eip3009'])
    refuse = false
    await expect(h.fire([MULTICALL_SIG, PAIRED_SIG])).resolves.toMatchObject({ status: 'processing' })
    expect(h.permitCalls().map((c) => (c.body as { kind: string }).kind)).toEqual(['multicall-authorization', 'eip3009', 'eip3009'])
  })

  it('completes only with the delivered amount: when Relay\'s request cannot be read, it waits', async () => {
    const h = setup({ status: 'success', requests: 500 })
    await h.start()
    await h.fire([EIP3009_SIG])
    expect(await h.a.status!({ leg: walletLeg, ref: REQ }, h.ctx)).toMatchObject({ status: 'processing' })
    h.s.requests = undefined
    expect(await h.a.status!({ leg: walletLeg, ref: REQ }, h.ctx)).toMatchObject({ status: 'succeeded', output: { value: '4.974221' } })
  })

  it('one EIP-3009 nonce serves one payment: a nonce Relay gives again is refused', async () => {
    const first = setup()
    expect((await first.start()).action?.surface?.kind).toBe('WALLET_SIGN')
    // Another session on the same server (same shared store) gets the same nonce.
    const second = setup({}, {}, first.ctx.shared, 'sess_2')
    expect((await second.start()).action?.surface?.kind).toBe('WALLET_TX')
    expect(second.log.warnings.some((w) => w.includes('already used'))).toBe(true)
    // The same session starting again (a retry) keeps its claim.
    expect((await first.start()).action?.surface?.kind).toBe('WALLET_SIGN')
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

  it('falls back to WALLET_TX when Relay has no permit route, the quote fails, the amount has no bound, or a check fails', async () => {
    const noPermit = setup({ permit: () => txQuote() })
    expect((await noPermit.start()).action?.surface?.kind).toBe('WALLET_TX')

    const failing = setup({ permitStatus: 500 })
    expect((await failing.start()).action?.surface?.kind).toBe('WALLET_TX')
    expect(failing.log.warnings.some((w) => w.includes('permit quote failed'))).toBe(true)

    // A quote input without decimals cannot bound the permit amount.
    const unbounded = setup()
    const q = await unbounded.quote()
    const noDecimals = { ...q, input: { ...q.input, asset: { kind: 'crypto' as const, chain: BASE_USDC.chain, token: BASE_USDC.token } } }
    expect((await unbounded.start(true, noDecimals)).action?.surface?.kind).toBe('WALLET_TX')

    // Relay asks to sign for another account: never shown to the user.
    const other = setup({ permit: () => permitQuote([item({ ...eip3009Sign, value: { ...eip3009Sign.value, from: OTHER } })]) })
    expect((await other.start()).action?.surface?.kind).toBe('WALLET_TX')
    expect(other.log.warnings.some((w) => w.includes('refused the permit'))).toBe(true)
    expect(other.permitCalls()).toHaveLength(0)
  })
})

describe('permitItems', () => {
  const steps = (q: RelayQuoteResponse) => q.steps as RelayStep[]
  it('takes only pure, incomplete EIP-712 permit steps for /execute/permits', () => {
    expect(permitItems(steps(pairQuote()))).toHaveLength(2)
    expect(permitItems(steps(txQuote()))).toBeUndefined()
    expect(permitItems([...steps(permitQuote()), ...steps(txQuote())])).toBeUndefined()
    const eip191 = { id: 'authorize', kind: 'signature', items: [{ status: 'incomplete', data: { sign: { signatureKind: 'eip191', message: '0x01' }, post: { endpoint: '/execute/permits', body: {} } } }] }
    expect(permitItems([eip191])).toBeUndefined()
    const elsewhere = permitQuote()
    elsewhere.steps[0]!.items![0]!.data!.post!.endpoint = '/somewhere'
    expect(permitItems(steps(elsewhere))).toBeUndefined()
    expect(permitItems([{ id: 'authorize1', kind: 'signature', items: [] }])).toBeUndefined()
    // An item that Relay marks complete was never signed here: refuse rather than skip it.
    expect(permitItems(steps(permitQuote([{ ...item(multicallSign, 'multicall-authorization'), status: 'complete' }, item(pairedSign)])))).toBeUndefined()
    // EIP712Domain in `types` is dropped: the wallet derives it from the domain.
    const withDomain = permitQuote([item({ ...eip3009Sign, types: { ...EIP3009_TYPES, EIP712Domain: [{ name: 'name', type: 'string' }] } })])
    expect(Object.keys(permitItems(steps(withDomain))![0]!.typedData.types)).toEqual(['ReceiveWithAuthorization'])
  })
})

describe('permitProblem (fails closed)', () => {
  const P: PermitCheck = { chainId: 8453, token: BASE_USDC.token, user: SIGNER, maxBase: 5_050_000n, requestId: REQ, nowSec: NOW_SEC }
  const items = (q: RelayQuoteResponse) => permitItems(q.steps as RelayStep[])!
  const single = (sign: Record<string, unknown>, kind = 'eip3009') => items(permitQuote([item(sign, kind)]))
  const v = eip3009Sign.value
  const withMessage = (m: Record<string, unknown>) => single({ ...eip3009Sign, value: { ...v, ...m } })
  /** The 3.2 pair with the MulticallAuthorization message changed */
  const pairWith = (m: Record<string, unknown>, paired: Record<string, unknown> = {}) =>
    items(permitQuote([item({ ...multicallSign, value: { ...multicallSign.value, ...m } }, 'multicall-authorization'), item({ ...pairedSign, value: { ...pairedSign.value, ...paired } })]))
  const fund = (f: Record<string, unknown>) => ({ funding: [{ ...multicallSign.value.funding[0], ...f }] })

  it('accepts the known shapes', () => {
    expect(permitProblem(items(permitQuote()), P)).toBeUndefined()
    expect(permitProblem(items(pairQuote()), P)).toBeUndefined()
    expect(permitProblem(single({ ...eip3009Sign, primaryType: 'TransferWithAuthorization', types: { TransferWithAuthorization: EIP3009_TYPES.ReceiveWithAuthorization } }), P)).toBeUndefined()
  })

  it('refuses an unknown message type, other fields, another kind or another request', () => {
    const permit2612 = { ...eip3009Sign, primaryType: 'Permit', types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }] }, value: { owner: SIGNER, spender: OTHER, value: '1' } }
    expect(permitProblem(single(permit2612), P)).toMatch(/unknown message type/)
    expect(permitProblem(single({ ...eip3009Sign, types: { ReceiveWithAuthorization: [...EIP3009_TYPES.ReceiveWithAuthorization, { name: 'extra', type: 'uint256' }] } }), P)).toBe('the permit message has unexpected fields')
    expect(permitProblem(single({ ...eip3009Sign, types: { ...EIP3009_TYPES, Extra: [] } }), P)).toBe('the permit message has unexpected fields')
    expect(permitProblem(single(eip3009Sign, 'permit2'), P)).toBe('the permit is posted with another kind')
    expect(permitProblem(items(permitQuote([{ ...item(eip3009Sign), requestId: '0xother' }])), P)).toBe('the permit is for another request')
  })

  it('EIP-3009: chain, token, account, receiver, amount, nonce and time window', () => {
    expect(permitProblem(single({ ...eip3009Sign, domain: { ...USDC_DOMAIN, chainId: 1 } }), P)).toBe('the permit is for another chain')
    expect(permitProblem(single({ ...eip3009Sign, domain: { ...USDC_DOMAIN, chainId: undefined } }), P)).toBe('the permit is for another chain')
    expect(permitProblem(single({ ...eip3009Sign, domain: { ...USDC_DOMAIN, verifyingContract: ARB_USDC.token } }), P)).toBe('the permit is for another token')
    expect(permitProblem(withMessage({ from: OTHER }), P)).toBe('the permit is for another account')
    expect(permitProblem(withMessage({ from: undefined }), P)).toBe('the permit is for another account')
    expect(permitProblem(withMessage({ to: OTHER }), P)).toBe('the permit pays an address that is not Relay')
    expect(permitProblem(withMessage({ value: '5050001' }), P)).toBe('the permit moves more than the quoted amount')
    expect(permitProblem(withMessage({ value: '0' }), P)).toBe('the permit moves more than the quoted amount')
    expect(permitProblem(withMessage({ value: 'lots' }), P)).toBe('the permit moves more than the quoted amount')
    expect(permitProblem(withMessage({ nonce: '0x01' }), P)).toBe('the permit has no valid nonce')
    expect(permitProblem(withMessage({ validBefore: NOW_SEC }), P)).toBe('the permit has expired')
    expect(permitProblem(withMessage({ validBefore: NOW_SEC + PERMIT_MAX_TTL_SEC + 1 }), P)).toBe('the permit stays valid for too long')
    expect(permitProblem(withMessage({ validAfter: NOW_SEC + 3600 }), P)).toBe('the permit is not valid yet')
    expect(permitProblem(withMessage({ validBefore: undefined }), P)).toBe('the permit has no valid time window')
  })

  it('MulticallAuthorization: proxy, account, refunds, relayer, native value and metadata', () => {
    expect(permitProblem(items(permitQuote([item({ ...multicallSign, domain: { ...multicallSign.domain, verifyingContract: OTHER } }, 'multicall-authorization'), item(pairedSign)])), P)).toBe(
      'the authorization is for a contract that is not Relay',
    )
    expect(permitProblem(pairWith({ from: OTHER }), P)).toBe('the permit is for another account')
    expect(permitProblem(pairWith({ refundTo: OTHER }), P)).toBe('the authorization refunds to another account')
    expect(permitProblem(pairWith({ nftRecipient: OTHER }), P)).toBe('the authorization refunds to another account')
    expect(permitProblem(pairWith({ relayer: OTHER }), P)).toBe('the authorization names a relayer that is not Relay')
    expect(permitProblem(pairWith({ msgValue: '1' }), P)).toBe('the authorization sends native value')
    expect(permitProblem(pairWith({ metadata: 'nope' }), P)).toBe('the authorization has invalid metadata')
  })

  it('MulticallAuthorization: every funding entry, the funding index and the total', () => {
    expect(permitProblem(pairWith({ funding: [] }), P)).toBe('the authorization has no funding')
    expect(permitProblem(pairWith({ fundingIndex: 1 }), P)).toBe('the authorization has an invalid funding index')
    expect(permitProblem(pairWith(fund({ token: ARB_USDC.token })), P)).toBe('the permit funds from another token or account')
    expect(permitProblem(pairWith(fund({ from: OTHER })), P)).toBe('the permit funds from another token or account')
    expect(permitProblem(pairWith(fund({ value: '0' })), P)).toBe('the permit moves more than the quoted amount')
    expect(permitProblem(pairWith(fund({ validBefore: NOW_SEC - 1 })), P)).toBe('the permit has expired')
    // Two entries, each under the bound, over it together.
    const f = multicallSign.value.funding[0]
    expect(permitProblem(pairWith({ funding: [f, { ...f, value: '100000' }] }), P)).toBe('the permit moves more than the quoted amount')
  })

  it('MulticallAuthorization: calls only to Relay contracts, or a token transfer or approval to one', () => {
    const call = (c: Record<string, unknown>) => ({ calls: [{ target: ROUTER_V32, allowFailure: false, value: '0', callData: '0x', ...c }] })
    expect(permitProblem(pairWith({ calls: [] }), P)).toBe('the authorization has no calls')
    expect(permitProblem(pairWith(call({ target: OTHER })), P)).toBe('the authorization calls a contract that is not Relay')
    expect(permitProblem(pairWith(call({ value: '1' })), P)).toBe('the authorization sends native value')
    expect(permitProblem(pairWith(call({ allowFailure: 'no' })), P)).toBe('the authorization has an invalid call')
    const toOther = `0xa9059cbb${OTHER.slice(2).padStart(64, '0')}${'0'.repeat(64)}`
    expect(permitProblem(pairWith(call({ target: BASE_USDC.token, callData: toOther })), P)).toBe('the authorization moves the token to an address that is not Relay')
    const approveOther = `0x095ea7b3${OTHER.slice(2).padStart(64, '0')}${'f'.repeat(64)}`
    expect(permitProblem(pairWith(call({ target: BASE_USDC.token, callData: approveOther })), P)).toBe('the authorization moves the token to an address that is not Relay')
    // transferFrom (or any other call) on the token is refused.
    expect(permitProblem(pairWith(call({ target: BASE_USDC.token, callData: `0x23b872dd${'0'.repeat(192)}` })), P)).toBe('the authorization calls a contract that is not Relay')
  })

  it('the pair: one token authorization, after the MulticallAuthorization, funding it exactly', () => {
    const multi = item(multicallSign, 'multicall-authorization')
    expect(permitProblem(items(permitQuote([multi])), P)).toBe('the permit has no token authorization')
    expect(permitProblem(items(permitQuote([item(pairedSign), multi])), P)).toBe('the permit has its authorizations in an unexpected order')
    expect(permitProblem(items(permitQuote([item(eip3009Sign), item(pairedSign)])), P)).toBe('the permit has more than one token authorization')
    expect(permitProblem(items(permitQuote([multi, multi, item(pairedSign)])), P)).toBe('the permit has its authorizations in an unexpected order')
    // The token authorization pays the v3 proxy, but the calls run on the v3.2 proxy.
    expect(permitProblem(pairWith({}, { to: PROXY_V3 }), P)).toBe('the token authorization pays another contract than the authorized calls')
    expect(permitProblem(pairWith({}, { value: '4000000' }), P)).toBe('the token authorization does not match the funding')
  })
})

// Keep the PermitItem type in use for the type checker.
export type { PermitItem }
