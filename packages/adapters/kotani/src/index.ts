// Kotani Pay adapter (API v3): African payment rails to stablecoins, and stablecoins to mobile money.
// - Deposit (onramp): M-Pesa and mobile money (STK push or USSD prompt on the user's phone), and
//   bank checkout (a hosted bank page). Kotani Pay sends USDC or USDT to the destination address.
// - Withdraw (offramp): the user sends USDC or USDT to a Kotani Pay escrow address, and Kotani Pay
//   pays out to the user's mobile money wallet.
// Docs: https://documentation.kotanipay.com/v3/overview (index: https://documentation.kotanipay.com/llms.txt)
//
// Why Kotani Pay and not Yellow Card: Kotani Pay sandbox accounts are self-service (register at
// integrator.kotanipay.com, generate a key). Yellow Card gives sandbox keys only after an intro call,
// KYB, an AML review and a signed agreement (docs.yellowcard.engineering/docs/getting-started-api).

import { POLL, awaitPoll, createAdapter, decimalFrom, erc20TransferData, fetchJson, hmacSha256, httpErrorToOrk, httpStatus, providerMessage, randomHex, timingSafeEqual } from '@openrampkit/adapter'
import type { AdapterContext, LegEvent } from '@openrampkit/adapter'
import { OrkException, SOLANA_MAINNET, USDC, add, cmp, evmChainId, isEvmChain, isSolanaChain, minorUnits, normalizeToken, orkError, roundTo, sameToken, sub, toBaseUnits } from '@openrampkit/core'
import type { Amount, CryptoAsset, FieldSpec, LegQuote, LegSpec, LegStep, PathwayLeg, TxRequest } from '@openrampkit/core'

export const KOTANI_API = 'https://api.kotanipay.io'
export const KOTANI_SANDBOX_API = 'https://sandbox-api.kotanipay.io'

/** A delivery (or sell) asset and its Kotani Pay `chain` and `token` codes */
export type KotaniAsset = {
  /** CAIP-2 chain id */
  chain: string
  /** Token address or mint, as in `@openrampkit/core` (lowercase on EVM) */
  token: string
  /** Kotani Pay token code: `USDC`, `USDT`, ... */
  symbol: string
  decimals: number
  /** Kotani Pay chain code: `BASE`, `POLYGON`, `ETHEREUM`, `SOLANA`, ... */
  kotaniChain: string
}

/** A country corridor: currency, method and how the user pays (or is paid) */
export type KotaniChannel = {
  /** ISO 3166-1 alpha-2 */
  country: string
  currency: string
  /** OpenRampKit method id */
  method: 'mpesa' | 'mobile_money' | 'bank_transfer'
  /** `mobile_money`: STK push or USSD prompt. `bank_checkout`: Kotani Pay hosted bank page (deposit only). */
  rail: 'mobile_money' | 'bank_checkout'
  /** Kotani Pay network codes for mobile money (`providerNetwork`) */
  networks?: string[]
  /** Static limits in `currency`. Kotani Pay limits per integrator are TO VERIFY; quotes carry Kotani's own errors. */
  min?: string
  max?: string
  /** Also offer this corridor for withdrawals (mobile money payouts) */
  payout?: boolean
}

export type KotaniOptions = {
  /** API key from the dashboard (integrator.kotanipay.com > API Keys) */
  apiKey: string
  /**
   * Webhook signing secret (dashboard > Settings). With a secret, Kotani Pay signs every callback
   * (`X-Kotani-Signature`). Without it, callbacks are unsigned and this adapter rejects them: the
   * server then relies on status polling.
   */
  webhookSecret?: string
  /**
   * API secret of a "secure" key. Set it only when request signing (secure mode) is on for your
   * account: every request then carries `x-timestamp`, `x-nonce` and `x-signature`.
   */
  apiSecret?: string
  /** Use the sandbox API (`https://sandbox-api.kotanipay.io`). Default false. */
  sandbox?: boolean
  /** API base URL. Overrides `sandbox`. */
  apiUrl?: string
  /** Offer only these countries (ISO 3166-1 alpha-2). Default: every corridor in `KOTANI_CHANNELS`. */
  countries?: string[]
  /** Offer only these methods (`mpesa`, `mobile_money`, `bank_transfer`) */
  methods?: string[]
  /** Delivery and sell assets. Default: `KOTANI_ASSETS`. */
  assets?: KotaniAsset[]
  /** Add withdraw legs (mobile money payouts). Your Kotani Pay payout balance must hold the payout currency. Default true. */
  offramp?: boolean
  /**
   * Who pays the Kotani Pay fee on a deposit. `customer` (default): the fee is added to what the user
   * pays, so the quote asks Kotani for `amount - fee`. `integrator`: your wallet pays it, so the user pays
   * the amount. This must match the billing setting of your Kotani Pay wallet.
   */
  feeBearer?: 'customer' | 'integrator'
  /** Quote lifetime in seconds. Default 120. Kotani Pay sets the rate when the order is created. */
  quoteTtlSec?: number
}

// ---------------------------------------------------------------- tables

const USDT: Record<string, string> = {
  'eip155:1': '0xdac17f958d2ee523a2206206994597c13d831ec7',
  'eip155:137': '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
  [SOLANA_MAINNET]: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
}

/**
 * Default assets. From the Kotani Pay supported chains example (POLYGON: USDT, USDC; ETHEREUM: USDT, USDC;
 * SOLANA: USDT, USDC; BASE: USDC), limited to chains in `CHAINS`. Kotani also lists CELO, STELLAR, TRON,
 * ARBITRUM, OPTIMISM, BINANCE and more: add them with the `assets` option after you check them.
 * TO VERIFY: which USDC contract Kotani sends on Polygon (native USDC is assumed, not USDC.e), and the
 * chain and token list per country (the docs say it "may vary by country").
 */
export const KOTANI_ASSETS: KotaniAsset[] = [
  { chain: 'eip155:8453', token: USDC['eip155:8453']!, symbol: 'USDC', decimals: 6, kotaniChain: 'BASE' },
  { chain: 'eip155:137', token: USDC['eip155:137']!, symbol: 'USDC', decimals: 6, kotaniChain: 'POLYGON' },
  { chain: 'eip155:137', token: USDT['eip155:137']!, symbol: 'USDT', decimals: 6, kotaniChain: 'POLYGON' },
  { chain: 'eip155:1', token: USDC['eip155:1']!, symbol: 'USDC', decimals: 6, kotaniChain: 'ETHEREUM' },
  { chain: 'eip155:1', token: USDT['eip155:1']!, symbol: 'USDT', decimals: 6, kotaniChain: 'ETHEREUM' },
  { chain: SOLANA_MAINNET, token: USDC[SOLANA_MAINNET]!, symbol: 'USDC', decimals: 6, kotaniChain: 'SOLANA' },
  { chain: SOLANA_MAINNET, token: USDT[SOLANA_MAINNET]!, symbol: 'USDT', decimals: 6, kotaniChain: 'SOLANA' },
]

/**
 * Default corridors. Currencies are in the Kotani Pay mobile money currency enum (KES, GHS, TZS, UGX,
 * ZMW, XAF, CDF, RWF, ETB, ZAR, XOF); network codes are in its network enum (MTN, AIRTEL, VODAFONE,
 * TIGO, YAS, ORANGE, ZAMTEL, MPESA, MOOV, FREE, EXPRESSO, HALOPESA, VODACOM, WAVE, ...).
 * TO VERIFY: the network list per country. `catalog()` replaces it with the live `availableNetworks`
 * from `GET /api/v3/customer/support/countries` when Kotani returns them.
 * TO VERIFY: Nigeria (NGN). NGN is in Kotani's currency list, but the docs show bank checkout for South
 * Africa only. Test `ng-bank-transfer` in the sandbox before you offer it.
 */
export const KOTANI_CHANNELS: KotaniChannel[] = [
  // Safaricom caps one M-Pesa payment at 250,000 KES. Kotani's own limits are TO VERIFY.
  { country: 'KE', currency: 'KES', method: 'mpesa', rail: 'mobile_money', networks: ['MPESA'], max: '250000', payout: true },
  { country: 'KE', currency: 'KES', method: 'mobile_money', rail: 'mobile_money', networks: ['AIRTEL'], payout: true },
  { country: 'GH', currency: 'GHS', method: 'mobile_money', rail: 'mobile_money', networks: ['MTN', 'VODAFONE', 'AIRTEL'], payout: true },
  { country: 'UG', currency: 'UGX', method: 'mobile_money', rail: 'mobile_money', networks: ['MTN', 'AIRTEL'], payout: true },
  { country: 'TZ', currency: 'TZS', method: 'mobile_money', rail: 'mobile_money', networks: ['VODACOM', 'AIRTEL', 'YAS', 'HALOPESA'], payout: true },
  { country: 'ZM', currency: 'ZMW', method: 'mobile_money', rail: 'mobile_money', networks: ['MTN', 'AIRTEL', 'ZAMTEL'], payout: true },
  { country: 'RW', currency: 'RWF', method: 'mobile_money', rail: 'mobile_money', networks: ['MTN', 'AIRTEL'], payout: true },
  { country: 'CM', currency: 'XAF', method: 'mobile_money', rail: 'mobile_money', networks: ['MTN', 'ORANGE'], payout: true },
  { country: 'CI', currency: 'XOF', method: 'mobile_money', rail: 'mobile_money', networks: ['MTN', 'ORANGE', 'MOOV', 'WAVE'], payout: true },
  { country: 'SN', currency: 'XOF', method: 'mobile_money', rail: 'mobile_money', networks: ['ORANGE', 'FREE', 'EXPRESSO', 'WAVE'], payout: true },
  { country: 'CD', currency: 'CDF', method: 'mobile_money', rail: 'mobile_money', networks: ['AIRTEL', 'ORANGE', 'VODACOM'], payout: true },
  { country: 'ZA', currency: 'ZAR', method: 'bank_transfer', rail: 'bank_checkout' },
  { country: 'NG', currency: 'NGN', method: 'bank_transfer', rail: 'bank_checkout' },
]

/** Phone country codes for the corridors, to turn a local number (07...) into international format */
const DIAL: Record<string, string> = {
  KE: '254', GH: '233', UG: '256', TZ: '255', ZM: '260', RW: '250', CM: '237', CI: '225', SN: '221', CD: '243', ZA: '27', NG: '234',
}

/** Network names as users know them */
const NETWORK_LABEL: Record<string, string> = {
  MPESA: 'M-Pesa', MTN: 'MTN MoMo', AIRTEL: 'Airtel Money', VODAFONE: 'Telecel Cash (Vodafone)', TIGO: 'Tigo Pesa', YAS: 'Mixx by Yas',
  ORANGE: 'Orange Money', ZAMTEL: 'Zamtel Kwacha', MOOV: 'Moov Money', FREE: 'Free Money', EXPRESSO: 'Expresso', HALOPESA: 'HaloPesa',
  VODACOM: 'Vodacom M-Pesa', WAVE: 'Wave', TMONEY: 'T-Money',
}

const networkLabel = (n: string) => NETWORK_LABEL[n] ?? n.charAt(0) + n.slice(1).toLowerCase()

/** Leg ids: `ke-mpesa`, `gh-mobile-money`, `za-bank-transfer`; withdraw legs: `sell-ke-mpesa` */
const legIdOf = (c: Pick<KotaniChannel, 'country' | 'method'>) => `${c.country.toLowerCase()}-${c.method.replace(/_/g, '-')}`
const SELL = 'sell-'
const CATALOG_TTL_SEC = 3600
const ORDER_TTL_SEC = 7 * 24 * 3600

// ---------------------------------------------------------------- API types

type Envelope<T> = { success?: boolean; message?: string; data?: T }

type KotaniRate = { from?: string; to?: string; value?: string; id?: string; fiatAmount?: number; cryptoAmount?: number; transactionAmount?: number; fee?: number }

type OnrampCreated = { id?: string; referenceId?: string; referenceNumber?: number; message?: string; customerKey?: string; redirectUrl?: string }

/** `GET /api/v3/onramp/{referenceId}` data and the `transaction.onramp.status.updated` webhook data */
export type KotaniOnramp = {
  referenceId?: string
  status?: string
  depositStatus?: string
  onchainStatus?: string
  transactionHash?: string | null
  cryptoAmount?: number
  cryptoAmountReceived?: number
  fiatAmount?: number
  fiatFee?: number
  fiatAmountToSend?: number
  chain?: string
  token?: string
  error?: { message?: string; code?: string } | null
}

/** `GET /api/v3/offramp/{referenceId}` data and the `transaction.offramp.status.updated` webhook data */
export type KotaniOfframp = {
  referenceId?: string
  status?: string
  onchainStatus?: string
  fiatAmount?: number
  fiatTransactionAmount?: number
  cryptoAmount?: number
  fiatCurrency?: string
  escrowAddress?: string
  transactionHash?: string
}

type CountrySupport = { countryCode?: string; currency?: string; serviceType?: string; isActive?: boolean; isEnabled?: boolean; availableNetworks?: string[]; supportedNetworks?: string[] }

/** What the adapter keeps per order (session store) */
type Order = {
  kind: 'onramp' | 'offramp'
  legId: string
  country: string
  currency: string
  method: string
  rail: KotaniChannel['rail']
  /** Fiat amount sent to Kotani (`fiatAmount`, before the fee) for onramps */
  fiatAmount?: string
  /** Crypto amount: what the user sends (offramp) */
  cryptoAmount?: string
  asset: KotaniAsset
  /** Onramp: where Kotani delivers */
  receiver?: string
  /** Offramp: the user's sending address, when known */
  sender?: string
  networks: string[]
  /** Set once the order is created at Kotani Pay */
  submitted?: boolean
  redirectUrl?: string
  escrowAddress?: string
  txHash?: string
}

// ---------------------------------------------------------------- status mapping

const SUCCESS = new Set(['SUCCESSFUL', 'SUCCESS', 'TRANSACTION_RETRY_SUCCESSFUL'])
const FAILED = new Set(['FAILED', 'DECLINED', 'CANCELLED', 'PERMANENTLY_FAILED', 'REVERSED', 'TRANSACTION_RETRY_FAILED'])

const failMsg = (prefix: string, e?: { message?: string } | null) => (e?.message ? `${prefix} (${e.message.slice(0, 120)})` : prefix)

/**
 * An onramp status as a LegEvent. Two statuses: `depositStatus` (the fiat payment) and
 * `onchainStatus` (the crypto delivery). Both must be SUCCESSFUL for success.
 * Returns undefined while the user still has to pay.
 */
export function onrampEvent(d: KotaniOnramp, asset?: CryptoAsset): LegEvent | undefined {
  const ref = d.referenceId ?? ''
  const dep = (d.depositStatus ?? '').toUpperCase()
  const chain = (d.onchainStatus ?? '').toUpperCase()
  const overall = (d.status ?? '').toUpperCase()
  const txHash = d.transactionHash || undefined
  if (SUCCESS.has(chain)) {
    const amount = d.cryptoAmountReceived ?? d.cryptoAmount
    return {
      ref, status: 'succeeded',
      ...(txHash ? { txHash } : {}),
      ...(asset && typeof amount === 'number' ? { output: { amount: decimalFrom(amount, asset.decimals ?? 6), asset } } : {}),
    }
  }
  if (FAILED.has(chain) && SUCCESS.has(dep)) {
    // The fiat was collected, the crypto was not sent. Kotani credits the fiat to the integrator's wallet.
    return { ref, status: 'failed', error: orkError('DELIVERY_FAILED', { message: failMsg('The crypto could not be sent. Contact support for a refund.', d.error), recovery: 'contact_support' }) }
  }
  if (dep === 'EXPIRED') return { ref, status: 'expired', error: orkError('PAYMENT_FAILED', { message: 'The payment request expired. Start again.', recovery: 'retry_payment' }) }
  if (FAILED.has(dep) || (FAILED.has(overall) && !SUCCESS.has(dep))) {
    return { ref, status: 'failed', error: orkError('PAYMENT_FAILED', { message: failMsg('The payment did not go through.', d.error), recovery: 'retry_payment' }) }
  }
  if (SUCCESS.has(dep)) return { ref, status: 'processing' }
  // PENDING, INITIATED, IN_PROGRESS, RETRY, DUPLICATE, ERROR_OCCURRED, REQUIRE_REVIEW: wait.
  // REQUIRE_REVIEW and ERROR_OCCURRED need Kotani support; the poll gives up after an hour.
  if (dep === 'REQUIRE_REVIEW' || dep === 'ERROR_OCCURRED') return { ref, status: 'processing' }
  return undefined
}

/**
 * An offramp status as a LegEvent. Undefined while Kotani waits for the user's crypto.
 * A failed payout after the crypto arrived is refunded on-chain by Kotani after about 5 minutes,
 * so it stays `processing` until `refund.completed` (refunded) or `refund.failed` (failed).
 */
export function offrampEvent(d: KotaniOfframp, currency?: string): LegEvent | undefined {
  const ref = d.referenceId ?? ''
  const st = (d.status ?? '').toUpperCase()
  const chain = (d.onchainStatus ?? '').toUpperCase()
  const txHash = d.transactionHash || undefined
  if (SUCCESS.has(st)) {
    const cur = d.fiatCurrency ?? currency
    const amount = d.fiatTransactionAmount
    return {
      ref, status: 'succeeded',
      ...(txHash ? { txHash } : {}),
      ...(cur && typeof amount === 'number' ? { output: { amount: decimalFrom(amount, minorUnits(cur)), asset: { kind: 'fiat', currency: cur.toUpperCase() } } } : {}),
    }
  }
  if (st === 'REFUNDED') return { ref, status: 'refunded' }
  if (st === 'REFUND_FAILED') return { ref, status: 'failed', error: orkError('DELIVERY_FAILED', { message: 'The payout failed and the refund failed. Contact support.', recovery: 'contact_support' }) }
  if (st === 'REFUND_PENDING' || ((FAILED.has(st) || st === 'EXPIRED') && SUCCESS.has(chain))) return { ref, status: 'processing' }
  if (st === 'EXPIRED') return { ref, status: 'expired', error: orkError('QUOTE_EXPIRED', { message: 'The withdrawal expired before the crypto arrived. Start again.' }) }
  if (FAILED.has(st)) return { ref, status: 'failed', error: orkError('PAYMENT_FAILED', { message: 'The payout did not go through.' }) }
  if (st === 'CRYPTO_RECEIVED' || st === 'IN_PROGRESS' || st === 'PROCESSING' || st === 'INITIATED' || SUCCESS.has(chain)) return { ref, status: 'processing' }
  return undefined
}

// ---------------------------------------------------------------- adapter

export function kotani(opts: KotaniOptions) {
  const api = (opts.apiUrl ?? (opts.sandbox ? KOTANI_SANDBOX_API : KOTANI_API)).replace(/\/$/, '')
  const assets = opts.assets ?? KOTANI_ASSETS
  const ttl = (opts.quoteTtlSec ?? 120) * 1000
  const feeBearer = opts.feeBearer ?? 'customer'
  const onlyCountries = opts.countries?.map((c) => c.toUpperCase())
  const channels = KOTANI_CHANNELS.filter((c) => (!onlyCountries || onlyCountries.includes(c.country)) && (!opts.methods || opts.methods.includes(c.method)))

  const chainsMap = (list: KotaniAsset[]) => {
    const m: Record<string, string[]> = {}
    for (const a of list) (m[a.chain] ??= []).push(normalizeToken(a.chain, a.token))
    return m
  }
  const deliverChains = chainsMap(assets)
  // Withdraw: the user's wallet sends the token. EVM and Solana wallets only.
  const sellAssets = assets.filter((a) => isEvmChain(a.chain) || isSolanaChain(a.chain))
  const sellChains = chainsMap(sellAssets)

  const legs: LegSpec[] = channels.map((c) => ({
    id: legIdOf(c),
    kind: 'fiat_onramp',
    methods: [c.method],
    from: { asset: { kind: 'fiat', currencies: [c.currency] }, location: ['user_account'] },
    to: { asset: { kind: 'crypto', chains: deliverChains }, location: ['address'] },
    regions: { allow: [c.country], deny: [] },
    ...(c.min || c.max ? { limits: { ...(c.min ? { min: c.min } : {}), ...(c.max ? { max: c.max } : {}), currency: c.currency } } : {}),
    eta: c.rail === 'bank_checkout' ? { min: 120, max: 3600 } : { min: 60, max: 900 },
    surfaces: c.rail === 'bank_checkout' ? ['FORM', 'REDIRECT'] : ['FORM'],
    capabilities: ['webhooks', 'polling', 'exact_output'],
  }))
  if (opts.offramp !== false && Object.keys(sellChains).length) {
    for (const c of channels) {
      if (!c.payout) continue
      legs.push({
        id: `${SELL}${legIdOf(c)}`,
        kind: 'crypto_offramp',
        methods: [c.method],
        from: { asset: { kind: 'crypto', chains: sellChains }, location: ['user_wallet', 'address'] },
        to: { asset: { kind: 'fiat', currencies: [c.currency] }, location: ['user_account'] },
        regions: { allow: [c.country], deny: [] },
        ...(c.min || c.max ? { limits: { ...(c.min ? { min: c.min } : {}), ...(c.max ? { max: c.max } : {}), currency: c.currency } } : {}),
        eta: { min: 120, max: 1800 },
        surfaces: ['FORM', 'WALLET_TX'],
        capabilities: ['webhooks', 'polling', 'refunds'],
      })
    }
  }
  const legById = new Map(legs.map((l) => [l.id, l]))
  const channelOf = new Map(channels.map((c) => [legIdOf(c), c]))

  function channelFor(legId: string): { channel: KotaniChannel; sell: boolean } {
    const sell = legId.startsWith(SELL)
    const channel = channelOf.get(sell ? legId.slice(SELL.length) : legId)
    if (!channel || !legById.has(legId)) throw new OrkException(orkError('BAD_REQUEST', { message: `Unknown Kotani Pay leg ${legId}` }), 400)
    return { channel, sell }
  }

  function assetFor(chain: string, token: string): KotaniAsset {
    const a = assets.find((x) => x.chain === chain && sameToken(chain, x.token, token))
    if (!a) throw new OrkException(orkError('NO_QUOTES', { message: 'Kotani Pay does not support this token on this network.' }), 422)
    return a
  }

  const cryptoAsset = (a: KotaniAsset): CryptoAsset => ({ kind: 'crypto', chain: a.chain, token: normalizeToken(a.chain, a.token), symbol: a.symbol, decimals: a.decimals })
  const fiatDec = (n: number | undefined, currency: string) => decimalFrom(n ?? 0, minorUnits(currency))
  const cryptoDec = (n: number | undefined, a: KotaniAsset) => decimalFrom(n ?? 0, a.decimals)

  // ------------------------------------------------------------ HTTP

  async function signHeaders(method: string, path: string, body: string | undefined): Promise<Record<string, string>> {
    if (!opts.apiSecret) return {}
    const ts = Math.floor(Date.now() / 1000).toString()
    const nonce = crypto.randomUUID()
    // POST: `${ts}.${nonce}.${compact JSON body}`. GET: `${ts}.${nonce}.${last path segment}`.
    const last = path.split('?')[0]!.split('/').pop() ?? ''
    const payload = `${ts}.${nonce}.${method === 'GET' ? last : body ?? '{}'}`
    return { 'x-timestamp': ts, 'x-nonce': nonce, 'x-signature': await hmacSha256(opts.apiSecret, payload, 'hex') }
  }

  async function call<T>(ctx: Pick<AdapterContext, 'fetch'>, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const raw = body === undefined ? undefined : JSON.stringify(body)
    const res = await fetchJson<Envelope<T>>(ctx.fetch, `${api}${path}`, {
      method,
      headers: { authorization: `Bearer ${opts.apiKey}`, ...(await signHeaders(method, path, raw)) },
      ...(raw !== undefined ? { body: raw } : {}),
    })
    if (res && res.success === false) {
      // An error inside a 200 envelope: treat it like a 400 with Kotani's message.
      throw Object.assign(new Error(`Kotani Pay: ${res.message ?? 'request failed'}`), { status: 400, body: res })
    }
    return (res?.data ?? {}) as T
  }

  /** Errors when creating an order: the user can act on 4xx messages. */
  function startError(e: unknown, ctx: Pick<AdapterContext, 'log'>): OrkException {
    if (e instanceof OrkException) return e
    const status = httpStatus(e)
    if (status === 429) return new OrkException(orkError('RATE_LIMITED'), 429)
    if (status === 400 || status === 409 || status === 422) {
      const msg = providerMessage(e)
      return new OrkException(orkError('PROVIDER_DECLINED', { message: msg ? `Kotani Pay: ${msg}`.slice(0, 200) : 'Kotani Pay declined this request.' }), 422)
    }
    return httpErrorToOrk(e, 'Kotani Pay', { log: ctx.log })
  }

  // ------------------------------------------------------------ catalog data

  async function supportedCountries(ctx: Pick<AdapterContext, 'fetch' | 'shared'>, service: 'DEPOSIT' | 'WITHDRAW'): Promise<CountrySupport[]> {
    const key = `countries:${service}`
    const cached = await ctx.shared.get<CountrySupport[]>(key)
    if (cached) return cached
    const list = await call<CountrySupport[]>(ctx, 'GET', `/api/v3/customer/support/countries?serviceType=${service}`)
    // Not a list: let the server fall back to the static legs (and do not cache it).
    if (!Array.isArray(list)) throw new Error('Kotani Pay: unexpected country support response')
    await ctx.shared.put(key, list, CATALOG_TTL_SEC)
    return list
  }

  async function networksFor(c: KotaniChannel, sell: boolean, ctx: Pick<AdapterContext, 'shared'>): Promise<string[]> {
    if (c.rail !== 'mobile_money') return []
    const live = await ctx.shared.get<CountrySupport[]>(`countries:${sell ? 'WITHDRAW' : 'DEPOSIT'}`)
    const row = live?.find((r) => r.countryCode?.toUpperCase() === c.country && (!r.currency || r.currency.toUpperCase() === c.currency))
    const fromLive = row?.availableNetworks?.length ? row.availableNetworks : row?.supportedNetworks
    const all = (fromLive?.length ? fromLive : c.networks ?? []).map((n) => n.toUpperCase())
    // M-Pesa (Kenya) and the other Kenyan wallets are separate methods.
    if (c.country === 'KE') return c.method === 'mpesa' ? all.filter((n) => n === 'MPESA') : all.filter((n) => n !== 'MPESA')
    return all
  }

  // ------------------------------------------------------------ steps

  function formFields(o: Order): FieldSpec[] {
    if (o.rail === 'bank_checkout') {
      return [
        { id: 'full_name', label: 'Full name', type: 'text', required: true },
        { id: 'phone', label: 'Phone number', type: 'tel', required: true },
      ]
    }
    const single = o.networks.length === 1 ? networkLabel(o.networks[0]!) : undefined
    const fields: FieldSpec[] = [
      { id: 'account_name', label: 'Name on the mobile money account', type: 'text', required: true },
      { id: 'phone', label: single ? `${single} phone number` : 'Mobile money phone number', type: 'tel', required: true },
    ]
    if (o.networks.length > 1) {
      fields.push({ id: 'network', label: 'Mobile money network', type: 'select', required: true, options: o.networks.map((n) => ({ value: n, label: networkLabel(n) })) })
    }
    return fields
  }

  function formStep(ref: string, o: Order): LegStep {
    return {
      state: 'PAYMENT',
      sub: o.kind === 'offramp' ? 'PAYOUT_ACCOUNT' : 'PAYMENT_DETAILS',
      status: 'awaiting_user',
      ref,
      surface: { kind: 'FORM', fields: formFields(o) },
      transitions: [{ name: 'submit_details', kind: 'SUBMIT', label: o.kind === 'offramp' ? 'Continue' : o.rail === 'bank_checkout' ? 'Continue to your bank' : 'Send payment request' }],
    }
  }

  /** The user's step after the order exists, while Kotani waits for the user */
  function waitingStep(ref: string, o: Order): LegStep {
    if (o.kind === 'offramp') {
      if (o.txHash) return { state: 'PROCESSING', sub: 'PAYING_OUT', status: 'processing', ref, transitions: [awaitPoll(POLL.checkout)], txHash: o.txHash }
      return sendCryptoStep(ref, o)
    }
    if (o.rail === 'bank_checkout' && o.redirectUrl) {
      return { state: 'PAYMENT', status: 'awaiting_user', ref, surface: { kind: 'REDIRECT', url: o.redirectUrl, popup: true, provider: 'Kotani Pay' }, transitions: [awaitPoll(POLL.checkout)] }
    }
    // STK push (M-Pesa, Airtel) or USSD prompt (MTN and others): the user approves on the phone.
    return { state: 'PAYMENT', sub: 'CONFIRM_ON_YOUR_PHONE', status: 'awaiting_user', ref, transitions: [awaitPoll(POLL.checkout)] }
  }

  function sendCryptoStep(ref: string, o: Order): LegStep {
    const a = o.asset
    const amount = toBaseUnits(o.cryptoAmount ?? '0', a.decimals)
    const to = o.escrowAddress!
    const tx: TxRequest = isSolanaChain(a.chain)
      ? { kind: 'solana', type: 'transfer', to, mint: a.token, amount, decimals: a.decimals }
      : { to: normalizeToken(a.chain, a.token), data: erc20TransferData(to, amount), value: '0', chainId: evmChainId(a.chain)! }
    return {
      state: 'PAYMENT', sub: 'SEND_CRYPTO', status: 'awaiting_user', ref,
      surface: { kind: 'WALLET_TX', chain: a.chain, txs: [tx] },
      transitions: [{ name: 'submit_tx', kind: 'SURFACE_RESULT', expects: 'tx_hash' }, awaitPoll(POLL.checkout)],
    }
  }

  function stepFromEvent(ev: LegEvent | undefined, ref: string, o: Order | undefined): LegStep {
    const base = { ref, ...(ev?.txHash ? { txHash: ev.txHash } : {}), ...(ev?.output ? { output: ev.output } : {}) }
    switch (ev?.status) {
      case undefined:
      case 'pending':
      case 'awaiting_user':
        return o ? waitingStep(ref, o) : { state: 'PAYMENT', status: 'awaiting_user', ref, transitions: [awaitPoll(POLL.checkout)] }
      case 'succeeded':
        return { state: 'COMPLETED', status: 'succeeded', transitions: [], ...base }
      case 'failed':
        return { state: 'FAILED', status: 'failed', transitions: [], ...base, ...(ev.error ? { error: ev.error } : {}) }
      case 'expired':
        return { state: 'EXPIRED', status: 'expired', transitions: [], ...base, ...(ev.error ? { error: ev.error } : {}) }
      case 'refunded':
        return { state: 'REFUNDED', status: 'refunded', transitions: [], ...base }
      default:
        return { state: 'PROCESSING', sub: o?.kind === 'offramp' ? 'PAYING_OUT' : 'SENDING_CRYPTO', status: 'processing', transitions: [awaitPoll(POLL.checkout)], ...base }
    }
  }

  const orderKey = (ref: string) => `order:${ref}`

  /** Phone number in international format: `+254712345678` */
  function phoneOf(raw: string, country: string): string {
    const digits = raw.replace(/[\s().-]/g, '')
    if (!/^\+?[0-9]{7,15}$/.test(digits)) throw new OrkException(orkError('BAD_REQUEST', { message: 'Enter a valid phone number.' }), 400)
    if (digits.startsWith('+')) return digits
    const dial = DIAL[country]
    if (dial && digits.startsWith('0')) return `+${dial}${digits.slice(1)}`
    if (dial && digits.startsWith(dial)) return `+${digits}`
    return dial ? `+${dial}${digits}` : `+${digits}`
  }

  // ------------------------------------------------------------ quotes

  async function rate(ctx: AdapterContext, path: '/api/v3/rate/onramp' | '/api/v3/rate/offramp', body: Record<string, unknown>): Promise<KotaniRate> {
    try {
      return await call<KotaniRate>(ctx, 'POST', path, body)
    } catch (e) {
      throw httpErrorToOrk(e, 'Kotani Pay', { what: 'price this amount', log: ctx.log })
    }
  }

  function checkLimits(c: KotaniChannel, fiat: string) {
    if (c.min && cmp(fiat, c.min) < 0) throw new OrkException(orkError('AMOUNT_TOO_LOW', { message: `The minimum for this method is ${c.min} ${c.currency}.` }), 422)
    if (c.max && cmp(fiat, c.max) > 0) throw new OrkException(orkError('AMOUNT_TOO_HIGH', { message: `The maximum for this method is ${c.max} ${c.currency}.` }), 422)
  }

  async function quoteOnramp(c: KotaniChannel, leg: PathwayLeg, amountIn: Amount | undefined, amountOut: Amount | undefined, ctx: AdapterContext): Promise<LegQuote> {
    if (leg.to.asset.kind !== 'crypto') throw new OrkException(orkError('BAD_REQUEST', { message: 'Kotani Pay delivers crypto only.' }), 400)
    const a = assetFor(leg.to.asset.chain, leg.to.asset.token)
    let r: KotaniRate
    if (amountOut) {
      r = await rate(ctx, '/api/v3/rate/onramp', { from: c.currency, to: a.symbol, fiatAmount: Number(amountOut.amount), source: 'crypto' })
    } else {
      const total = roundTo(amountIn?.amount ?? '0', minorUnits(c.currency))
      if (cmp(total, '0') <= 0) throw new OrkException(orkError('AMOUNT_TOO_LOW'), 422)
      checkLimits(c, total)
      r = await rate(ctx, '/api/v3/rate/onramp', { from: c.currency, to: a.symbol, fiatAmount: Number(total) })
      // Kotani adds its fee on top of `fiatAmount` (`fiatAmountToSend = fiatAmount + fiatFee`).
      // When the customer pays the fee, ask again for `total - fee` so that the user pays `total`.
      if (feeBearer === 'customer' && (r.fee ?? 0) > 0) {
        const net = sub(total, fiatDec(r.fee, c.currency))
        if (cmp(net, '0') <= 0) throw new OrkException(orkError('AMOUNT_TOO_LOW', { message: 'The amount does not cover the Kotani Pay fee.' }), 422)
        r = await rate(ctx, '/api/v3/rate/onramp', { from: c.currency, to: a.symbol, fiatAmount: Number(net) })
      }
    }
    const fiatAmount = fiatDec(r.fiatAmount, c.currency)
    const fee = fiatDec(r.fee, c.currency)
    const pays = feeBearer === 'customer' ? add(fiatAmount, fee) : fiatAmount
    if (amountOut) checkLimits(c, pays)
    const spec = legById.get(leg.legId)!
    return {
      adapterId: 'kotani',
      legId: leg.legId,
      input: { amount: pays, asset: { kind: 'fiat', currency: c.currency } },
      output: { amount: cryptoDec(r.cryptoAmount, a), asset: cryptoAsset(a) },
      fees: feeBearer === 'customer' && cmp(fee, '0') > 0 ? [{ kind: 'provider', label: 'Kotani Pay fee', amount: fee, currency: c.currency }] : [],
      eta: spec.eta,
      expiresAt: new Date(Date.now() + ttl).toISOString(),
      ...(spec.limits ? { limits: spec.limits } : {}),
      data: { fiatAmount, ...(r.id ? { rateId: r.id } : {}) },
    }
  }

  async function quoteOfframp(c: KotaniChannel, leg: PathwayLeg, amountIn: Amount | undefined, amountOut: Amount | undefined, ctx: AdapterContext): Promise<LegQuote> {
    if (leg.from.asset.kind !== 'crypto') throw new OrkException(orkError('BAD_REQUEST', { message: 'Kotani Pay sells crypto only.' }), 400)
    const a = assetFor(leg.from.asset.chain, leg.from.asset.token)
    const r = amountOut
      ? await rate(ctx, '/api/v3/rate/offramp', { from: a.symbol, to: c.currency, cryptoAmount: Number(amountOut.amount), source: 'fiat' })
      : await rate(ctx, '/api/v3/rate/offramp', { from: a.symbol, to: c.currency, cryptoAmount: Number(amountIn?.amount ?? '0') })
    // `transactionAmount`: what reaches the recipient. The fee is in the fiat currency.
    const out = fiatDec(r.transactionAmount ?? r.fiatAmount, c.currency)
    checkLimits(c, out)
    const fee = fiatDec(r.fee, c.currency)
    const spec = legById.get(leg.legId)!
    const cryptoAmount = amountOut ? cryptoDec(r.cryptoAmount, a) : decimalFrom(amountIn?.amount ?? '0', a.decimals)
    return {
      adapterId: 'kotani',
      legId: leg.legId,
      input: { amount: cryptoAmount, asset: cryptoAsset(a) },
      output: { amount: out, asset: { kind: 'fiat', currency: c.currency } },
      fees: cmp(fee, '0') > 0 ? [{ kind: 'provider', label: 'Kotani Pay fee', amount: fee, currency: c.currency }] : [],
      eta: spec.eta,
      expiresAt: new Date(Date.now() + ttl).toISOString(),
      ...(spec.limits ? { limits: spec.limits } : {}),
      data: { cryptoAmount },
    }
  }

  // ------------------------------------------------------------ status

  async function remoteStatus(ref: string, o: Order | undefined, kind: 'onramp' | 'offramp', ctx: AdapterContext): Promise<LegStep> {
    if (kind === 'offramp') {
      const d = await call<KotaniOfframp>(ctx, 'GET', `/api/v3/offramp/${encodeURIComponent(ref)}`)
      const ev = offrampEvent({ ...d, referenceId: ref }, o?.currency)
      return stepFromEvent(ev, ref, o)
    }
    const d = await call<KotaniOnramp>(ctx, 'GET', `/api/v3/onramp/${encodeURIComponent(ref)}`)
    const asset = o ? cryptoAsset(o.asset) : undefined
    return stepFromEvent(onrampEvent({ ...d, referenceId: ref }, asset), ref, o)
  }

  return createAdapter({
    id: 'kotani',
    name: 'Kotani Pay',
    legs,

    /** Keep the corridors that Kotani has active and enabled for this integrator; cache the live networks. */
    async catalog(input, ctx) {
      const service = input.direction === 'withdraw' ? 'WITHDRAW' : 'DEPOSIT'
      const rows = await supportedCountries(ctx, service)
      const on = new Set(rows.filter((r) => r.isActive !== false && r.isEnabled !== false && r.countryCode).map((r) => r.countryCode!.toUpperCase()))
      return legs.filter((l) => {
        const { channel, sell } = channelFor(l.id)
        return sell === (service === 'WITHDRAW') && on.has(channel.country)
      })
    },

    async quote({ leg, amountIn, amountOut }, ctx) {
      const { channel, sell } = channelFor(leg.legId)
      return sell ? quoteOfframp(channel, leg, amountIn, amountOut, ctx) : quoteOnramp(channel, leg, amountIn, amountOut, ctx)
    },

    async start({ leg, quote, deliverTo, source }, ctx) {
      const { channel, sell } = channelFor(leg.legId)
      const ref = `${ctx.session.id}-${randomHex(6)}`
      const networks = await networksFor(channel, sell, ctx)
      let o: Order
      if (sell) {
        if (quote.input.asset.kind !== 'crypto') throw new OrkException(orkError('BAD_REQUEST', { message: 'Kotani Pay sells crypto only.' }), 400)
        const a = assetFor(quote.input.asset.chain, quote.input.asset.token)
        const sender = source?.address && source.address !== 'app' ? source.address : undefined
        o = { kind: 'offramp', legId: leg.legId, country: channel.country, currency: channel.currency, method: channel.method, rail: channel.rail, cryptoAmount: quote.input.amount, asset: a, networks, ...(sender ? { sender } : {}) }
      } else {
        if (quote.output.asset.kind !== 'crypto') throw new OrkException(orkError('BAD_REQUEST', { message: 'Kotani Pay delivers crypto only.' }), 400)
        const receiver = deliverTo?.address ?? (ctx.destination.type === 'crypto' ? ctx.destination.address : undefined)
        if (!receiver) throw new OrkException(orkError('BAD_REQUEST', { message: 'Kotani Pay needs a wallet address to deliver to.' }), 400)
        const a = assetFor(quote.output.asset.chain, quote.output.asset.token)
        const fiatAmount = String((quote.data as { fiatAmount?: string } | undefined)?.fiatAmount ?? quote.input.amount)
        o = { kind: 'onramp', legId: leg.legId, country: channel.country, currency: channel.currency, method: channel.method, rail: channel.rail, fiatAmount, asset: a, receiver, networks }
      }
      if (channel.rail === 'mobile_money' && !networks.length) {
        throw new OrkException(orkError('PROVIDER_UNAVAILABLE', { message: 'Kotani Pay has no mobile money network for this country right now.' }), 502)
      }
      await ctx.store.put(orderKey(ref), o, ORDER_TTL_SEC)
      return formStep(ref, o)
    },

    async transition({ ref, name, inputs }, ctx) {
      const o = await ctx.store.get<Order>(orderKey(ref))
      if (!o) throw new OrkException(orkError('NOT_FOUND', { message: 'Unknown Kotani Pay order.' }), 404)

      if (name === 'submit_tx') {
        if (o.kind !== 'offramp' || !o.submitted) throw new OrkException(orkError('BAD_REQUEST', { message: 'Enter the payout account first.' }), 409)
        const txHash = typeof inputs?.txHash === 'string' ? inputs.txHash.trim() : ''
        if (!txHash) throw new OrkException(orkError('BAD_REQUEST', { message: 'Send the transaction hash.' }), 400)
        const next: Order = { ...o, txHash }
        await ctx.store.put(orderKey(ref), next, ORDER_TTL_SEC)
        return waitingStep(ref, next)
      }
      if (name !== 'submit_details') throw new OrkException(orkError('BAD_REQUEST', { message: `Transition ${name} is not supported.` }), 409)
      // A second submit (double click, retry) does not create a second order.
      if (o.submitted) return waitingStep(ref, o)

      const v = (id: string) => (typeof inputs?.[id] === 'string' ? (inputs[id] as string).trim() : '')
      for (const f of formFields(o)) {
        if (f.required && !v(f.id)) throw new OrkException(orkError('BAD_REQUEST', { message: `Enter the ${f.label.toLowerCase()}.` }), 400)
      }
      const phoneNumber = phoneOf(v('phone'), o.country)
      const network = o.networks.length === 1 ? o.networks[0]! : v('network').toUpperCase()
      if (o.rail === 'mobile_money' && !o.networks.includes(network)) throw new OrkException(orkError('BAD_REQUEST', { message: 'Choose a mobile money network.' }), 400)

      let next: Order
      try {
        if (o.kind === 'onramp') {
          const body = {
            ...(o.rail === 'bank_checkout'
              ? { bankCheckout: { fullName: v('full_name'), phoneNumber, paymentMethod: 'PAYBYBANK' } }
              : { mobileMoney: { phoneNumber, accountName: v('account_name'), providerNetwork: network } }),
            fiatAmount: Number(o.fiatAmount),
            currency: o.currency,
            chain: o.asset.kotaniChain,
            token: o.asset.symbol,
            receiverAddress: o.receiver,
            referenceId: ref,
            callbackUrl: ctx.urls.webhookUrl,
          }
          const r = await call<OnrampCreated>(ctx, 'POST', '/api/v3/onramp', body)
          if (o.rail === 'bank_checkout' && !r.redirectUrl) {
            ctx.log.warn('kotani: bank checkout returned no redirectUrl', { ref })
            throw new OrkException(orkError('PROVIDER_UNAVAILABLE', { message: 'Kotani Pay did not return a bank page. Try again later.' }), 502)
          }
          next = { ...o, submitted: true, ...(r.redirectUrl ? { redirectUrl: r.redirectUrl } : {}) }
        } else {
          const body = {
            mobileMoneyReceiver: { phoneNumber, accountName: v('account_name'), networkProvider: network },
            cryptoAmount: Number(o.cryptoAmount),
            currency: o.currency,
            chain: o.asset.kotaniChain,
            token: o.asset.symbol,
            referenceId: ref,
            callbackUrl: ctx.urls.webhookUrl,
            ...(o.sender ? { senderAddress: o.sender, refund_config: { address: o.sender } } : {}),
          }
          const r = await call<KotaniOfframp>(ctx, 'POST', '/api/v3/offramp', body)
          if (!r.escrowAddress) {
            ctx.log.warn('kotani: offramp returned no escrowAddress', { ref })
            throw new OrkException(orkError('PROVIDER_UNAVAILABLE', { message: 'Kotani Pay did not return a deposit address. Try again later.' }), 502)
          }
          next = { ...o, submitted: true, escrowAddress: r.escrowAddress }
        }
      } catch (e) {
        throw startError(e, ctx)
      }
      await ctx.store.put(orderKey(ref), next, ORDER_TTL_SEC)
      return waitingStep(ref, next)
    },

    async status({ leg, ref }, ctx) {
      const o = await ctx.store.get<Order>(orderKey(ref))
      if (o && !o.submitted) return formStep(ref, o)
      const kind = o?.kind ?? (leg.legId.startsWith(SELL) ? 'offramp' : 'onramp')
      if (kind === 'offramp' && o && !o.txHash) {
        // Before the user sends, a status check must not lose the WALLET_TX step.
        const step = await remoteStatus(ref, o, kind, ctx)
        return step.state === 'PAYMENT' ? sendCryptoStep(ref, o) : step
      }
      return remoteStatus(ref, o, kind, ctx)
    },

    webhook: {
      /**
       * Signed webhooks: `X-Kotani-Signature: sha256=<hex>`, the HMAC-SHA256 with the webhook secret of
       * `JSON.stringify(body without its "signature" field)`. TO VERIFY with a live callback that this
       * re-serialization matches Kotani's for every payload (the documented method).
       */
      async verify(req, rawBody, ctx) {
        if (!opts.webhookSecret) {
          ctx.log.warn('kotani: webhook received, but no webhookSecret is set; rejecting it (status polling continues)')
          return false
        }
        const header = (req.headers.get('x-kotani-signature') ?? '').trim()
        if (!header) return false
        let parsed: unknown
        try {
          parsed = JSON.parse(rawBody)
        } catch {
          return false
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
        const { signature: _signature, ...rest } = parsed as Record<string, unknown>
        const expected = `sha256=${await hmacSha256(opts.webhookSecret, JSON.stringify(rest), 'hex')}`
        return timingSafeEqual(expected, header)
      },

      async parse(rawBody, ctx) {
        let body: { event?: string; data?: Record<string, unknown> }
        try {
          body = JSON.parse(rawBody)
        } catch {
          ctx.log.warn('kotani: webhook body is not JSON')
          return []
        }
        const d = body?.data
        if (!d || typeof d !== 'object' || typeof d.referenceId !== 'string') return []
        const ref = d.referenceId
        switch (body.event) {
          case 'transaction.onramp.status.updated': {
            // The asset comes from the payload's chain and token codes.
            const a = assets.find((x) => x.kotaniChain === String(d.chain ?? '').toUpperCase() && x.symbol === String(d.token ?? '').toUpperCase())
            const ev = onrampEvent(d as KotaniOnramp, a ? cryptoAsset(a) : undefined)
            return ev ? [ev] : []
          }
          case 'transaction.offramp.status.updated': {
            const ev = offrampEvent(d as KotaniOfframp)
            return ev ? [ev] : []
          }
          case 'refund.completed':
            return [{ ref, status: 'refunded', ...(typeof d.refundTransactionHash === 'string' ? { txHash: d.refundTransactionHash } : {}) }]
          case 'refund.failed':
            return [{ ref, status: 'failed', error: orkError('DELIVERY_FAILED', { message: 'The payout failed and the refund failed. Contact support.', recovery: 'contact_support' }) }]
          default:
            return []
        }
      },
    },

    async health(ctx) {
      try {
        await fetchJson(ctx.fetch, `${api}/health`)
        return { ok: true }
      } catch (e) {
        return { ok: false, detail: String((e as Error).message ?? e).slice(0, 200) }
      }
    },
  })
}
