// Mock provider adapter for local development, demos and tests.
// It moves no money. It exercises every surface: hosted redirect checkout, QR, deposit address and wallet tx.

import { POLL as POLLS, awaitPoll, buildSettlementTxs, createAdapter, erc20PaidTo, erc20TransferData, evmRpc, hashSettlementCalls, settlementCallsFrom, solanaPaidTo, verifySettlement } from '@openrampkit/adapter'
import type { AdapterContext, EvmReceipt, LegEvent, SolanaParsedTx, SolanaSignatureStatus } from '@openrampkit/adapter'
import { CHAINS, OrkException, USDC, add, bps, chainName, evmChainId, fromScaled, isEvmChain, isSolanaChain, isSolanaSignature, isUsdc, minorUnits, mulRatio, nativeDecimals, normalizeToken, orkError, roundTo, sub, toBaseUnits, toScaled } from '@openrampkit/core'
import type { Amount, CryptoAsset, FieldSpec, LegQuote, LegSpec, LegStep, PollSpec, TxRequest } from '@openrampkit/core'

export type MockOptions = {
  /** How long a mock payment or bridge takes to settle (ms). Default 3000. */
  settleMs?: number
  /** Add mock `wallet` and `transfer` legs (use when the real Relay adapter is not configured) */
  crypto?: boolean
  /** Add a mock `bridge` leg for two-leg pathways (use when the real Relay adapter is not configured) */
  bridge?: boolean
  /**
   * Add a mock `offramp` leg (crypto_offramp) for withdraw to cash: USDC in, fiat out to the user's
   * bank or e-wallet (bank_transfer, gcash, momo, promptpay). It asks for the payout account (FORM),
   * then for a USDC transfer to a mock provider address (WALLET_TX), then settles after `settleMs`.
   */
  offramp?: boolean
  /** Name shown to users. Default "Test provider". */
  name?: string
  /**
   * Adapter id. Default `mock`. Give each instance its own id when you configure more than one mock,
   * for example to compare quotes from several mock providers in a demo.
   */
  id?: string
  /** Fees in basis points per leg. Defaults: card 250, local 100, payin 70, offramp 100, crypto legs 5. */
  feeBps?: MockFees
  /** FX spread in basis points on the test rate of the onramp and offramp legs. Default 0. A higher spread gives a worse rate. */
  spreadBps?: number
  /** Time estimates in seconds per leg, shown before the user pays. Defaults: see the docs. */
  eta?: Partial<Record<'card' | 'local' | 'payin' | 'offramp', { min: number; max: number }>>
  /** Offer only these methods. A leg with methods that keeps none is left out. Default: all methods. */
  methods?: string[]
  /** Serve only these countries (ISO 3166-1 alpha-2) on the fiat legs. Default: the built-in regions of each leg. */
  countries?: string[]
  /**
   * How the card leg checks out. `redirect` (default): a hosted checkout page in a new tab.
   * `form`: test card fields in the widget (a FORM surface), for static demos that cannot serve the hosted page.
   */
  cardCheckout?: 'redirect' | 'form'
  /** With `crypto`: also offer the `exchange_transfer` method ("From an exchange") on the transfer leg. */
  exchange?: boolean
  /**
   * Test only: add an `onchain` leg (method `wallet`, surface WALLET_TX) on a local dev chain such as
   * Anvil. It asks the wallet to send `token` to the destination address with a real ERC-20 transfer,
   * and completes only when the receipt, read over JSON-RPC from `rpcUrl`, shows that transfer.
   * Use it with a destination on `chain` in `token`. The quote is 1:1 with no fee.
   *
   * With a destination `settlement` contract, the leg pays through OpenRampSettlement instead:
   * `approve` + `settle` (from `buildSettlementTxs`, with the destination `calls`), and it completes
   * only when `verifySettlement` finds a receipt for the session that pays the quoted amount.
   * This works on any EVM chain with a public RPC, for example a testnet.
   */
  localChain?: MockLocalChain
  /**
   * Test only: add a `solana-onchain` leg (method `wallet`, surface WALLET_TX) on a Solana cluster,
   * for example devnet. It asks the wallet for one transfer of `mint` (an SPL token, or `native` SOL)
   * to the destination address, the same as `localChain` does on EVM. It completes only when the
   * signature, read over JSON-RPC from `rpcUrl`, is confirmed without error, is in a slot at or after
   * the slot when the leg started, moves at least the quoted amount of `mint` to the destination,
   * and did not complete another payment before. The quote is 1:1 with no fee.
   */
  solanaLocalChain?: MockSolanaLocalChain
}

/** A Solana cluster for the mock `solana-onchain` leg (see `MockOptions.solanaLocalChain`) */
export type MockSolanaLocalChain = {
  /** CAIP-2 chain id, for example `SOLANA_DEVNET` */
  chain: string
  /** JSON-RPC URL of the cluster, for example `https://api.devnet.solana.com` */
  rpcUrl: string
  /** SPL mint to pay with (base58, case-sensitive), or `native` for SOL */
  mint: string
  /** Default `USDC` (`SOL` for native) */
  symbol?: string
  /** Default 6 (9 for native) */
  decimals?: number
}

/** Fees in basis points per leg (see `MockOptions.feeBps`) */
export type MockFees = { card?: number; local?: number; payin?: number; offramp?: number; crypto?: number }

/** A local dev chain for the mock `onchain` leg (see `MockOptions.localChain`) */
export type MockLocalChain = {
  /** CAIP-2 chain id, for example `eip155:31337` (Anvil) */
  chain: string
  /** JSON-RPC URL of the chain, for example `http://127.0.0.1:8545` */
  rpcUrl: string
  /** ERC-20 token contract to pay with, for example a mock USDC */
  token: string
  /** Default `USDC` */
  symbol?: string
  /** Default 6 */
  decimals?: number
}

/** Payout methods of the mock offramp leg */
export const MOCK_PAYOUT_METHODS = ['bank_transfer', 'gcash', 'momo', 'promptpay']

/** Rough FX to USD for quotes. Test data only. */
const USD_PER_UNIT: Record<string, string> = {
  USD: '1', EUR: '1.08', GBP: '1.27', SGD: '0.74', MYR: '0.22', THB: '0.029', PHP: '0.0175', IDR: '0.000062',
  VND: '0.0000395', INR: '0.012', BRL: '0.18', AUD: '0.66', CAD: '0.73', JPY: '0.0067', KRW: '0.00073',
}

/** Best-effort symbol for a token when the caller did not give one (test data only). */
function symbolOf(a: { chain: string; token: string; symbol?: string }): string {
  if (a.symbol) return a.symbol
  const t = a.token.toLowerCase()
  if (t === 'native' || t === '0x0000000000000000000000000000000000000000' || t === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') return CHAINS[a.chain]?.nativeSymbol ?? 'ETH'
  return isUsdc(a.chain, a.token) ? 'USDC' : 'TOKEN'
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** A stable fake address for a seed, in the format of `chain` (Solana: base58 of 32 bytes; else EVM). Test data only. */
function fakeAddressFor(chain: string, seed: string): string {
  let h = 0n
  const bits = isSolanaChain(chain) ? 256n : 160n
  for (const c of seed) h = (h * 131n + BigInt(c.charCodeAt(0))) % (1n << bits)
  if (!isSolanaChain(chain)) return `0x${h.toString(16).padStart(40, '0')}`
  // Set the top bit so that the address always has 43 or 44 characters.
  let n = h | (1n << 255n)
  let out = ''
  while (n > 0n) {
    out = BASE58_ALPHABET[Number(n % 58n)]! + out
    n /= 58n
  }
  return out
}

const POLL: PollSpec = POLLS.dev
const ORDER_TTL_SEC = 24 * 60 * 60
const BASE_USDC: CryptoAsset = { kind: 'crypto', chain: 'eip155:8453', token: USDC['eip155:8453']!, symbol: 'USDC', decimals: 6 }
const usdcChains = Object.fromEntries(Object.entries(USDC).map(([c, t]) => [c, [t]]))
/** The mock offramp asks for an ERC-20 transfer, so it takes EVM USDC only */
const evmUsdcChains = Object.fromEntries(Object.entries(USDC).filter(([c]) => isEvmChain(c)).map(([c, t]) => [c, [t]]))

type MockOrder = {
  status: 'awaiting' | 'paid' | 'failed'
  paidAt?: number
  output: Amount
  kind: string
  /** Offramp: the payout method, the amount to send and where, and a masked payout account once given */
  method?: string
  input?: Amount
  payTo?: string
  account?: string
  /** Local chain: the hash the wallet reported */
  txHash?: string
  /** Local chain through OpenRampSettlement: the contract, the calls hash and the block at start */
  settlement?: { contract: string; callsHash: string; fromBlock: string }
  /** Solana local chain: the confirmed slot when the leg started */
  fromSlot?: number
}

const WORK = 18
/** Exact decimal division, `a / b` (test data only) */
function div(a: string, b: string): string {
  return fromScaled((toScaled(a, WORK) * 10n ** BigInt(WORK)) / toScaled(b, WORK), WORK)
}

/** Payout account fields per method. Labels are the provider's own (English). */
function payoutFields(method: string | undefined): FieldSpec[] {
  const name: FieldSpec = { id: 'account_name', label: 'Account holder name', type: 'text', required: true }
  if (!method || method === 'bank_transfer') {
    return [name, { id: 'bank_name', label: 'Bank name', type: 'text', required: true }, { id: 'account_number', label: 'Account number', type: 'text', required: true }]
  }
  if (method === 'promptpay') return [name, { id: 'phone', label: 'PromptPay phone number or ID', type: 'tel', required: true }]
  return [name, { id: 'phone', label: `${method === 'gcash' ? 'GCash' : method === 'momo' ? 'MoMo' : 'E-wallet'} phone number`, type: 'tel', required: true }]
}

/** Test card fields of the `form` card checkout. Labels are the provider's own (English). */
const CARD_FIELDS: FieldSpec[] = [
  { id: 'card_number', label: 'Card number (test: 4242 4242 4242 4242)', type: 'text', required: true },
  { id: 'expiry', label: 'Expiry (MM/YY)', type: 'text', required: true },
  { id: 'cvc', label: 'CVC', type: 'text', required: true },
]
/** The test card number that the `form` card checkout declines */
export const MOCK_DECLINED_CARD = '4000000000000002'

const mask = (v: string) => (v.length <= 4 ? v : `${'*'.repeat(Math.min(6, v.length - 4))}${v.slice(-4)}`)

export function mockAdapter(opts: MockOptions = {}) {
  const settleMs = opts.settleMs ?? 3000
  const name = opts.name ?? 'Test provider'
  const id = opts.id ?? 'mock'
  const fees = { card: 250, local: 100, payin: 70, offramp: 100, crypto: 5, ...opts.feeBps }
  const spread = opts.spreadBps ?? 0
  const cardForm = opts.cardCheckout === 'form'

  const legs: LegSpec[] = [
    {
      id: 'card',
      kind: 'fiat_onramp',
      methods: ['card', 'apple_pay', 'google_pay'],
      from: { asset: { kind: 'fiat', currencies: '*' }, location: ['user_account'] },
      to: { asset: { kind: 'crypto', chains: { 'eip155:8453': [BASE_USDC.token] } }, location: ['address'] },
      regions: { allow: ['*'], deny: [] },
      limits: { min: '10', max: '20000', currency: 'USD' },
      eta: opts.eta?.card ?? { min: 60, max: 300 },
      surfaces: [cardForm ? 'FORM' : 'REDIRECT'],
      requires: ['provider_kyc'],
    },
    {
      id: 'local',
      kind: 'fiat_onramp',
      methods: ['vietqr', 'momo', 'qris', 'gopay', 'dana', 'gcash', 'qrph', 'promptpay', 'duitnow', 'touchngo', 'paynow', 'bank_transfer'],
      from: { asset: { kind: 'fiat', currencies: ['VND', 'IDR', 'PHP', 'THB', 'MYR', 'SGD'] }, location: ['user_account'] },
      to: { asset: { kind: 'crypto', chains: { 'eip155:8453': [BASE_USDC.token] } }, location: ['address'] },
      regions: { allow: ['VN', 'ID', 'PH', 'TH', 'MY', 'SG'], deny: [] },
      limits: { min: '5', max: '3000', currency: 'USD' },
      eta: opts.eta?.local ?? { min: 10, max: 120 },
      surfaces: ['QR'],
      requires: ['provider_kyc'],
    },
    {
      id: 'payin',
      kind: 'fiat_payin',
      methods: ['qris', 'promptpay', 'vietqr', 'qrph', 'duitnow', 'paynow', 'card'],
      from: { asset: { kind: 'fiat', currencies: '*' }, location: ['user_account'] },
      to: { asset: { kind: 'fiat', currencies: '*' }, location: ['merchant_account'] },
      regions: { allow: ['*'], deny: [] },
      eta: opts.eta?.payin ?? { min: 5, max: 60 },
      surfaces: ['QR'],
    },
  ]
  if (opts.crypto) {
    legs.push(
      {
        id: 'wallet',
        kind: 'bridge_swap',
        methods: ['wallet'],
        from: { asset: { kind: 'crypto', chains: '*' }, location: ['user_wallet'] },
        to: { asset: { kind: 'crypto', chains: '*' }, location: ['address'] },
        regions: { allow: ['*'], deny: [] },
        eta: { min: 5, max: 30 },
        surfaces: ['WALLET_TX'],
        requires: ['wallet'],
      },
      {
        id: 'transfer',
        kind: 'bridge_swap',
        methods: opts.exchange ? ['transfer', 'exchange_transfer'] : ['transfer'],
        from: { asset: { kind: 'crypto', chains: '*' }, location: ['user_wallet'] },
        to: { asset: { kind: 'crypto', chains: '*' }, location: ['address'] },
        regions: { allow: ['*'], deny: [] },
        eta: { min: 10, max: 60 },
        surfaces: ['DEPOSIT_ADDRESS'],
      },
    )
  }
  if (opts.bridge) {
    legs.push({
      id: 'bridge',
      kind: 'bridge_swap',
      from: { asset: { kind: 'crypto', chains: usdcChains }, location: ['address'] },
      to: { asset: { kind: 'crypto', chains: '*' }, location: ['address'] },
      regions: { allow: ['*'], deny: [] },
      eta: { min: 5, max: 30 },
      surfaces: ['DEPOSIT_ADDRESS'],
    })
  }
  if (opts.offramp) {
    legs.push({
      id: 'offramp',
      kind: 'crypto_offramp',
      methods: MOCK_PAYOUT_METHODS,
      from: { asset: { kind: 'crypto', chains: evmUsdcChains }, location: ['user_wallet', 'address'] },
      to: { asset: { kind: 'fiat', currencies: Object.keys(USD_PER_UNIT) }, location: ['user_account'] },
      regions: { allow: ['*'], deny: [] },
      limits: { min: '5', max: '5000', currency: 'USD' },
      eta: opts.eta?.offramp ?? { min: 60, max: 900 },
      surfaces: ['FORM', 'WALLET_TX'],
    })
  }

  const local = opts.localChain
  const localAsset: CryptoAsset | undefined = local
    ? { kind: 'crypto', chain: local.chain, token: local.token.toLowerCase(), symbol: local.symbol ?? 'USDC', decimals: local.decimals ?? 6 }
    : undefined
  if (localAsset) {
    const chains = { [localAsset.chain]: [localAsset.token] }
    legs.push({
      id: 'onchain',
      kind: 'bridge_swap',
      methods: ['wallet'],
      from: { asset: { kind: 'crypto', chains }, location: ['user_wallet'] },
      to: { asset: { kind: 'crypto', chains }, location: ['address'] },
      regions: { allow: ['*'], deny: [] },
      eta: { min: 1, max: 30 },
      surfaces: ['WALLET_TX'],
      requires: ['wallet'],
      // `settlement`: with a destination settlement contract, the leg pays with approve + settle.
      capabilities: ['settlement'],
    })
  }

  const sol = opts.solanaLocalChain
  const solAsset: CryptoAsset | undefined = sol
    ? {
        kind: 'crypto',
        chain: sol.chain,
        token: normalizeToken(sol.chain, sol.mint),
        symbol: sol.symbol ?? (sol.mint === 'native' ? 'SOL' : 'USDC'),
        decimals: sol.decimals ?? (sol.mint === 'native' ? nativeDecimals(sol.chain) : 6),
      }
    : undefined
  if (solAsset) {
    const chains = { [solAsset.chain]: [solAsset.token] }
    legs.push({
      id: 'solana-onchain',
      kind: 'bridge_swap',
      methods: ['wallet'],
      from: { asset: { kind: 'crypto', chains }, location: ['user_wallet'] },
      to: { asset: { kind: 'crypto', chains }, location: ['address'] },
      regions: { allow: ['*'], deny: [] },
      eta: { min: 1, max: 30 },
      surfaces: ['WALLET_TX'],
      requires: ['wallet'],
    })
  }

  // Countries and methods narrow the legs.
  if (opts.countries) {
    const only = opts.countries.map((c) => c.toUpperCase())
    for (const l of legs) {
      if (l.kind !== 'fiat_onramp' && l.kind !== 'fiat_payin' && l.kind !== 'crypto_offramp') continue
      l.regions = { ...l.regions, allow: l.regions.allow.includes('*') ? only : l.regions.allow.filter((c) => only.includes(c)) }
    }
  }
  if (opts.methods) {
    const only = new Set(opts.methods)
    for (const l of legs) if (l.methods) l.methods = l.methods.filter((m) => only.has(m))
  }
  for (let i = legs.length - 1; i >= 0; i--) {
    const l = legs[i]!
    if ((l.methods && !l.methods.length) || !l.regions.allow.length) legs.splice(i, 1)
  }

  /** Test FX rate with the spread: the user gets less USD when buying and less fiat when selling. */
  const rateOf = (fiat: string, side: 'buy' | 'sell'): string | undefined => {
    const r = USD_PER_UNIT[fiat]
    if (!r || !spread) return r
    return side === 'buy' ? sub(r, bps(r, spread)) : add(r, bps(r, spread))
  }

  const webhookSuffix = `/webhooks/${id}`
  const baseOf = (ctx: AdapterContext) => (ctx.urls.webhookUrl.endsWith(webhookSuffix) ? ctx.urls.webhookUrl.slice(0, -webhookSuffix.length) : ctx.urls.webhookUrl)
  const orderKey = (ref: string) => `order:${ref}`

  const fakeAddress = (seed: string) => fakeAddressFor('eip155:1', seed)

  function destAsset(ctx: AdapterContext): CryptoAsset {
    const d = ctx.destination
    if (d.type !== 'crypto') return BASE_USDC
    return { kind: 'crypto', chain: d.chain, token: d.token, symbol: d.symbol ?? 'USDC', decimals: d.decimals ?? 6 }
  }

  async function settled(ref: string, ctx: Pick<AdapterContext, 'shared'>): Promise<LegStep | undefined> {
    const o = await ctx.shared.get<MockOrder>(orderKey(ref))
    if (!o) return undefined
    if (o.status === 'failed') return { state: 'FAILED', status: 'failed', transitions: [], error: orkError('PAYMENT_FAILED'), ref }
    if (o.status === 'paid' && o.paidAt && Date.now() - o.paidAt >= settleMs) {
      return { state: 'COMPLETED', status: 'succeeded', transitions: [], output: o.output, ref, txHash: `0x${ref.replace(/[^0-9a-f]/g, '').padEnd(64, '0').slice(0, 64)}` }
    }
    if (o.status === 'paid') return { state: 'PROCESSING', sub: 'SETTLING', status: 'processing', transitions: [awaitPoll(POLL)], ref }
    return undefined
  }

  /** The offramp's user step: the payout account form, then the USDC transfer to the provider. */
  function offrampStep(ref: string, o: MockOrder): LegStep {
    if (!o.account) {
      return {
        state: 'PAYMENT', sub: 'PAYOUT_ACCOUNT', status: 'awaiting_user', ref,
        surface: { kind: 'FORM', fields: payoutFields(o.method) },
        transitions: [{ name: 'submit_details', kind: 'SUBMIT', label: 'Continue' }],
      }
    }
    const input = o.input ?? { amount: '0', asset: BASE_USDC }
    const asset = input.asset.kind === 'crypto' ? input.asset : BASE_USDC
    const tx: TxRequest = { to: asset.token, data: erc20TransferData(o.payTo ?? fakeAddress(ref), toBaseUnits(input.amount, asset.decimals ?? 6)), value: '0', chainId: evmChainId(asset.chain) ?? 8453 }
    return {
      state: 'PAYMENT', sub: 'SEND_CRYPTO', status: 'awaiting_user', ref,
      surface: { kind: 'WALLET_TX', chain: asset.chain, txs: [tx] },
      transitions: [{ name: 'submit_tx', kind: 'SURFACE_RESULT', expects: 'tx_hash' }],
    }
  }

  /** The card leg's user step with `cardCheckout: 'form'`: test card fields in the widget. */
  function cardFormStep(ref: string): LegStep {
    return {
      state: 'PAYMENT', sub: 'CARD_DETAILS', status: 'awaiting_user', ref,
      surface: { kind: 'FORM', fields: CARD_FIELDS },
      transitions: [{ name: 'pay_card', kind: 'SUBMIT', label: 'Pay (test mode)' }],
    }
  }

  /**
   * The local chain leg's user step: one ERC-20 transfer to the destination address, or, with a
   * settlement contract, `approve` + `settle` for this session.
   */
  function localStep(ref: string, o: MockOrder, ctx: Pick<AdapterContext, 'session' | 'destination'>): LegStep {
    const asset = localAsset!
    const amount = BigInt(toBaseUnits(o.input!.amount, asset.decimals ?? 6))
    const chainId = evmChainId(asset.chain)!
    const calls = ctx.destination.type === 'crypto' ? settlementCallsFrom(ctx.destination.calls) : []
    const txs: TxRequest[] = o.settlement
      ? buildSettlementTxs({ chainId, contract: o.settlement.contract, sessionId: ctx.session.id, token: asset.token, amount, recipient: o.payTo!, calls })
      : [{ to: asset.token, data: erc20TransferData(o.payTo!, amount.toString()), value: '0', chainId }]
    return {
      state: 'PAYMENT', sub: 'SEND_CRYPTO', status: 'awaiting_user', ref,
      surface: { kind: 'WALLET_TX', chain: asset.chain, txs },
      // With a settlement, a poll also finds a session that the contract already settled.
      transitions: [{ name: 'submit_tx', kind: 'SURFACE_RESULT', expects: 'tx_hash' }, ...(o.settlement ? [awaitPoll(POLL)] : [])],
    }
  }

  /**
   * The settlement leg completes when the contract has a receipt for this session that pays the
   * recipient the quoted amount with the session's calls. The session id is the proof, not the hash.
   */
  async function verifyLocalSettlement(ref: string, o: MockOrder, ctx: Pick<AdapterContext, 'fetch' | 'log' | 'session' | 'destination'>): Promise<LegStep> {
    const asset = localAsset!
    const s = o.settlement!
    const fail = (message: string, txHash?: string): LegStep => ({
      state: 'FAILED', status: 'failed', transitions: [], error: orkError('PAYMENT_FAILED', { message }), ref, ...(txHash ? { txHash } : {}),
    })
    const r = await verifySettlement({
      rpcUrl: local!.rpcUrl,
      contract: s.contract,
      sessionId: ctx.session.id,
      fetch: ctx.fetch,
      log: ctx.log,
      fromBlock: s.fromBlock,
      expect: { token: asset.token, recipient: o.payTo!, minAmount: BigInt(toBaseUnits(o.input!.amount, asset.decimals ?? 6)), callsHash: s.callsHash },
    })
    if (r.settled) {
      if (!r.ok) return fail(r.problem!, r.record.txHash)
      return { state: 'COMPLETED', status: 'succeeded', transitions: [], output: o.output, ref, txHash: r.record.txHash }
    }
    if (!o.txHash) return localStep(ref, o, ctx)
    const receipt = await evmRpc<EvmReceipt | null>(ctx.fetch, local!.rpcUrl, 'eth_getTransactionReceipt', [o.txHash], { log: ctx.log })
    if (!receipt) return { state: 'PROCESSING', sub: 'CONFIRMING', status: 'processing', ref, txHash: o.txHash, transitions: [awaitPoll(POLL)] }
    if (receipt.status !== '0x1') return fail('The transaction failed on chain.', o.txHash)
    return fail('The transaction did not settle this session.', o.txHash)
  }

  /** The local chain leg completes only when the receipt pays the destination at least the quoted amount. */
  async function verifyLocal(ref: string, o: MockOrder, ctx: Pick<AdapterContext, 'fetch' | 'log' | 'shared'>): Promise<LegStep> {
    const asset = localAsset!
    const txHash = o.txHash!
    const receipt = await evmRpc<EvmReceipt | null>(ctx.fetch, local!.rpcUrl, 'eth_getTransactionReceipt', [txHash], { log: ctx.log })
    if (!receipt) return { state: 'PROCESSING', sub: 'CONFIRMING', status: 'processing', ref, txHash, transitions: [awaitPoll(POLL)] }
    const fail = (message: string): LegStep => ({ state: 'FAILED', status: 'failed', transitions: [], error: orkError('PAYMENT_FAILED', { message }), ref, txHash })
    if (receipt.status !== '0x1') return fail('The transaction failed on chain.')
    if (erc20PaidTo(receipt, asset.token, o.payTo!) < BigInt(toBaseUnits(o.input!.amount, asset.decimals ?? 6))) {
      return fail('The transaction does not pay the destination the quoted amount.')
    }
    // One transaction completes one payment only.
    const usedKey = `txused:${asset.chain}:${txHash.toLowerCase()}`
    const usedBy = await ctx.shared.get<string>(usedKey)
    if (usedBy && usedBy !== ref) return fail('This transaction was already used for another payment.')
    if (!usedBy) await ctx.shared.put(usedKey, ref, ORDER_TTL_SEC)
    return { state: 'COMPLETED', status: 'succeeded', transitions: [], output: o.output, ref, txHash }
  }

  /** The Solana leg's user step: one transfer of the mint to the destination owner address. */
  function solanaStep(ref: string, o: MockOrder): LegStep {
    const asset = solAsset!
    const decimals = asset.decimals ?? 6
    const tx: TxRequest = { kind: 'solana', type: 'transfer', to: o.payTo!, mint: asset.token, amount: toBaseUnits(o.input!.amount, decimals), decimals }
    return {
      state: 'PAYMENT', sub: 'SEND_CRYPTO', status: 'awaiting_user', ref,
      surface: { kind: 'WALLET_TX', chain: asset.chain, txs: [tx] },
      transitions: [{ name: 'submit_tx', kind: 'SURFACE_RESULT', expects: 'tx_hash' }],
    }
  }

  /**
   * The Solana leg completes only when the signature is confirmed without error, is not older than
   * the leg, moves at least the quoted amount to the destination, and did not complete another payment.
   */
  async function verifySolana(ref: string, o: MockOrder, ctx: Pick<AdapterContext, 'fetch' | 'log' | 'shared'>): Promise<LegStep> {
    const asset = solAsset!
    const sig = o.txHash!
    const rpc = <T>(method: string, params: unknown[]) => evmRpc<T>(ctx.fetch, sol!.rpcUrl, method, params, { log: ctx.log })
    const waiting: LegStep = { state: 'PROCESSING', sub: 'CONFIRMING', status: 'processing', ref, txHash: sig, transitions: [awaitPoll(POLL)] }
    const fail = (message: string): LegStep => ({ state: 'FAILED', status: 'failed', transitions: [], error: orkError('PAYMENT_FAILED', { message }), ref, txHash: sig })
    // One signature completes one payment only. Solana signatures are case-sensitive.
    const usedKey = `txused:${asset.chain}:${sig}`
    const usedBy = await ctx.shared.get<string>(usedKey)
    if (usedBy && usedBy !== ref) return fail('This transaction was already used for another payment.')
    const st = await rpc<{ value?: SolanaSignatureStatus[] } | null>('getSignatureStatuses', [[sig], { searchTransactionHistory: true }])
    const s = st?.value?.[0]
    if (!s) return waiting
    if (s.err) return fail('The transaction failed on chain.')
    if (s.confirmationStatus !== 'confirmed' && s.confirmationStatus !== 'finalized') return waiting
    const tx = await rpc<SolanaParsedTx | null>('getTransaction', [sig, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }])
    if (!tx?.meta) return waiting
    if (tx.meta.err) return fail('The transaction failed on chain.')
    // Only a transaction from after the start of this leg can pay it.
    if (o.fromSlot !== undefined && (typeof tx.slot !== 'number' || tx.slot < o.fromSlot)) return fail('The transaction was sent before this payment started.')
    if (solanaPaidTo(tx, o.payTo!, asset.token) < BigInt(toBaseUnits(o.input!.amount, asset.decimals ?? 6))) {
      return fail('The transaction does not pay the destination the quoted amount.')
    }
    if (!usedBy) await ctx.shared.put(usedKey, ref, ORDER_TTL_SEC)
    return { state: 'COMPLETED', status: 'succeeded', transitions: [], output: o.output, ref, txHash: sig }
  }

  return createAdapter({
    id,
    name,
    legs,

    async quote({ leg, amountIn, amountOut }, ctx): Promise<LegQuote> {
      refuseLive(ctx)
      const spec = legs.find((l) => l.id === leg.legId)
      if (!spec) throw unknownLeg(leg.legId)
      const now = Date.now()
      const expiresAt = new Date(now + 60_000).toISOString()
      if (spec.kind === 'crypto_offramp') {
        // USDC in, fiat out: 1 USDC = 1 USD, minus 1%.
        const fiat = (leg.to.asset.kind === 'fiat' ? leg.to.asset.currency : ctx.destination.type === 'fiat' ? ctx.destination.currency : 'USD').toUpperCase()
        const rate = rateOf(fiat, 'sell')
        if (!rate) throw new OrkException(orkError('NO_QUOTES', { message: `${name} has no rate for ${fiat}.` }), 422)
        const inAsset: CryptoAsset = amountIn?.asset.kind === 'crypto' ? amountIn.asset : leg.from.asset.kind === 'crypto' ? leg.from.asset : BASE_USDC
        const usdc = amountIn ? amountIn.amount : roundTo(div(mulRatio(amountOut?.amount ?? '0', rate), String((10_000 - fees.offramp) / 10_000)), 6)
        const fee = roundTo(bps(usdc, fees.offramp), 6)
        const out = roundTo(div(sub(usdc, fee), rate), minorUnits(fiat))
        return {
          adapterId: id, legId: leg.legId,
          input: { amount: usdc, asset: { ...inAsset, symbol: 'USDC', decimals: 6 } },
          output: { amount: out.startsWith('-') ? '0' : out, asset: { kind: 'fiat', currency: fiat } },
          fees: [{ kind: 'provider', label: `${name} fee`, amount: fee, currency: 'USDC' }],
          eta: spec.eta, expiresAt,
        }
      }
      if (spec.kind === 'fiat_onramp' || spec.kind === 'fiat_payin') {
        const fiat = (amountIn?.asset.kind === 'fiat' ? amountIn.asset.currency : leg.from.asset.kind === 'fiat' ? leg.from.asset.currency : 'USD').toUpperCase()
        const rate = rateOf(fiat, 'buy')
        if (!rate) throw new OrkException(orkError('NO_QUOTES', { message: `${name} has no rate for ${fiat}.` }), 422)
        const input = amountIn?.amount ?? '0'
        const feePct = spec.id === 'card' ? fees.card : fees.local
        if (spec.kind === 'fiat_payin') {
          const fee = roundTo(bps(input, fees.payin), minorUnits(fiat))
          return {
            adapterId: id, legId: leg.legId,
            input: { amount: input, asset: { kind: 'fiat', currency: fiat } },
            output: { amount: roundTo(sub(input, fee), minorUnits(fiat)), asset: { kind: 'fiat', currency: fiat } },
            fees: [{ kind: 'provider', label: `${name} fee`, amount: fee, currency: fiat }],
            eta: spec.eta, expiresAt,
          }
        }
        const usd = mulRatio(input, rate)
        const fee = bps(usd, feePct)
        const out = roundTo(sub(usd, fee), 6)
        return {
          adapterId: id, legId: leg.legId,
          input: { amount: input, asset: { kind: 'fiat', currency: fiat } },
          output: { amount: out.startsWith('-') ? '0' : out, asset: leg.to.asset.kind === 'crypto' ? { ...BASE_USDC, ...leg.to.asset, symbol: 'USDC', decimals: 6 } : BASE_USDC },
          fees: [{ kind: 'provider', label: `${name} fee`, amount: roundTo(mulRatio(fee, String(1 / Number(rate))), minorUnits(fiat)), currency: fiat }],
          eta: spec.eta, expiresAt,
        }
      }
      if (spec.id === 'solana-onchain' && solAsset) {
        // A plain transfer on the cluster: what the user sends arrives.
        const amount = amountIn?.amount ?? amountOut?.amount ?? '0'
        return { adapterId: id, legId: leg.legId, input: { amount, asset: solAsset }, output: { amount, asset: solAsset }, fees: [], eta: spec.eta, expiresAt }
      }
      if (spec.id === 'onchain' && localAsset) {
        // A plain transfer on the local chain: what the user sends arrives.
        const amount = amountIn?.amount ?? amountOut?.amount ?? '0'
        return {
          adapterId: id, legId: leg.legId,
          input: { amount, asset: localAsset },
          output: { amount, asset: localAsset },
          fees: [],
          eta: spec.eta, expiresAt,
        }
      }
      // crypto legs: 1:1 minus 5 bps
      const input = amountIn?.amount ?? amountOut?.amount ?? '0'
      const fee = bps(input, fees.crypto)
      const inAsset = amountIn?.asset.kind === 'crypto' ? amountIn.asset : BASE_USDC
      return {
        adapterId: id, legId: leg.legId,
        input: { amount: input, asset: { ...inAsset, symbol: symbolOf(inAsset), decimals: inAsset.decimals ?? (symbolOf(inAsset) === 'USDC' ? 6 : nativeDecimals(inAsset.chain)) } },
        output: { amount: roundTo(sub(input, fee), 6), asset: destAsset(ctx) },
        fees: [{ kind: 'network', label: 'Network and bridge', amount: roundTo(fee, 6), currency: 'USDC' }],
        eta: spec.eta, expiresAt,
        ...(leg.legId === 'transfer' ? { data: { anyAmount: true } } : {}),
      }
    },

    async prepareDeposit({ leg }, ctx) {
      return { address: fakeAddress(`${ctx.session.id}:${leg.legId}:deposit`) }
    },

    async start({ leg, quote, deliverTo }, ctx): Promise<LegStep> {
      refuseLive(ctx)
      const ref = `mock_${ctx.session.id.slice(4, 14)}_${leg.legId}_${Date.now().toString(36)}`
      const order: MockOrder = { status: 'awaiting', output: quote.output, kind: leg.legId }
      await ctx.shared.put(orderKey(ref), order, ORDER_TTL_SEC)
      const base = baseOf(ctx)
      switch (leg.legId) {
        case 'card':
          if (cardForm) return cardFormStep(ref)
          return {
            state: 'PAYMENT', status: 'awaiting_user', ref,
            surface: { kind: 'REDIRECT', url: `${base}/adapters/${id}/checkout?ref=${encodeURIComponent(ref)}&amount=${quote.input.amount}&currency=${quote.input.asset.kind === 'fiat' ? quote.input.asset.currency : ''}&to=${encodeURIComponent(deliverTo?.address ?? '')}`, popup: true, provider: name },
            transitions: [awaitPoll(POLL)],
          }
        case 'local':
        case 'payin': {
          const cur = quote.input.asset.kind === 'fiat' ? quote.input.asset.currency : 'USD'
          return {
            state: 'PAYMENT', status: 'awaiting_user', ref,
            surface: { kind: 'QR', payload: `MOCKQR|${ref}|${quote.input.amount}|${cur}`, amount: quote.input.amount, currency: cur, reference: ref.slice(-10).toUpperCase(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() },
            transitions: [
              { name: 'simulate_payment', kind: 'SUBMIT', label: 'Simulate payment (test mode)' },
              awaitPoll(POLL),
            ],
          }
        }
        case 'wallet': {
          const d = destAsset(ctx)
          const src = quote.input.asset.kind === 'crypto' ? quote.input.asset : d
          // Solana: a transfer of the input token to a fake address (or the destination on the same chain).
          const tx: TxRequest = isSolanaChain(src.chain)
            ? {
                kind: 'solana', type: 'transfer',
                to: deliverTo?.address && isSolanaChain(d.chain) ? deliverTo.address : fakeAddressFor(src.chain, ref),
                mint: src.token === 'native' ? 'native' : src.token,
                amount: toBaseUnits(quote.input.amount, src.decimals ?? nativeDecimals(src.chain)),
                decimals: src.decimals ?? nativeDecimals(src.chain),
              }
            : { to: deliverTo?.address ?? fakeAddress(ref), data: '0x', value: '0', chainId: evmChainId(src.chain) ?? 8453 }
          return {
            state: 'PAYMENT', status: 'awaiting_user', ref,
            surface: { kind: 'WALLET_TX', chain: src.chain, txs: [tx] },
            transitions: [{ name: 'submit_tx', kind: 'SURFACE_RESULT', expects: 'tx_hash' }],
          }
        }
        case 'transfer': {
          const src = quote.input.asset.kind === 'crypto' ? quote.input.asset : BASE_USDC
          const address = fakeAddressFor(src.chain, `${ctx.session.userId}:${src.chain}:${src.token}`)
          const warning = leg.method === 'exchange_transfer'
            ? `In your exchange, withdraw ${symbolOf(src)} and choose the ${chainName(src.chain)} network. This is a test address.`
            : `Send only ${symbolOf(src)} on ${chainName(src.chain)}. This is a test address.`
          return {
            state: 'PAYMENT', status: 'awaiting_user', ref,
            surface: { kind: 'DEPOSIT_ADDRESS', chain: src.chain, chainName: chainName(src.chain), token: src.token, symbol: symbolOf(src), address, min: '1', warning },
            transitions: [
              { name: 'simulate_deposit', kind: 'SUBMIT', label: 'Simulate deposit (test mode)' },
              awaitPoll(POLL),
            ],
          }
        }
        case 'onchain': {
          const recipient = deliverTo?.address ?? (ctx.destination.type === 'crypto' ? ctx.destination.address : undefined)
          if (!recipient) throw new OrkException(orkError('BAD_REQUEST', { message: 'The local chain leg needs a destination address.' }), 400)
          const d = ctx.destination
          let settlement: MockOrder['settlement']
          if (d.type === 'crypto' && d.settlement) {
            // Only blocks from now on can hold this session's settlement.
            const fromBlock = await evmRpc<string>(ctx.fetch, local!.rpcUrl, 'eth_blockNumber', [], { log: ctx.log })
            settlement = { contract: d.settlement.contract, callsHash: hashSettlementCalls(settlementCallsFrom(d.calls)), fromBlock }
          }
          const o: MockOrder = { ...order, input: quote.input, payTo: recipient, ...(settlement ? { settlement } : {}) }
          await ctx.shared.put(orderKey(ref), o, ORDER_TTL_SEC)
          return localStep(ref, o, ctx)
        }
        case 'solana-onchain': {
          const recipient = deliverTo?.address ?? (ctx.destination.type === 'crypto' ? ctx.destination.address : undefined)
          if (!recipient) throw new OrkException(orkError('BAD_REQUEST', { message: 'The Solana leg needs a destination address.' }), 400)
          // Only slots from now on can hold the payment.
          const fromSlot = await evmRpc<number>(ctx.fetch, sol!.rpcUrl, 'getSlot', [{ commitment: 'confirmed' }], { log: ctx.log })
          const o: MockOrder = { ...order, input: quote.input, payTo: recipient, ...(typeof fromSlot === 'number' ? { fromSlot } : {}) }
          await ctx.shared.put(orderKey(ref), o, ORDER_TTL_SEC)
          return solanaStep(ref, o)
        }
        case 'offramp': {
          const offer: MockOrder = { ...order, ...(leg.method ? { method: leg.method } : {}), input: quote.input, payTo: fakeAddress(`offramp:${ref}`) }
          await ctx.shared.put(orderKey(ref), offer, ORDER_TTL_SEC)
          return offrampStep(ref, offer)
        }
        case 'bridge': {
          // The previous leg delivers into the deposit address; treat it as paid now.
          await ctx.shared.put(orderKey(ref), { ...order, status: 'paid', paidAt: Date.now() }, ORDER_TTL_SEC)
          return { state: 'PROCESSING', sub: 'BRIDGING', status: 'processing', ref, transitions: [awaitPoll(POLL)] }
        }
      }
      throw unknownLeg(leg.legId)
    },

    async transition({ ref, name: t, inputs }, ctx): Promise<LegStep> {
      const o = await ctx.shared.get<MockOrder>(orderKey(ref))
      if (!o) throw new OrkException(orkError('NOT_FOUND', { message: 'Unknown mock order.' }), 404)
      if (o.kind === 'offramp' && t === 'submit_details') {
        if (o.status !== 'awaiting') throw new OrkException(orkError('BAD_REQUEST', { message: 'The payout account is already set.' }), 409)
        const v = (id: string) => (typeof inputs?.[id] === 'string' ? (inputs[id] as string).trim() : '')
        for (const f of payoutFields(o.method)) {
          if (!v(f.id)) throw new OrkException(orkError('BAD_REQUEST', { message: `Enter the ${f.label.toLowerCase()}.` }), 400)
        }
        const acct = v('account_number') || v('phone')
        if (v('phone') && !/^\+?[0-9 ()-]{7,20}$/.test(v('phone'))) throw new OrkException(orkError('BAD_REQUEST', { message: 'Enter a valid phone number.' }), 400)
        if (v('account_number') && !/^[0-9A-Za-z -]{4,34}$/.test(v('account_number'))) throw new OrkException(orkError('BAD_REQUEST', { message: 'Enter a valid account number.' }), 400)
        const next: MockOrder = { ...o, account: mask(acct.replace(/\D/g, '') || acct) }
        await ctx.shared.put(orderKey(ref), next, ORDER_TTL_SEC)
        return offrampStep(ref, next)
      }
      if (o.kind === 'solana-onchain') {
        if (t !== 'submit_tx') throw new OrkException(orkError('BAD_REQUEST', { message: `Transition ${t} is not supported.` }), 409)
        const sig = typeof inputs?.txHash === 'string' ? inputs.txHash : ''
        if (!isSolanaSignature(sig)) throw new OrkException(orkError('BAD_REQUEST', { message: 'Send a valid Solana transaction signature.' }), 400)
        const next: MockOrder = { ...o, txHash: sig }
        await ctx.shared.put(orderKey(ref), next, ORDER_TTL_SEC)
        return verifySolana(ref, next, ctx)
      }
      if (o.kind === 'onchain') {
        if (t !== 'submit_tx') throw new OrkException(orkError('BAD_REQUEST', { message: `Transition ${t} is not supported.` }), 409)
        const txHash = typeof inputs?.txHash === 'string' ? inputs.txHash : ''
        if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new OrkException(orkError('BAD_REQUEST', { message: 'Send a valid transaction hash.' }), 400)
        const next: MockOrder = { ...o, txHash }
        await ctx.shared.put(orderKey(ref), next, ORDER_TTL_SEC)
        return next.settlement ? verifyLocalSettlement(ref, next, ctx) : verifyLocal(ref, next, ctx)
      }
      if (o.kind === 'card' && t === 'pay_card') {
        if (!cardForm) throw new OrkException(orkError('BAD_REQUEST', { message: `Transition ${t} is not supported.` }), 409)
        if (o.status !== 'awaiting') throw new OrkException(orkError('BAD_REQUEST', { message: 'This card payment is already sent.' }), 409)
        const v = (k: string) => (typeof inputs?.[k] === 'string' ? (inputs[k] as string).replace(/\s+/g, '') : '')
        if (!/^[0-9]{12,19}$/.test(v('card_number'))) throw new OrkException(orkError('BAD_REQUEST', { message: 'Enter a valid card number.' }), 400)
        if (!/^(0[1-9]|1[0-2])\/?[0-9]{2}$/.test(v('expiry'))) throw new OrkException(orkError('BAD_REQUEST', { message: 'Enter the expiry as MM/YY.' }), 400)
        if (!/^[0-9]{3,4}$/.test(v('cvc'))) throw new OrkException(orkError('BAD_REQUEST', { message: 'Enter a valid CVC.' }), 400)
        if (v('card_number') === MOCK_DECLINED_CARD) {
          await ctx.shared.put(orderKey(ref), { ...o, status: 'failed' }, ORDER_TTL_SEC)
          return { state: 'FAILED', status: 'failed', transitions: [], error: orkError('PAYMENT_FAILED', { message: 'The test card was declined.' }), ref }
        }
        await ctx.shared.put(orderKey(ref), { ...o, status: 'paid', paidAt: Date.now() }, ORDER_TTL_SEC)
        return { state: 'PROCESSING', sub: 'SETTLING', status: 'processing', ref, transitions: [awaitPoll(POLL)] }
      }
      if (o.kind === 'offramp' && t === 'submit_tx' && !o.account) {
        throw new OrkException(orkError('BAD_REQUEST', { message: 'Enter the payout account first.' }), 409)
      }
      if (t === 'simulate_payment' || t === 'simulate_deposit' || t === 'submit_tx') {
        await ctx.shared.put(orderKey(ref), { ...o, status: 'paid', paidAt: Date.now() }, ORDER_TTL_SEC)
        return {
          state: 'PROCESSING', sub: 'SETTLING', status: 'processing', ref,
          transitions: [awaitPoll(POLL)],
          ...(typeof inputs?.txHash === 'string' ? { txHash: inputs.txHash } : {}),
        }
      }
      throw new OrkException(orkError('BAD_REQUEST', { message: `Transition ${t} is not supported.` }), 409)
    },

    async status({ ref }, ctx): Promise<LegStep> {
      const pending = await ctx.shared.get<MockOrder>(orderKey(ref))
      if (pending?.kind === 'solana-onchain') return pending.txHash ? verifySolana(ref, pending, ctx) : solanaStep(ref, pending)
      if (pending?.kind === 'onchain') {
        if (pending.settlement) return verifyLocalSettlement(ref, pending, ctx)
        return pending.txHash ? verifyLocal(ref, pending, ctx) : localStep(ref, pending, ctx)
      }
      const done = await settled(ref, ctx)
      if (done) return done
      const o = await ctx.shared.get<MockOrder>(orderKey(ref))
      if (o?.kind === 'offramp') return offrampStep(ref, o)
      if (o?.kind === 'card' && cardForm && o.status === 'awaiting') return cardFormStep(ref)
      return { state: 'PAYMENT', status: 'awaiting_user', ref, transitions: [awaitPoll(POLL)] }
    },

    async routes(req, subpath, ctx) {
      const url = new URL(req.url)
      const ref = url.searchParams.get('ref') ?? ''
      if (subpath === 'checkout' && req.method === 'GET') {
        const amount = escapeHtml(url.searchParams.get('amount') ?? '')
        const currency = escapeHtml(url.searchParams.get('currency') ?? '')
        return new Response(checkoutPage(escapeHtml(name), amount, currency, escapeHtml(ref), `${ctx.baseUrl}/adapters/${id}/pay`), { headers: { 'content-type': 'text/html; charset=utf-8' } })
      }
      if (subpath === 'pay' && req.method === 'POST') {
        const form = await req.formData()
        const r = String(form.get('ref') ?? '')
        const outcome = String(form.get('outcome') ?? 'success')
        const o = await ctx.shared.get<MockOrder>(orderKey(r))
        if (!o) return new Response('Unknown order', { status: 404 })
        if (outcome === 'fail') {
          await ctx.shared.put(orderKey(r), { ...o, status: 'failed' }, ORDER_TTL_SEC)
          await ctx.applyEvent({ ref: r, status: 'failed', error: orkError('PAYMENT_FAILED') } satisfies LegEvent)
        } else {
          await ctx.shared.put(orderKey(r), { ...o, status: 'paid', paidAt: Date.now() }, ORDER_TTL_SEC)
          await ctx.applyEvent({ ref: r, status: 'processing' })
        }
        return new Response(donePage(outcome !== 'fail'), { headers: { 'content-type': 'text/html; charset=utf-8' } })
      }
      return undefined
    },
  })
}

/**
 * The mock moves no money, and anyone who knows an order ref can mark it paid on the checkout page.
 * So it never runs in a live session: a live app must not credit a mock payment.
 */
function refuseLive(ctx: AdapterContext) {
  if (ctx.session.livemode) throw new OrkException(orkError('PROVIDER_UNAVAILABLE', { message: 'The mock provider is for test mode only.' }), 503)
}

function unknownLeg(legId: string) {
  return new OrkException(orkError('NOT_FOUND', { message: `Unknown mock leg ${legId}` }), 404)
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function checkoutPage(name: string, amount: string, currency: string, ref: string, action: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name} checkout</title>
<style>body{font-family:system-ui,sans-serif;background:#f4f5f7;margin:0;display:grid;place-items:center;min-height:100vh}
.card{background:#fff;border-radius:16px;padding:28px;width:min(360px,90vw);box-shadow:0 8px 30px rgba(0,0,0,.08)}
h1{font-size:18px;margin:0 0 4px}.muted{color:#667;font-size:13px}.amt{font-size:32px;font-weight:700;margin:18px 0}
input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #ccd;border-radius:8px;margin:4px 0 10px;font-size:15px}
button{width:100%;padding:12px;border:0;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;margin-top:6px}
.pay{background:#2744c4;color:#fff}.fail{background:#eee;color:#333}.badge{display:inline-block;background:#fff4d6;color:#8a5a00;font-size:12px;padding:2px 8px;border-radius:99px}</style></head>
<body><div class="card"><span class="badge">Test mode</span><h1>${name}</h1><div class="muted">Mock card checkout. No money moves.</div>
<div class="amt">${amount} ${currency}</div>
<label class="muted">Card number<input value="4242 4242 4242 4242" readonly></label>
<form method="post" action="${action}"><input type="hidden" name="ref" value="${ref}"><input type="hidden" name="outcome" value="success"><button class="pay" type="submit">Pay ${amount} ${currency}</button></form>
<form method="post" action="${action}"><input type="hidden" name="ref" value="${ref}"><input type="hidden" name="outcome" value="fail"><button class="fail" type="submit">Decline payment</button></form>
</div></body></html>`
}

function donePage(ok: boolean) {
  return `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px;text-align:center"><h2>${ok ? 'Payment received' : 'Payment declined'}</h2><p>You can close this tab and go back to the app.</p><script>setTimeout(()=>window.close(),1200)</script>`
}
