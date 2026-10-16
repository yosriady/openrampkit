// Flashnet Orchestra adapter (experimental): Cash App and Lightning onramp to USDC, deposits from
// Bitcoin and Tron to USDC through Orchestra deposit addresses, and payouts of USDC to a Cash App user
// or a Lightning address (withdraw). Docs: https://docs.flashnet.xyz/llms.txt
// and the OpenAPI spec at https://orchestration.flashnet.xyz/openapi.json (read on 2026-10-16).
//
// - Base URL: https://orchestration.flashnet.xyz. There is no sandbox in the docs or the spec.
// - Auth: `Authorization: Bearer fn_...` (a server key). Client keys (`fnp_`) are refused here.
//   Flashnet reviews new accounts before it enables the API (403 `account_pending_approval`).
// - Amounts are integer strings in the smallest unit of the asset (sats for BTC, 6 decimals for USDC).
// - Estimate (public): GET /v1/orchestration/estimate?sourceChain&sourceAsset&destinationChain&destinationAsset&amount
//   -> { estimatedOut, feeAmount, totalFeeAmount, feeAsset, feeBps, totalFeeAmountUsd?, destination{decimals} }.
// - Limits (public): GET /v1/orchestration/limits?... -> { routes: [{ limits: { fiatUsd: { supported, min, max } } }] }.
// - Onramp: POST /v1/orchestration/onramp (X-Idempotency-Key) with { destinationChain, destinationAsset,
//   recipientAddress, amountFiatUsd, tag } -> { orderId, quoteId, depositAddress (a BOLT11 invoice),
//   paymentLinks.cashApp, amountIn (sats), estimatedOut, expiresAt }. A 202 { orderId, status: 'paused' }
//   means a screening review. Pay with Cash App or any Lightning wallet. Not for residents of New York City.
// - Quote: POST /v1/orchestration/quote (X-Idempotency-Key) -> { quoteId, depositAddress, depositMemo?,
//   amountIn, estimatedOut, expiresAt }. Funding the address makes the order; no confirm call.
//   `refundAddress` is required for deposits from Tron.
// - Status: GET /v1/orchestration/status?quoteId= -> { order } (404 before the deposit is seen). Flat order
//   fields: status, quoteId, destinationChain, destinationAsset, destinationAddress, recipientAddress,
//   destinationTxHash, sourceTxHash, refundTxHash, amountOut, errorCode.
// - Webhooks: { event, timestamp, data: order } with nested source/destination/refund/error objects.
//   `X-Flashnet-Timestamp` (ms) and `X-Flashnet-Signature` (hex HMAC-SHA256 of `{timestamp}.{rawBody}`).
//   Dedupe on (data.id, event, data.updatedAt). Register with POST /v1/webhooks (the secret is shown once).
//
// - Offramp (payouts): POST /v1/orchestration/offramp (X-Idempotency-Key) with { sourceChain, sourceAsset,
//   amount, recipientAddress ($cashtag or user@domain), refundAddress, tag } -> the quote answer
//   ({ quoteId, depositAddress, amountIn, estimatedOut (sats), expiresAt, source, destination }). Exact in,
//   variable delivery: the dollar amount is not locked. Funding the deposit address makes the order.
//   `completed` means the Lightning payment was delivered, not that Cash App credited dollars.
//   The withdraw target is the server's validated `lightning` destination (never a client value).
//   Sources: USDC on Base, Ethereum, Arbitrum, Optimism and Polygon (routes.json lists `lightning:BTC`
//   for them). The user's wallet or the app's treasury sends an ERC-20 transfer that we build (WALLET_TX).
//
// Server-side only. Web-standard APIs only (fetch, WebCrypto), so it runs on Cloudflare Workers.

import {
  POLL,
  awaitPoll,
  ERC20_TRANSFER_TOPIC,
  erc20TransferData,
  evmRpc,
  topicAddress,
  bytesToHex,
  claimOnce,
  createAdapter,
  deliverableToAsset,
  fetchJson,
  httpErrorToOpenRamp,
  httpStatus,
  legStepFromEvent,
  providerMessage,
  quoteExpiresAt,
  requireDeliverAsset,
  resolveEnv,
  statusMap,
  verifyTimestampedHmac,
} from '@openrampkit/adapter'
import type { AdapterContext, AdapterEnv, DeliverableAsset, LegEvent, Logger, ScopedKV } from '@openrampkit/adapter'
import {
  BITCOIN_MAINNET,
  LIGHTNING,
  LIGHTNING_BTC,
  OpenRampException,
  SOLANA_MAINNET,
  TRON_MAINNET,
  TRON_USDT,
  USDC,
  chainName,
  cmp,
  evmChainId,
  fromBaseUnits,
  isDecimal,
  openRampError,
  parseLightningTarget,
  roundTo,
  sameLightningAddress,
  toBaseUnits,
} from '@openrampkit/core'
import type { Amount, CryptoAsset, Fee, LegQuote, LegSpec, LegStatus, LegStep, OpenRampErrorCode, PathwayLeg, StepDetailCode, Surface } from '@openrampkit/core'
import { bolt11ExpiresAt, decodeBolt11 } from './bolt11.js'

export { decodeBolt11 } from './bolt11.js'
export type { Bolt11 } from './bolt11.js'

export type FlashnetLeg = 'cash_app' | 'lightning' | 'transfer' | 'cash_app_payout' | 'lightning_payout'

/** The payout (withdraw) legs: USDC to a Cash App user or to a Lightning address */
type PayoutLeg = 'cash_app_payout' | 'lightning_payout'
const isPayout = (id: FlashnetLeg): id is PayoutLeg => id === 'cash_app_payout' || id === 'lightning_payout'

export type FlashnetDeliverAsset = DeliverableAsset & {
  /** Orchestra chain id, e.g. `base` */
  fnChain: string
  /** Orchestra asset id, e.g. `USDC` */
  fnAsset: string
}

export type FlashnetOptions = {
  /** Server key (`fn_...`) from the Orchestra dashboard. Server-side only. */
  apiKey: string
  /** Orchestra has production only. Default 'production'; 'sandbox' throws. */
  env?: AdapterEnv
  /** The webhook signing secret (returned once by POST /v1/webhooks). Without it, every webhook is rejected. */
  webhookSecret?: string
  /** Assets Orchestra may deliver, most preferred first. Default: USDC on Base, Solana, Ethereum, Arbitrum, Optimism, Polygon. */
  deliverAssets?: FlashnetDeliverAsset[]
  /**
   * The legs to offer. Default: all (`cash_app`, `lightning`, `transfer`, and the withdraw legs
   * `cash_app_payout` and `lightning_payout`).
   */
  legs?: FlashnetLeg[]
  /** How the Lightning invoice shows. 'qr' (default): a QR code (scan with a phone). 'deeplink': a button that opens Cash App or the wallet. */
  invoiceSurface?: 'qr' | 'deeplink'
  /**
   * Refund addresses per origin chain, used when the user's own address is not known. Orchestra needs one
   * for Tron deposits. A refund then goes to this address (yours), not to the user.
   */
  refundAddresses?: { tron?: string; bitcoin?: string; evm?: string }
  /**
   * Payouts: JSON-RPC URLs per CAIP-2 chain (for example `{ 'eip155:8453': 'https://mainnet.base.org' }`).
   * With one, `submit_tx` reads the receipt and binds the funding transaction to the payout only when it
   * is a confirmed USDC transfer of the quoted amount from the sender to this payout's deposit address.
   * Without one, a reported hash is never trusted: the payout waits for Orchestra to see the deposit.
   */
  rpcUrls?: Record<string, string>
  /** Payouts: the confirmations a funding transaction needs before it is bound (default 2) */
  payoutConfirmations?: number
  apiUrl?: string
}

/** Orchestra chain id per CAIP-2 chain (OpenAPI chain enum) */
const FN_CHAIN: Record<string, string> = {
  'eip155:8453': 'base',
  'eip155:1': 'ethereum',
  'eip155:42161': 'arbitrum',
  'eip155:10': 'optimism',
  'eip155:137': 'polygon',
  [SOLANA_MAINNET]: 'solana',
  [BITCOIN_MAINNET]: 'bitcoin',
  [TRON_MAINNET]: 'tron',
}

const usdc = (chain: string, symbol = 'USDC'): FlashnetDeliverAsset => ({ chain, token: USDC[chain]!, symbol, decimals: 6, fnChain: FN_CHAIN[chain]!, fnAsset: 'USDC' })

export const DEFAULT_DELIVER_ASSETS: FlashnetDeliverAsset[] = [
  usdc('eip155:8453'),
  usdc(SOLANA_MAINNET),
  usdc('eip155:1'),
  usdc('eip155:42161'),
  usdc('eip155:10'),
  usdc('eip155:137'),
]

/** What a `transfer` leg takes: BTC on Bitcoin and USDT on Tron (decimals confirmed from GET /v2/orchestration/routes) */
type SourceDef = { chain: string; token: string; symbol: string; decimals: number; fnChain: string; fnAsset: string }
export const FLASHNET_SOURCES: SourceDef[] = [
  { chain: BITCOIN_MAINNET, token: 'native', symbol: 'BTC', decimals: 8, fnChain: 'bitcoin', fnAsset: 'BTC' },
  { chain: TRON_MAINNET, token: TRON_USDT, symbol: 'USDT', decimals: 6, fnChain: 'tron', fnAsset: 'USDT' },
]

/** What a payout leg takes: USDC on the EVM chains whose route lists `lightning:BTC` (routes.json, read on 2026-10-16) */
export const FLASHNET_PAYOUT_SOURCES: SourceDef[] = ['eip155:8453', 'eip155:1', 'eip155:42161', 'eip155:10', 'eip155:137'].map((chain) => ({
  chain,
  token: USDC[chain]!.toLowerCase(),
  symbol: 'USDC',
  decimals: 6,
  fnChain: FN_CHAIN[chain]!,
  fnAsset: 'USDC',
}))

/** What a payout delivers: BTC over Lightning, in sats (Orchestra `lightning:BTC`, 8 decimals) */
const LN_OUT: FlashnetDeliverAsset = { chain: LIGHTNING, token: 'native', symbol: 'BTC', decimals: 8, fnChain: 'lightning', fnAsset: 'BTC' }

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const EVM_ZERO = /^0x0{40}$/
const EVM_TX = /^0x[0-9a-fA-F]{64}$/
const BITCOIN_ADDRESS = /^(?:[13][1-9A-HJ-NP-Za-km-z]{25,34}|bc1[ac-hj-np-z02-9]{11,71}|BC1[AC-HJ-NP-Z02-9]{11,71})$/
const TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/
const HASH = /^(0x)?[A-Za-z0-9]{16,128}$/
const INT = /^[0-9]{1,40}$/

/** Nominal amount (sats) to read the rate of a Lightning route */
const NOMINAL_SATS = '100000'
/** The least time an invoice must have left when we show it */
const MIN_INVOICE_LEFT_MS = 60_000
/** After the invoice expires with no order, wait this long before the leg expires (a payment at the last second) */
const INVOICE_GRACE_MS = 60_000
const RECORD_TTL_SEC = 30 * 24 * 3600
const CLAIM_TTL_SEC = 90 * 24 * 3600
const FIAT_LIMITS = { min: '1', max: '50000' }

type FnEstimate = {
  estimatedOut?: string
  feeAmount?: string
  totalFeeAmount?: string
  feeBps?: number
  feeAmountUsd?: string
  totalFeeAmountUsd?: string
  destination?: { chain?: string; asset?: string; decimals?: number }
}

type FnQuote = FnEstimate & {
  quoteId?: string
  orderId?: string
  status?: string
  depositAddress?: string
  depositMemo?: string
  amountIn?: string
  expiresAt?: string
  recipientAddress?: string
}

/** Flat order from GET /status */
type FnOrder = {
  id?: string
  status?: string
  quoteId?: string | null
  updatedAt?: string
  sourceChain?: string | null
  sourceAsset?: string | null
  destinationChain?: string | null
  destinationAsset?: string | null
  destinationAddress?: string | null
  recipientAddress?: string | null
  destinationTxHash?: string | null
  sourceTxHash?: string | null
  refundTxHash?: string | null
  amountIn?: string | null
  amountOut?: string | null
  errorCode?: string | null
}

/** Webhook `data`: nested source, destination, refund and error */
type FnHookOrder = {
  id?: string
  status?: string
  quoteId?: string | null
  updatedAt?: string
  amountIn?: string | null
  amountOut?: string | null
  recipientAddress?: string | null
  source?: { chain?: string | null; asset?: string | null; txHash?: string | null } | null
  destination?: { chain?: string | null; asset?: string | null; address?: string | null; txHash?: string | null } | null
  refund?: { txHash?: string | null } | null
  error?: { code?: string | null } | null
}

/** One order in one shape */
type Order = {
  id?: string
  status?: string
  quoteId?: string
  srcChain?: string
  srcAsset?: string
  destChain?: string
  destAsset?: string
  destAddress?: string
  recipient?: string
  destTx?: string
  sourceTx?: string
  refundTx?: string
  amountIn?: string
  amountOut?: string
  errorCode?: string
}

/** What a started leg expects. Kept in the session store and in `shared` (webhooks have no session store). */
type LegRecord = {
  legId: FlashnetLeg
  recipient: string
  output: CryptoAsset & { decimals: number }
  fnChain: string
  fnAsset: string
  /** Transfer legs: the origin chain (CAIP-2) */
  sourceChain?: string
  /** Lightning legs: when the invoice expires (ms) */
  invoiceExpiresAt?: number
  /**
   * Payout legs: what the sender must send. `fundTx` is set only after the receipt proved that the
   * transaction paid this deposit address (never from a hash that a client reported).
   */
  payout?: { fnChain: string; fnAsset: string; token: string; amount: string; depositAddress: string; sender?: string; fundTx?: string }
}

type Mapped = { status: LegStatus; detail?: StepDetailCode; special?: 'failed' | 'fallback' | 'expired' }

/**
 * Orchestra order statuses (https://docs.flashnet.xyz/orchestra/status.md). Money safety: an order exists
 * only after the deposit, so `failed`, `fallback_delivered` and an expired order with a deposit stay
 * `processing` with `delayed`, and the operator gets an error log. They never show a failure with "try again".
 */
const STATUS = statusMap<Mapped>('Flashnet', {
  processing: { status: 'processing', detail: 'processing' },
  confirming: { status: 'processing', detail: 'confirming' },
  awaiting_approval: { status: 'processing', detail: 'delayed' },
  swapping: { status: 'processing', detail: 'settling' },
  bridging: { status: 'processing', detail: 'bridging' },
  delivering: { status: 'processing', detail: 'settling' },
  refunding: { status: 'processing', detail: 'refunding' },
  // The docs say internal paused states show as processing; the onramp 202 answer shows `paused`.
  paused: { status: 'processing', detail: 'delayed' },
  // "Unconfirmed or replaced deposit; can resume"
  unfulfilled: { status: 'processing', detail: 'delayed' },
  completed: { status: 'succeeded' },
  refunded: { status: 'refunded' },
  failed: { status: 'processing', detail: 'delayed', special: 'failed' },
  fallback_delivered: { status: 'processing', detail: 'delayed', special: 'fallback' },
  expired: { status: 'processing', detail: 'delayed', special: 'expired' },
})

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

function fromStatus(o: FnOrder): Order {
  return {
    id: str(o.id),
    status: str(o.status),
    quoteId: str(o.quoteId),
    srcChain: str(o.sourceChain),
    srcAsset: str(o.sourceAsset),
    destChain: str(o.destinationChain),
    destAsset: str(o.destinationAsset),
    destAddress: str(o.destinationAddress),
    recipient: str(o.recipientAddress),
    destTx: str(o.destinationTxHash),
    sourceTx: str(o.sourceTxHash),
    refundTx: str(o.refundTxHash),
    amountIn: str(o.amountIn),
    amountOut: str(o.amountOut),
    errorCode: str(o.errorCode),
  }
}

function fromHook(d: FnHookOrder): Order {
  return {
    id: str(d.id),
    status: str(d.status),
    quoteId: str(d.quoteId),
    srcChain: str(d.source?.chain),
    srcAsset: str(d.source?.asset),
    destChain: str(d.destination?.chain),
    destAsset: str(d.destination?.asset),
    destAddress: str(d.destination?.address),
    recipient: str(d.recipientAddress),
    destTx: str(d.destination?.txHash),
    sourceTx: str(d.source?.txHash),
    refundTx: str(d.refund?.txHash),
    amountIn: str(d.amountIn),
    amountOut: str(d.amountOut),
    errorCode: str(d.error?.code),
  }
}

/** Two addresses on a chain are the same (EVM without case; Lightning addresses parsed, without case; others exact) */
function sameAddress(chain: string, a: string | undefined, b: string): boolean {
  if (!a) return false
  if (chain === LIGHTNING) return sameLightningAddress(a, b)
  return chain.startsWith('eip155:') ? a.toLowerCase() === b.toLowerCase() : a === b
}

async function sha256Hex(s: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
}

/** Orchestra error code from `{ error: { code } }` */
function errorCode(e: unknown): string | undefined {
  const body = (e as { body?: unknown } | undefined)?.body as { error?: { code?: unknown } } | undefined
  const c = body?.error?.code
  return typeof c === 'string' ? c : undefined
}

/** A failed Orchestra call as an OpenRampException, with the documented error codes (https://docs.flashnet.xyz/api/errors.md) */
function flashnetError(e: unknown, log: Pick<Logger, 'warn' | 'error'>, what: string): OpenRampException {
  const code = errorCode(e)
  const status = httpStatus(e)
  const msg = providerMessage(e)
  const own = (c: OpenRampErrorCode, message: string, http = 422, recovery: 'requote' | 'choose_other' = 'choose_other') =>
    new OpenRampException(openRampError(c, { message: `Flashnet: ${msg ?? message}`.slice(0, 200), recovery }), http)
  if (status !== undefined && status < 500 && status !== 401 && status !== 403 && status !== 429) {
    if (code === 'amount_too_small') return own('AMOUNT_TOO_LOW', 'the amount is too low.', 422, 'requote')
    if (code === 'amount_too_large' || code === 'amount_exceeds_liquidity') return own('AMOUNT_TOO_HIGH', 'the amount is too high.', 422, 'requote')
    if (code === 'quote_expired' || code === 'expired') return own('QUOTE_EXPIRED', 'the quote expired.', 409, 'requote')
  }
  if (status === 403 && (code === 'sanctioned_address' || code === 'screening_blocked')) {
    return own('PROVIDER_DECLINED', 'this payment was declined.', 403)
  }
  return httpErrorToOpenRamp(e, 'Flashnet', {
    what,
    log,
    setupHint: 'Check the Flashnet apiKey (a server key, fn_...). Flashnet must approve the account before the API works (account_pending_approval).',
  })
}

const unavailable = (message: string) => new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message, recovery: 'choose_other' }), 502)

export function flashnet(opts: FlashnetOptions) {
  if (!opts.apiKey || !opts.apiKey.startsWith('fn_')) throw new Error('flashnet: apiKey must be a server key (fn_...). Client keys (fnp_) are for browsers.')
  const env = resolveEnv('flashnet', opts.env, undefined, 'production')
  if (env === 'sandbox') throw new Error('flashnet: Orchestra has no sandbox. Use env: \'production\' with small amounts.')
  const api = (opts.apiUrl ?? 'https://orchestration.flashnet.xyz').replace(/\/+$/, '')
  const headers = { authorization: `Bearer ${opts.apiKey}` }
  const deliver = opts.deliverAssets?.length ? opts.deliverAssets : DEFAULT_DELIVER_ASSETS
  const enabled = (id: FlashnetLeg) => !opts.legs || opts.legs.includes(id)
  for (const d of deliver) if (!d.fnChain || !d.fnAsset || d.decimals === undefined) throw new Error('flashnet: each deliver asset needs fnChain, fnAsset and decimals')
  const toChains: Record<string, string[]> = {}
  for (const d of deliver) (toChains[d.chain] ??= []).push(d.chain.startsWith('eip155:') ? d.token.toLowerCase() : d.token)
  const fromChains: Record<string, string[]> = {}
  for (const s of FLASHNET_SOURCES) (fromChains[s.chain] ??= []).push(s.token)
  const payoutChains: Record<string, string[]> = {}
  for (const s of FLASHNET_PAYOUT_SOURCES) (payoutChains[s.chain] ??= []).push(s.token)

  const legs: LegSpec[] = []
  if (enabled('cash_app')) {
    legs.push({
      id: 'cash_app',
      kind: 'fiat_onramp',
      methods: ['cash_app'],
      from: { asset: { kind: 'fiat', currencies: ['USD'] }, location: ['user_account'] },
      to: { asset: { kind: 'crypto', chains: toChains }, location: ['address'] },
      // Cash App is US only. The onramp is not for residents of New York City; we deny the whole state (TO VERIFY with Flashnet).
      regions: { allow: ['US'], deny: ['US-NY'] },
      limits: { ...FIAT_LIMITS, currency: 'USD' },
      eta: { min: 10, max: 600 },
      surfaces: ['QR', 'DEEPLINK'],
    })
  }
  if (enabled('lightning')) {
    legs.push({
      id: 'lightning',
      kind: 'fiat_onramp',
      methods: ['lightning'],
      // The amount is in USD; the user pays the BTC invoice from any Lightning wallet.
      from: { asset: { kind: 'fiat', currencies: ['USD'] }, location: ['user_account'] },
      to: { asset: { kind: 'crypto', chains: toChains }, location: ['address'] },
      regions: { allow: ['*'], deny: ['US-NY'] },
      limits: { ...FIAT_LIMITS, currency: 'USD' },
      eta: { min: 10, max: 600 },
      surfaces: ['QR', 'DEEPLINK'],
    })
  }
  if (enabled('transfer')) {
    legs.push({
      id: 'transfer',
      kind: 'bridge_swap',
      methods: ['transfer'],
      from: { asset: { kind: 'crypto', chains: fromChains }, location: ['user_wallet'] },
      to: { asset: { kind: 'crypto', chains: toChains }, location: ['address'] },
      regions: { allow: ['*'], deny: [] },
      // Bitcoin needs confirmations; Tron is faster
      eta: { min: 60, max: 3600 },
      surfaces: ['DEPOSIT_ADDRESS'],
    })
  }
  // Withdraw: USDC from the user's wallet or the app's treasury, paid out over Lightning
  const payoutLeg = (id: PayoutLeg): LegSpec => ({
    id,
    kind: 'crypto_offramp',
    methods: [id === 'cash_app_payout' ? 'cash_app' : 'lightning'],
    from: { asset: { kind: 'crypto', chains: payoutChains }, location: ['user_wallet', 'address'] },
    to: { asset: { kind: 'crypto', chains: { [LIGHTNING]: ['native'] } }, location: [id === 'cash_app_payout' ? 'cash_app' : 'lightning_address'] },
    // Cash App is US only. TO VERIFY with Flashnet: the region rules of the offramp (the onramp excludes New York City).
    regions: id === 'cash_app_payout' ? { allow: ['US'], deny: ['US-NY'] } : { allow: ['*'], deny: ['US-NY'] },
    eta: { min: 60, max: 1800 },
    surfaces: ['WALLET_TX'],
  })
  if (enabled('cash_app_payout')) legs.push(payoutLeg('cash_app_payout'))
  if (enabled('lightning_payout')) legs.push(payoutLeg('lightning_payout'))
  if (!legs.length) throw new Error('flashnet: `legs` selects no leg')

  const legId = (leg: PathwayLeg): FlashnetLeg => {
    const id = leg.legId as FlashnetLeg
    if (!legs.some((l) => l.id === id)) throw new OpenRampException(openRampError('BAD_REQUEST', { message: `Unknown Flashnet leg ${leg.legId}` }), 400)
    return id
  }

  const get = <T>(ctx: Pick<AdapterContext, 'fetch'>, path: string, q: Record<string, string>) =>
    fetchJson<T>(ctx.fetch, `${api}${path}?${new URLSearchParams(q)}`, { headers })

  async function post<T>(ctx: AdapterContext, path: string, body: Record<string, unknown>): Promise<T> {
    // The same request gives the same key: a retry gets the stored answer. A changed request gets a new key.
    const key = ctx.idempotencyKey(`flashnet:${path.split('/').pop()}:${await sha256Hex(JSON.stringify(body))}`)
    return fetchJson<T>(ctx.fetch, `${api}${path}`, { method: 'POST', headers: { ...headers, 'x-idempotency-key': key }, body: JSON.stringify(body) })
  }

  /** The recipient: the next leg's deposit address, else the session's own destination. Never from the provider. */
  function recipientFor(ctx: AdapterContext, deliverTo: { address: string } | undefined, target: FlashnetDeliverAsset): string {
    if (deliverTo?.address) return deliverTo.address
    const d = ctx.destination
    if (d.type !== 'crypto' || d.chain !== target.chain || !sameAddressToken(d.chain, d.token, target.token)) {
      throw new OpenRampException(openRampError('BAD_REQUEST', { message: 'Flashnet delivers only to the session destination.' }), 400)
    }
    return d.address
  }

  function sameAddressToken(chain: string, a: string, b: string): boolean {
    return chain.startsWith('eip155:') ? a.toLowerCase() === b.toLowerCase() : a === b
  }

  /** The answer names the asset we asked for (when it names one), with the decimals we use */
  function checkDestination(res: FnEstimate, target: FlashnetDeliverAsset) {
    const d = res.destination
    if (!d) return
    if ((d.chain && d.chain !== target.fnChain) || (d.asset && d.asset !== target.fnAsset) || (d.decimals !== undefined && d.decimals !== target.decimals)) {
      throw unavailable('Flashnet answered for another asset.')
    }
  }

  async function estimate(ctx: AdapterContext, src: { fnChain: string; fnAsset: string }, target: FlashnetDeliverAsset, amount: string): Promise<FnEstimate> {
    let r: FnEstimate
    try {
      r = await get<FnEstimate>(ctx, '/v1/orchestration/estimate', {
        sourceChain: src.fnChain,
        sourceAsset: src.fnAsset,
        destinationChain: target.fnChain,
        destinationAsset: target.fnAsset,
        amount,
      })
    } catch (e) {
      throw flashnetError(e, ctx.log, 'price this amount')
    }
    if (!r || !INT.test(r.estimatedOut ?? '') || BigInt(r.estimatedOut!) <= 0n) {
      throw new OpenRampException(openRampError('NO_QUOTES', { message: 'Flashnet did not return a price for this amount.' }), 422)
    }
    checkDestination(r, target)
    return r
  }

  /** The USD limits of the Lightning route, from GET /limits. Static limits when the call fails. */
  async function fiatLimits(ctx: AdapterContext, target: FlashnetDeliverAsset): Promise<{ min: string; max: string }> {
    try {
      const r = await get<{ routes?: Array<{ limits?: { fiatUsd?: { supported?: boolean; min?: string; max?: string } } }> }>(ctx, '/v1/orchestration/limits', {
        sourceChain: 'lightning',
        sourceAsset: 'BTC',
        destinationChain: target.fnChain,
        destinationAsset: target.fnAsset,
      })
      const f = r?.routes?.[0]?.limits?.fiatUsd
      if (f?.supported === false) throw new OpenRampException(openRampError('NO_QUOTES', { message: 'Flashnet has no USD onramp to this asset.', recovery: 'choose_other' }), 422)
      if (f && isDecimal(f.min ?? '') && isDecimal(f.max ?? '')) return { min: f.min!, max: f.max! }
    } catch (e) {
      if (e instanceof OpenRampException) throw e
      ctx.log.warn('flashnet: GET /limits failed; using the static limits', { error: String((e as Error)?.message ?? e).slice(0, 200) })
    }
    return FIAT_LIMITS
  }

  function usdFee(r: FnEstimate): Fee {
    const usd = r.totalFeeAmountUsd ?? r.feeAmountUsd
    return isDecimal(usd ?? '')
      ? { kind: 'provider', label: 'Flashnet fee', amount: { value: roundTo(usd!, 2), asset: { kind: 'fiat', currency: 'USD' } }, included: true }
      : { kind: 'provider', label: 'Flashnet fee', amount: null, included: true }
  }

  async function quoteLightning(id: 'cash_app' | 'lightning', input: { leg: PathwayLeg; amountIn?: Amount; amountOut?: Amount }, ctx: AdapterContext): Promise<LegQuote> {
    const target = requireDeliverAsset(deliver, input.leg.to.asset, 'Flashnet')
    if (input.amountIn?.asset.kind !== 'fiat' || input.amountIn.asset.currency.toUpperCase() !== 'USD') {
      throw new OpenRampException(openRampError('NO_QUOTES', { message: 'Flashnet quotes this method in USD you pay.', recovery: 'choose_other' }), 422)
    }
    const usd = roundTo(input.amountIn.value, 2)
    const lim = await fiatLimits(ctx, target)
    if (cmp(usd, lim.min) < 0) throw new OpenRampException(openRampError('AMOUNT_TOO_LOW', { message: `The Flashnet minimum is ${lim.min} USD.`, recovery: 'requote' }), 422)
    if (cmp(usd, lim.max) > 0) throw new OpenRampException(openRampError('AMOUNT_TOO_HIGH', { message: `The Flashnet maximum is ${lim.max} USD.`, recovery: 'requote' }), 422)
    const ln = { fnChain: 'lightning', fnAsset: 'BTC' }
    // The estimate takes sats, not USD. Read the rate with a nominal amount, then price the sats for `usd`.
    // TO VERIFY: Cash App converts USD to sats at its own rate, so the delivered amount can differ a little.
    const nominal = await estimate(ctx, ln, target, NOMINAL_SATS)
    const feeUsd = Number(nominal.totalFeeAmountUsd ?? nominal.feeAmountUsd ?? '0')
    const nominalUsd = Number(fromBaseUnits(nominal.estimatedOut!, target.decimals!)) + (Number.isFinite(feeUsd) ? feeUsd : 0)
    if (!(nominalUsd > 0)) throw new OpenRampException(openRampError('NO_QUOTES', { message: 'Flashnet did not return a price.' }), 422)
    const sats = String(Math.ceil((Number(usd) * Number(NOMINAL_SATS)) / nominalUsd))
    const r = await estimate(ctx, ln, target, sats)
    const fees: Fee[] = [usdFee(r)]
    if (id === 'cash_app') fees.push({ kind: 'other', label: 'Cash App USD to bitcoin rate', amount: null, included: true })
    const usdAmount: Amount = { value: usd, asset: { kind: 'fiat', currency: 'USD' } }
    return {
      adapterId: 'flashnet',
      legId: id,
      input: usdAmount,
      output: { value: fromBaseUnits(r.estimatedOut!, target.decimals!), asset: deliverableToAsset(target) },
      fees,
      // The rate is set when the invoice is made and paid.
      guarantee: 'estimate',
      eta: { min: 10, max: 600 },
      // Orchestra quotes last 2 minutes
      expiresAt: quoteExpiresAt(2),
      limits: { ...lim, currency: 'USD' },
      data: { usd, sats },
    }
  }

  function sourceOf(input: { leg: PathwayLeg; source?: { chain: string; token: string } }): SourceDef {
    const a = input.source ?? (input.leg.from.asset.kind === 'crypto' ? input.leg.from.asset : undefined)
    const s = a && FLASHNET_SOURCES.find((x) => x.chain === a.chain && x.token === a.token)
    if (!s) throw new OpenRampException(openRampError('NO_QUOTES', { message: 'Flashnet takes BTC on Bitcoin or USDT on Tron here.', recovery: 'choose_other' }), 422)
    return s
  }

  /** Where a refund goes: the user's own address on the origin chain, else the app's configured address */
  function refundFor(src: SourceDef, sender: string | undefined): string | undefined {
    const valid = (a: string | undefined) => !!a && (src.chain === TRON_MAINNET ? TRON_ADDRESS.test(a) : BITCOIN_ADDRESS.test(a))
    if (valid(sender)) return sender
    const conf = src.chain === TRON_MAINNET ? opts.refundAddresses?.tron : opts.refundAddresses?.bitcoin
    return valid(conf) ? conf : undefined
  }

  async function quoteTransfer(input: { leg: PathwayLeg; amountIn?: Amount; amountOut?: Amount; source?: { chain: string; token: string; address?: string } }, ctx: AdapterContext): Promise<LegQuote> {
    const target = requireDeliverAsset(deliver, input.leg.to.asset, 'Flashnet')
    const src = sourceOf(input)
    if (!input.amountIn || input.amountIn.asset.kind !== 'crypto') {
      throw new OpenRampException(openRampError('NO_QUOTES', { message: 'Flashnet needs the amount you send.', recovery: 'choose_other' }), 422)
    }
    // Orchestra requires a refund address for Tron deposits (quotes page)
    if (src.chain === TRON_MAINNET && !refundFor(src, input.source?.address)) {
      throw new OpenRampException(openRampError('NO_QUOTES', { message: 'Flashnet needs a Tron refund address for this deposit.', recovery: 'choose_other' }), 422)
    }
    const amount = toBaseUnits(roundTo(input.amountIn.value, src.decimals), src.decimals)
    const r = await estimate(ctx, src, target, amount)
    return {
      adapterId: 'flashnet',
      legId: 'transfer',
      input: { value: fromBaseUnits(amount, src.decimals), asset: { kind: 'crypto', chain: src.chain, token: src.token, symbol: src.symbol, decimals: src.decimals } },
      output: { value: fromBaseUnits(r.estimatedOut!, target.decimals!), asset: deliverableToAsset(target) },
      fees: [usdFee(r)],
      // Late funding gets new pricing (integration page), so the output is an estimate.
      guarantee: 'estimate',
      eta: { min: 60, max: 3600 },
      expiresAt: quoteExpiresAt(2),
      data: { amount },
    }
  }

  const recKey = (ref: string) => `rec:${ref}`

  async function saveRecord(ctx: AdapterContext, ref: string, rec: LegRecord) {
    await ctx.store.put(recKey(ref), rec, RECORD_TTL_SEC)
    await ctx.shared.put(recKey(ref), rec, RECORD_TTL_SEC)
  }

  async function startLightning(id: 'cash_app' | 'lightning', input: { quote: LegQuote; deliverTo?: { address: string } }, ctx: AdapterContext): Promise<LegStep> {
    const target = requireDeliverAsset(deliver, input.quote.output.asset, 'Flashnet')
    const recipient = recipientFor(ctx, input.deliverTo, target)
    const data = (input.quote.data ?? {}) as { usd?: string }
    const usd = roundTo(data.usd ?? input.quote.input.value, 2)
    const body = {
      destinationChain: target.fnChain,
      destinationAsset: target.fnAsset,
      recipientAddress: recipient,
      amountFiatUsd: Number(usd).toFixed(2),
      tag: tagFor(ctx),
    }
    let res: FnQuote
    try {
      res = await post<FnQuote>(ctx, '/v1/orchestration/onramp', body)
    } catch (e) {
      throw flashnetError(e, ctx.log, 'create this payment')
    }
    // 202: kept for a screening review, with no invoice. Nothing was paid, so the user can choose another method.
    if (res?.status === 'paused' || !res?.depositAddress) {
      ctx.log.warn('flashnet: onramp order held for review; no invoice', { orderId: res?.orderId })
      throw new OpenRampException(openRampError('PROVIDER_DECLINED', { message: 'Flashnet cannot take this payment now. Choose another method.', recovery: 'choose_other' }), 422)
    }
    const ref = res.quoteId
    if (!ref || !SAFE_ID.test(ref) || (res.orderId !== undefined && !SAFE_ID.test(res.orderId))) throw unavailable('Flashnet returned an order id that is not valid.')
    checkDestination(res, target)
    if (res.recipientAddress !== undefined && !sameAddress(target.chain, res.recipientAddress, recipient)) {
      ctx.log.error('flashnet: the onramp recipient is not the session destination; refusing the invoice', { quoteId: ref })
      throw unavailable('Flashnet returned another recipient.')
    }
    const invoice = res.depositAddress
    const inv = decodeBolt11(invoice)
    // Mainnet invoices with an amount only. The amount must be the order's amountIn (sats).
    if (!inv || inv.network !== 'bc' || inv.amountMsat === undefined) throw unavailable('Flashnet returned an invoice that is not valid.')
    if (!INT.test(res.amountIn ?? '') || inv.amountMsat !== BigInt(res.amountIn!) * 1000n) {
      ctx.log.error('flashnet: the invoice amount is not the order amount; refusing the invoice', { quoteId: ref })
      throw unavailable('Flashnet returned an invoice for another amount.')
    }
    const providerExp = res.expiresAt ? Date.parse(res.expiresAt) : Number.NaN
    const expiresAt = Math.min(bolt11ExpiresAt(inv), Number.isFinite(providerExp) ? providerExp : Number.POSITIVE_INFINITY)
    if (expiresAt - Date.now() < MIN_INVOICE_LEFT_MS) throw new OpenRampException(openRampError('QUOTE_EXPIRED', { recovery: 'requote' }), 409)
    // One payment hash pays one leg
    if (!(await claimOnce(ctx.shared, `ln:${inv.paymentHash}`, ref, CLAIM_TTL_SEC))) {
      ctx.log.error('flashnet: this invoice already belongs to another leg; refusing it', { quoteId: ref })
      throw unavailable('Flashnet returned an invoice that is in use.')
    }
    await saveRecord(ctx, ref, {
      legId: id,
      recipient,
      output: { ...deliverableToAsset(target), decimals: target.decimals! },
      fnChain: target.fnChain,
      fnAsset: target.fnAsset,
      invoiceExpiresAt: expiresAt,
    })
    // We build the link from the invoice; we never use a link from the answer as it is.
    const link = id === 'cash_app' ? `https://cash.app/launch/lightning/${invoice}` : `lightning:${invoice}`
    const appName = id === 'cash_app' ? 'Cash App' : 'Lightning wallet'
    const surface: Surface =
      opts.invoiceSurface === 'deeplink'
        ? { kind: 'DEEPLINK', url: link, appName }
        : { kind: 'QR', payload: link, amount: usd, currency: 'USD', method: id, expiresAt: new Date(expiresAt).toISOString() }
    return {
      status: 'requires_action',
      action: { kind: 'payment', surface, transitions: [awaitPoll(POLL.checkout)] },
      ref,
      ...(res.orderId ? { providerRef: res.orderId } : {}),
    }
  }

  async function startTransfer(input: { quote: LegQuote; leg: PathwayLeg; deliverTo?: { address: string }; source?: { chain: string; token: string; address?: string } }, ctx: AdapterContext): Promise<LegStep> {
    const target = requireDeliverAsset(deliver, input.quote.output.asset, 'Flashnet')
    const recipient = recipientFor(ctx, input.deliverTo, target)
    const qa = input.quote.input.asset
    const src = sourceOf({ leg: input.leg, ...(qa.kind === 'crypto' ? { source: { chain: qa.chain, token: qa.token } } : {}) })
    const data = (input.quote.data ?? {}) as { amount?: string }
    const amount = INT.test(data.amount ?? '') ? data.amount! : toBaseUnits(roundTo(input.quote.input.value, src.decimals), src.decimals)
    const refund = refundFor(src, input.source?.address)
    if (src.chain === TRON_MAINNET && !refund) {
      throw new OpenRampException(openRampError('NO_QUOTES', { message: 'Flashnet needs a Tron refund address for this deposit.', recovery: 'choose_other' }), 422)
    }
    const body = {
      sourceChain: src.fnChain,
      sourceAsset: src.fnAsset,
      destinationChain: target.fnChain,
      destinationAsset: target.fnAsset,
      amount,
      recipientAddress: recipient,
      ...(refund ? { refundAddress: refund } : {}),
      tag: tagFor(ctx),
    }
    let res: FnQuote
    try {
      res = await post<FnQuote>(ctx, '/v1/orchestration/quote', body)
    } catch (e) {
      throw flashnetError(e, ctx.log, 'create this deposit')
    }
    const ref = res?.quoteId
    if (!ref || !SAFE_ID.test(ref)) throw unavailable('Flashnet returned a quote id that is not valid.')
    checkDestination(res, target)
    if (res.recipientAddress !== undefined && !sameAddress(target.chain, res.recipientAddress, recipient)) {
      ctx.log.error('flashnet: the quote recipient is not the session destination; refusing the address', { quoteId: ref })
      throw unavailable('Flashnet returned another recipient.')
    }
    const address = res.depositAddress
    const okAddress = !!address && (src.chain === TRON_MAINNET ? TRON_ADDRESS.test(address) : BITCOIN_ADDRESS.test(address))
    if (!okAddress) throw unavailable('Flashnet returned a deposit address that is not valid.')
    if (res.amountIn !== undefined && res.amountIn !== amount) {
      ctx.log.error('flashnet: the quote amount is not the amount we asked for; refusing the address', { quoteId: ref })
      throw unavailable('Flashnet returned a quote for another amount.')
    }
    const memo = res.depositMemo && /^[\x21-\x7e]{1,128}$/.test(res.depositMemo) ? res.depositMemo : undefined
    // One deposit address pays one leg: a reused address could complete two sessions with one transfer.
    if (!(await claimOnce(ctx.shared, `addr:${src.chain}:${address}`, ref, CLAIM_TTL_SEC))) {
      ctx.log.error('flashnet: this deposit address already belongs to another leg; refusing it', { quoteId: ref })
      throw unavailable('Flashnet returned a deposit address that is in use.')
    }
    await saveRecord(ctx, ref, {
      legId: 'transfer',
      recipient,
      output: { ...deliverableToAsset(target), decimals: target.decimals! },
      fnChain: target.fnChain,
      fnAsset: target.fnAsset,
      sourceChain: src.chain,
    })
    const value = fromBaseUnits(amount, src.decimals)
    const name = chainName(src.chain)
    return {
      status: 'requires_action',
      action: {
        kind: 'payment',
        surface: {
          kind: 'DEPOSIT_ADDRESS',
          chain: src.chain,
          chainName: name,
          token: src.token,
          symbol: src.symbol,
          address,
          ...(memo ? { memo } : {}),
          warning: `Send ${value} ${src.symbol} on ${name} in one transfer. Other tokens or chains may be lost. The price can change if the deposit arrives late.`,
        },
        transitions: [awaitPoll(POLL.onchain)],
      },
      ref,
    }
  }

  /** The payout source of a quote or a start: USDC on a supported EVM chain, and the session's own source when it is given */
  function payoutSource(asset: { chain: string; token: string } | undefined, sessionSource?: { chain: string; token: string }): SourceDef {
    const s = asset && FLASHNET_PAYOUT_SOURCES.find((x) => x.chain === asset.chain && x.token === asset.token.toLowerCase())
    if (!s) throw new OpenRampException(openRampError('NO_QUOTES', { message: 'Flashnet pays out from USDC on Base, Ethereum, Arbitrum, Optimism or Polygon.', recovery: 'choose_other' }), 422)
    if (sessionSource && (sessionSource.chain !== s.chain || sessionSource.token.toLowerCase() !== s.token)) {
      throw new OpenRampException(openRampError('BAD_REQUEST', { message: 'The quote is for another source asset.' }), 400)
    }
    return s
  }

  /**
   * The payout recipient: the session's validated Lightning destination, parsed again (fail closed).
   * The Cash App leg pays a `$cashtag` only, and the Lightning leg any other Lightning address.
   */
  function payoutRecipient(ctx: AdapterContext, id: PayoutLeg): { address: string; send: string } {
    const d = ctx.destination
    const t = d.type === 'lightning' ? parseLightningTarget(d.cashtag ?? d.address) : undefined
    if (d.type !== 'lightning' || !t || t.address !== d.address || t.cashtag !== d.cashtag || (id === 'cash_app_payout') !== !!t.cashtag) {
      throw new OpenRampException(openRampError('NO_QUOTES', { message: "Flashnet pays this method only to the session's Lightning target.", recovery: 'choose_other' }), 422)
    }
    // Orchestra takes `$name` for Cash App and `user@domain` for a Lightning address (offramp page).
    return { address: t.address, send: t.cashtag ?? t.address }
  }

  /** Where Orchestra refunds a failed payout: the sender on the source chain, else the app's EVM refund address */
  function payoutRefund(sender: string | undefined): string | undefined {
    const ok = (a: string | undefined) => !!a && EVM_ADDRESS.test(a) && !EVM_ZERO.test(a)
    if (ok(sender)) return sender
    return ok(opts.refundAddresses?.evm) ? opts.refundAddresses!.evm : undefined
  }

  const noRefund = () =>
    new OpenRampException(
      openRampError('NO_QUOTES', { message: 'Flashnet needs a refund address on the source chain. Connect a wallet, or set refundAddresses.evm.', recovery: 'choose_other' }),
      422,
    )

  async function quotePayout(
    id: PayoutLeg,
    input: { leg: PathwayLeg; amountIn?: Amount; amountOut?: Amount; source?: { chain: string; token: string; address?: string } },
    ctx: AdapterContext,
  ): Promise<LegQuote> {
    payoutRecipient(ctx, id)
    const a = input.amountIn?.asset
    // Exact in only: Orchestra does not lock the amount that arrives.
    if (!input.amountIn || a?.kind !== 'crypto') {
      throw new OpenRampException(openRampError('NO_QUOTES', { message: 'Flashnet quotes a payout from the amount you send.', recovery: 'choose_other' }), 422)
    }
    const src = payoutSource(a, input.source)
    if (!payoutRefund(input.source?.address)) throw noRefund()
    const amount = toBaseUnits(roundTo(input.amountIn.value, src.decimals), src.decimals)
    if (!INT.test(amount) || BigInt(amount) <= 0n) throw new OpenRampException(openRampError('AMOUNT_TOO_LOW', { recovery: 'requote' }), 422)
    // TO VERIFY: GET /estimate prices a `lightning:BTC` destination as the offramp quote does (sats out).
    const r = await estimate(ctx, src, LN_OUT, amount)
    const fees: Fee[] = [usdFee(r)]
    if (id === 'cash_app_payout') fees.push({ kind: 'other', label: 'Cash App bitcoin to USD rate', amount: null, included: true })
    return {
      adapterId: 'flashnet',
      legId: id,
      input: { value: fromBaseUnits(amount, src.decimals), asset: { kind: 'crypto', chain: src.chain, token: src.token, symbol: src.symbol, decimals: src.decimals } },
      output: { value: fromBaseUnits(r.estimatedOut!, 8), asset: LIGHTNING_BTC },
      fees,
      // Variable delivery: the sats (and the dollars in Cash App) are not locked.
      guarantee: 'estimate',
      eta: { min: 60, max: 1800 },
      expiresAt: quoteExpiresAt(2),
      data: { amount },
    }
  }

  type FnOfframp = FnQuote & {
    amountMode?: string
    source?: { chain?: string; asset?: string; decimals?: number; contractAddress?: string | null }
  }

  async function startPayout(
    id: PayoutLeg,
    input: { quote: LegQuote; leg: PathwayLeg; deliverTo?: { address: string }; source?: { chain: string; token: string; address?: string } },
    ctx: AdapterContext,
  ): Promise<LegStep> {
    const badQuote = (message: string) => new OpenRampException(openRampError('BAD_REQUEST', { message }), 400)
    // A payout is the last leg: it never delivers to another leg's address.
    if (input.deliverTo) throw badQuote("Flashnet payouts deliver only to the session's Lightning target.")
    // The recipient comes only from the session destination that the server checked (format, allowed, screened).
    const recipient = payoutRecipient(ctx, id)
    const q = input.quote
    if (q.adapterId !== 'flashnet' || q.legId !== id) throw badQuote('The quote is for another method.')
    const out = q.output.asset
    if (out.kind !== 'crypto' || out.chain !== LIGHTNING || out.token !== 'native') throw badQuote('The quote is for another asset.')
    const qa = q.input.asset
    const src = payoutSource(qa.kind === 'crypto' ? qa : undefined, input.source)
    // The amount is the quote's amount, in base units. A quote whose data disagrees is refused.
    const amount = toBaseUnits(roundTo(q.input.value, src.decimals), src.decimals)
    const data = (q.data ?? {}) as { amount?: unknown }
    if (data.amount !== amount || !INT.test(amount) || BigInt(amount) <= 0n) throw badQuote('The quote amount is not valid.')
    const refund = payoutRefund(input.source?.address)
    if (!refund) throw noRefund()
    const body = {
      sourceChain: src.fnChain,
      sourceAsset: src.fnAsset,
      amount,
      recipientAddress: recipient.send,
      refundAddress: refund,
      tag: tagFor(ctx),
    }
    let res: FnOfframp
    try {
      res = await post<FnOfframp>(ctx, '/v1/orchestration/offramp', body)
    } catch (e) {
      throw flashnetError(e, ctx.log, 'create this payout')
    }
    const ref = res?.quoteId
    if (!ref || !SAFE_ID.test(ref)) throw unavailable('Flashnet returned a quote id that is not valid.')
    // Fail closed on every field we can check: the funds go to this deposit address.
    const refuse = (why: string, message: string) => {
      ctx.log.error(`flashnet: ${why}; refusing the payout`, { quoteId: ref })
      return unavailable(message)
    }
    if (res.amountIn !== amount) throw refuse('the offramp amount is not the amount we asked for', 'Flashnet returned a quote for another amount.')
    if (res.amountMode !== undefined && res.amountMode !== 'exact_in') throw refuse('the offramp quote is not exact in', 'Flashnet returned another kind of quote.')
    checkDestination(res, LN_OUT)
    const rs = res.source
    if (
      rs &&
      ((rs.chain && rs.chain !== src.fnChain) ||
        (rs.asset && rs.asset !== src.fnAsset) ||
        (rs.decimals !== undefined && rs.decimals !== src.decimals) ||
        (rs.contractAddress && rs.contractAddress.toLowerCase() !== src.token))
    ) {
      throw refuse('the offramp source is not the session source', 'Flashnet answered for another asset.')
    }
    if (res.recipientAddress !== undefined && !sameLightningAddress(res.recipientAddress, recipient.address)) {
      throw refuse('the offramp recipient is not the session target', 'Flashnet returned another recipient.')
    }
    // We send a plain ERC-20 transfer: a deposit that needs a memo cannot be paid that way.
    if (res.depositMemo) throw refuse('the offramp deposit needs a memo', 'Flashnet returned a deposit that this wallet cannot pay.')
    const address = res.depositAddress
    if (!address || !EVM_ADDRESS.test(address) || EVM_ZERO.test(address)) throw unavailable('Flashnet returned a deposit address that is not valid.')
    const chainId = evmChainId(src.chain)
    if (!chainId) throw unavailable('The Flashnet payout chain is not an EVM chain.')
    // One Orchestra quote pays one leg, and one deposit address takes one payout (atomic claims).
    if (!(await claimOnce(ctx.shared, `payout:${ref}`, `${ctx.session.id}:${ctx.pathway.index}`, CLAIM_TTL_SEC))) {
      throw refuse('this offramp quote already belongs to another leg', 'Flashnet returned a quote that is in use.')
    }
    if (!(await claimOnce(ctx.shared, `addr:${src.chain}:${address.toLowerCase()}`, ref, CLAIM_TTL_SEC))) {
      throw refuse('this deposit address already belongs to another leg', 'Flashnet returned a deposit address that is in use.')
    }
    // A retried start (the same idempotency key gives the same quote) keeps the funding transaction it saw.
    const fundTx = (await ctx.shared.get<LegRecord>(recKey(ref)))?.payout?.fundTx
    await saveRecord(ctx, ref, {
      legId: id,
      recipient: recipient.address,
      output: { ...LIGHTNING_BTC, decimals: 8 },
      fnChain: LN_OUT.fnChain,
      fnAsset: LN_OUT.fnAsset,
      sourceChain: src.chain,
      payout: {
        fnChain: src.fnChain,
        fnAsset: src.fnAsset,
        token: src.token,
        amount,
        depositAddress: address.toLowerCase(),
        ...(input.source?.address && EVM_ADDRESS.test(input.source.address) ? { sender: input.source.address.toLowerCase() } : {}),
        ...(fundTx ? { fundTx } : {}),
      },
    })
    return {
      status: 'requires_action',
      action: {
        kind: 'payment',
        // We build the transfer from the checked quote: the token, the amount and the deposit address.
        surface: { kind: 'WALLET_TX', chain: src.chain, txs: [{ to: src.token, data: erc20TransferData(address, amount), value: '0', chainId }] },
        transitions: [{ name: 'submit_tx', kind: 'SURFACE_RESULT', expects: 'tx_hash' }],
      },
      ref,
    }
  }

  /** Session-scoped note of the hash this session's client reported. Not shared: it can never block another session. */
  const reportedKey = (ref: string) => `reported:${ref}`

  /**
   * Check a reported funding transaction on chain: a successful receipt with enough confirmations, and
   * USDC Transfer logs from the payout's sender to its deposit address that add up to the quoted amount.
   * 'unchecked' when there is no RPC URL or no known sender; 'pending' before enough confirmations.
   */
  async function verifyFunding(ctx: AdapterContext, rec: LegRecord, hash: string): Promise<'ok' | 'pending' | 'bad' | 'unchecked'> {
    const p = rec.payout!
    const url = opts.rpcUrls?.[rec.sourceChain!]
    if (!url || !p.sender) return 'unchecked'
    const receipt = await evmRpc<{ status?: string; blockNumber?: string; logs?: Array<{ address: string; topics: string[]; data: string }> } | null>(ctx.fetch, url, 'eth_getTransactionReceipt', [hash], { log: ctx.log })
    if (!receipt) return 'pending'
    if (receipt.status !== '0x1' || !/^0x[0-9a-fA-F]+$/.test(receipt.blockNumber ?? '')) return 'bad'
    const from = topicAddress(p.sender)
    const to = topicAddress(p.depositAddress)
    let paid = 0n
    for (const log of receipt.logs ?? []) {
      if (log.address?.toLowerCase() !== p.token || log.topics?.[0] !== ERC20_TRANSFER_TOPIC) continue
      if (log.topics[1]?.toLowerCase() !== from || log.topics[2]?.toLowerCase() !== to) continue
      if (!/^0x[0-9a-fA-F]{1,64}$/.test(log.data)) return 'bad'
      paid += BigInt(log.data)
    }
    if (paid !== BigInt(p.amount)) return 'bad'
    const head = await evmRpc<string>(ctx.fetch, url, 'eth_blockNumber', [], { log: ctx.log })
    if (typeof head !== 'string' || !/^0x[0-9a-fA-F]+$/.test(head)) return 'pending'
    const confirmations = BigInt(head) - BigInt(receipt.blockNumber!) + 1n
    return confirmations >= BigInt(Math.max(1, opts.payoutConfirmations ?? 2)) ? 'ok' : 'pending'
  }

  /**
   * Bind a verified funding transaction to the payout: claim the hash for this leg (owner: the leg ref,
   * so a retry of the same leg passes), save it, and report it to Orchestra. Returns false when another
   * leg already holds this transaction.
   */
  async function bindFunding(ctx: AdapterContext, ref: string, rec: LegRecord, hash: string): Promise<boolean> {
    if (!(await claimOnce(ctx.shared, `src:${hash}`, ref, CLAIM_TTL_SEC))) {
      ctx.log.error('flashnet: this transaction already funded another leg', { quoteId: ref })
      return false
    }
    if (rec.payout!.fundTx !== hash) await saveRecord(ctx, ref, { ...rec, payout: { ...rec.payout!, fundTx: hash } })
    // Orchestra detects EVM deposits by itself; /submit is the documented fallback, sent only for a
    // transaction that the receipt proved. A failure here is not fatal.
    try {
      await post(ctx, '/v1/orchestration/submit', { quoteId: ref, txHash: hash })
    } catch (e) {
      ctx.log.warn('flashnet: POST /submit failed; Orchestra should still detect the deposit', { quoteId: ref, error: String((e as Error)?.message ?? e).slice(0, 200) })
    }
    return true
  }

  /**
   * `submit_tx` of a payout leg. The hash comes from the client, so nothing shared is claimed or saved
   * until the receipt proves that it paid this payout (see `verifyFunding`). Until then the hash is only
   * a session-scoped note that keeps this leg waiting (it never shows the wallet step again).
   */
  async function submitPayoutTx(ref: string, inputs: Record<string, unknown> | undefined, ctx: AdapterContext): Promise<LegStep> {
    const rec = (await ctx.shared.get<LegRecord>(recKey(ref))) ?? (await ctx.store.get<LegRecord>(recKey(ref)))
    if (!rec?.payout || !rec.sourceChain) throw new OpenRampException(openRampError('NOT_FOUND', { message: 'Unknown Flashnet payout.' }), 404)
    const hash = typeof inputs?.txHash === 'string' ? inputs.txHash.toLowerCase() : ''
    if (!EVM_TX.test(hash)) throw new OpenRampException(openRampError('BAD_REQUEST', { message: 'Send a valid transaction hash.' }), 400)
    const waiting: LegStep = { status: 'processing', detail: { code: 'confirming' }, poll: POLL.onchain, ref }
    if (rec.payout.fundTx) {
      if (rec.payout.fundTx === hash) return { ...waiting, transactions: [{ role: 'source', chain: rec.sourceChain, hash }] }
      throw new OpenRampException(openRampError('CONFLICT', { message: 'This payout already has another transaction.' }), 409)
    }
    const v = await verifyFunding(ctx, rec, hash)
    if (v === 'bad') throw new OpenRampException(openRampError('BAD_REQUEST', { message: 'This transaction did not pay this withdrawal.' }), 400)
    if (v === 'ok') {
      if (!(await bindFunding(ctx, ref, rec, hash))) throw new OpenRampException(openRampError('CONFLICT', { message: 'This transaction already paid another withdrawal.' }), 409)
      return { ...waiting, transactions: [{ role: 'source', chain: rec.sourceChain, hash }] }
    }
    await ctx.store.put(reportedKey(ref), hash, RECORD_TTL_SEC)
    return waiting
  }

  /** `tag` on each order, for support: the session id in the allowed characters */
  function tagFor(ctx: AdapterContext): string {
    return `ork:${ctx.session.id}`.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 64)
  }

  /**
   * The event of an order for leg `ref`. Completion checks fail closed: the order must be for this quote,
   * deliver the expected asset to the session's recipient, carry a positive amount, and be the first
   * leg to claim the order and its deposit. Any miss keeps the leg `processing` and logs an error.
   */
  async function eventFrom(o: Order, ref: string, rec: LegRecord | undefined, shared: ScopedKV, log: Logger): Promise<LegEvent | undefined> {
    const m = STATUS(o.status, log)
    if (!m) return undefined
    const held = (why: string): LegEvent => {
      log.error(`flashnet: ${why}; the leg stays processing. Check the order in the Flashnet dashboard.`, { ref, orderId: o.id, status: o.status, errorCode: o.errorCode })
      return { ref, status: 'processing', detail: { code: 'delayed', ...(o.status ? { providerStatus: o.status.slice(0, 64) } : {}) }, ...(o.id && SAFE_ID.test(o.id) ? { providerRef: o.id } : {}) }
    }
    if (!rec) return held('no record for this leg')
    if (o.quoteId && o.quoteId !== ref) return held('the order is for another quote')
    const base: LegEvent = {
      ref,
      status: m.status,
      ...(o.id && SAFE_ID.test(o.id) ? { providerRef: o.id } : {}),
      ...(m.detail ? { detail: { code: m.detail, providerStatus: o.status!.slice(0, 64) } } : {}),
    }
    const txs: NonNullable<LegStep['transactions']> = []
    if (rec.sourceChain && o.sourceTx && HASH.test(o.sourceTx)) txs.push({ role: 'source', chain: rec.sourceChain, hash: o.sourceTx })
    if (m.special === 'failed') return { ...held(`order failed (${o.errorCode ?? 'no code'})`), ...(txs.length ? { transactions: txs } : {}) }
    if (m.special === 'fallback') return held('the order delivered a fallback asset, not the quoted asset')
    if (m.special === 'expired') {
      // No deposit seen: the leg expires. A deposit (or a payout transaction that we know of): money may
      // have moved, so it stays processing.
      if (!o.sourceTx && !rec.payout?.fundTx && !(o.amountIn && INT.test(o.amountIn) && BigInt(o.amountIn) > 0n)) {
        return { ref, status: 'expired', error: openRampError('QUOTE_EXPIRED', { recovery: 'requote' }) }
      }
      return held('the order expired after a deposit')
    }
    if (m.status === 'refunded') {
      if (o.refundTx && HASH.test(o.refundTx)) txs.push({ role: 'refund', ...(rec.sourceChain ? { chain: rec.sourceChain } : {}), hash: o.refundTx })
      return { ...base, ...(txs.length ? { transactions: txs } : {}) }
    }
    if (m.status !== 'succeeded') return { ...base, ...(txs.length ? { transactions: txs } : {}) }
    // Completion checks
    if (o.destChain !== rec.fnChain || o.destAsset !== rec.fnAsset) return held('the order delivered another asset')
    const p = rec.payout
    if (p) {
      // A payout: the order took the quoted source asset and amount. TO VERIFY: the order echoes them as sent.
      if ((o.srcChain && o.srcChain !== p.fnChain) || (o.srcAsset && o.srcAsset !== p.fnAsset)) return held('the payout order took another asset')
      if (o.amountIn && o.amountIn !== p.amount) return held('the payout order took another amount')
    }
    // TO VERIFY: a payout order names the Lightning address in recipientAddress (destinationAddress may differ).
    const to = rec.output.chain === LIGHTNING ? (o.recipient ?? o.destAddress) : (o.destAddress ?? o.recipient)
    if (!sameAddress(rec.output.chain, to, rec.recipient)) return held('the order delivered to another address')
    if (!o.amountOut || !INT.test(o.amountOut) || BigInt(o.amountOut) <= 0n) return held('the order has no delivered amount')
    if (!o.id || !(await claimOnce(shared, `order:${o.id}`, ref, CLAIM_TTL_SEC))) return held('the order already completed another leg')
    if (o.sourceTx && !(await claimOnce(shared, `src:${/^(0x)?[0-9a-fA-F]+$/.test(o.sourceTx) ? o.sourceTx.toLowerCase() : o.sourceTx}`, ref, CLAIM_TTL_SEC))) return held('the deposit already completed another leg')
    // A Lightning payment has no chain transaction to show
    if (o.destTx && HASH.test(o.destTx) && rec.output.chain !== LIGHTNING) txs.push({ role: 'destination', chain: rec.output.chain, hash: o.destTx })
    const output: Amount = { value: fromBaseUnits(o.amountOut, rec.output.decimals), asset: rec.output }
    return { ...base, output, ...(txs.length ? { transactions: txs } : {}) }
  }

  return createAdapter({
    id: 'flashnet',
    env,
    name: 'Flashnet',
    legs,

    async sourceTokens(input) {
      if (input.method !== 'transfer' || !enabled('transfer')) return []
      return FLASHNET_SOURCES.map((s) => ({ chain: s.chain, token: s.token, symbol: s.symbol, decimals: s.decimals, name: s.symbol === 'BTC' ? 'Bitcoin' : 'Tether USD' }))
    },

    async quote(input, ctx) {
      const id = legId(input.leg)
      if (isPayout(id)) return quotePayout(id, input, ctx)
      return id === 'transfer' ? quoteTransfer(input, ctx) : quoteLightning(id, input, ctx)
    },

    async start(input, ctx) {
      const id = legId(input.leg)
      if (isPayout(id)) return startPayout(id, input, ctx)
      return id === 'transfer' ? startTransfer(input, ctx) : startLightning(id, input, ctx)
    },

    async transition(input, ctx) {
      const id = legId(input.leg)
      if (!isPayout(id) || input.name !== 'submit_tx') {
        throw new OpenRampException(openRampError('BAD_REQUEST', { message: `Transition ${input.name} is not supported.` }), 409)
      }
      if (!SAFE_ID.test(input.ref)) throw new OpenRampException(openRampError('NOT_FOUND', { message: 'Unknown Flashnet payout.' }), 404)
      return submitPayoutTx(input.ref, input.inputs, ctx)
    },

    async status(input, ctx) {
      const id = legId(input.leg)
      const poll = id === 'transfer' || isPayout(id) ? POLL.onchain : POLL.checkout
      const rec = (await ctx.store.get<LegRecord>(recKey(input.ref))) ?? (await ctx.shared.get<LegRecord>(recKey(input.ref)))
      let res: { order?: FnOrder | null }
      try {
        res = await get<{ order?: FnOrder | null }>(ctx, '/v1/orchestration/status', { quoteId: input.ref })
      } catch (e) {
        if (httpStatus(e) !== 404) throw flashnetError(e, ctx.log, 'check this payment')
        res = { order: null }
      }
      if (!res?.order) {
        // No order: nothing was paid yet. An unpaid invoice ends the leg after its expiry (and a short grace).
        if (rec?.invoiceExpiresAt && Date.now() > rec.invoiceExpiresAt + INVOICE_GRACE_MS) {
          return { status: 'expired', ref: input.ref, error: openRampError('QUOTE_EXPIRED', { message: 'The invoice expired. Get a new quote to continue.', recovery: 'requote' }) }
        }
        // A payout whose funding transaction was sent: wait for Orchestra to see it (never back to the wallet step).
        if (rec?.payout && !rec.payout.fundTx) {
          const reported = await ctx.store.get<string>(reportedKey(input.ref))
          if (reported) {
            // Check the reported hash again: bind it once the receipt proves it (enough confirmations).
            if ((await verifyFunding(ctx, rec, reported)) === 'ok') await bindFunding(ctx, input.ref, rec, reported)
            return { status: 'processing', detail: { code: 'confirming' }, poll, ref: input.ref }
          }
        }
        if (rec?.payout?.fundTx) return { status: 'processing', detail: { code: 'confirming' }, poll, ref: input.ref }
        return legStepFromEvent(undefined, input.ref, poll)
      }
      // An expired order after this session reported a funding hash stays processing (money may have
      // moved). The note is session-scoped and changes only this leg's own view.
      const reported = rec?.payout && !rec.payout.fundTx ? await ctx.store.get<string>(reportedKey(input.ref)) : undefined
      const view = reported && rec?.payout ? { ...rec, payout: { ...rec.payout, fundTx: reported } } : rec
      const ev = await eventFrom(fromStatus(res.order), input.ref, view, ctx.shared, ctx.log)
      return legStepFromEvent(ev, input.ref, poll)
    },

    webhook: {
      configured: !!opts.webhookSecret,
      async verify(req, rawBody, ctx) {
        if (!opts.webhookSecret) {
          ctx.log.warn('flashnet: webhookSecret is not set; rejecting webhook')
          return false
        }
        const ts = req.headers.get('x-flashnet-timestamp')?.trim()
        const sig = req.headers.get('x-flashnet-signature')?.trim()
        // Milliseconds since epoch; hex HMAC-SHA256 of `{timestamp}.{rawBody}`, 5 minute window
        if (!ts || !/^\d{13}$/.test(ts) || !sig || !/^[0-9a-fA-F]{64}$/.test(sig)) return false
        return verifyTimestampedHmac({
          secret: opts.webhookSecret,
          rawBody,
          header: sig,
          timestamp: new Date(Number(ts)).toISOString(),
          message: () => `${ts}.${rawBody}`,
          toleranceSec: 300,
        })
      },
      async parse(rawBody, ctx) {
        let body: { event?: string; data?: FnHookOrder }
        try {
          body = JSON.parse(rawBody) as { event?: string; data?: FnHookOrder }
        } catch {
          ctx.log.warn('flashnet: webhook body is not JSON')
          return []
        }
        const d = body?.data
        if (!d || typeof d !== 'object' || typeof body.event !== 'string' || !body.event.startsWith('order.')) return []
        // A superseded order is replaced by another operation of the same quote; the next event tells the result.
        if (body.event === 'order.superseded') return []
        const ref = str(d.quoteId)
        if (!ref || !SAFE_ID.test(ref)) return []
        // The leg is found by the server's ref index (ref = quoteId). Our record gives what it must deliver.
        const rec = await ctx.shared.get<LegRecord>(recKey(ref))
        if (!rec) {
          ctx.log.warn('flashnet: webhook for a quote this server did not start; ignored', { quoteId: ref })
          return []
        }
        const o = fromHook(d)
        if (body.event === 'order.recovery_required') o.status = 'failed'
        const ev = await eventFrom(o, ref, rec, ctx.shared, ctx.log)
        return ev ? [{ ...ev, eventId: eventKey(body.event, d) }] : []
      },
      async replayKey(_req, rawBody) {
        try {
          const b = JSON.parse(rawBody) as { event?: string; data?: FnHookOrder }
          if (b?.event && b.data?.id) return eventKey(b.event, b.data)
        } catch {
          // not JSON
        }
        return `flashnet:body:${await sha256Hex(rawBody)}`
      },
    },

    async health(ctx) {
      try {
        await fetchJson(ctx.fetch, `${api}/v2/orchestration/routes`, { headers })
        return { ok: true }
      } catch (e) {
        return { ok: false, detail: String((e as Error)?.message ?? e).slice(0, 200) }
      }
    },
  })
}

/** The docs' dedupe key: (data.id, event, data.updatedAt) */
function eventKey(event: string, d: FnHookOrder): string {
  return `flashnet:${d.id}:${event}:${d.updatedAt ?? ''}`
}
