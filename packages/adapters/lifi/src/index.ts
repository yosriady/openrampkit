// LI.FI adapter: pay from a connected wallet with any token on any chain (https://docs.li.fi).
//
// Leg:
// - `wallet` The user's wallet signs LI.FI's transaction (and an ERC-20 approval when needed).
//            LI.FI swaps and bridges the token to the session destination.
//
// A second any-token, any-chain router next to Relay: the server quotes both and ranks them.
// Source chains: EVM and Solana. Destination chains: EVM and Solana.
//
// Money rules (the same as the Relay adapter):
// - One source transaction pays one session only (used record by chain and tx hash).
// - The leg completes only when the destination got at least the quoted minimum (`toAmountMin`),
//   compared with bigint math in base units.
// - On EVM token destinations with an RPC, one Transfer log of the delivery transaction must pay
//   the recipient at least the minimum (no sum of logs). The log is recorded as used by
//   (chain, tx hash, log index), so it never completes a second session.
//
// Server-side only. Web-standard APIs only (fetch), so it runs on Cloudflare Workers.

import { ERC20_TRANSFER_TOPIC, POLL, awaitPoll, claimOnce, createAdapter, evmRpc, fetchJson, httpErrorToOrk, httpStatus, randomHex, topicAddress } from '@openrampkit/adapter'
import type { AdapterContext, EvmReceipt, Logger, QuoteInput, StartInput } from '@openrampkit/adapter'
import {
  CHAINS,
  OrkException,
  SOLANA_MAINNET,
  chainName,
  cmp,
  evmChainId,
  fromBaseUnits,
  isSolanaAddress,
  isSolanaSignature,
  isUsdc,
  orkError,
  sameToken,
  toBaseUnits,
} from '@openrampkit/core'
import type { Amount, CryptoAsset, Fee, LegQuote, LegSpec, LegStep, PollSpec, TxRequest } from '@openrampkit/core'

export type LifiOptions = {
  /** LI.FI API key (`x-lifi-api-key`), from the Partner Portal. Optional, but the free quote limit is low. Keep it on the server. */
  apiKey?: string
  /** Default https://li.quest/v1 */
  baseUrl?: string
  /** LI.FI `integrator` string (your app name), for attribution and fees */
  integrator?: string
  /**
   * Your fee in basis points (LI.FI `fee`, a fraction: 25 bps is 0.0025). Needs `integrator`, and a
   * fee wallet for that integrator in the LI.FI Partner Portal; else LI.FI refuses the quote.
   */
  feeBps?: number
  /** LI.FI `slippage` in basis points (50 is 0.5%). Default: LI.FI picks a value. */
  slippageBps?: number
  /** LI.FI route `order`. Default: LI.FI picks. */
  order?: 'FASTEST' | 'CHEAPEST'
  /**
   * JSON-RPC URLs per CAIP-2 chain. The adapter uses them to check the ERC-20 approval allowance on the
   * source chain, and the delivery `Transfer` log on the destination chain. Defaults to public RPCs for
   * the main EVM chains; set your own for production.
   */
  rpcUrls?: Record<string, string>
  /**
   * Check the delivery on chain (EVM token destinations with an RPC). Default true. When false, or when
   * there is no RPC, the leg trusts the amount in the LI.FI status.
   */
  verifyOnChain?: boolean
}

/** Public RPCs for on-chain checks. Rate-limited: use your own in production. */
export const DEFAULT_RPC_URLS: Record<string, string> = {
  'eip155:1': 'https://ethereum-rpc.publicnode.com',
  'eip155:8453': 'https://mainnet.base.org',
  'eip155:42161': 'https://arb1.arbitrum.io/rpc',
  'eip155:10': 'https://mainnet.optimism.io',
  'eip155:137': 'https://polygon-rpc.com',
}

/** LI.FI chain id of Solana mainnet (`GET /v1/chains`, key `sol`) */
export const LIFI_SOLANA_CHAIN_ID = 1151111081099710
/** LI.FI address of the native token on EVM chains */
const EVM_NATIVE = '0x0000000000000000000000000000000000000000'
/** LI.FI address of SOL (`GET /v1/token?chain=SOL&token=SOL`) */
const SOLANA_NATIVE = '11111111111111111111111111111111'
/** LI.FI needs a `fromAddress` for every quote. Used until the user's wallet is known; the start quotes again with it. */
const PLACEHOLDER_USER = '0x000000000000000000000000000000000000dEaD'
const PLACEHOLDER_SOLANA_USER = SOLANA_NATIVE

const WALLET_QUOTE_REUSE_MS = 20_000
const WALLET_QUOTE_TTL_MS = 60_000
/** How long a payment record stays in the session store */
const RECORD_TTL_SEC = 7 * 24 * 60 * 60
/** How long a used transaction or log stays recorded */
const USED_TTL_SEC = 90 * 24 * 60 * 60
/** Allowed difference between our clock and the source tx time */
const TX_CLOCK_SKEW_MS = 5 * 60_000

export const LIFI_POLL: PollSpec = POLL.onchain
const POLL_TRANSITION = awaitPoll(LIFI_POLL)
const SUBMIT_TX = { name: 'submit_tx', kind: 'SURFACE_RESULT', expects: 'tx_hash' } as const

// ---------------- LI.FI API types (only the fields we read) ----------------

export type LifiToken = { address: string; chainId: number; symbol: string; decimals: number }
type LifiFeeCost = { name: string; amount: string; included?: boolean; token: LifiToken; feeSplit?: { lifiFee?: string; integratorFee?: string } }
type LifiGasCost = { amount: string; token: LifiToken }
/** A LI.FI `Step` from `GET /v1/quote` or `GET /v1/quote/toAmount` */
export type LifiQuote = {
  id: string
  type?: string
  tool?: string
  action: { fromToken: LifiToken; toToken: LifiToken; fromChainId: number; toChainId: number; fromAmount: string; fromAddress?: string; toAddress?: string; slippage?: number }
  estimate: {
    fromAmount: string
    toAmount: string
    toAmountMin: string
    approvalAddress?: string
    executionDuration?: number
    feeCosts?: LifiFeeCost[]
    gasCosts?: LifiGasCost[]
  }
  /** EVM: an ethers TransactionRequest (`value`, `gasLimit` as hex). Solana: `data` is the base64 transaction. */
  transactionRequest?: { to?: string; data?: string; value?: string; gasLimit?: string; chainId?: number; from?: string }
}
/** The fields of `eth_getTransactionReceipt` that the delivery check reads */
type DeliveryReceipt = Omit<EvmReceipt, 'logs'> & { logs?: Array<{ address: string; topics: string[]; data: string; logIndex?: string; removed?: boolean }> }
type LifiTransfer = { txHash?: string; chainId?: number; amount?: string; token?: LifiToken; timestamp?: number }
/** `GET /v1/status` */
export type LifiStatus = {
  status: 'NOT_FOUND' | 'INVALID' | 'PENDING' | 'DONE' | 'FAILED' | string
  substatus?: string
  substatusMessage?: string
  fromAddress?: string
  toAddress?: string
  tool?: string
  sending?: LifiTransfer
  receiving?: LifiTransfer
  /** The stored quote, when LI.FI has one. `stepId` matches the quote `id`. */
  quote?: { stepId?: string }
}

// ---------------- helpers ----------------

function isSolana(chain: string) {
  return chain.startsWith('solana:')
}

/** CAIP-2 chain -> LI.FI chain id. EVM chains and Solana mainnet only. */
export function lifiChainId(chain: string): number {
  if (chain === SOLANA_MAINNET) return LIFI_SOLANA_CHAIN_ID
  const id = evmChainId(chain)
  if (id === undefined) throw new OrkException(orkError('NO_QUOTES', { message: `LI.FI does not support ${chainName(chain)} here.` }), 422)
  return id
}

export function caip2FromLifi(chainId: number): string {
  return chainId === LIFI_SOLANA_CHAIN_ID ? SOLANA_MAINNET : `eip155:${chainId}`
}

/** Our token id -> LI.FI token address */
export function lifiToken(chain: string, token: string): string {
  if (token.toLowerCase() === 'native') return isSolana(chain) ? SOLANA_NATIVE : EVM_NATIVE
  return token
}

function isNative(chain: string, token: string) {
  const t = token.toLowerCase()
  return t === 'native' || (!isSolana(chain) && t === EVM_NATIVE) || (isSolana(chain) && token === SOLANA_NATIVE)
}

function sameAsset(aChain: string, aToken: string, bChain: string, bToken: string) {
  if (aChain !== bChain) return false
  if (isNative(aChain, aToken) && isNative(bChain, bToken)) return true
  return sameToken(aChain, aToken, bToken)
}

/** Key form of an address or tx hash: EVM lowercased, Solana (base58, case-sensitive) as given */
function key(v: string): string {
  return v.startsWith('0x') ? v.toLowerCase() : v
}

/** True when `address` is a valid account of `chain`'s VM (the format only) */
function fitsChain(chain: string, address: string | undefined): address is string {
  if (!address) return false
  return isSolana(chain) ? isSolanaAddress(address) : /^0x[0-9a-fA-F]{40}$/.test(address)
}

function sameAddress(chain: string, a: string | undefined, b: string): boolean {
  if (!a) return false
  return isSolana(chain) ? a === b : a.toLowerCase() === b.toLowerCase()
}

function knownDecimals(chain: string, token: string): number | undefined {
  if (isNative(chain, token)) return isSolana(chain) ? 9 : 18
  if (isUsdc(chain, token)) return 6
  return undefined
}

function knownSymbol(chain: string, token: string): string | undefined {
  if (isNative(chain, token)) return isSolana(chain) ? 'SOL' : CHAINS[chain]?.nativeSymbol
  if (isUsdc(chain, token)) return 'USDC'
  return undefined
}

const DIGITS = /^[0-9]+$/
const big = (v: string | undefined): bigint | undefined => (v && DIGITS.test(v) ? BigInt(v) : undefined)
/** Hex or decimal quantity -> decimal string */
const quantity = (v: string | undefined): string | undefined => {
  if (!v) return undefined
  try {
    return BigInt(v).toString()
  } catch {
    return undefined
  }
}

function cryptoAsset(a: Amount | undefined, what: string): CryptoAsset {
  if (!a || a.asset.kind !== 'crypto') throw new OrkException(orkError('BAD_REQUEST', { message: `LI.FI needs a crypto ${what}.` }))
  if (a.asset.chain === '*' || a.asset.token === '*') throw new OrkException(orkError('BAD_REQUEST', { message: 'Choose the token you want to pay with.' }))
  return a.asset
}

/** Fees from a LI.FI quote. The integrator part of a fee is the app fee. Gas is summed per gas token. */
export function feesFrom(q: LifiQuote): Fee[] {
  const out: Fee[] = []
  for (const f of q.estimate.feeCosts ?? []) {
    const total = big(f.amount)
    if (total === undefined || total === 0n) continue
    const app = big(f.feeSplit?.integratorFee) ?? 0n
    const rest = total - app
    if (rest > 0n) out.push({ kind: 'provider', label: f.name || 'LI.FI fee', amount: fromBaseUnits(rest.toString(), f.token.decimals), currency: f.token.symbol })
    if (app > 0n) out.push({ kind: 'app', label: 'App fee', amount: fromBaseUnits(app.toString(), f.token.decimals), currency: f.token.symbol })
  }
  const gas = new Map<string, { sum: bigint; token: LifiToken }>()
  for (const g of q.estimate.gasCosts ?? []) {
    const n = big(g.amount)
    if (n === undefined || n === 0n) continue
    const k = `${g.token.chainId}:${key(g.token.address)}`
    const cur = gas.get(k)
    gas.set(k, { sum: (cur?.sum ?? 0n) + n, token: g.token })
  }
  for (const { sum, token } of gas.values()) out.push({ kind: 'network', label: 'Network fee', amount: fromBaseUnits(sum.toString(), token.decimals), currency: token.symbol })
  return out
}

function etaFrom(q: LifiQuote, fallback: { min: number; max: number }) {
  const t = q.estimate.executionDuration
  if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) return fallback
  return { min: Math.max(1, Math.round(t)), max: Math.max(fallback.max, Math.round(t * 4)) }
}

/** ERC-20 approve(address,uint256) calldata */
export function erc20ApproveData(spender: string, amountBase: string): string {
  return `0x095ea7b3${spender.toLowerCase().replace(/^0x/, '').padStart(64, '0')}${BigInt(amountBase).toString(16).padStart(64, '0')}`
}

/** ERC-20 allowance(address,address) calldata */
function erc20AllowanceData(owner: string, spender: string): string {
  const pad = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0')
  return `0xdd62ed3e${pad(owner)}${pad(spender)}`
}

function toOrk(e: unknown, log?: Pick<Logger, 'warn'>): OrkException {
  return httpErrorToOrk(e, 'LI.FI', { what: 'find a route for this pair right now', ...(log ? { log } : {}) })
}

// ---------------- stored state ----------------

type WalletRecord = {
  /** Source chain: tells how to read `txHash` (EVM hash or Solana signature) */
  fromChain: string
  /** Destination chain, token (our form) and receiver */
  toChain: string
  toToken: string
  recipient: string
  /** Smallest delivery that completes the leg (LI.FI `toAmountMin`, base units of the destination token) */
  minBase: string
  /** Decimals of the destination token */
  toDecimals: number
  output: Amount
  /** When the payment started (ms). A source tx older than this cannot pay this session. */
  since: number
  /** LI.FI quote id of the transaction we gave the wallet */
  stepId?: string
  tool?: string
  txHash?: string
}

export function lifi(opts: LifiOptions = {}) {
  const baseUrl = (opts.baseUrl ?? 'https://li.quest/v1').replace(/\/+$/, '')
  if (opts.feeBps !== undefined) {
    if (!(opts.feeBps >= 0 && opts.feeBps < 10_000)) throw new Error('lifi: feeBps must be at least 0 and less than 10000')
    if (opts.feeBps > 0 && !opts.integrator) throw new Error('lifi: feeBps needs an integrator (configure its fee wallet in the LI.FI Partner Portal)')
  }
  const verifyOnChain = opts.verifyOnChain ?? true
  let warnedNoKey = false

  function warnNoKey(log: Pick<Logger, 'warn'>) {
    if (opts.apiKey || warnedNoKey) return
    warnedNoKey = true
    log.warn('lifi: no apiKey. LI.FI allows 75 quote requests per two hours per IP without a key. Set lifi({ apiKey }) from the LI.FI Partner Portal.')
  }

  async function api<T>(ctx: Pick<AdapterContext, 'fetch'>, path: string, query: Record<string, string | undefined>): Promise<T> {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, v)
    return fetchJson<T>(ctx.fetch, `${baseUrl}${path}?${qs.toString()}`, { headers: opts.apiKey ? { 'x-lifi-api-key': opts.apiKey } : {}, timeoutMs: 8000 })
  }

  function rpcUrl(chain: string): string | undefined {
    return (opts.rpcUrls ?? {})[chain] ?? DEFAULT_RPC_URLS[chain]
  }

  async function decimalsOf(ctx: Pick<AdapterContext, 'fetch' | 'shared'>, asset: CryptoAsset): Promise<number> {
    if (typeof asset.decimals === 'number') return asset.decimals
    const known = knownDecimals(asset.chain, asset.token)
    if (known !== undefined) return known
    const k = `dec:${asset.chain}:${key(asset.token)}`
    const cached = await ctx.shared.get<number>(k)
    if (typeof cached === 'number') return cached
    const t = await api<LifiToken>(ctx, '/token', { chain: String(lifiChainId(asset.chain)), token: lifiToken(asset.chain, asset.token) }).catch((e) => {
      throw toOrk(e)
    })
    if (typeof t?.decimals !== 'number') throw new OrkException(orkError('BAD_REQUEST', { message: 'LI.FI does not know this token.' }))
    await ctx.shared.put(k, t.decimals, 7 * 24 * 60 * 60)
    return t.decimals
  }

  function withMeta(asset: CryptoAsset, decimals: number, symbol?: string): CryptoAsset {
    const s = asset.symbol ?? symbol ?? knownSymbol(asset.chain, asset.token)
    return { ...asset, decimals, ...(s ? { symbol: s } : {}) }
  }

  function recipientOf(ctx: AdapterContext, deliverTo?: { address: string }): string {
    if (deliverTo?.address) return deliverTo.address
    if (ctx.destination.type === 'crypto') return ctx.destination.address
    throw new OrkException(orkError('BAD_REQUEST', { message: 'LI.FI legs need a crypto destination.' }))
  }

  function destAsset(ctx: AdapterContext, legTo: CryptoAsset | undefined): CryptoAsset {
    if (legTo && legTo.chain !== '*' && legTo.token !== '*') return legTo
    const d = ctx.destination
    if (d.type !== 'crypto') throw new OrkException(orkError('BAD_REQUEST', { message: 'LI.FI legs need a crypto destination.' }))
    return { kind: 'crypto', chain: d.chain, token: d.token, ...(d.symbol ? { symbol: d.symbol } : {}), ...(d.decimals !== undefined ? { decimals: d.decimals } : {}) }
  }

  /** LI.FI cannot call a settlement contract: those payments go through another adapter. */
  function settles(ctx: AdapterContext, deliverTo?: { address: string }): boolean {
    const d = ctx.destination
    if (d.type !== 'crypto' || !d.settlement) return false
    return !deliverTo?.address || deliverTo.address.toLowerCase() === d.address.toLowerCase()
  }

  // ---------- leg spec ----------

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
      // TO VERIFY: withdraw sessions (the same leg shape as Relay `wallet`) are not tested with LI.FI.
      capabilities: ['polling'],
    },
  ]

  // ---------- quote ----------

  type QuoteParams = Record<string, string | undefined>

  async function fetchQuote(ctx: AdapterContext, exactOut: boolean, params: QuoteParams): Promise<LifiQuote> {
    const q = await api<LifiQuote>(ctx, exactOut ? '/quote/toAmount' : '/quote', params).catch((e) => {
      throw toOrk(e, ctx.log)
    })
    if (!q?.action?.fromToken || !q.action.toToken || !q.estimate || !big(q.estimate.fromAmount) || !big(q.estimate.toAmount) || big(q.estimate.toAmountMin) === undefined) {
      throw new OrkException(orkError('PROVIDER_UNAVAILABLE', { message: 'LI.FI returned an incomplete quote.' }), 502)
    }
    return q
  }

  async function quoteWallet(input: QuoteInput, ctx: AdapterContext): Promise<LegQuote> {
    const origin: CryptoAsset = input.source
      ? { kind: 'crypto', chain: input.source.chain, token: input.source.token }
      : cryptoAsset(input.amountIn ?? { amount: '0', asset: input.leg.from.asset }, 'source')
    if (!origin.chain.startsWith('eip155:') && origin.chain !== SOLANA_MAINNET) {
      throw new OrkException(orkError('NO_QUOTES', { message: 'LI.FI wallet payments support EVM chains and Solana only.' }), 422)
    }
    const dest = destAsset(ctx, input.leg.to.asset.kind === 'crypto' ? input.leg.to.asset : undefined)
    if (settles(ctx, input.deliverTo)) {
      throw new OrkException(orkError('NO_QUOTES', { message: 'LI.FI cannot pay into a settlement contract.' }), 422)
    }
    if (sameAsset(origin.chain, origin.token, dest.chain, dest.token)) {
      // A plain transfer needs no router. The Relay adapter covers it, with on-chain checks.
      throw new OrkException(orkError('NO_QUOTES', { message: 'LI.FI does not route a token to itself.' }), 422)
    }
    const recipient = recipientOf(ctx, input.deliverTo)
    if (!fitsChain(dest.chain, recipient)) throw new OrkException(orkError('BAD_REQUEST', { message: `The receiver is not a ${chainName(dest.chain)} address.` }))
    const user = fitsChain(origin.chain, input.source?.address) ? input.source!.address! : isSolana(origin.chain) ? PLACEHOLDER_SOLANA_USER : PLACEHOLDER_USER

    const exactOut = !input.amountIn && !!input.amountOut
    const inDec = await decimalsOf(ctx, { ...origin, ...(input.amountIn?.asset.kind === 'crypto' && input.amountIn.asset.decimals !== undefined ? { decimals: input.amountIn.asset.decimals } : {}) })
    const outDec = exactOut ? await decimalsOf(ctx, dest) : undefined
    const amount = exactOut ? input.amountOut!.amount : (input.amountIn?.amount ?? '0')
    if (cmp(amount, '0') <= 0) throw new OrkException(orkError('BAD_REQUEST', { message: 'Enter an amount to pay.' }))

    const params: QuoteParams = {
      fromChain: String(lifiChainId(origin.chain)),
      toChain: String(lifiChainId(dest.chain)),
      fromToken: lifiToken(origin.chain, origin.token),
      toToken: lifiToken(dest.chain, dest.token),
      fromAddress: user,
      toAddress: recipient,
      ...(exactOut ? { toAmount: toBaseUnits(amount, outDec!) } : { fromAmount: toBaseUnits(amount, inDec) }),
      ...(opts.integrator ? { integrator: opts.integrator } : {}),
      ...(opts.feeBps ? { fee: String(opts.feeBps / 10_000) } : {}),
      ...(opts.slippageBps !== undefined ? { slippage: String(Math.max(0, Math.min(10_000, Math.round(opts.slippageBps))) / 10_000) } : {}),
      ...(opts.order ? { order: opts.order } : {}),
    }
    const q = await fetchQuote(ctx, exactOut, params)
    checkRoute(q, params)
    const from = q.action.fromToken
    const to = q.action.toToken
    return {
      adapterId: 'lifi',
      legId: 'wallet',
      input: { amount: fromBaseUnits(q.estimate.fromAmount, from.decimals), asset: withMeta(origin, from.decimals, from.symbol) },
      output: { amount: fromBaseUnits(q.estimate.toAmount, to.decimals), asset: withMeta(dest, to.decimals, to.symbol) },
      fees: feesFrom(q),
      eta: etaFrom(q, legs[0]!.eta),
      expiresAt: new Date(Date.now() + WALLET_QUOTE_TTL_MS).toISOString(),
      data: {
        params,
        exactOut,
        user,
        quotedAt: Date.now(),
        step: q,
        recipient,
        minOutput: fromBaseUnits(q.estimate.toAmountMin, to.decimals),
        ...(q.tool ? { tool: q.tool } : {}),
      },
    }
  }

  /** The route must deliver what we asked for: the chains, the tokens and the receiver. */
  function checkRoute(q: LifiQuote, params: QuoteParams) {
    const a = q.action
    const toChain = caip2FromLifi(Number(params.toChain))
    const fromChain = caip2FromLifi(Number(params.fromChain))
    const ok =
      String(a.fromChainId) === params.fromChain &&
      String(a.toChainId) === params.toChain &&
      sameAsset(fromChain, a.fromToken.address, fromChain, params.fromToken!) &&
      sameAsset(toChain, a.toToken.address, toChain, params.toToken!) &&
      (a.toAddress === undefined || sameAddress(toChain, a.toAddress, params.toAddress!))
    if (!ok) throw new OrkException(orkError('PROVIDER_UNAVAILABLE', { message: 'LI.FI returned a route for another pair.' }), 502)
  }

  // ---------- start ----------

  async function allowanceOk(ctx: AdapterContext, chain: string, token: string, owner: string, spender: string, amount: bigint): Promise<boolean> {
    const url = rpcUrl(chain)
    if (!url) return false
    try {
      const r = await evmRpc<string>(ctx.fetch, url, 'eth_call', [{ to: token, data: erc20AllowanceData(owner, spender) }, 'latest'], { log: ctx.log })
      return typeof r === 'string' && r.startsWith('0x') && r.length > 2 && BigInt(r) >= amount
    } catch {
      return false // unknown: send the approval
    }
  }

  async function walletTxs(ctx: AdapterContext, q: LifiQuote, origin: CryptoAsset, user: string): Promise<TxRequest[]> {
    const t = q.transactionRequest
    if (!t?.data) throw new OrkException(orkError('PROVIDER_UNAVAILABLE', { message: 'LI.FI returned no transaction for this route.' }), 502)
    if (isSolana(origin.chain)) return [{ kind: 'solana', type: 'transaction', transaction: t.data }]
    const chainId = evmChainId(origin.chain)!
    if (!t.to || (t.chainId !== undefined && t.chainId !== chainId)) {
      throw new OrkException(orkError('PROVIDER_UNAVAILABLE', { message: 'LI.FI returned a transaction for another chain.' }), 502)
    }
    const txs: TxRequest[] = []
    const spender = q.estimate.approvalAddress
    // TO VERIFY: tokens like USDT on Ethereum need the allowance reset to 0 first; we do not reset it.
    if (!isNative(origin.chain, origin.token) && spender) {
      const amount = q.estimate.fromAmount
      if (!(await allowanceOk(ctx, origin.chain, origin.token, user, spender, BigInt(amount)))) {
        txs.push({ to: origin.token, data: erc20ApproveData(spender, amount), chainId })
      }
    }
    const value = quantity(t.value)
    const gas = quantity(t.gasLimit)
    txs.push({ to: t.to, data: t.data, ...(value && value !== '0' ? { value } : {}), chainId, ...(gas ? { gas } : {}) })
    return txs
  }

  async function startWallet(input: StartInput, ctx: AdapterContext): Promise<LegStep> {
    const data = (input.quote.data ?? {}) as Record<string, unknown>
    const origin = cryptoAsset(input.quote.input, 'input')
    const dest = cryptoAsset(input.quote.output, 'output')
    const params = data.params as QuoteParams | undefined
    if (!params) throw new OrkException(orkError('QUOTE_EXPIRED'), 410)
    // LI.FI builds the transaction for `fromAddress` (refunds go there too): we need the real wallet.
    const user = input.source?.address
    if (!fitsChain(origin.chain, user)) {
      throw new OrkException(orkError('BAD_REQUEST', { message: `Connect a ${isSolana(origin.chain) ? 'Solana' : 'EVM'} wallet to pay from ${chainName(origin.chain)}.`, recovery: 'choose_other' }))
    }
    let q = data.step as LifiQuote | undefined
    const fresh = typeof data.quotedAt === 'number' && Date.now() - data.quotedAt < WALLET_QUOTE_REUSE_MS
    if (!q || !fresh || !sameAddress(origin.chain, data.user as string | undefined, user)) {
      const p = { ...params, fromAddress: user }
      q = await fetchQuote(ctx, data.exactOut === true, p)
      checkRoute(q, p)
    }
    const txs = await walletTxs(ctx, q, origin, user)
    const ref = `lifi:${ctx.session.id}:${randomHex()}`
    const toDecimals = q.action.toToken.decimals
    const output: Amount = { amount: fromBaseUnits(q.estimate.toAmount, toDecimals), asset: { ...dest, decimals: toDecimals } }
    await ctx.store.put(
      `w:${ref}`,
      {
        fromChain: origin.chain,
        toChain: dest.chain,
        toToken: dest.token,
        recipient: params.toAddress!,
        minBase: q.estimate.toAmountMin,
        toDecimals,
        output,
        since: Date.now(),
        stepId: q.id,
        ...(q.tool ? { tool: q.tool } : {}),
      } satisfies WalletRecord,
      RECORD_TTL_SEC,
    )
    return { state: 'PAYMENT', surface: { kind: 'WALLET_TX', chain: origin.chain, txs }, transitions: [SUBMIT_TX], status: 'awaiting_user', ref }
  }

  // ---------- one transaction, one session ----------

  function ownerOf(ctx: AdapterContext, ref: string): string {
    return `${ctx.session.id}:${ref}`
  }

  function srcKey(chain: string, hash: string) {
    return `txused:${chain}:${key(hash)}`
  }

  // ---------- status ----------

  const fail = (ref: string, message: string, txHash?: string, recovery?: 'contact_support'): LegStep => ({
    state: 'FAILED',
    status: 'failed',
    transitions: [],
    ref,
    ...(txHash ? { txHash } : {}),
    error: orkError('DELIVERY_FAILED', { message, ...(recovery ? { recovery } : {}) }),
  })

  /**
   * LI.FI says DONE and COMPLETED. The leg completes only when the delivery is to our receiver, in our
   * token and chain, at least `minBase`, and (EVM tokens with an RPC) one unused Transfer log shows it.
   */
  async function verifyDelivery(ctx: AdapterContext, ref: string, rec: WalletRecord, s: LifiStatus): Promise<LegStep> {
    const recv = s.receiving
    const outHash = recv?.txHash
    const amount = big(recv?.amount)
    const toChainId = lifiChainId(rec.toChain)
    if (!recv || !outHash || amount === undefined) return { state: 'PROCESSING', sub: 'confirming', status: 'processing', transitions: [POLL_TRANSITION], ref, txHash: rec.txHash! }
    if (recv.chainId !== toChainId) return fail(ref, `LI.FI delivered on another chain than ${chainName(rec.toChain)}.`, outHash, 'contact_support')
    if (!recv.token || !sameAsset(rec.toChain, recv.token.address, rec.toChain, lifiToken(rec.toChain, rec.toToken))) {
      return fail(ref, 'LI.FI delivered another token.', outHash, 'contact_support')
    }
    if (!sameAddress(rec.toChain, s.toAddress, rec.recipient)) return fail(ref, 'LI.FI delivered to another address.', outHash, 'contact_support')
    const min = BigInt(rec.minBase)
    if (amount < min) return fail(ref, 'The delivery is less than the quoted minimum.', outHash, 'contact_support')
    const decimals = recv.token.decimals ?? rec.toDecimals
    let paid = amount

    if (verifyOnChain && !isSolana(rec.toChain) && !isNative(rec.toChain, rec.toToken) && rpcUrl(rec.toChain)) {
      const url = rpcUrl(rec.toChain)!
      const receipt = await evmRpc<DeliveryReceipt | null>(
        ctx.fetch,
        url,
        'eth_getTransactionReceipt',
        [outHash],
        { log: ctx.log },
      )
      if (!receipt) return { state: 'PROCESSING', sub: 'confirming', status: 'processing', transitions: [POLL_TRANSITION], ref, txHash: outHash }
      if (receipt.status !== '0x1') return fail(ref, 'The delivery transaction failed on chain.', outHash, 'contact_support')
      const token = rec.toToken.toLowerCase()
      const to = topicAddress(rec.recipient)
      const logs = (receipt.logs ?? [])
        .filter((l) => !l.removed && l.address.toLowerCase() === token && l.topics[0] === ERC20_TRANSFER_TOPIC && l.topics[2]?.toLowerCase() === to)
        .sort((a, b) => Number(BigInt(a.logIndex ?? '0x0') - BigInt(b.logIndex ?? '0x0')))
      const owner = ownerOf(ctx, ref)
      let found: bigint | undefined
      let taken = false
      // One log pays one session: the first log that pays at least the minimum and that no other session has.
      for (const l of logs) {
        const v = BigInt(l.data)
        if (v < min) continue
        const k = `${srcKey(rec.toChain, outHash)}:${BigInt(l.logIndex ?? '0x0').toString()}`
        if (!(await claimOnce(ctx.shared, k, owner, USED_TTL_SEC))) {
          taken = true
          continue
        }
        found = v
        break
      }
      if (found === undefined) {
        return fail(ref, taken ? 'This delivery was already used for another payment.' : 'The delivery transaction does not pay the destination the quoted minimum.', outHash, 'contact_support')
      }
      paid = found
    }
    return {
      state: 'COMPLETED',
      status: 'succeeded',
      transitions: [],
      ref,
      txHash: outHash,
      output: { ...rec.output, amount: fromBaseUnits(paid.toString(), decimals) },
    }
  }

  async function statusWallet(ctx: AdapterContext, ref: string): Promise<LegStep> {
    const rec = await ctx.store.get<WalletRecord>(`w:${ref}`)
    if (!rec) throw new OrkException(orkError('NOT_FOUND', { message: 'This LI.FI payment is not known.' }), 404)
    if (!rec.txHash) return { state: 'PAYMENT', transitions: [SUBMIT_TX], status: 'awaiting_user', ref }
    const txHash = rec.txHash
    const waiting = (sub: string): LegStep => ({ state: 'PROCESSING', sub, status: 'processing', transitions: [POLL_TRANSITION], ref, txHash })
    // One source transaction pays one session only.
    const usedBy = await ctx.shared.get<string>(srcKey(rec.fromChain, txHash))
    if (usedBy && usedBy !== ownerOf(ctx, ref)) return fail(ref, 'This transaction was already used for another payment.', txHash)

    let s: LifiStatus
    try {
      s = await api<LifiStatus>(ctx, '/status', { txHash, fromChain: String(lifiChainId(rec.fromChain)), toChain: String(lifiChainId(rec.toChain)) })
    } catch (e) {
      // 404 (code 1003): LI.FI has not indexed the hash yet. Normal for a minute or two.
      if (httpStatus(e) === 404) return waiting('not_found')
      throw toOrk(e, ctx.log)
    }
    // LI.FI also finds a transfer by its delivery hash: the hash the wallet gave must be the source.
    if (s.sending?.txHash && key(s.sending.txHash) !== key(txHash)) return fail(ref, 'The transaction is not the source of a LI.FI transfer.', txHash)
    if (s.sending?.chainId !== undefined && s.sending.chainId !== lifiChainId(rec.fromChain)) return fail(ref, `The transaction is not on ${chainName(rec.fromChain)}.`, txHash)
    // The source tx must be newer than this payment, and (when LI.FI stored the quote) be the one we built.
    if (typeof s.sending?.timestamp === 'number' && s.sending.timestamp * 1000 < rec.since - TX_CLOCK_SKEW_MS) {
      return fail(ref, 'The transaction was sent before this payment started.', txHash)
    }
    // TO VERIFY: `quote.stepId` equals the /quote `id` (LI.FI docs say so; not seen live yet).
    if (s.quote?.stepId && rec.stepId && s.quote.stepId !== rec.stepId) return fail(ref, 'The transaction is not the one built for this payment.', txHash)

    switch (s.status) {
      case 'DONE':
        if (s.substatus === 'REFUNDED') return { state: 'REFUNDED', status: 'refunded', transitions: [], ref, txHash }
        // PARTIAL: LI.FI delivered another token (the full value). The destination did not get its token.
        if (s.substatus === 'PARTIAL') return fail(ref, 'LI.FI delivered another token than the quote. Contact support.', s.receiving?.txHash ?? txHash, 'contact_support')
        if (s.substatus && s.substatus !== 'COMPLETED') return waiting(s.substatus.toLowerCase())
        return verifyDelivery(ctx, ref, rec, s)
      case 'FAILED':
        if (s.substatus === 'REFUNDED') return { state: 'REFUNDED', status: 'refunded', transitions: [], ref, txHash }
        return fail(ref, 'LI.FI could not complete the transfer.', txHash, 'contact_support')
      case 'INVALID':
        // TO VERIFY: LI.FI gives INVALID when the hash is not tied to the `bridge` param, which we do not send.
        return fail(ref, 'LI.FI does not know this transaction as a transfer.', txHash)
      default:
        // NOT_FOUND, PENDING (WAIT_SOURCE_CONFIRMATIONS, WAIT_DESTINATION_TRANSACTION, REFUND_IN_PROGRESS, ...)
        return waiting((s.substatus ?? s.status ?? 'pending').toLowerCase())
    }
  }

  return createAdapter({
    id: 'lifi',
    name: 'LI.FI',
    legs,

    async quote(input, ctx) {
      warnNoKey(ctx.log)
      if (input.leg.legId !== 'wallet') throw new OrkException(orkError('NOT_FOUND', { message: `Unknown LI.FI leg ${input.leg.legId}` }), 404)
      return quoteWallet(input, ctx)
    },

    async start(input, ctx) {
      if (input.leg.legId !== 'wallet') throw new OrkException(orkError('NOT_FOUND', { message: `Unknown LI.FI leg ${input.leg.legId}` }), 404)
      return startWallet(input, ctx)
    },

    async transition(input, ctx) {
      if (input.leg.legId !== 'wallet' || input.name !== 'submit_tx') {
        throw new OrkException(orkError('BAD_REQUEST', { message: `Transition ${input.name} is not supported.` }), 409)
      }
      const rec = await ctx.store.get<WalletRecord>(`w:${input.ref}`)
      if (!rec) throw new OrkException(orkError('NOT_FOUND', { message: 'This LI.FI payment is not known.' }), 404)
      const txHash = String(input.inputs?.txHash ?? input.inputs?.hash ?? '').trim()
      const ok = isSolana(rec.fromChain) ? isSolanaSignature(txHash) : /^0x[0-9a-fA-F]{64}$/.test(txHash)
      if (!ok) throw new OrkException(orkError('BAD_REQUEST', { message: 'A transaction hash is required.' }))
      if (rec.txHash && key(rec.txHash) !== key(txHash)) throw new OrkException(orkError('BAD_REQUEST', { message: 'This payment already has a transaction.' }), 409)
      // One source transaction pays one session only: refuse a hash that another payment holds.
      if (!(await claimOnce(ctx.shared, srcKey(rec.fromChain, txHash), ownerOf(ctx, input.ref), USED_TTL_SEC))) {
        throw new OrkException(orkError('BAD_REQUEST', { message: 'This transaction was already used for another payment.' }), 409)
      }
      await ctx.store.put(`w:${input.ref}`, { ...rec, txHash } satisfies WalletRecord, RECORD_TTL_SEC)
      return { state: 'PROCESSING', transitions: [POLL_TRANSITION], status: 'processing', ref: input.ref, txHash }
    },

    async status(input, ctx) {
      if (input.leg.legId !== 'wallet') throw new OrkException(orkError('NOT_FOUND', { message: `Unknown LI.FI leg ${input.leg.legId}` }), 404)
      return statusWallet(ctx, input.ref)
    },

    async health(ctx) {
      try {
        const res = await api<{ chains?: unknown[] }>(ctx, '/chains', { chainTypes: 'EVM,SVM' })
        return { ok: Array.isArray(res.chains) && res.chains.length > 0 }
      } catch (e) {
        return { ok: false, detail: String((e as Error)?.message ?? e).slice(0, 200) }
      }
    },
  })
}
