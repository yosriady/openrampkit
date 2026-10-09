// Meld adapter: aggregated fiat onramp quotes from many providers (https://docs.meld.io).
//
// - Auth: `Authorization: BASIC <apiKey>` and `Meld-Version: 2026-02-03`. Sandbox https://api-sb.meld.io,
//   production https://api.meld.io.
// - Catalog: GET /service-providers/properties/payment-methods (categories=CRYPTO_ONRAMP, countries,
//   fiatCurrencies, serviceProviders). One leg per payment method.
// - Quote: POST /payments/crypto/quote returns one quote per service provider. The best (most crypto
//   out) is the leg quote; the whole list is in `quote.data.providers`.
// - Start: POST /crypto/session/widget (sessionType BUY) with the chosen provider gives a widget URL
//   (REDIRECT). We prefer `serviceProviderWidgetUrl`; `widgetUrl` is Meld's hosted fallback.
// - Status: GET /payments/transactions?externalSessionIds=<ref>.
// - Webhooks: `Meld-Signature` = base64url (with padding) HMAC-SHA256 over
//   `${Meld-Signature-Timestamp}.${webhookUrl}.${rawBody}` with the webhook profile secret.
//
// Server-side only. Web-standard APIs only (fetch, WebCrypto), so it runs on Cloudflare Workers.

import {
  POLL as POLLS,
  awaitPoll,
  cachedJson,
  createAdapter,
  decimalFrom,
  deliverableToAsset,
  fetchJson,
  httpErrorToOpenRamp,
  legStepFromEvent,
  quoteExpiresAt,
  randomHex,
  requireDeliverAsset,
  resolveEnv,
  statusMap,
  verifyTimestampedHmac,
} from '@openrampkit/adapter'
import type { AdapterContext, AdapterEnv, LegEvent, Logger } from '@openrampkit/adapter'
import { OpenRampException, USDC, cmp, openRampError, roundTo } from '@openrampkit/core'
import type { Amount, Asset, Fee, LegSpec, LegStatus, PollSpec, StepDetailCode } from '@openrampkit/core'

export type MeldDeliverAsset = { chain: string; token: string; currencyCode: string; symbol?: string; decimals?: number }

export type MeldOptions = {
  /** Meld API key (sent as `Authorization: BASIC <apiKey>`) */
  apiKey: string
  /** Provider environment: 'sandbox' (test keys, no real money) or 'production'. The server checks it against `livemode`. */
  env: AdapterEnv
  /** Only quote these service providers (e.g. ['TRANSAK', 'BANXA']). Default: every provider on your account. */
  serviceProviders?: string[]
  /** Webhook profile secret (GET /notifications/webhooks). Needed to accept webhooks. */
  webhookSecret?: string
  /**
   * The webhook URL registered in the Meld profile. The signature covers it. Default: the URL of the
   * incoming request, which is right unless a proxy rewrites it.
   */
  webhookUrl?: string
  /** Assets Meld may deliver, most preferred first. Default: USDC on Base, Ethereum, Polygon, Arbitrum. */
  deliverAssets?: MeldDeliverAsset[]
  /** Country used for quotes when the session has none. Default 'US'. */
  defaultCountry?: string
  /** Default '2026-02-03' */
  version?: string
  apiUrl?: string
}

type MeldQuote = {
  transactionType?: string
  sourceAmount?: number
  sourceAmountWithoutFees?: number
  destinationAmount?: number
  destinationCurrencyCode?: string
  sourceCurrencyCode?: string
  exchangeRate?: number
  transactionFee?: number
  networkFee?: number
  partnerFee?: number
  totalFee?: number
  serviceProvider?: string
  paymentMethodType?: string
  rampIntelligence?: { rampScore?: number; lowKyc?: boolean; previouslyUsed?: boolean }
}

type MeldTransaction = {
  id?: string
  status?: string
  destinationAmount?: number
  destinationCurrencyCode?: string
  externalSessionId?: string
  serviceProvider?: string
  cryptoDetails?: { blockchainTransactionId?: string | null; chainId?: string | null }
}

type MeldPaymentMethod = { paymentMethod: string; name?: string; paymentType?: string }

const POLL: PollSpec = POLLS.checkout

/**
 * Meld transaction status -> leg status (and a step detail). A status that is not in the table is
 * logged once and gives no event: the leg keeps its current step.
 */
const STATUS = statusMap<{ status: LegStatus; detail?: StepDetailCode }>('Meld', {
  // The user is still in the provider page (2FA too)
  PENDING_CREATED: { status: 'requires_action' },
  TWO_FA_REQUIRED: { status: 'requires_action' },
  PENDING: { status: 'processing', detail: 'processing' },
  TWO_FA_PROVIDED: { status: 'processing', detail: 'processing' },
  ACCEPTED: { status: 'processing', detail: 'processing' },
  AUTHORIZED: { status: 'processing', detail: 'processing' },
  SETTLING: { status: 'processing', detail: 'settling' },
  PARTIALLY_SETTLED: { status: 'processing', detail: 'settling' },
  // ERROR is temporary at Meld: the provider may retry.
  ERROR: { status: 'processing', detail: 'delayed' },
  SETTLED: { status: 'succeeded' },
  FAILED: { status: 'failed' },
  DECLINED: { status: 'failed' },
  CANCELLED: { status: 'failed' },
  AUTHORIZATION_EXPIRED: { status: 'failed' },
  REFUNDED: { status: 'refunded' },
})

/** Meld webhook event type -> the transaction status, for an event without `paymentTransactionStatus` */
const EVENT_STATUS = statusMap<string>('Meld webhook', {
  TRANSACTION_CRYPTO_PENDING: 'PENDING',
  TRANSACTION_CRYPTO_TRANSFERRING: 'SETTLING',
  TRANSACTION_CRYPTO_COMPLETE: 'SETTLED',
  TRANSACTION_CRYPTO_FAILED: 'FAILED',
})

const CATALOG_TTL_SEC = 60 * 60
const WEBHOOK_TOLERANCE_SEC = 5 * 60

/**
 * Meld currency codes. VERIFIED: `USDC` (Ethereum) and `USDC_BASE` (docs.meld.io Meld Checkout URL parameters).
 * TO VERIFY: `USDC_POLYGON`, `USDC_ARBITRUM` (resolve with GET /service-providers/properties/crypto-currencies).
 */
export const DEFAULT_DELIVER_ASSETS: MeldDeliverAsset[] = [
  { chain: 'eip155:8453', token: USDC['eip155:8453']!, currencyCode: 'USDC_BASE', symbol: 'USDC', decimals: 6 },
  { chain: 'eip155:1', token: USDC['eip155:1']!, currencyCode: 'USDC', symbol: 'USDC', decimals: 6 },
  { chain: 'eip155:137', token: USDC['eip155:137']!, currencyCode: 'USDC_POLYGON', symbol: 'USDC', decimals: 6 },
  { chain: 'eip155:42161', token: USDC['eip155:42161']!, currencyCode: 'USDC_ARBITRUM', symbol: 'USDC', decimals: 6 },
]

/**
 * Meld `paymentMethod` code -> OpenRampKit method id. Unknown codes keep their lowercase name.
 * The quote API takes `paymentMethodType` as a free string; Meld lists the codes and their countries at
 * https://www.meld.io/coverage/payment-methods (data: https://www.meld.io/api/network-partner/supported/payment-methods
 * and .../supported/countries?paymentMethod=CODE, read 2026-10-04). Codes from that list: SEPA_INSTANT,
 * UK_FASTER_PAYMENTS, FPS, OPEN_BANKING, IDEAL, BANCONTACT, SOFORT, BLIK (PL), PAYID (AU), SPEI and STP (MX),
 * PSE, KHIPU, MPESA (KE), MOBILE_MONEY, IMPS (IN), ASTROPAY, PAYPAL, CASH_APP, ZELLE, VENMO, INTERAC,
 * REVOLUT_PAY, REVOLUT, MERCADOPAGO.
 * TO VERIFY: `UPI` (in the list, IN) and `BINANCE_PAY` (the list has BINANCE_P2P and BINANCE_CASH_BALANCE, not BINANCE_PAY).
 * TO VERIFY: `MERCADO_PAGO` (older spelling; the list uses MERCADOPAGO, which is sent first).
 */
export const MELD_METHOD_IDS: Record<string, string> = {
  CREDIT_DEBIT_CARD: 'card',
  APPLE_PAY: 'apple_pay',
  GOOGLE_PAY: 'google_pay',
  SEPA: 'sepa',
  ACH: 'ach',
  PIX: 'pix',
  UPI: 'upi',
  BINANCE_PAY: 'binance_pay',
  BANK_TRANSFER: 'bank_transfer',
  LOCAL_BANK_TRANSFER: 'bank_transfer',
  PAYPAL: 'paypal',
  VENMO: 'venmo',
  CASH_APP: 'cash_app',
  ZELLE: 'zelle',
  REVOLUT_PAY: 'revolut_pay',
  REVOLUT: 'revolut',
  MERCADOPAGO: 'mercadopago',
  MERCADO_PAGO: 'mercadopago',
  INTERAC: 'interac',
  SEPA_INSTANT: 'sepa_instant',
  UK_FASTER_PAYMENTS: 'faster_payments',
  FPS: 'faster_payments',
  OPEN_BANKING: 'open_banking',
  IDEAL: 'ideal',
  BANCONTACT: 'bancontact',
  SOFORT: 'sofort',
  BLIK: 'blik',
  PAYID: 'payid',
  SPEI: 'spei',
  STP: 'spei',
  PSE: 'pse',
  KHIPU: 'khipu',
  MPESA: 'mpesa',
  MOBILE_MONEY: 'mobile_money',
  IMPS: 'imps',
  ASTROPAY: 'astropay',
}

export function meldMethodId(code: string): string {
  return MELD_METHOD_IDS[code.toUpperCase()] ?? code.toLowerCase()
}

/** Leg id -> Meld code: the first code that maps to it, else the id in upper case */
export function meldCode(legId: string): string {
  return Object.entries(MELD_METHOD_IDS).find(([, id]) => id === legId)?.[0] ?? legId.toUpperCase()
}

const SEPA = ['AT', 'BE', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK', 'NO', 'IS', 'LI', 'CH']
/** Meld OPEN_BANKING countries (coverage list, 2026-10-04) */
const OPEN_BANKING = ['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'EE', 'ES', 'FI', 'FR', 'GB', 'GR', 'HR', 'HU', 'IE', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'RO', 'SE', 'SI', 'SK']
/** Meld MOBILE_MONEY countries (coverage list, 2026-10-04) */
const MOBILE_MONEY = ['BD', 'BF', 'BJ', 'BW', 'CD', 'CG', 'CI', 'CM', 'DZ', 'EG', 'GA', 'GH', 'GM', 'ID', 'JO', 'KE', 'LR', 'ML', 'MW', 'PE', 'PH', 'PK', 'RW', 'SN', 'TG', 'TZ', 'UG', 'VN', 'ZM']
const FAST = { min: 60, max: 1800 }
const BANK_INSTANT = { min: 120, max: 3600 }

/** Static legs, used when the catalog is not available. Countries follow core METHOD_COUNTRIES. */
const STATIC: Array<{ id: string; countries?: string[]; currencies: string[] | '*'; eta: { min: number; max: number } }> = [
  { id: 'card', currencies: '*', eta: FAST },
  { id: 'apple_pay', currencies: '*', eta: FAST },
  { id: 'google_pay', currencies: '*', eta: FAST },
  { id: 'upi', countries: ['IN'], currencies: ['INR'], eta: BANK_INSTANT },
  { id: 'pix', countries: ['BR'], currencies: ['BRL'], eta: BANK_INSTANT },
  { id: 'binance_pay', currencies: '*', eta: FAST },
  { id: 'sepa', countries: SEPA, currencies: ['EUR'], eta: { min: 3600, max: 3 * 86400 } },
  { id: 'ach', countries: ['US'], currencies: ['USD'], eta: { min: 3600, max: 5 * 86400 } },
  { id: 'sepa_instant', countries: SEPA, currencies: ['EUR'], eta: BANK_INSTANT },
  { id: 'faster_payments', countries: ['GB'], currencies: ['GBP'], eta: BANK_INSTANT },
  { id: 'open_banking', countries: OPEN_BANKING, currencies: '*', eta: BANK_INSTANT },
  { id: 'ideal', countries: ['NL'], currencies: ['EUR'], eta: BANK_INSTANT },
  { id: 'bancontact', countries: ['BE'], currencies: ['EUR'], eta: BANK_INSTANT },
  { id: 'blik', countries: ['PL'], currencies: ['PLN'], eta: BANK_INSTANT },
  { id: 'payid', countries: ['AU'], currencies: ['AUD'], eta: BANK_INSTANT },
  { id: 'interac', countries: ['CA'], currencies: ['CAD'], eta: BANK_INSTANT },
  { id: 'spei', countries: ['MX'], currencies: ['MXN'], eta: BANK_INSTANT },
  { id: 'pse', countries: ['CO'], currencies: ['COP'], eta: BANK_INSTANT },
  { id: 'khipu', countries: ['CL'], currencies: ['CLP'], eta: BANK_INSTANT },
  { id: 'imps', countries: ['IN'], currencies: ['INR'], eta: BANK_INSTANT },
  { id: 'mpesa', countries: ['KE'], currencies: ['KES'], eta: BANK_INSTANT },
  { id: 'mobile_money', countries: MOBILE_MONEY, currencies: '*', eta: BANK_INSTANT },
]

const dec = decimalFrom

export function meld(opts: MeldOptions) {
  const env = resolveEnv('meld', opts.env, undefined, 'production')
  const api = (opts.apiUrl ?? (env === 'sandbox' ? 'https://api-sb.meld.io' : 'https://api.meld.io')).replace(/\/+$/, '')
  const headers = { authorization: `BASIC ${opts.apiKey}`, 'meld-version': opts.version ?? '2026-02-03' }
  const deliver = opts.deliverAssets?.length ? opts.deliverAssets : DEFAULT_DELIVER_ASSETS
  const toChains: Record<string, string[]> = {}
  for (const d of deliver) (toChains[d.chain] ??= []).push(d.chain.startsWith('eip155:') ? d.token.toLowerCase() : d.token)

  const leg = (id: string, extra: Partial<LegSpec> = {}): LegSpec => ({
    id,
    kind: 'fiat_onramp',
    methods: [id],
    from: { asset: { kind: 'fiat', currencies: '*' }, location: ['user_account'] },
    to: { asset: { kind: 'crypto', chains: toChains }, location: ['address'] },
    regions: { allow: ['*'], deny: [] },
    eta: { min: 60, max: 1800 },
    surfaces: ['REDIRECT'],
    requires: ['provider_kyc'],
    ...extra,
  })
  const staticLegs = STATIC.map((s) => leg(s.id, { from: { asset: { kind: 'fiat', currencies: s.currencies }, location: ['user_account'] }, regions: { allow: s.countries ?? ['*'], deny: [] }, eta: s.eta }))

  async function call<T>(ctx: Pick<AdapterContext, 'fetch'>, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    return fetchJson<T>(ctx.fetch, `${api}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  }

  /** The asset Meld delivers for `asset`. NO_QUOTES when Meld does not deliver that token on that chain (never another token). */
  function deliverFor(asset: Asset | undefined): MeldDeliverAsset {
    return requireDeliverAsset(deliver, asset, 'Meld')
  }

  const assetOf = deliverableToAsset

  /**
   * The event for a Meld transaction status, or undefined for an unknown status (logged once; the leg
   * keeps its current step). `providerRef` is the Meld transaction id, when known.
   */
  function eventFrom(ref: string, status: string | undefined, tx: MeldTransaction | undefined, providerRef: string | undefined, log?: Pick<Logger, 'warn'>): LegEvent | undefined {
    const m = STATUS(status, log)
    if (!m) return undefined
    const ev: LegEvent = { ref, status: m.status }
    if (providerRef) ev.providerRef = providerRef
    // A status poll while the user is in the provider page: no surface, the UI keeps the current one.
    if (m.status === 'requires_action') ev.action = { kind: 'payment', transitions: [awaitPoll(POLL)] }
    if (m.detail) ev.detail = { code: m.detail, providerStatus: status }
    if (m.status === 'failed') ev.error = openRampError('PAYMENT_FAILED', { message: 'The purchase did not complete.', recovery: 'retry_payment' })
    const d = deliver.find((x) => x.currencyCode === tx?.destinationCurrencyCode)
    if ((m.status === 'succeeded' || m.status === 'processing') && d && tx?.destinationAmount !== undefined) {
      ev.output = { value: dec(tx.destinationAmount, d.decimals ?? 8), asset: assetOf(d) }
    }
    // The provider's on-chain delivery to the wallet
    const hash = tx?.cryptoDetails?.blockchainTransactionId
    if (m.status === 'succeeded' && hash) ev.transactions = [{ role: 'destination', ...(d ? { chain: d.chain } : {}), hash }]
    return ev
  }

  return createAdapter({
    id: 'meld',
    env,
    name: 'Meld',
    legs: staticLegs,

    async catalog(input, ctx) {
      const country = input.country?.toUpperCase()
      const key = `pm:${country ?? '*'}:${input.currency.toUpperCase()}`
      const methods = await cachedJson(
        ctx.shared,
        key,
        CATALOG_TTL_SEC,
        async () => {
          const q = new URLSearchParams({ categories: 'CRYPTO_ONRAMP', fiatCurrencies: input.currency.toUpperCase() })
          if (country) q.set('countries', country)
          if (opts.serviceProviders?.length) q.set('serviceProviders', opts.serviceProviders.join(','))
          const list = await call<MeldPaymentMethod[]>(ctx, 'GET', `/service-providers/properties/payment-methods?${q}`)
          // An empty or odd answer is a failure: throw so the server keeps the static legs, and do not cache it.
          if (!Array.isArray(list) || !list.length) {
            throw new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message: 'Meld returned no payment methods.' }), 502)
          }
          return list
        },
        { valid: (m) => Array.isArray(m) && m.length > 0 },
      )
      const ids = [...new Set(methods.map((m) => meldMethodId(m.paymentMethod)))]
      return ids.map((id) => {
        const s = STATIC.find((x) => x.id === id)
        return leg(id, {
          from: { asset: { kind: 'fiat', currencies: [input.currency.toUpperCase()] }, location: ['user_account'] },
          regions: { allow: country ? [country] : s?.countries ?? ['*'], deny: [] },
          ...(s ? { eta: s.eta } : {}),
        })
      })
    },

    async quote(input, ctx) {
      if (!input.amountIn) throw new OpenRampException(openRampError('NO_QUOTES', { message: 'Meld quotes need a fiat amount.' }), 422)
      const fiatAsset = input.amountIn.asset
      if (fiatAsset.kind !== 'fiat') throw new OpenRampException(openRampError('BAD_REQUEST', { message: 'Meld quotes need a fiat amount.' }))
      const fiat = fiatAsset.currency.toUpperCase()
      const target = deliverFor(input.leg.to.asset.kind === 'crypto' ? input.leg.to.asset : undefined)
      const country = (ctx.session.country ?? opts.defaultCountry ?? 'US').toUpperCase()
      const region = ctx.session.region?.toUpperCase()
      const wallet = input.deliverTo?.address ?? (ctx.destination.type === 'crypto' ? ctx.destination.address : undefined)
      const paymentMethodType = meldCode(input.leg.legId)
      const body = {
        countryCode: country,
        sourceCurrencyCode: fiat,
        sourceAmount: Number(roundTo(input.amountIn.value, 2)),
        destinationCurrencyCode: target.currencyCode,
        paymentMethodType,
        ...(wallet ? { walletAddress: wallet } : {}),
        ...(opts.serviceProviders?.length ? { serviceProviders: opts.serviceProviders } : {}),
        ...(region?.startsWith(`${country}-`) ? { subdivision: region } : {}),
      }
      let res: { quotes?: MeldQuote[]; message?: string; error?: string }
      try {
        res = await call(ctx, 'POST', '/payments/crypto/quote', body)
      } catch (e) {
        throw httpErrorToOpenRamp(e, 'Meld', { what: 'price this amount', log: ctx.log })
      }
      const quotes = (res.quotes ?? []).filter((q) => q.serviceProvider && typeof q.destinationAmount === 'number' && q.destinationAmount > 0 && typeof q.sourceAmount === 'number')
      if (!quotes.length) {
        throw new OpenRampException(openRampError('NO_QUOTES', { message: res.message ? `Meld: ${res.message}`.slice(0, 200) : 'No Meld provider can serve this amount.' }), 422)
      }
      const providers = quotes
        .map((q) => ({
          serviceProvider: q.serviceProvider!,
          destinationAmount: dec(q.destinationAmount, target.decimals ?? 8),
          sourceAmount: dec(q.sourceAmount, 2),
          totalFee: dec(q.totalFee, 2),
          ...(q.rampIntelligence?.rampScore !== undefined ? { rampScore: q.rampIntelligence.rampScore } : {}),
        }))
        .sort((a, b) => cmp(b.destinationAmount, a.destinationAmount))
      const best = quotes.find((q) => q.serviceProvider === providers[0]!.serviceProvider)!
      // Meld states each fee in the source fiat, inside `sourceAmount` (it also returns `sourceAmountWithoutFees`): all `included`.
      const fiatFee = (n: number): Amount => ({ value: dec(n, 2), asset: { kind: 'fiat', currency: fiat } })
      const fees: Fee[] = []
      if (best.transactionFee) fees.push({ kind: 'provider', label: `${best.serviceProvider} fee`, amount: fiatFee(best.transactionFee), included: true })
      if (best.networkFee) fees.push({ kind: 'network', label: 'Network fee', amount: fiatFee(best.networkFee), included: true })
      if (best.partnerFee) fees.push({ kind: 'app', label: 'App fee', amount: fiatFee(best.partnerFee), included: true })
      return {
        adapterId: 'meld',
        legId: input.leg.legId,
        input: { value: dec(best.sourceAmount, 2), asset: { kind: 'fiat', currency: fiat } },
        output: { value: providers[0]!.destinationAmount, asset: assetOf(target) },
        fees,
        // An estimate: the provider Meld routes to sets the rate when it executes the order.
        guarantee: 'estimate',
        eta: STATIC.find((s) => s.id === input.leg.legId)?.eta ?? { min: 60, max: 1800 },
        expiresAt: quoteExpiresAt(5),
        data: { serviceProvider: best.serviceProvider, providers, paymentMethodType, currencyCode: target.currencyCode, fiat, country },
      }
    },

    async start(input, ctx) {
      const data = (input.quote.data ?? {}) as { serviceProvider?: string; paymentMethodType?: string; currencyCode?: string; fiat?: string; country?: string }
      if (!data.serviceProvider) throw new OpenRampException(openRampError('QUOTE_EXPIRED', { recovery: 'requote' }), 409)
      const target = deliverFor(input.quote.output.asset.kind === 'crypto' ? input.quote.output.asset : undefined)
      const wallet = input.deliverTo?.address ?? (ctx.destination.type === 'crypto' ? ctx.destination.address : undefined)
      if (!wallet) throw new OpenRampException(openRampError('BAD_REQUEST', { message: 'Meld needs a wallet address to deliver to.' }))
      const ref = `ork_${randomHex(12)}`
      const body = {
        sessionType: 'BUY',
        sessionData: {
          walletAddress: wallet,
          countryCode: data.country ?? (ctx.session.country ?? opts.defaultCountry ?? 'US').toUpperCase(),
          sourceCurrencyCode: data.fiat ?? (input.quote.input.asset.kind === 'fiat' ? input.quote.input.asset.currency : 'USD'),
          // A string here (the quote API takes a number)
          sourceAmount: roundTo(input.quote.input.value, 2),
          destinationCurrencyCode: data.currencyCode ?? target.currencyCode,
          serviceProvider: data.serviceProvider,
          paymentMethodType: data.paymentMethodType ?? meldCode(input.leg.legId),
          redirectUrl: ctx.urls.returnUrl,
          ...(ctx.session.ip ? { clientIpAddress: ctx.session.ip } : {}),
        },
        externalCustomerId: ctx.session.userId,
        externalSessionId: ref,
      }
      let res: { id?: string; widgetUrl?: string; serviceProviderWidgetUrl?: string }
      try {
        res = await call(ctx, 'POST', '/crypto/session/widget', body)
      } catch (e) {
        throw httpErrorToOpenRamp(e, 'Meld', { what: 'start the purchase', log: ctx.log })
      }
      const url = res.serviceProviderWidgetUrl || res.widgetUrl
      if (!url) throw new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message: 'Meld did not return a widget URL.' }), 502)
      // No providerRef yet: Meld gives the transaction id once the user starts paying (`res.id` is the widget session).
      return {
        status: 'requires_action',
        action: { kind: 'payment', surface: { kind: 'REDIRECT', url, popup: true, provider: data.serviceProvider }, transitions: [awaitPoll(POLL)] },
        ref,
      }
    },

    async status(input, ctx) {
      let res: { transactions?: MeldTransaction[] }
      try {
        res = await call(ctx, 'GET', `/payments/transactions?externalSessionIds=${encodeURIComponent(input.ref)}`)
      } catch (e) {
        throw httpErrorToOpenRamp(e, 'Meld', { what: 'find this purchase', noQuoteStatuses: [], log: ctx.log })
      }
      const tx = res.transactions?.[0]
      // No transaction yet, or an unknown status: a payment poll. The server ignores it when the leg is
      // already further (it never moves a leg back), so the leg keeps its current step.
      return legStepFromEvent(tx ? eventFrom(input.ref, tx.status, tx, tx.id, ctx.log) : undefined, input.ref, POLL)
    },

    webhook: {
      // Without the webhookSecret, no webhook can verify (see `resultChannels`).
      configured: !!opts.webhookSecret,
      async verify(req, rawBody, ctx) {
        if (!opts.webhookSecret) {
          ctx.log.warn('meld: webhookSecret is not set; rejecting webhook')
          return false
        }
        const url = opts.webhookUrl ?? req.url
        // TO VERIFY: Meld documents no tolerance window; we reject timestamps more than 5 minutes off.
        return verifyTimestampedHmac({
          secret: opts.webhookSecret,
          rawBody,
          // Meld sends base64url with padding; the helper compares without padding
          header: req.headers.get('meld-signature')?.trim().replace(/=+$/, ''),
          timestamp: req.headers.get('meld-signature-timestamp'),
          toleranceSec: WEBHOOK_TOLERANCE_SEC,
          message: (ts) => `${ts}.${url}.${rawBody}`,
          encoding: 'base64url',
        })
      },
      async parse(rawBody, ctx) {
        let ev: { eventType?: string; payload?: { externalSessionId?: string; paymentTransactionId?: string; paymentTransactionStatus?: string } }
        try {
          ev = JSON.parse(rawBody) as typeof ev
        } catch {
          ctx.log.warn('meld: webhook body is not JSON')
          return []
        }
        if (!ev.eventType?.startsWith('TRANSACTION_CRYPTO_')) return []
        const p = ev.payload ?? {}
        // PENDING_CREATED events may come without the session ids; later events carry them.
        if (!p.externalSessionId) return []
        const status = p.paymentTransactionStatus || EVENT_STATUS(ev.eventType, ctx.log)
        // The event has no amounts: read the transaction for the output and the tx hash (the docs advise it).
        let tx: MeldTransaction | undefined
        if (status === 'SETTLED' && p.paymentTransactionId) {
          try {
            tx = (await call<{ transaction?: MeldTransaction }>(ctx, 'GET', `/payments/transactions/${encodeURIComponent(p.paymentTransactionId)}`)).transaction
          } catch (e) {
            ctx.log.warn('meld: could not read the settled transaction', { error: String((e as Error)?.message ?? e).slice(0, 200) })
          }
        }
        const out = eventFrom(p.externalSessionId, status, tx, p.paymentTransactionId ?? tx?.id, ctx.log)
        return out ? [out] : []
      },
    },

    async health(ctx) {
      try {
        await call(ctx, 'GET', '/service-providers?categories=CRYPTO_ONRAMP')
        return { ok: true }
      } catch (e) {
        return { ok: false, detail: String((e as Error)?.message ?? e).slice(0, 200) }
      }
    },
  })
}
