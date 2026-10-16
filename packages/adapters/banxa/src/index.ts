// Banxa adapter: direct fiat onramp through Banxa Hosted Checkout, API integration
// (https://docs.banxa.com/products/hosted-checkout/docs/api-integration/api-integration-overview).
//
// - Base URL: https://api.banxa.com/{partnerRef} (sandbox https://api.banxa-sandbox.com/{partnerRef}).
// - Auth: every /v2 call sends the v2 API key in `x-api-key`. Banxa uses HMAC request signing only for
//   POST /v2/identities/token/share (KYC sharing), which this adapter does not call
//   (https://docs.banxa.com/products/hosted-checkout/docs/getting-started/authentication-and-environments).
// - Quote: GET /{partnerRef}/v2/quotes/buy?fiat&crypto&blockchain&paymentMethodId&fiatAmount|cryptoAmount.
//   Display only: no quote id, no validity window, the final price is set at checkout. The Banxa spread is
//   in the rate (https://docs.banxa.com/products/hosted-checkout/docs/api-integration/get-a-quote).
// - Order: POST /{partnerRef}/v2/buy -> { id, checkoutUrl }. The checkoutUrl must load within 1 minute of
//   the response; after it loads it does not expire
//   (https://docs.banxa.com/products/hosted-checkout/docs/api-integration/create-buy-order).
// - Status: GET /{partnerRef}/v2/orders/{orderId} (the Banxa order id, kept in the session store at start)
//   (https://docs.banxa.com/products/hosted-checkout/docs/transaction-lifecycle/order-lookup).
// - Catalog: GET /v2/countries, GET /v2/payment-methods/buy, GET /v2/crypto/buy and GET /v2/fiats/buy,
//   cached for a day (https://docs.banxa.com/products/hosted-checkout/openapi.md).
// - Webhooks: `Authorization: Bearer {hmacKey}:{hex HMAC-SHA256}:{nonce}`, signed with the HMAC secret
//   (not the v2 API key) over `POST\n{path of our webhook URL}\n{nonce}\n{raw body}`
//   (https://docs.banxa.com/products/hosted-checkout/docs/transaction-lifecycle/webhooks).
//
// Server-side only. Web-standard APIs only (fetch, WebCrypto), so it runs on Cloudflare Workers.

import {
  POLL as POLLS,
  awaitPoll,
  cachedJson,
  createAdapter,
  deliverableToAsset,
  fetchJson,
  hmacSha256,
  httpErrorToOpenRamp,
  httpStatus,
  legStepFromEvent,
  providerMessage,
  quoteExpiresAt,
  randomHex,
  requireDeliverAsset,
  resolveEnv,
  statusMap,
  timingSafeEqual,
  webhookBodyKey,
} from '@openrampkit/adapter'
import type { AdapterContext, AdapterEnv, DeliverableAsset, LegEvent, Logger, ScopedKV } from '@openrampkit/adapter'
import { OpenRampException, USDC, fromScaled, isDecimal, openRampError, roundTo, toScaled } from '@openrampkit/core'
import type { Amount, Fee, LegSpec, LegStatus, OpenRampErrorCode, PollSpec, StepDetailCode, Surface } from '@openrampkit/core'

export type BanxaDeliverAsset = DeliverableAsset & {
  /** Banxa crypto code (`crypto` in quotes and orders), e.g. `USDC` (GET /v2/crypto/buy `id`) */
  coin: string
  /**
   * Banxa blockchain code (`blockchain` in quotes and orders), e.g. `ETH`. The adapter prefers the code
   * that GET /v2/crypto/buy gives for this chain id (`network`) and uses this one when the list has none.
   */
  blockchain: string
  /** Where Banxa does not sell this asset: country -> restricted state codes (an empty list: the whole country) */
  unsupportedCountries?: Record<string, string[]>
}

export type BanxaOptions = {
  /** Partner reference from Banxa onboarding. It is the first segment of every API path. */
  partnerRef: string
  /** v2 API key (`x-api-key`). Server-side only. */
  apiKey: string
  /** Provider environment: 'sandbox' (api.banxa-sandbox.com, no real money) or 'production'. The server checks it against `livemode`. */
  env: AdapterEnv
  /** HMAC secret of the HMAC key pair. Banxa signs webhooks with it. Without it, every webhook is rejected. */
  hmacSecret?: string
  /** HMAC API key of the same pair. When set, a webhook must name this key in its Authorization header. */
  hmacKey?: string
  /**
   * The path of the webhook URL that Banxa calls, e.g. `/api/openramp/webhooks/banxa`. Banxa signs this
   * path. Default: the path of the request that the server receives. Set it when a proxy rewrites the path.
   */
  webhookPath?: string
  /** How the checkout opens. Default 'redirect' (a popup). */
  surface?: 'redirect' | 'iframe'
  /** Assets Banxa may deliver, most preferred first. Default: USDC on Base, Ethereum, Arbitrum, Optimism, Polygon. */
  deliverAssets?: BanxaDeliverAsset[]
  /** Limit the legs (leg ids, see `BANXA_METHODS`) */
  methods?: string[]
  /** Banxa `subPartnerId` on each order (a channel or site within your account) */
  subPartnerId?: string
  /** Banxa `discountCode` on each quote and order (sets your commission per order) */
  discountCode?: string
  /** Fiat currency when the quote has none. Default 'USD'. */
  baseCurrencyDefault?: string
  apiUrl?: string
}

type BxQuote = {
  paymentMethodId?: string
  cryptoAmount?: string | number | null
  fiatAmount?: string | number | null
  processingFee?: string | number | null
  networkFee?: string | number | null
  partnerFee?: string | number | null
}

type BxCreated = { id?: string; checkoutUrl?: string; externalOrderId?: string | null }

/** GET /v2/orders/{orderId} */
type BxOrder = {
  id?: string
  externalId?: string | null
  status?: string
  orderType?: string
  crypto?: { id?: string; blockchain?: string; network?: string | null } | null
  cryptoAmount?: string | number | null
  transactionHash?: string | null
}

/** Order webhook body */
type BxWebhook = {
  order_id?: string
  external_id?: string | null
  status?: string
  status_date?: string
  order_type?: string
  crypto_coin?: string
  crypto_blockchain?: string
  crypto_amount?: string | number | null
  transaction_hash?: string | null
}

type BxCoin = {
  id: string
  blockchains?: Array<{ id: string; address?: string | null; network?: string | null; unsupportedCountries?: Record<string, string[]> | unknown[] }>
}
type BxCountry = { id: string }
type BxPaymentMethod = { id: string; name?: string; supportedFiats?: string[] }
type BxFiat = { id: string; supportedPaymentMethods?: Array<{ id: string; minimum?: string; maximum?: string }> }

/** One order, from the order lookup or a webhook */
type Order = { id?: string; ref?: string; status?: string; coin?: string; blockchain?: string; network?: string | null; cryptoAmount?: string | number | null; txHash?: string | null }

const POLL: PollSpec = POLLS.checkout
const CATALOG_TTL_SEC = 24 * 60 * 60
/** Banxa quotes have no validity window; the docs call them short-lived (about 60 seconds). */
const QUOTE_TTL_MIN = 1
/** Required iframe permissions (https://docs.banxa.com/products/hosted-checkout/docs/checkout-experience/iframe/iframe-web) */
const IFRAME_ALLOW = 'payment; camera; microphone; encrypted-media'

const EEA = ['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK']

/**
 * Countries Banxa does not serve
 * (https://docs.banxa.com/products/hosted-checkout/docs/reference/geographic-and-asset-restrictions, 2026-10-16).
 * The catalog replaces the allow list with GET /v2/countries.
 */
export const BANXA_DENY_COUNTRIES = [
  'AF', 'BY', 'CF', 'TD', 'CN', 'CG', 'CD', 'CU', 'GW', 'HT', 'IR', 'IQ', 'KP', 'LB', 'LY', 'MY', 'ML', 'MD', 'MM', 'NI',
  'NG', 'NE', 'SH', 'RU', 'SO', 'SS', 'LK', 'SD', 'SY', 'TN', 'UA', 'VE', 'YE', 'ZW',
]

/** Stablecoins are not sold in Canada (geographic and asset restrictions page). The live crypto list adds the US state rules. */
const NO_STABLECOINS = { CA: [] as string[] }

/**
 * Default: USDC, most preferred first. Banxa codes from GET /v2/crypto/buy where the docs show them
 * (`ETH`, `OPTIMISM`, `MATIC` in the OpenAPI example). The adapter maps each chain id to the code that
 * the live crypto list gives, so a wrong code here only matters when that list is not available.
 */
export const DEFAULT_DELIVER_ASSETS: BanxaDeliverAsset[] = [
  // TO VERIFY: the Banxa blockchain code for Base (`BASE` inferred)
  { chain: 'eip155:8453', token: USDC['eip155:8453']!, coin: 'USDC', blockchain: 'BASE', symbol: 'USDC', decimals: 6, unsupportedCountries: NO_STABLECOINS },
  { chain: 'eip155:1', token: USDC['eip155:1']!, coin: 'USDC', blockchain: 'ETH', symbol: 'USDC', decimals: 6, unsupportedCountries: NO_STABLECOINS },
  // TO VERIFY: the Banxa blockchain code for Arbitrum (`ARB` inferred)
  { chain: 'eip155:42161', token: USDC['eip155:42161']!, coin: 'USDC', blockchain: 'ARB', symbol: 'USDC', decimals: 6, unsupportedCountries: NO_STABLECOINS },
  { chain: 'eip155:10', token: USDC['eip155:10']!, coin: 'USDC', blockchain: 'OPTIMISM', symbol: 'USDC', decimals: 6, unsupportedCountries: NO_STABLECOINS },
  { chain: 'eip155:137', token: USDC['eip155:137']!, coin: 'USDC', blockchain: 'MATIC', symbol: 'USDC', decimals: 6, unsupportedCountries: NO_STABLECOINS },
]

type MethodDef = {
  /** Leg id */
  id: string
  /** OpenRampKit method id (`packages/core/src/codes.ts`) */
  method: string
  /** Banxa `paymentMethodId` */
  paymentMethodId: string
  currencies: string[] | '*'
  /** Countries where the method exists; undefined = everywhere Banxa serves */
  countries?: string[]
  eta: { min: number; max: number }
}

const INSTANT = { min: 60, max: 900 }
const BANK = { min: 3600, max: 3 * 86400 }
const LOCAL = { min: 120, max: 3600 }
/** Leg id prefix of catalog legs for Banxa methods that `BANXA_METHODS` does not list */
const UNKNOWN_PREFIX = 'bx_'

/** Card, Apple Pay and Google Pay fiats (supported payment methods page, 2026-10-16) */
const CARD_FIATS = [
  'AUD', 'AED', 'CAD', 'CHF', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD', 'IDR', 'INR', 'JPY', 'MXN', 'NOK', 'NZD', 'PHP', 'PLN', 'QAR', 'RON', 'SAR',
  'SEK', 'SGD', 'THB', 'TRY', 'TWD', 'USD', 'VND', 'ZAR',
]

/**
 * One leg per buy payment method. Ids, regions and fiats from
 * https://docs.banxa.com/products/hosted-checkout/docs/reference/supported-payment-methods (2026-10-16).
 * The catalog refines the fiats with GET /v2/payment-methods/buy, and adds methods it does not know.
 * ACH (`ach-bank-transfer`) is not here: the docs say ACH is for sell orders only.
 */
export const BANXA_METHODS: MethodDef[] = [
  { id: 'card', method: 'card', paymentMethodId: 'debit-credit-card', currencies: CARD_FIATS, eta: INSTANT },
  { id: 'apple_pay', method: 'apple_pay', paymentMethodId: 'apple-pay', currencies: CARD_FIATS, eta: INSTANT },
  { id: 'google_pay', method: 'google_pay', paymentMethodId: 'google-pay', currencies: CARD_FIATS, eta: INSTANT },
  { id: 'sepa', method: 'sepa', paymentMethodId: 'sepa-bank-transfer', currencies: ['EUR'], countries: [...EEA, 'CH'], eta: BANK },
  { id: 'gbp_bank', method: 'faster_payments', paymentMethodId: 'gbp-bank-transfer', currencies: ['GBP'], countries: ['GB'], eta: LOCAL },
  { id: 'payid', method: 'payid', paymentMethodId: 'payid-bank-transfer', currencies: ['AUD'], countries: ['AU'], eta: LOCAL },
  // NPP Direct Entry: an Australian bank transfer with BSB and account number
  { id: 'npp', method: 'bank_transfer', paymentMethodId: 'npp-bank-transfer', currencies: ['AUD'], countries: ['AU'], eta: LOCAL },
  { id: 'ideal', method: 'ideal', paymentMethodId: 'ideal-bank-transfer', currencies: ['EUR'], countries: ['NL'], eta: LOCAL },
  { id: 'klarna', method: 'klarna', paymentMethodId: 'klarna-paynow', currencies: ['EUR', 'SEK'], countries: ['AT', 'BE', 'FI', 'DE', 'NL', 'ES', 'SE'], eta: { min: 120, max: 86400 } },
  { id: 'paypal', method: 'paypal', paymentMethodId: 'paypal', currencies: ['EUR'], countries: EEA, eta: INSTANT },
  { id: 'interac', method: 'interac', paymentMethodId: 'interac-bank-transfer', currencies: ['CAD'], countries: ['CA'], eta: LOCAL },
  { id: 'spei', method: 'spei', paymentMethodId: 'spei', currencies: ['MXN'], countries: ['MX'], eta: LOCAL },
  { id: 'khipu', method: 'khipu', paymentMethodId: 'khipu', currencies: ['CLP'], countries: ['CL'], eta: LOCAL },
  { id: 'zar_bank', method: 'bank_transfer', paymentMethodId: 'zar-bank-transfer', currencies: ['ZAR'], countries: ['ZA'], eta: LOCAL },
  { id: 'vietqr', method: 'vietqr', paymentMethodId: 'viet-qr', currencies: ['VND'], countries: ['VN'], eta: LOCAL },
  // TO VERIFY: UPI is in the paymentMethodId list of the quote and order pages, but not in the supported payment methods table.
  { id: 'upi', method: 'upi', paymentMethodId: 'upi', currencies: ['INR'], countries: ['IN'], eta: LOCAL },
]

/**
 * Banxa buy order statuses (https://docs.banxa.com/products/hosted-checkout/docs/transaction-lifecycle/order-statuses).
 * Settle only on `complete`: `paymentReceived` can still end in `cancelled` after a risk review.
 * `expired` can resume when a late payment arrives; the leg ends as `expired`, and the server's late
 * payment path takes a later `complete`. An unknown status is no event: the leg keeps its current step.
 */
const STATUS = statusMap<{ status: LegStatus; detail?: StepDetailCode }>('Banxa', {
  // Order created; the user does KYC and pays in the checkout
  pendingPayment: { status: 'requires_action' },
  // The user sent payment details; Banxa waits for the payment system to confirm
  waitingPayment: { status: 'processing', detail: 'processing' },
  paymentReceived: { status: 'processing', detail: 'settling' },
  inProgress: { status: 'processing', detail: 'processing' },
  // Held for extra verification (ID, address, source of funds); Banxa support contacts the user
  extraVerification: { status: 'processing', detail: 'delayed' },
  // The crypto transaction is on the chain; `complete` follows after 2 confirmations
  cryptoTransferred: { status: 'processing', detail: 'confirming' },
  complete: { status: 'succeeded' },
  // Cancelled by Banxa (risk and compliance)
  cancelled: { status: 'failed' },
  // Declined by the payment system
  declined: { status: 'failed' },
  expired: { status: 'expired' },
  refunded: { status: 'refunded' },
})

/** The canonical string that Banxa signs: `METHOD\nPATH\nNONCE` plus `\nBODY` when there is a body. */
export function banxaCanonical(method: string, path: string, nonce: string, body?: string): string {
  return [method.toUpperCase(), path, nonce, ...(body !== undefined && body !== '' ? [body] : [])].join('\n')
}

/** Hex HMAC-SHA256 of the Banxa canonical string with the HMAC secret */
export function banxaSignature(secret: string, method: string, path: string, nonce: string, body?: string): Promise<string> {
  return hmacSha256(secret, banxaCanonical(method, path, nonce, body), 'hex')
}

/** A provider decimal (string or number) as a decimal string with at most `digits` fraction digits and no trailing zeros */
function dec(v: string | number | null | undefined, digits: number): string | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const s = typeof v === 'number' ? (Number.isFinite(v) ? v.toFixed(digits) : '') : v.trim()
  if (!isDecimal(s)) return undefined
  return fromScaled(toScaled(s, digits), digits)
}

const positive = (v: string | undefined): v is string => v !== undefined && Number(v) > 0

/** The application error code of a Banxa error body (`code`, `errorCode` or `error.code`), when it has one. TO VERIFY: the error body shape. */
function providerCode(e: unknown): string | undefined {
  const body = (e as { body?: unknown } | undefined)?.body
  if (!body || typeof body !== 'object') return undefined
  const b = body as { code?: unknown; errorCode?: unknown; error?: unknown }
  const nested = b.error && typeof b.error === 'object' ? (b.error as { code?: unknown }).code : undefined
  for (const c of [b.code, b.errorCode, nested]) if ((typeof c === 'string' && c) || typeof c === 'number') return String(c)
  return undefined
}

/**
 * A failed Banxa call as an OpenRampException. Documented: 401 is a setup error (wrong key or wrong
 * environment), 429 is a rate limit, 400 and 422 carry an application `code`, and code 5034 means the
 * coin is not sold in the user's region. TO VERIFY: the messages for amount limits and KYC refusals
 * (Banxa documents no codes for them); we match their text.
 */
function banxaError(e: unknown, log: Pick<Logger, 'warn' | 'error'>, what: string, noQuoteStatuses?: number[]): OpenRampException {
  const status = httpStatus(e)
  if (status === 400 || status === 422) {
    const code = providerCode(e)
    const msg = providerMessage(e) ?? ''
    const own = (c: OpenRampErrorCode, message: string) => new OpenRampException(openRampError(c, { message: `Banxa: ${msg || message}`.slice(0, 200), recovery: 'choose_other' }), 422)
    if (code === '5034' || /restrict|not (available|supported) (in|for) (your|this) (country|region|location)/i.test(msg)) return own('REGION_UNSUPPORTED', 'this asset is not sold in your region.')
    if (/\b(minimum|too low|below|at least)\b/i.test(msg)) return own('AMOUNT_TOO_LOW', 'the amount is too low.')
    if (/\b(maximum|too high|above|exceeds?)\b/i.test(msg)) return own('AMOUNT_TOO_HIGH', 'the amount is too high.')
    if (/\b(kyc|identity|verification)\b/i.test(msg) && /\b(reject|rejected|failed|declined|blocked)\b/i.test(msg)) return own('KYC_REJECTED', 'identity verification failed.')
  }
  return httpErrorToOpenRamp(e, 'Banxa', {
    what,
    log,
    ...(noQuoteStatuses ? { noQuoteStatuses } : {}),
    setupHint: 'Check the Banxa apiKey (the v2 x-api-key), partnerRef and env: sandbox keys only work on api.banxa-sandbox.com, production keys only on api.banxa.com.',
  })
}

export function banxa(opts: BanxaOptions) {
  if (!opts.partnerRef) throw new Error('banxa: partnerRef is required')
  if (!/^[A-Za-z0-9_-]+$/.test(opts.partnerRef)) throw new Error('banxa: partnerRef must be letters, digits, - or _')
  const env = resolveEnv('banxa', opts.env, undefined, 'production')
  const host = (opts.apiUrl ?? (env === 'sandbox' ? 'https://api.banxa-sandbox.com' : 'https://api.banxa.com')).replace(/\/+$/, '')
  const base = `${host}/${opts.partnerRef}/v2`
  const headers = { 'x-api-key': opts.apiKey }
  const deliver = opts.deliverAssets?.length ? opts.deliverAssets : DEFAULT_DELIVER_ASSETS
  const allow = (id: string) => !opts.methods || opts.methods.includes(id)
  const defs = BANXA_METHODS.filter((m) => allow(m.id))
  if (!defs.length) throw new Error('banxa: `methods` selects no known leg')
  const byId = new Map(BANXA_METHODS.map((d) => [d.id, d]))
  const byPaymentMethod = new Map(BANXA_METHODS.map((d) => [d.paymentMethodId, d]))
  const toChains: Record<string, string[]> = {}
  for (const d of deliver) (toChains[d.chain] ??= []).push(d.chain.startsWith('eip155:') ? d.token.toLowerCase() : d.token)

  const legFor = (d: MethodDef, allowed?: string[]): LegSpec => ({
    id: d.id,
    kind: 'fiat_onramp',
    methods: [d.method],
    from: { asset: { kind: 'fiat', currencies: d.currencies }, location: ['user_account'] },
    to: { asset: { kind: 'crypto', chains: toChains }, location: ['address'] },
    regions: allowed ? { allow: allowed, deny: [] } : { allow: d.countries ?? ['*'], deny: BANXA_DENY_COUNTRIES },
    eta: d.eta,
    surfaces: [opts.surface === 'iframe' ? 'IFRAME' : 'REDIRECT'],
    requires: ['provider_kyc'],
  })
  const legs = defs.map((d) => legFor(d))

  /**
   * A leg from the catalog for a Banxa method that `BANXA_METHODS` does not list: leg id `bx_` plus the
   * Banxa id with `_` for `-`, method id the Banxa id in lowercase with `_`.
   */
  const unknownDef = (paymentMethodId: string, currencies: string[]): MethodDef => {
    const method = paymentMethodId.toLowerCase().replace(/-/g, '_')
    return { id: `${UNKNOWN_PREFIX}${method}`, method, paymentMethodId: paymentMethodId.toLowerCase(), currencies, eta: { min: 60, max: 86400 } }
  }

  function def(legId: string): MethodDef {
    const d = byId.get(legId)
    if (d && allow(legId)) return d
    // A catalog leg for a method the static table does not list (see `unknownDef`)
    if (!d && legId.startsWith(UNKNOWN_PREFIX) && /^[a-z0-9_]+$/.test(legId.slice(UNKNOWN_PREFIX.length)) && allow(legId)) {
      return unknownDef(legId.slice(UNKNOWN_PREFIX.length).replace(/_/g, '-'), [])
    }
    throw new OpenRampException(openRampError('BAD_REQUEST', { message: `Unknown Banxa leg ${legId}` }), 400)
  }

  const get = <T>(ctx: Pick<AdapterContext, 'fetch'>, path: string) => fetchJson<T>(ctx.fetch, `${base}${path}`, { headers })

  /** A catalog list from GET {path}, cached for a day. Throws when Banxa gives no list. */
  const catalogList = <T>(ctx: Pick<AdapterContext, 'fetch' | 'shared'>, key: string, path: string) =>
    cachedJson<T[]>(
      ctx.shared,
      key,
      CATALOG_TTL_SEC,
      async () => {
        const list = await get<T[]>(ctx, path)
        if (!Array.isArray(list) || !list.length) throw new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message: 'Banxa returned an empty list.' }), 502)
        return list
      },
      { valid: (l) => Array.isArray(l) && l.length > 0 },
    )

  /**
   * The Banxa blockchain code and region rules for `d`, from the live crypto list (by coin and chain id).
   * Falls back to the static entry when the list fails or has no match.
   */
  async function coinFor(d: BanxaDeliverAsset, ctx: Pick<AdapterContext, 'fetch' | 'shared' | 'log'>): Promise<{ blockchain: string; unsupported: Record<string, string[]> }> {
    const fallback = { blockchain: d.blockchain, unsupported: d.unsupportedCountries ?? {} }
    const chainId = d.chain.startsWith('eip155:') ? d.chain.slice(7) : undefined
    let list: BxCoin[]
    try {
      list = await catalogList<BxCoin>(ctx, 'crypto', '/crypto/buy')
    } catch (e) {
      ctx.log.warn('banxa: GET /v2/crypto/buy failed; using the static blockchain code', { error: String((e as Error)?.message ?? e).slice(0, 200) })
      return fallback
    }
    const coin = list.find((c) => c.id?.toUpperCase() === d.coin.toUpperCase())
    const chain = coin?.blockchains?.find(
      (b) => (chainId !== undefined && b.network === chainId && (!b.address || b.address.toLowerCase() === d.token.toLowerCase())) || (chainId === undefined && b.id === d.blockchain),
    )
    if (!chain) return fallback
    const live = chain.unsupportedCountries && !Array.isArray(chain.unsupportedCountries) ? chain.unsupportedCountries : {}
    return { blockchain: chain.id, unsupported: { ...fallback.unsupported, ...live } }
  }

  /** REGION_UNSUPPORTED when Banxa does not sell the asset in the user's country or US state */
  function checkRegion(d: BanxaDeliverAsset, unsupported: Record<string, string[]>, ctx: AdapterContext) {
    const country = ctx.session.country?.toUpperCase()
    if (!country) return
    const states = unsupported[country]
    if (!states) return
    const region = ctx.session.region?.toUpperCase()
    const state = region?.startsWith(`${country}-`) ? region.slice(country.length + 1) : undefined
    if (!states.length || (state && states.map((s) => s.toUpperCase()).includes(state))) {
      throw new OpenRampException(openRampError('REGION_UNSUPPORTED', { message: `Banxa does not sell ${d.symbol ?? d.coin} on this network in your region.`, recovery: 'choose_other' }), 422)
    }
  }

  /** AMOUNT_TOO_LOW or AMOUNT_TOO_HIGH from the per-method limits of GET /v2/fiats/buy. Skipped when the list fails. */
  async function checkLimits(fiat: string, paymentMethodId: string, value: string, ctx: AdapterContext) {
    let fiats: BxFiat[]
    try {
      fiats = await catalogList<BxFiat>(ctx, 'fiats', '/fiats/buy')
    } catch {
      return
    }
    const lim = fiats.find((f) => f.id?.toUpperCase() === fiat)?.supportedPaymentMethods?.find((p) => p.id === paymentMethodId)
    if (!lim) return
    const n = Number(value)
    if (lim.minimum && Number(lim.minimum) > 0 && n < Number(lim.minimum)) {
      throw new OpenRampException(openRampError('AMOUNT_TOO_LOW', { message: `The Banxa minimum is ${lim.minimum} ${fiat}.`, recovery: 'requote' }), 422)
    }
    if (lim.maximum && Number(lim.maximum) > 0 && n > Number(lim.maximum)) {
      throw new OpenRampException(openRampError('AMOUNT_TOO_HIGH', { message: `The Banxa maximum is ${lim.maximum} ${fiat}.`, recovery: 'requote' }), 422)
    }
  }

  /** The delivered asset of an order: by coin, and by blockchain code (static, or from the cached crypto list) or chain id */
  async function assetOf(o: Order, shared: ScopedKV): Promise<BanxaDeliverAsset | undefined> {
    const coin = o.coin?.toUpperCase()
    if (!coin) return undefined
    const same = deliver.filter((d) => d.coin.toUpperCase() === coin)
    if (o.network) {
      const hit = same.find((d) => d.chain === `eip155:${o.network}`)
      if (hit) return hit
    }
    if (!o.blockchain) return undefined
    const direct = same.find((d) => d.blockchain.toUpperCase() === o.blockchain!.toUpperCase())
    if (direct) return direct
    const list = await shared.get<BxCoin[]>('crypto')
    const network = list?.find((c) => c.id?.toUpperCase() === coin)?.blockchains?.find((b) => b.id === o.blockchain)?.network
    return network ? same.find((d) => d.chain === `eip155:${network}`) : undefined
  }

  async function eventFrom(o: Order, shared: ScopedKV, log: Pick<Logger, 'warn'>): Promise<LegEvent | undefined> {
    if (!o.ref) return undefined
    const m = STATUS(o.status, log)
    if (!m) return undefined
    const d = await assetOf(o, shared)
    const value = d ? dec(o.cryptoAmount, d.decimals ?? 8) : undefined
    const output: Amount | undefined = d && positive(value) ? { value, asset: deliverableToAsset(d) } : undefined
    const base: LegEvent = { ref: o.ref, status: m.status, ...(o.id ? { providerRef: o.id } : {}), ...(m.detail ? { detail: { code: m.detail, providerStatus: o.status! } } : {}) }
    // Webhooks send `transaction_hash: "0"` before `complete`
    const hash = o.txHash && o.txHash !== '0' ? o.txHash : undefined
    switch (m.status) {
      case 'succeeded':
        return {
          ...base,
          ...(hash ? { transactions: [{ role: 'destination' as const, hash, ...(d ? { chain: d.chain } : {}) }] } : {}),
          ...(output ? { output } : {}),
        }
      case 'failed':
        return {
          ...base,
          error:
            o.status === 'declined'
              ? openRampError('PAYMENT_FAILED', { message: 'The payment was declined. Try again or use another method.', recovery: 'retry_payment' })
              : openRampError('PROVIDER_DECLINED', { message: 'Banxa cancelled this order after a review. Contact Banxa support for details.', recovery: 'contact_support' }),
        }
      case 'processing':
        return { ...base, ...(hash ? { transactions: [{ role: 'destination' as const, hash, ...(d ? { chain: d.chain } : {}) }] } : {}), ...(output ? { output } : {}) }
      default:
        // requires_action: the user still pays in the checkout (no surface: the UI keeps it). expired, refunded: final.
        return base
    }
  }

  const orderKey = (ref: string) => `order:${ref}`

  return createAdapter({
    id: 'banxa',
    env,
    name: 'Banxa',
    legs,

    async catalog(_input, ctx) {
      const [countries, methods] = await Promise.all([
        catalogList<BxCountry>(ctx, 'countries', '/countries'),
        catalogList<BxPaymentMethod>(ctx, 'payment-methods', '/payment-methods/buy'),
      ])
      const allowed = countries.map((c) => c.id?.toUpperCase()).filter((c): c is string => !!c && !BANXA_DENY_COUNTRIES.includes(c))
      const out: LegSpec[] = []
      const seen = new Set<string>()
      for (const pm of methods) {
        if (!pm?.id || seen.has(pm.id)) continue
        seen.add(pm.id)
        const fiats = (pm.supportedFiats ?? []).map((f) => f.toUpperCase())
        if (!fiats.length) continue
        const known = byPaymentMethod.get(pm.id)
        const d = known ? { ...known, currencies: fiats } : unknownDef(pm.id, fiats)
        // ACH is a sell method (supported payment methods page); skip it if the buy list ever names it.
        if (!allow(d.id) || (!known && pm.id === 'ach-bank-transfer')) continue
        const where = d.countries ? d.countries.filter((c) => allowed.includes(c)) : allowed
        if (where.length) out.push(legFor(d, where))
      }
      if (!out.length) throw new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message: 'Banxa returned no buy methods.' }), 502)
      return out
    },

    async quote(input, ctx) {
      const d = def(input.leg.legId)
      const target = requireDeliverAsset(deliver, input.leg.to.asset.kind === 'crypto' ? input.leg.to.asset : undefined, 'Banxa')
      const { blockchain, unsupported } = await coinFor(target, ctx)
      checkRegion(target, unsupported, ctx)
      const fiatAsset = input.amountIn?.asset ?? input.leg.from.asset
      const fiat = (fiatAsset.kind === 'fiat' ? fiatAsset.currency : opts.baseCurrencyDefault ?? 'USD').toUpperCase()
      const q = new URLSearchParams({ fiat, crypto: target.coin, blockchain, paymentMethodId: d.paymentMethodId })
      let side: 'fiat' | 'crypto'
      if (input.amountIn) {
        side = 'fiat'
        const amount = roundTo(input.amountIn.value, 2)
        await checkLimits(fiat, d.paymentMethodId, amount, ctx)
        q.set('fiatAmount', amount)
      } else if (input.amountOut) {
        side = 'crypto'
        q.set('cryptoAmount', roundTo(input.amountOut.value, Math.min(8, target.decimals ?? 8)))
      } else throw new OpenRampException(openRampError('BAD_REQUEST', { message: 'Banxa quotes need an amount.' }))
      if (ctx.session.userId) q.set('externalCustomerId', ctx.session.userId)
      if (ctx.session.ip) q.set('ipAddress', ctx.session.ip)
      if (opts.discountCode) q.set('discountCode', opts.discountCode)
      let res: BxQuote | BxQuote[]
      try {
        res = await get<BxQuote | BxQuote[]>(ctx, `/quotes/buy?${q}`)
      } catch (e) {
        throw banxaError(e, ctx.log, 'price this amount')
      }
      // With a discountCode the answer is a list
      const r = Array.isArray(res) ? res[0] : res
      const output = dec(r?.cryptoAmount, target.decimals ?? 8)
      const total = dec(r?.fiatAmount, 2)
      if (!positive(output) || !positive(total)) {
        throw new OpenRampException(openRampError('NO_QUOTES', { message: 'Banxa did not return a quote for this amount.' }), 422)
      }
      const fiatAmt = (v: string): Amount => ({ value: v, asset: { kind: 'fiat', currency: fiat } })
      // `fiatAmount` is what the user spends; the docs give fiatAmount / cryptoAmount as the all-in rate,
      // so both fees are inside it. TO VERIFY with a sandbox order that the checkout charges fiatAmount.
      const fees: Fee[] = []
      const processing = dec(r!.processingFee, 2)
      const network = dec(r!.networkFee, 2)
      const partner = dec(r!.partnerFee, 2)
      if (positive(processing)) fees.push({ kind: 'provider', label: 'Banxa processing fee', amount: fiatAmt(processing), included: true })
      if (positive(network)) fees.push({ kind: 'network', label: 'Network fee', amount: fiatAmt(network), included: true })
      if (positive(partner)) fees.push({ kind: 'app', label: 'App fee', amount: fiatAmt(partner), included: true })
      // The Banxa spread is in the exchange rate and has no stated amount.
      fees.push({ kind: 'provider', label: 'Banxa spread (in the rate)', amount: null, included: true })
      return {
        adapterId: 'banxa',
        legId: d.id,
        input: fiatAmt(total),
        output: { value: output, asset: deliverableToAsset(target) },
        fees,
        // The final price is set at checkout.
        guarantee: 'estimate',
        eta: d.eta,
        expiresAt: quoteExpiresAt(QUOTE_TTL_MIN),
        data: { coin: target.coin, blockchain, paymentMethodId: d.paymentMethodId, fiat, side, fiatAmount: total, cryptoAmount: output },
      }
    },

    async start(input, ctx) {
      const d = def(input.leg.legId)
      const data = (input.quote.data ?? {}) as { coin?: string; blockchain?: string; paymentMethodId?: string; fiat?: string; side?: 'fiat' | 'crypto'; cryptoAmount?: string }
      const target = requireDeliverAsset(deliver, input.quote.output.asset.kind === 'crypto' ? input.quote.output.asset : undefined, 'Banxa')
      const walletAddress = input.deliverTo?.address ?? (ctx.destination.type === 'crypto' ? ctx.destination.address : undefined)
      if (!walletAddress) throw new OpenRampException(openRampError('BAD_REQUEST', { message: 'Banxa needs a wallet address to deliver to.' }))
      const fiat = input.quote.input.asset.kind === 'fiat' ? input.quote.input.asset.currency : data.fiat ?? opts.baseCurrencyDefault ?? 'USD'
      // externalOrderId routes webhooks back to this leg. A new one per start: a retry after an expired
      // checkout URL makes a new Banxa order. TO VERIFY: whether Banxa rejects a repeated externalOrderId.
      const ref = `ork_${randomHex(12)}`
      const body: Record<string, string> = {
        crypto: data.coin ?? target.coin,
        blockchain: data.blockchain ?? target.blockchain,
        fiat: fiat.toUpperCase(),
        // One side only: Banxa uses cryptoAmount when both are set.
        ...(data.side === 'crypto' && data.cryptoAmount ? { cryptoAmount: data.cryptoAmount } : { fiatAmount: roundTo(input.quote.input.value, 2) }),
        walletAddress,
        redirectUrl: ctx.urls.returnUrl,
        paymentMethodId: data.paymentMethodId ?? d.paymentMethodId,
        // A stable id per user, so returning users skip repeat KYC. Optional fields are left out, never null.
        externalCustomerId: ctx.session.userId,
        externalOrderId: ref,
      }
      if (ctx.session.email) body.email = ctx.session.email
      if (opts.subPartnerId) body.subPartnerId = opts.subPartnerId
      if (opts.discountCode) body.discountCode = opts.discountCode
      let res: BxCreated
      try {
        res = await fetchJson<BxCreated>(ctx.fetch, `${base}/buy`, { method: 'POST', headers, body: JSON.stringify(body) })
      } catch (e) {
        throw banxaError(e, ctx.log, 'create this order')
      }
      if (!res?.id || !res.checkoutUrl) {
        throw new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message: 'Banxa did not return a checkout.' }), 502)
      }
      let origin: string
      try {
        origin = new URL(res.checkoutUrl).origin
      } catch {
        throw new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message: 'Banxa returned a checkout URL that is not valid.' }), 502)
      }
      // status() reads the order by the Banxa id.
      await ctx.store.put(orderKey(ref), res.id)
      // The checkout URL must load within 1 minute; the UI opens it at once.
      // In an iframe, the checkout leaves the frame for KYC, for Apple Pay and in browsers that block third-party cookies.
      const surface: Surface =
        opts.surface === 'iframe'
          ? { kind: 'IFRAME', url: res.checkoutUrl, origin, allow: IFRAME_ALLOW, height: 700, provider: 'Banxa' }
          : { kind: 'REDIRECT', url: res.checkoutUrl, popup: true, provider: 'Banxa' }
      return { status: 'requires_action', action: { kind: 'payment', surface, transitions: [awaitPoll(POLL)] }, ref, providerRef: res.id }
    },

    async status(input, ctx) {
      const id = await ctx.store.get<string>(orderKey(input.ref))
      if (!id) {
        ctx.log.warn('banxa: no Banxa order id for this leg; waiting for a webhook', { ref: input.ref })
        return legStepFromEvent(undefined, input.ref, POLL)
      }
      let o: BxOrder
      try {
        o = await get<BxOrder>(ctx, `/orders/${encodeURIComponent(id)}`)
      } catch (e) {
        if (httpStatus(e) === 404) return legStepFromEvent(undefined, input.ref, POLL)
        throw banxaError(e, ctx.log, 'find this order', [])
      }
      const ev = await eventFrom(
        { id: o.id ?? id, ref: input.ref, status: o.status, coin: o.crypto?.id, blockchain: o.crypto?.blockchain, network: o.crypto?.network, cryptoAmount: o.cryptoAmount, txHash: o.transactionHash },
        ctx.shared,
        ctx.log,
      )
      // No event (an unknown status): a status poll. The server never moves a leg back.
      return legStepFromEvent(ev, input.ref, POLL)
    },

    webhook: {
      // Without the HMAC secret, no webhook can verify (see `resultChannels`).
      configured: !!opts.hmacSecret,
      async verify(req, rawBody, ctx) {
        if (!opts.hmacSecret) {
          ctx.log.warn('banxa: hmacSecret is not set; rejecting webhook')
          return false
        }
        const auth = req.headers.get('authorization')?.trim()
        const m = auth ? /^Bearer\s+(.+)$/i.exec(auth) : null
        if (!m) return false
        // `{key}:{signature}:{nonce}`. The nonce is opaque: use it exactly as received.
        const parts = m[1]!.split(':')
        if (parts.length < 3) return false
        const nonce = parts.pop()!
        const signature = parts.pop()!
        const key = parts.join(':')
        if (!nonce || !/^[0-9a-fA-F]{64}$/.test(signature)) return false
        if (opts.hmacKey && !timingSafeEqual(key, opts.hmacKey)) return false
        // Banxa signs the path of our own webhook URL (not a Banxa path). TO VERIFY: whether a query string is part of it.
        let path: string
        try {
          path = opts.webhookPath ?? new URL(req.url).pathname
        } catch {
          return false
        }
        // No time window: the docs say to treat the nonce as opaque, and Banxa retries the same delivery
        // for up to 2 hours. Replays are dropped by `replayKey`, and events only move a leg forward.
        const expected = await banxaSignature(opts.hmacSecret, 'POST', path, nonce, rawBody)
        return timingSafeEqual(signature.toLowerCase(), expected)
      },
      async parse(rawBody, ctx) {
        let body: BxWebhook
        try {
          body = JSON.parse(rawBody) as BxWebhook
        } catch {
          ctx.log.warn('banxa: webhook body is not JSON')
          return []
        }
        // Order webhooks only. KYC, extra verification and account blocked webhooks have no external_id.
        if (!body || typeof body !== 'object' || !body.order_id || !body.external_id || (body.order_type && body.order_type.toUpperCase() !== 'BUY')) return []
        const ev = await eventFrom(
          { id: body.order_id, ref: body.external_id, status: body.status, coin: body.crypto_coin, blockchain: body.crypto_blockchain, cryptoAmount: body.crypto_amount, txHash: body.transaction_hash },
          ctx.shared,
          ctx.log,
        )
        return ev ? [{ ...ev, eventId: orderEventKey(body) }] : []
      },
      async replayKey(_req, rawBody) {
        // The docs suggest order_id and status as the dedupe key. With status_date, a later move back to
        // the same status (for example after extra verification) is a new event. Other bodies: their hash.
        try {
          const body = JSON.parse(rawBody) as BxWebhook
          if (body?.order_id && body.status) return orderEventKey(body)
        } catch {
          // not JSON: hash the body
        }
        return webhookBodyKey(rawBody)
      },
    },

    async health(ctx) {
      try {
        await get(ctx, '/countries')
        return { ok: true }
      } catch (e) {
        return { ok: false, detail: String((e as Error)?.message ?? e).slice(0, 200) }
      }
    },
  })
}

function orderEventKey(b: BxWebhook): string {
  return `banxa:${b.order_id}:${b.status}:${b.status_date ?? ''}`
}

