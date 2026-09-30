// Relay adapter: crypto bridge and swap legs (https://docs.relay.link).
//
// Legs:
// - `wallet`   The user's connected wallet signs Relay's transaction steps (WALLET_TX).
// - `transfer` The user sends any amount to a Relay open deposit address (DEPOSIT_ADDRESS).
// - `bridge`   Hop leg after an onramp: the onramp delivers USDC into a Relay open deposit
//              address, and Relay moves it to the destination chain and token.
//
// Server-side only. Web-standard APIs only (fetch, WebCrypto), so it runs on Cloudflare Workers.

import { ERC20_TRANSFER_TOPIC, POLL, awaitPoll, createAdapter, erc20PaidTo, erc20TransferData, evmRpc, fetchJson, httpErrorToOrk, randomHex, topicAddress } from '@openrampkit/adapter'
import type { AdapterContext, EvmReceipt, Logger, QuoteInput, StartInput } from '@openrampkit/adapter'
import {
  CHAINS,
  OrkException,
  USDC,
  chainName,
  cmp,
  evmChainId,
  fromBaseUnits,
  orkError,
  toBaseUnits,
} from '@openrampkit/core'
import type { Amount, CryptoAsset, Fee, LegQuote, LegSpec, LegStep, PollSpec, TxRequest } from '@openrampkit/core'

export type RelayOptions = {
  /** Relay API key (x-api-key). Needed for GET /requests/v3 and higher rate limits. */
  apiKey?: string
  /** Default https://api.relay.link. Testnets: https://api.testnets.relay.link */
  baseUrl?: string
  /** App fee in basis points, paid to `recipient` (accrues as a claimable balance at Relay) */
  appFee?: { bps: number; recipient: string }
  /** Relay `referrer` string, for attribution */
  referrer?: string
  /**
   * Where Relay refunds failed deposit-address requests.
   * 'origin' (default) sends the origin chain's native-currency address, which turns on
   * automatic refund to the original sender. Or pass an explicit address.
   */
  refundTo?: 'origin' | string
  /**
   * JSON-RPC URLs per CAIP-2 chain, used to verify same-chain, same-token moves on chain
   * (Relay is not involved there). Defaults to public RPCs for the main chains; set your own
   * for production. A chain without an RPC URL cannot use same-chain moves.
   */
  rpcUrls?: Record<string, string>
}

/** Public RPCs for on-chain verification. Rate-limited: use your own in production. */
export const DEFAULT_RPC_URLS: Record<string, string> = {
  'eip155:1': 'https://ethereum-rpc.publicnode.com',
  'eip155:8453': 'https://mainnet.base.org',
  'eip155:42161': 'https://arb1.arbitrum.io/rpc',
  'eip155:10': 'https://mainnet.optimism.io',
  'eip155:137': 'https://polygon-rpc.com',
}

/** Allowed difference between our clock and block timestamps when a direct payment checks its tx age */
const DIRECT_TX_CLOCK_SKEW_MS = 5 * 60_000

export const RELAY_SOLANA_CHAIN_ID = 792703809
const SOLANA_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
const EVM_NATIVE = '0x0000000000000000000000000000000000000000'
const SOLANA_NATIVE = '11111111111111111111111111111111'
/** Relay accepts any address as `user` for quotes; used when no wallet is connected yet. */
const PLACEHOLDER_USER = '0x000000000000000000000000000000000000dEaD'
const DEPOSIT_ADDRESS_TTL_SEC = 24 * 60 * 60
const WALLET_QUOTE_REUSE_MS = 20_000
const WALLET_QUOTE_TTL_MS = 60_000

export const RELAY_POLL: PollSpec = POLL.onchain
const RECORD_TTL_SEC = 7 * 24 * 60 * 60

const HOP_CHAINS = ['eip155:8453', 'eip155:42161', 'eip155:10', 'eip155:137', 'eip155:1'] as const

// ---------------- Relay API types (only the fields we read) ----------------

type RelayCurrency = { chainId: number; address: string; symbol: string; decimals: number }
type RelayAmount = { currency: RelayCurrency; amount: string; amountFormatted?: string }
type RelayStepItem = { status?: string; data?: { from?: string; to: string; data?: string; value?: string; chainId: number; gas?: string } }
type RelayStep = { id: string; kind: 'transaction' | 'signature' | string; items?: RelayStepItem[]; requestId?: string; depositAddress?: string }
export type RelayQuoteResponse = {
  requestId?: string
  steps: RelayStep[]
  fees?: Partial<Record<'gas' | 'relayer' | 'app', RelayAmount>>
  details?: { currencyIn?: RelayAmount; currencyOut?: RelayAmount; timeEstimate?: number }
}
type RelayIntentStatus = { status: string; details?: string; inTxHashes?: string[]; txHashes?: string[] }
type RelayTx = { hash?: string; txHash?: string; chainId?: number }
type RelayRequest = {
  id: string
  status: string
  createdAt: string
  data?: {
    outTxs?: RelayTx[]
    inTxs?: RelayTx[]
    failReason?: string | null
    metadata?: { currencyOut?: RelayAmount }
    route?: { actual?: { destination?: { outputCurrency?: RelayAmount } }; quoted?: { destination?: { outputCurrency?: RelayAmount } } }
  }
}

// ---------------- helpers ----------------

/** CAIP-2 chain -> Relay numeric chain id */
export function relayChainId(chain: string): number {
  if (chain === SOLANA_CAIP2 || chain === 'solana') return RELAY_SOLANA_CHAIN_ID
  const id = evmChainId(chain)
  if (id === undefined) throw new OrkException(orkError('BAD_REQUEST', { message: `Relay does not support chain ${chain}.` }))
  return id
}

export function caip2FromRelay(chainId: number): string {
  return chainId === RELAY_SOLANA_CHAIN_ID ? SOLANA_CAIP2 : `eip155:${chainId}`
}

function isSolana(chain: string) {
  return chain.startsWith('solana:')
}

/** Our token id -> Relay currency address */
export function relayCurrency(chain: string, token: string): string {
  if (token === 'native') return isSolana(chain) ? SOLANA_NATIVE : EVM_NATIVE
  return token
}

function isNative(chain: string, token: string) {
  const t = token.toLowerCase()
  return t === 'native' || t === EVM_NATIVE || (isSolana(chain) && token === SOLANA_NATIVE)
}

function sameAsset(aChain: string, aToken: string, bChain: string, bToken: string) {
  if (aChain !== bChain) return false
  if (isNative(aChain, aToken) && isNative(bChain, bToken)) return true
  // EVM addresses are case-insensitive; Solana mints are case-sensitive
  return isSolana(aChain) ? aToken === bToken : aToken.toLowerCase() === bToken.toLowerCase()
}

function cryptoAsset(a: Amount | undefined, what: string): CryptoAsset {
  if (!a || a.asset.kind !== 'crypto') throw new OrkException(orkError('BAD_REQUEST', { message: `Relay needs a crypto ${what}.` }))
  if (a.asset.chain === '*' || a.asset.token === '*') throw new OrkException(orkError('BAD_REQUEST', { message: 'Choose the token you want to pay with.' }))
  return a.asset
}

function knownDecimals(chain: string, token: string): number | undefined {
  if (isNative(chain, token)) return isSolana(chain) ? 9 : 18
  if (USDC[chain] && USDC[chain] === token.toLowerCase()) return 6
  return undefined
}

function knownSymbol(chain: string, token: string): string | undefined {
  if (isNative(chain, token)) return isSolana(chain) ? 'SOL' : CHAINS[chain]?.nativeSymbol
  if (USDC[chain] && USDC[chain] === token.toLowerCase()) return 'USDC'
  return undefined
}

function fmt(r: RelayAmount): string {
  return fromBaseUnits(r.amount, r.currency.decimals)
}

function feesFrom(q: RelayQuoteResponse): Fee[] {
  const out: Fee[] = []
  const add = (kind: Fee['kind'], label: string, f?: RelayAmount) => {
    if (!f || !f.amount || f.amount === '0') return
    out.push({ kind, label, amount: fmt(f), currency: f.currency.symbol })
  }
  add('network', 'Network fee', q.fees?.gas)
  // `relayer` already includes relayerGas and relayerService, so we do not add those.
  add('provider', 'Relay fee', q.fees?.relayer)
  add('app', 'App fee', q.fees?.app)
  return out
}

function etaFrom(q: RelayQuoteResponse, fallback: { min: number; max: number }) {
  const t = q.details?.timeEstimate
  if (typeof t !== 'number' || !Number.isFinite(t)) return fallback
  return { min: Math.max(1, Math.round(t)), max: Math.max(fallback.max, Math.round(t * 4)) }
}

/** ERC-20 transfer(address,uint256) calldata (from `@openrampkit/adapter`) */
export { erc20TransferData }

/** Map a failed Relay HTTP call to an OrkException with a safe message. */
function toOrk(e: unknown, log?: Pick<Logger, 'warn'>): OrkException {
  return httpErrorToOrk(e, 'Relay', { what: 'find a route for this pair right now', ...(log ? { log } : {}) })
}

const POLL_TRANSITION = awaitPoll(RELAY_POLL)
const SUBMIT_TX = { name: 'submit_tx', kind: 'SURFACE_RESULT', expects: 'tx_hash' } as const

/** Terminal LegStep for a Relay request or intent status, or undefined while it is still running */
function terminalStep(status: string, extra: { ref: string; txHash?: string; output?: Amount }): LegStep | undefined {
  switch (status) {
    case 'success':
      return { state: 'COMPLETED', status: 'succeeded', transitions: [], ...extra }
    case 'failure':
      return {
        state: 'FAILED',
        status: 'failed',
        transitions: [],
        error: orkError('DELIVERY_FAILED', { message: 'Relay could not complete the transfer.', recovery: 'contact_support' }),
        ...extra,
      }
    case 'refund':
      return { state: 'REFUNDED', status: 'refunded', transitions: [], ...extra }
    default:
      return undefined
  }
}

/** Relay's request id from a quote response (top level or on a step) */
function requestIdOf(q: RelayQuoteResponse): string | undefined {
  return q.requestId ?? q.steps?.find((s) => s.requestId)?.requestId
}

// ---------------- stored state ----------------

/** `since`: when the direct payment started (ms). A transaction mined before it cannot pay this session. */
type WalletRecord = { mode: 'relay' | 'direct'; requestId?: string; txHash?: string; output?: Amount; chain?: string; token?: string; recipient?: string; amountBase?: string; since?: number }
type DepositRecord = { address: string; since: number; mode: 'relay' | 'direct'; output?: Amount; chain?: string; token?: string; fromBlock?: string }

export function relay(opts: RelayOptions = {}) {
  const baseUrl = (opts.baseUrl ?? 'https://api.relay.link').replace(/\/+$/, '')
  let warnedV2 = false

  const headers = (): Record<string, string> => (opts.apiKey ? { 'x-api-key': opts.apiKey } : {})

  async function api<T>(ctx: Pick<AdapterContext, 'fetch'>, path: string, body?: unknown): Promise<T> {
    return fetchJson<T>(ctx.fetch, `${baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      timeoutMs: 8000,
    })
  }

  async function decimalsOf(ctx: Pick<AdapterContext, 'fetch' | 'shared'>, asset: CryptoAsset): Promise<number> {
    if (typeof asset.decimals === 'number') return asset.decimals
    const known = knownDecimals(asset.chain, asset.token)
    if (known !== undefined) return known
    const key = `dec:${asset.chain}:${asset.token.toLowerCase()}`
    const cached = await ctx.shared.get<number>(key)
    if (typeof cached === 'number') return cached
    const list = await api<Array<{ decimals: number }>>(ctx, '/currencies/v2', {
      chainIds: [relayChainId(asset.chain)],
      address: relayCurrency(asset.chain, asset.token),
      limit: 1,
    }).catch((e) => {
      throw toOrk(e)
    })
    const d = list?.[0]?.decimals
    if (typeof d !== 'number') throw new OrkException(orkError('BAD_REQUEST', { message: 'Relay does not know this token.' }))
    await ctx.shared.put(key, d, 7 * 24 * 60 * 60)
    return d
  }

  function withMeta(asset: CryptoAsset, decimals: number, symbol?: string): CryptoAsset {
    const s = asset.symbol ?? symbol ?? knownSymbol(asset.chain, asset.token)
    return { ...asset, decimals, ...(s ? { symbol: s } : {}) }
  }

  function refundTo(originChain: string): string {
    if (opts.refundTo && opts.refundTo !== 'origin') return opts.refundTo
    return isSolana(originChain) ? SOLANA_NATIVE : EVM_NATIVE
  }

  function baseBody(origin: CryptoAsset, dest: CryptoAsset) {
    return {
      originChainId: relayChainId(origin.chain),
      originCurrency: relayCurrency(origin.chain, origin.token),
      destinationChainId: relayChainId(dest.chain),
      destinationCurrency: relayCurrency(dest.chain, dest.token),
      ...(opts.referrer ? { referrer: opts.referrer } : {}),
      ...(opts.appFee && opts.appFee.bps > 0 ? { appFees: [{ recipient: opts.appFee.recipient, fee: String(Math.round(opts.appFee.bps)) }] } : {}),
    }
  }

  function recipientOf(ctx: AdapterContext, deliverTo?: { address: string }): string {
    if (deliverTo?.address) return deliverTo.address
    if (ctx.destination.type === 'crypto') return ctx.destination.address
    throw new OrkException(orkError('BAD_REQUEST', { message: 'Relay legs need a crypto destination.' }))
  }

  function destAsset(ctx: AdapterContext, legTo: CryptoAsset | undefined): CryptoAsset {
    if (legTo && legTo.chain !== '*') return legTo
    const d = ctx.destination
    if (d.type !== 'crypto') throw new OrkException(orkError('BAD_REQUEST', { message: 'Relay legs need a crypto destination.' }))
    return { kind: 'crypto', chain: d.chain, token: d.token, ...(d.symbol ? { symbol: d.symbol } : {}), ...(d.decimals !== undefined ? { decimals: d.decimals } : {}) }
  }

  // ---------- open deposit addresses ----------

  function depositKey(recipient: string, origin: CryptoAsset, dest: CryptoAsset) {
    const norm = (chain: string, token: string) => (isSolana(chain) ? token : token.toLowerCase())
    return `da:${recipient.toLowerCase()}:${origin.chain}:${norm(origin.chain, origin.token)}:${dest.chain}:${norm(dest.chain, dest.token)}`
  }

  /** Quote with an open deposit address. Returns the raw quote and the deposit address (cached per route for 24 h). */
  async function depositQuote(
    ctx: Pick<AdapterContext, 'fetch' | 'shared'>,
    p: { origin: CryptoAsset; dest: CryptoAsset; recipient: string; amountBase: string },
  ): Promise<{ q: RelayQuoteResponse; address: string; requestId?: string }> {
    const q = await api<RelayQuoteResponse>(ctx, '/quote/v2', {
      user: p.recipient,
      recipient: p.recipient,
      ...baseBody(p.origin, p.dest),
      amount: p.amountBase,
      tradeType: 'EXACT_INPUT',
      useDepositAddress: true,
      refundTo: refundTo(p.origin.chain),
    }).catch((e) => {
      throw toOrk(e)
    })
    const key = depositKey(p.recipient, p.origin, p.dest)
    const cached = await ctx.shared.get<string>(key)
    const fresh = q.steps?.find((s) => s.depositAddress)?.depositAddress
    const address = cached ?? fresh
    if (!address) throw new OrkException(orkError('PROVIDER_UNAVAILABLE', { message: 'Relay did not return a deposit address.' }), 502)
    if (!cached) await ctx.shared.put(key, address, DEPOSIT_ADDRESS_TTL_SEC)
    const requestId = requestIdOf(q)
    return { q, address, ...(requestId ? { requestId } : {}) }
  }

  /** Get the cached open deposit address for a route, creating it with a nominal quote when missing. */
  async function openDepositAddress(ctx: Pick<AdapterContext, 'fetch' | 'shared'>, origin: CryptoAsset, dest: CryptoAsset, recipient: string): Promise<string> {
    if (sameAsset(origin.chain, origin.token, dest.chain, dest.token)) return recipient
    const cached = await ctx.shared.get<string>(depositKey(recipient, origin, dest))
    if (cached) return cached
    const decimals = await decimalsOf(ctx, origin)
    const { address } = await depositQuote(ctx, { origin, dest, recipient, amountBase: toBaseUnits(nominalAmount(decimals), decimals) })
    return address
  }

  /** Amount used to price an open deposit address when the user did not give one */
  function nominalAmount(decimals: number): string {
    return decimals <= 8 ? '10' : '0.005'
  }

  // ---------- status of deposit-address legs ----------

  async function findRequest(ctx: AdapterContext, address: string, since: number): Promise<RelayRequest | undefined> {
    let list: RelayRequest[] = []
    const q = `depositAddress=${encodeURIComponent(address)}&limit=5`
    if (opts.apiKey) {
      const res = await api<{ requests?: RelayRequest[] }>(ctx, `/requests/v3?${q}`)
      list = res.requests ?? []
    } else {
      if (!warnedV2) {
        warnedV2 = true
        ctx.log.warn('relay: no apiKey, using deprecated GET /requests/v2 (Relay retires it on 2026-11-24). Set relay({ apiKey }) to use /requests/v3.')
      }
      const res = await api<{ requests?: RelayRequest[] }>(ctx, `/requests/v2?${q}`)
      list = res.requests ?? []
    }
    // Only requests created after this leg started (1 minute of slack for clock skew)
    return list
      .filter((r) => Date.parse(r.createdAt) >= since - 60_000)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]
  }

  function requestOutput(r: RelayRequest): Amount | undefined {
    const out = r.data?.route?.actual?.destination?.outputCurrency ?? r.data?.route?.quoted?.destination?.outputCurrency ?? r.data?.metadata?.currencyOut
    if (!out?.currency || !out.amount) return undefined
    return {
      amount: fmt(out),
      asset: { kind: 'crypto', chain: caip2FromRelay(out.currency.chainId), token: out.currency.address, symbol: out.currency.symbol, decimals: out.currency.decimals },
    }
  }

  function requestTxHash(r: RelayRequest): string | undefined {
    const t = r.data?.outTxs?.[0]
    return t?.txHash ?? t?.hash
  }

  function mapRequest(r: RelayRequest, ref: string): LegStep {
    const txHash = requestTxHash(r)
    const output = requestOutput(r)
    const extra = { ref, ...(txHash ? { txHash } : {}), ...(output ? { output } : {}) }
    return terminalStep(r.status, extra) ?? { state: 'PROCESSING', sub: r.status, status: 'processing', transitions: [POLL_TRANSITION], ...extra }
  }

  // ---------- leg specs ----------

  const usdcHops: Record<string, string[]> = Object.fromEntries(HOP_CHAINS.filter((c) => USDC[c]).map((c) => [c, [USDC[c]!]]))

  const legs: LegSpec[] = [
    {
      id: 'wallet',
      kind: 'bridge_swap',
      methods: ['wallet'],
      from: { asset: { kind: 'crypto', chains: '*' }, location: ['user_wallet'] },
      to: { asset: { kind: 'crypto', chains: '*' }, location: ['address'] },
      regions: { allow: ['*'], deny: [] },
      eta: { min: 5, max: 60 },
      surfaces: ['WALLET_TX'],
      requires: ['wallet'],
      capabilities: ['polling'],
    },
    {
      id: 'transfer',
      kind: 'bridge_swap',
      methods: ['transfer'],
      from: { asset: { kind: 'crypto', chains: '*' }, location: ['user_wallet'] },
      to: { asset: { kind: 'crypto', chains: '*' }, location: ['address'] },
      regions: { allow: ['*'], deny: [] },
      eta: { min: 10, max: 120 },
      surfaces: ['DEPOSIT_ADDRESS'],
      capabilities: ['polling', 'refunds'],
    },
    {
      id: 'bridge',
      kind: 'bridge_swap',
      from: { asset: { kind: 'crypto', chains: usdcHops }, location: ['address'] },
      to: { asset: { kind: 'crypto', chains: '*' }, location: ['address'] },
      regions: { allow: ['*'], deny: [] },
      eta: { min: 5, max: 60 },
      // Not shown to the user: the previous leg delivers into the address.
      surfaces: ['DEPOSIT_ADDRESS'],
      capabilities: ['polling', 'refunds'],
    },
  ]

  // ---------- quote per leg ----------

  async function quoteWallet(input: QuoteInput, ctx: AdapterContext): Promise<LegQuote> {
    const origin: CryptoAsset = input.source
      ? { kind: 'crypto', chain: input.source.chain, token: input.source.token }
      : cryptoAsset(input.amountIn ?? { amount: '0', asset: input.leg.from.asset }, 'source')
    if (!origin.chain.startsWith('eip155:')) {
      throw new OrkException(orkError('BAD_REQUEST', { message: 'Wallet payments support EVM chains only. Use "Transfer crypto" instead.' }))
    }
    const dest = destAsset(ctx, input.leg.to.asset.kind === 'crypto' ? input.leg.to.asset : undefined)
    const recipient = recipientOf(ctx, input.deliverTo)
    const user = input.source?.address ?? PLACEHOLDER_USER
    const inDec = await decimalsOf(ctx, { ...origin, ...(input.amountIn?.asset.kind === 'crypto' && input.amountIn.asset.decimals !== undefined ? { decimals: input.amountIn.asset.decimals } : {}) })
    const originMeta = withMeta(origin, inDec)
    const legEta = legs[0]!.eta

    // Same chain and token: a plain transfer, no Relay.
    if (sameAsset(origin.chain, origin.token, dest.chain, dest.token)) {
      const amount = input.amountIn?.amount ?? input.amountOut?.amount ?? '0'
      return {
        adapterId: 'relay',
        legId: 'wallet',
        input: { amount, asset: originMeta },
        output: { amount, asset: withMeta(dest, inDec) },
        fees: [],
        eta: { min: 5, max: 30 },
        data: { direct: true, recipient, amountBase: toBaseUnits(amount, inDec), user },
      }
    }

    const outDec = await decimalsOf(ctx, dest)
    const exactOut = !input.amountIn && !!input.amountOut
    const body = {
      user,
      recipient,
      ...baseBody(origin, dest),
      amount: exactOut ? toBaseUnits(input.amountOut!.amount, outDec) : toBaseUnits(input.amountIn?.amount ?? '0', inDec),
      tradeType: exactOut ? 'EXACT_OUTPUT' : 'EXACT_INPUT',
    }
    const q = await api<RelayQuoteResponse>(ctx, '/quote/v2', body).catch((e) => {
      throw toOrk(e, ctx.log)
    })
    const cin = q.details?.currencyIn
    const cout = q.details?.currencyOut
    if (!cin || !cout) throw new OrkException(orkError('PROVIDER_UNAVAILABLE', { message: 'Relay returned an incomplete quote.' }), 502)
    return {
      adapterId: 'relay',
      legId: 'wallet',
      input: { amount: fmt(cin), asset: withMeta(origin, cin.currency.decimals, cin.currency.symbol) },
      output: { amount: fmt(cout), asset: withMeta(dest, cout.currency.decimals, cout.currency.symbol) },
      fees: feesFrom(q),
      eta: etaFrom(q, legEta),
      expiresAt: new Date(Date.now() + WALLET_QUOTE_TTL_MS).toISOString(),
      data: { direct: false, body, user, quotedAt: Date.now(), steps: q.steps ?? [], requestId: requestIdOf(q) },
    }
  }

  async function quoteDeposit(legId: 'transfer' | 'bridge', input: QuoteInput, ctx: AdapterContext): Promise<LegQuote> {
    const origin: CryptoAsset =
      legId === 'transfer' && input.source
        ? { kind: 'crypto', chain: input.source.chain, token: input.source.token }
        : cryptoAsset(input.amountIn ?? { amount: '0', asset: input.leg.from.asset }, 'source')
    const dest = destAsset(ctx, input.leg.to.asset.kind === 'crypto' ? input.leg.to.asset : undefined)
    const recipient = recipientOf(ctx, input.deliverTo)
    const inDec = await decimalsOf(ctx, { ...origin, ...(input.amountIn?.asset.kind === 'crypto' && input.amountIn.asset.decimals !== undefined ? { decimals: input.amountIn.asset.decimals } : {}) })
    const originMeta = withMeta(origin, inDec)
    const spec = legs.find((l) => l.id === legId)!
    const given = input.amountIn?.amount ?? '0'
    const anyAmount = legId === 'transfer'

    if (sameAsset(origin.chain, origin.token, dest.chain, dest.token)) {
      return {
        adapterId: 'relay',
        legId,
        input: { amount: given, asset: originMeta },
        output: { amount: given, asset: withMeta(dest, inDec) },
        fees: [],
        eta: { min: 5, max: 60 },
        data: { direct: true, depositAddress: recipient, anyAmount, nominal: false },
      }
    }

    const nominal = cmp(given, '0') <= 0
    const amount = nominal ? nominalAmount(inDec) : given
    const { q, address, requestId } = await depositQuote(ctx, { origin, dest, recipient, amountBase: toBaseUnits(amount, inDec) })
    const cin = q.details?.currencyIn
    const cout = q.details?.currencyOut
    if (!cin || !cout) throw new OrkException(orkError('PROVIDER_UNAVAILABLE', { message: 'Relay returned an incomplete quote.' }), 502)
    return {
      adapterId: 'relay',
      legId,
      input: { amount: fmt(cin), asset: withMeta(origin, cin.currency.decimals, cin.currency.symbol) },
      output: { amount: fmt(cout), asset: withMeta(dest, cout.currency.decimals, cout.currency.symbol) },
      fees: feesFrom(q),
      eta: etaFrom(q, spec.eta),
      // Open deposit addresses accept any amount; the output is the rate-based estimate for `input`.
      data: { direct: false, depositAddress: address, requestId, anyAmount, nominal, recipient },
    }
  }

  // ---------- start per leg ----------

  /** Wallet transactions from Relay steps. `unsupported` names the first step kind we cannot run (e.g. `signature`). */
  function walletTxsFrom(steps: RelayStep[]): { txs: TxRequest[]; unsupported?: string } {
    const txs: TxRequest[] = []
    let unsupported: string | undefined
    for (const s of steps) {
      if (s.kind !== 'transaction') {
        unsupported ??= s.kind || 'unknown'
        continue
      }
      for (const it of s.items ?? []) {
        if (it.status === 'complete' || !it.data) continue
        txs.push({
          to: it.data.to,
          ...(it.data.data && it.data.data !== '0x' ? { data: it.data.data } : {}),
          ...(it.data.value && it.data.value !== '0' ? { value: it.data.value } : {}),
          chainId: it.data.chainId,
          ...(it.data.gas ? { gas: it.data.gas } : {}),
        })
      }
    }
    return { txs, ...(unsupported ? { unsupported } : {}) }
  }

  function payStep(chain: string, txs: TxRequest[], ref: string): LegStep {
    return {
      state: 'PAYMENT',
      surface: { kind: 'WALLET_TX', chain, txs },
      transitions: [SUBMIT_TX],
      status: 'awaiting_user',
      ref,
    }
  }

  async function rpc<T>(ctx: Pick<AdapterContext, 'fetch' | 'log'>, chain: string, method: string, params: unknown[]): Promise<T> {
    const url = (opts.rpcUrls ?? {})[chain] ?? DEFAULT_RPC_URLS[chain]
    if (!url) throw new OrkException(orkError('PROVIDER_UNAVAILABLE', { message: `No RPC is configured to verify transfers on ${chainName(chain)}.` }), 502)
    return evmRpc<T>(ctx.fetch, url, method, params, { log: ctx.log })
  }

  /** A same-chain wallet payment counts only when the receipt shows it paid the recipient at least the amount. */
  async function verifyDirectWallet(ctx: AdapterContext, ref: string, rec: WalletRecord): Promise<LegStep> {
    const chain = rec.chain!
    const receipt = await rpc<EvmReceipt | null>(ctx, chain, 'eth_getTransactionReceipt', [rec.txHash])
    const extra = { ref, txHash: rec.txHash! }
    if (!receipt) return { state: 'PROCESSING', sub: 'confirming', status: 'processing', transitions: [POLL_TRANSITION], ...extra }
    const fail = (message: string): LegStep => ({ state: 'FAILED', status: 'failed', transitions: [], error: orkError('DELIVERY_FAILED', { message }), ...extra })
    if (receipt.status !== '0x1') return fail('The transaction failed on chain.')
    // The transaction must be newer than this payment: an older transfer to the same recipient (for
    // example a shared merchant address) must not complete a new session.
    if (rec.since !== undefined) {
      const block = receipt.blockNumber ? await rpc<{ timestamp?: string } | null>(ctx, chain, 'eth_getBlockByNumber', [receipt.blockNumber, false]) : null
      if (!block?.timestamp) return { state: 'PROCESSING', sub: 'confirming', status: 'processing', transitions: [POLL_TRANSITION], ...extra }
      if (Number(BigInt(block.timestamp)) * 1000 < rec.since - DIRECT_TX_CLOCK_SKEW_MS) return fail('The transaction was sent before this payment started.')
    }
    const need = BigInt(rec.amountBase ?? '0')
    const recipient = (rec.recipient ?? '').toLowerCase()
    let paid = 0n
    if (isNative(chain, rec.token ?? '')) {
      const tx = await rpc<{ to?: string; value?: string } | null>(ctx, chain, 'eth_getTransactionByHash', [rec.txHash])
      if (tx?.to?.toLowerCase() === recipient) paid = BigInt(tx.value ?? '0x0')
    } else {
      paid = erc20PaidTo(receipt, rec.token ?? '', recipient)
    }
    if (paid < need) return fail('The transaction does not pay the destination the quoted amount.')
    // One transaction can complete one payment only: an old hash must not be reused for a new session.
    const usedKey = `txused:${chain}:${rec.txHash!.toLowerCase()}`
    const usedBy = await ctx.shared.get<string>(usedKey)
    if (usedBy && usedBy !== ref) return fail('This transaction was already used for another payment.')
    if (!usedBy) await ctx.shared.put(usedKey, ref, 90 * 24 * 3600)
    return { state: 'COMPLETED', status: 'succeeded', transitions: [], ...extra, ...(rec.output ? { output: rec.output } : {}) }
  }

  /** Transfer to the destination itself (same chain and token): find ERC20 Transfer logs to it since the start block. */
  async function findDirectDeposit(ctx: AdapterContext, ref: string, rec: DepositRecord): Promise<LegStep | undefined> {
    if (!rec.chain || !rec.token || !rec.fromBlock || isNative(rec.chain, rec.token)) return undefined
    const logs = await rpc<Array<{ data: string; transactionHash: string }>>(ctx, rec.chain, 'eth_getLogs', [
      { fromBlock: rec.fromBlock, toBlock: 'latest', address: rec.token, topics: [ERC20_TRANSFER_TOPIC, null, topicAddress(rec.address)] },
    ])
    if (!logs?.length) return undefined
    const total = logs.reduce((acc, l) => acc + BigInt(l.data), 0n)
    const decimals = rec.output?.asset.kind === 'crypto' ? (rec.output.asset.decimals ?? 6) : 6
    return {
      state: 'COMPLETED',
      status: 'succeeded',
      transitions: [],
      ref,
      txHash: logs[logs.length - 1]!.transactionHash,
      ...(rec.output ? { output: { ...rec.output, amount: fromBaseUnits(total.toString(), decimals) } } : {}),
    }
  }

  async function startWallet(input: StartInput, ctx: AdapterContext): Promise<LegStep> {
    const data = (input.quote.data ?? {}) as Record<string, unknown>
    const origin = cryptoAsset(input.quote.input, 'input')

    if (data.direct) {
      const recipient = String(data.recipient)
      const amountBase = String(data.amountBase)
      const chainId = evmChainId(origin.chain)!
      const tx: TxRequest = isNative(origin.chain, origin.token)
        ? { to: recipient, value: amountBase, chainId }
        : { to: origin.token, data: erc20TransferData(recipient, amountBase), chainId }
      const ref = `direct:${ctx.session.id}:${randomHex()}`
      await ctx.store.put(
        `w:${ref}`,
        { mode: 'direct', output: input.quote.output, chain: origin.chain, token: origin.token, recipient, amountBase, since: Date.now() } satisfies WalletRecord,
        RECORD_TTL_SEC,
      )
      return payStep(origin.chain, [tx], ref)
    }

    // Reuse the quote's steps when they are fresh and built for this user, otherwise re-quote.
    let steps = data.steps as RelayStep[] | undefined
    let requestId = data.requestId as string | undefined
    const user = input.source?.address
    const fresh = typeof data.quotedAt === 'number' && Date.now() - data.quotedAt < WALLET_QUOTE_REUSE_MS
    if (!steps || !fresh || (user && String(data.user).toLowerCase() !== user.toLowerCase())) {
      if (!data.body) throw new OrkException(orkError('QUOTE_EXPIRED'), 410)
      const body = { ...(data.body as Record<string, unknown>), ...(user ? { user } : {}) }
      const q = await api<RelayQuoteResponse>(ctx, '/quote/v2', body).catch((e) => {
        throw toOrk(e, ctx.log)
      })
      steps = q.steps ?? []
      requestId = requestIdOf(q)
    }
    const { txs, unsupported } = walletTxsFrom(steps)
    const ref = requestId ?? `relay:${ctx.session.id}:${randomHex()}`
    if (unsupported || !txs.length) {
      return {
        state: 'FAILED',
        status: 'failed',
        transitions: [],
        ref,
        error: orkError('PROVIDER_DECLINED', {
          message: unsupported
            ? `This route needs a ${unsupported} step, which is not supported yet. Try another token or "Transfer crypto".`
            : 'Relay returned no transactions for this route.',
          recovery: 'choose_other',
        }),
      }
    }
    await ctx.store.put(`w:${ref}`, { mode: 'relay', requestId: ref } satisfies WalletRecord, RECORD_TTL_SEC)
    return payStep(caip2FromRelay(txs[0]!.chainId), txs, ref)
  }

  async function startDeposit(legId: 'transfer' | 'bridge', input: StartInput, ctx: AdapterContext): Promise<LegStep> {
    const data = (input.quote.data ?? {}) as Record<string, unknown>
    const origin = cryptoAsset(input.quote.input, 'input')
    let address = data.depositAddress as string | undefined
    if (!address) {
      const dest = cryptoAsset(input.quote.output, 'output')
      address = await openDepositAddress(ctx, origin, dest, recipientOf(ctx, input.deliverTo))
    }
    const key = `d:${address.toLowerCase()}`
    const prev = await ctx.store.get<DepositRecord>(key)
    const since = prev?.since ?? Date.now()
    // Same chain and token: the address is the destination itself, so we watch Transfer logs from now on.
    const fromBlock = data.direct ? (prev?.fromBlock ?? (await rpc<string>(ctx, origin.chain, 'eth_blockNumber', []))) : undefined
    await ctx.store.put(
      key,
      { address, since, mode: data.direct ? 'direct' : 'relay', output: input.quote.output, chain: origin.chain, token: origin.token, ...(fromBlock ? { fromBlock } : {}) } satisfies DepositRecord,
      RECORD_TTL_SEC,
    )

    if (legId === 'bridge') {
      return { state: 'PROCESSING', sub: 'waiting_for_deposit', transitions: [POLL_TRANSITION], status: 'processing', ref: address }
    }
    const symbol = origin.symbol ?? knownSymbol(origin.chain, origin.token) ?? 'the token'
    const name = chainName(origin.chain)
    return {
      state: 'PAYMENT',
      surface: {
        kind: 'DEPOSIT_ADDRESS',
        chain: origin.chain,
        chainName: name,
        token: origin.token,
        symbol,
        address,
        warning: `Send only ${symbol} on ${name}. Other tokens or chains may be lost.`,
      },
      transitions: [POLL_TRANSITION],
      status: 'awaiting_user',
      ref: address,
    }
  }

  return createAdapter({
    id: 'relay',
    name: 'Relay',
    legs,

    async quote(input, ctx) {
      switch (input.leg.legId) {
        case 'wallet':
          return quoteWallet(input, ctx)
        case 'transfer':
          return quoteDeposit('transfer', input, ctx)
        case 'bridge':
          return quoteDeposit('bridge', input, ctx)
        default:
          throw new OrkException(orkError('NOT_FOUND', { message: `Unknown Relay leg ${input.leg.legId}` }), 404)
      }
    },

    async prepareDeposit(input, ctx) {
      const origin = cryptoAsset({ amount: '0', asset: input.leg.from.asset }, 'hop asset')
      const dest = destAsset(ctx, input.leg.to.asset.kind === 'crypto' ? input.leg.to.asset : undefined)
      const recipient = recipientOf(ctx)
      const address = await openDepositAddress(ctx, origin, dest, recipient)
      // Remember when this session first used the address, so status ignores older deposits.
      const key = `d:${address.toLowerCase()}`
      if (!(await ctx.store.get(key))) {
        await ctx.store.put(key, { address, since: Date.now(), mode: address === recipient ? 'direct' : 'relay' } satisfies DepositRecord, RECORD_TTL_SEC)
      }
      return { address, ref: address }
    },

    async start(input, ctx) {
      switch (input.leg.legId) {
        case 'wallet':
          return startWallet(input, ctx)
        case 'transfer':
          return startDeposit('transfer', input, ctx)
        case 'bridge':
          return startDeposit('bridge', input, ctx)
        default:
          throw new OrkException(orkError('NOT_FOUND', { message: `Unknown Relay leg ${input.leg.legId}` }), 404)
      }
    },

    async transition(input, ctx) {
      if (input.leg.legId !== 'wallet' || input.name !== 'submit_tx') {
        throw new OrkException(orkError('BAD_REQUEST', { message: `Transition ${input.name} is not supported.` }), 409)
      }
      const txHash = String(input.inputs?.txHash ?? input.inputs?.hash ?? '')
      if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new OrkException(orkError('BAD_REQUEST', { message: 'A transaction hash is required.' }))
      const rec = (await ctx.store.get<WalletRecord>(`w:${input.ref}`)) ?? { mode: 'relay' as const, requestId: input.ref }
      await ctx.store.put(`w:${input.ref}`, { ...rec, txHash } satisfies WalletRecord, RECORD_TTL_SEC)
      return { state: 'PROCESSING', transitions: [POLL_TRANSITION], status: 'processing', ref: input.ref, txHash }
    },

    async status(input, ctx) {
      const { legId } = input.leg
      if (legId === 'wallet') {
        const rec = await ctx.store.get<WalletRecord>(`w:${input.ref}`)
        if (rec?.mode === 'direct') {
          // Same-chain transfer: the wallet's tx hash is checked on chain before the leg counts.
          if (!rec.txHash) return { state: 'PAYMENT', transitions: [SUBMIT_TX], status: 'awaiting_user', ref: input.ref }
          return verifyDirectWallet(ctx, input.ref, rec)
        }
        const s = await api<RelayIntentStatus>(ctx, `/intents/status/v3?requestId=${encodeURIComponent(input.ref)}`).catch((e) => {
          throw toOrk(e, ctx.log)
        })
        const txHash = s.txHashes?.[0] ?? rec?.txHash
        const extra = { ref: input.ref, ...(txHash ? { txHash } : {}) }
        const done = terminalStep(s.status, extra)
        if (done) return done
        if (!rec?.txHash && !s.inTxHashes?.length) {
          return { state: 'PAYMENT', transitions: [SUBMIT_TX], status: 'awaiting_user', ref: input.ref }
        }
        return { state: 'PROCESSING', sub: s.status, status: 'processing', transitions: [POLL_TRANSITION], ...extra }
      }

      // transfer / bridge: look for deposits into the address
      const rec = await ctx.store.get<DepositRecord>(`d:${input.ref.toLowerCase()}`)
      const waiting: LegStep =
        legId === 'bridge'
          ? { state: 'PROCESSING', sub: 'waiting_for_deposit', status: 'processing', transitions: [POLL_TRANSITION], ref: input.ref }
          : { state: 'PAYMENT', status: 'awaiting_user', transitions: [POLL_TRANSITION], ref: input.ref }
      // Same chain and token: the address is the destination itself; look for Transfer logs to it.
      if (rec?.mode === 'direct') return (await findDirectDeposit(ctx, input.ref, rec)) ?? waiting
      const found = await findRequest(ctx, input.ref, rec?.since ?? 0).catch((e) => {
        throw toOrk(e, ctx.log)
      })
      return found ? mapRequest(found, input.ref) : waiting
    },

    async health(ctx) {
      try {
        const res = await api<{ chains?: unknown[] }>(ctx, '/chains')
        return { ok: Array.isArray(res.chains) && res.chains.length > 0 }
      } catch (e) {
        return { ok: false, detail: String((e as Error)?.message ?? e).slice(0, 200) }
      }
    },
  })
}

