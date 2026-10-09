// MoonPay adapter: fiat onramp through the MoonPay buy widget (https://dev.moonpay.com).
//
// - Quote: GET https://api.moonpay.com/v3/currencies/{code}/buy_quote (publishable key only).
//   We send `areFeesIncluded=true`, so the user pays exactly the amount they typed (`totalAmount`).
// - Widget URL: https://buy.moonpay.com (sandbox https://buy-sandbox.moonpay.com). Signing is
//   mandatory when `walletAddress` is set: base64 HMAC-SHA256 of `new URL(url).search` (the query
//   string with the leading '?') with the secret key, appended last as `&signature=`
//   (https://dev.moonpay.com/widget/on-ramp/customization/url-signing).
// - Status: GET /v1/transactions/ext/{externalTransactionId}?apiKey=pk_... (the docs say it returns
//   an array because the id is not unique; the OpenAPI schema shows one object; we accept both).
// - Webhooks: `Moonpay-Signature-V2: t=<unix>,s=<hex>`, HMAC-SHA256 over `${t}.${rawBody}` with the
//   webhook API key from the dashboard (https://dev.moonpay.com/api-reference/widget/webhooks/signature).
// - Catalog: GET /v3/countries (public) gives the countries and US states where buying is allowed.
//
// Server-side only. Web-standard APIs only (fetch, WebCrypto), so it runs on Cloudflare Workers.

import {
  POLL as POLLS,
  awaitPoll,
  createAdapter,
  decimalFrom,
  deliverableToAsset,
  fetchJson,
  hmacSha256,
  httpErrorToOpenRamp,
  httpStatus,
  legStepFromEvent,
  randomHex,
  requireDeliverAsset,
  resolveEnv,
  timingSafeEqual,
} from '@openrampkit/adapter'
import type { AdapterContext, AdapterEnv, LegEvent } from '@openrampkit/adapter'
import { OpenRampException, USDC, openRampError, roundTo } from '@openrampkit/core'
import type { Asset, CryptoAsset, Fee, LegSpec, PollSpec, Surface } from '@openrampkit/core'

export type MoonPayDeliverAsset = {
  /** CAIP-2 chain */
  chain: string
  /** Token address (lowercase for EVM) */
  token: string
  /** MoonPay currency code, e.g. `usdc_base` (GET /v3/currencies) */
  currencyCode: string
  symbol?: string
  decimals?: number
  /** From /v3/currencies `notAllowedUSStates` (two-letter state codes) */
  notAllowedUSStates?: string[]
  /** From /v3/currencies `notAllowedCountries` */
  notAllowedCountries?: string[]
}

export type MoonPayOptions = {
  /** Publishable key (pk_live_... or pk_test_...) */
  publishableKey: string
  /** Secret key (sk_...). Signs widget URLs. */
  secretKey: string
  /** Webhook API key from the dashboard (Developers page). Needed to accept webhooks. */
  webhookKey?: string
  /** Provider environment: 'sandbox' (test keys, no real money) or 'production'. The server checks it against `livemode`. */
  env: AdapterEnv
  /** Fiat currency when the quote has none. Default 'USD'. */
  baseCurrencyDefault?: string
  /** How the widget opens. Default 'redirect' (a popup). */
  surface?: 'redirect' | 'iframe'
  /** Assets MoonPay may deliver, most preferred first. Default: USDC on Base, Ethereum, Arbitrum, Optimism, Polygon. */
  deliverAssets?: MoonPayDeliverAsset[]
  /** Limit the legs (leg ids: card, apple_pay, google_pay, ach, sepa, gbp_bank, gbp_open_banking, pix, paypal, venmo, revolut_pay, interac) */
  methods?: string[]
  /** Your fee on top, in percent (MoonPay `extraFeePercentage`, set up with MoonPay first) */
  extraFeePercentage?: number
  /** Theme for the widget */
  theme?: 'dark' | 'light'
  apiUrl?: string
  widgetUrl?: string
}

type MpQuote = {
  baseCurrencyAmount?: number
  baseCurrencyCode?: string
  quoteCurrencyAmount?: number
  quoteCurrencyCode?: string
  quoteCurrencyPrice?: number
  feeAmount?: number
  extraFeeAmount?: number
  networkFeeAmount?: number
  totalAmount?: number
  expiresAt?: string
}

type MpTransaction = {
  id?: string
  status?: 'waitingPayment' | 'pending' | 'waitingAuthorization' | 'failed' | 'completed' | string
  failureReason?: string | null
  cryptoTransactionId?: string | null
  quoteCurrencyAmount?: number | string | null
  externalTransactionId?: string | null
  currency?: { code?: string } | null
  currencyCode?: string
  walletAddress?: string
}

type MpCountry = {
  alpha2: string
  isAllowed?: boolean
  isBuyAllowed?: boolean
  states?: Array<{ code: string; isBuyAllowed?: boolean; isAllowed?: boolean }>
}

const POLL: PollSpec = POLLS.checkout
const COUNTRIES_TTL_SEC = 24 * 60 * 60
const WEBHOOK_TOLERANCE_SEC = 5 * 60
// TO VERIFY: MoonPay's recommended iframe `allow` list (https://dev.moonpay.com/widget/on-ramp/integration-methods/url).
const IFRAME_ALLOW = 'accelerometer; autoplay; camera; gyroscope; payment; clipboard-write'

const EEA = ['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK']

/**
 * Countries where MoonPay does not allow buying (live GET /v3/countries, isBuyAllowed=false, 2026-09-29).
 * The catalog refreshes this from the API.
 */
export const MOONPAY_DENY_COUNTRIES = [
  'AF', 'BD', 'BB', 'BY', 'BF', 'CF', 'CN', 'CD', 'CI', 'CU', 'GN', 'GW', 'HT', 'IN', 'IR', 'IQ', 'JM', 'JP', 'XK', 'KP',
  'LB', 'LR', 'LY', 'MG', 'MY', 'ML', 'MN', 'MA', 'MM', 'NI', 'PK', 'PS', 'RU', 'SN', 'SO', 'SS', 'SD', 'SY', 'UG', 'UA',
  'VE', 'EH', 'YE', 'ZW',
]
/** US states and territories with isBuyAllowed=false (live, 2026-09-29) */
export const MOONPAY_DENY_US_STATES = ['US-VI']

/** Live GET /v3/currencies, 2026-09-29 */
export const DEFAULT_DELIVER_ASSETS: MoonPayDeliverAsset[] = [
  { chain: 'eip155:8453', token: USDC['eip155:8453']!, currencyCode: 'usdc_base', symbol: 'USDC', decimals: 6, notAllowedUSStates: ['NY', 'VI'], notAllowedCountries: ['CA'] },
  { chain: 'eip155:1', token: USDC['eip155:1']!, currencyCode: 'usdc', symbol: 'USDC', decimals: 6, notAllowedUSStates: ['VI'] },
  { chain: 'eip155:42161', token: USDC['eip155:42161']!, currencyCode: 'usdc_arbitrum', symbol: 'USDC', decimals: 6, notAllowedUSStates: ['NY', 'VI'] },
  { chain: 'eip155:10', token: USDC['eip155:10']!, currencyCode: 'usdc_optimism', symbol: 'USDC', decimals: 6, notAllowedUSStates: ['VI'] },
  { chain: 'eip155:137', token: USDC['eip155:137']!, currencyCode: 'usdc_polygon', symbol: 'USDC', decimals: 6, notAllowedUSStates: ['VI'] },
]

type MethodDef = {
  /** Leg id */
  id: string
  /** OpenRampKit method id */
  method: string
  /** MoonPay `paymentMethod` */
  paymentMethod: string
  currencies: string[] | '*'
  /** Countries where the method exists; undefined = everywhere MoonPay buys */
  countries?: string[]
  eta: { min: number; max: number }
}

const INSTANT = { min: 60, max: 900 }
const BANK = { min: 3600, max: 3 * 86400 }

/**
 * Leg per payment method. Values from the buy_quote `paymentMethod` enum (live, 2026-09-29).
 * Currency rules seen in live quote errors: SEPA needs EUR, gbp_bank_transfer needs GBP, PIX needs BRL,
 * ACH does not take EUR.
 * - `gbp_bank_transfer` is UK Faster Payments and `gbp_open_banking_payment` is UK open banking
 *   (https://dev.moonpay.com/widget/on-ramp/customization/parameters.md and the buy_quote enum,
 *   https://dev.moonpay.com/api-reference/widget/getbuyquote.md).
 * - SEPA Instant has no own id: it is part of `sepa_bank_transfer`
 *   (https://support.moonpay.com/en/articles/380823-moonpay-s-supported-payment-methods).
 */
export const MOONPAY_METHODS: MethodDef[] = [
  { id: 'card', method: 'card', paymentMethod: 'credit_debit_card', currencies: '*', eta: INSTANT },
  { id: 'apple_pay', method: 'apple_pay', paymentMethod: 'apple_pay', currencies: '*', eta: INSTANT },
  { id: 'google_pay', method: 'google_pay', paymentMethod: 'google_pay', currencies: '*', eta: INSTANT },
  { id: 'ach', method: 'ach', paymentMethod: 'ach_bank_transfer', currencies: ['USD'], countries: ['US'], eta: BANK },
  { id: 'sepa', method: 'sepa', paymentMethod: 'sepa_bank_transfer', currencies: ['EUR'], countries: [...EEA, 'CH'], eta: { min: 3600, max: 2 * 86400 } },
  { id: 'gbp_bank', method: 'faster_payments', paymentMethod: 'gbp_bank_transfer', currencies: ['GBP'], countries: ['GB'], eta: { min: 300, max: 86400 } },
  { id: 'gbp_open_banking', method: 'open_banking', paymentMethod: 'gbp_open_banking_payment', currencies: ['GBP'], countries: ['GB'], eta: { min: 120, max: 3600 } },
  { id: 'pix', method: 'pix', paymentMethod: 'pix_instant_payment', currencies: ['BRL'], countries: ['BR'], eta: { min: 120, max: 1800 } },
  { id: 'paypal', method: 'paypal', paymentMethod: 'paypal', currencies: '*', eta: INSTANT },
  // TO VERIFY: Venmo and Cash App through MoonPay are US-only (the enum has them; the docs do not list regions).
  { id: 'venmo', method: 'venmo', paymentMethod: 'venmo', currencies: ['USD'], countries: ['US'], eta: INSTANT },
  { id: 'revolut_pay', method: 'revolut_pay', paymentMethod: 'revolut_pay', currencies: '*', eta: INSTANT },
  { id: 'interac', method: 'interac', paymentMethod: 'interac', currencies: ['CAD'], countries: ['CA'], eta: { min: 300, max: 3600 } },
]

const dec = decimalFrom

function parseSigHeader(header: string): Record<string, string> {
  return Object.fromEntries(
    header.split(',').map((kv) => {
      const i = kv.indexOf('=')
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()]
    }),
  )
}

export function moonpay(opts: MoonPayOptions) {
  const env = resolveEnv('moonpay', opts.env, undefined, 'production')
  const apiUrl = (opts.apiUrl ?? 'https://api.moonpay.com').replace(/\/+$/, '')
  const widgetUrl = (opts.widgetUrl ?? (env === 'sandbox' ? 'https://buy-sandbox.moonpay.com' : 'https://buy.moonpay.com')).replace(/\/+$/, '')
  const widgetOrigin = new URL(widgetUrl).origin
  const deliver = opts.deliverAssets?.length ? opts.deliverAssets : DEFAULT_DELIVER_ASSETS
  const defs = MOONPAY_METHODS.filter((m) => !opts.methods || opts.methods.includes(m.id))
  if (!defs.length) throw new Error('moonpay: `methods` selects no known leg')
  const byId = new Map(defs.map((d) => [d.id, d]))
  const toChains: Record<string, string[]> = {}
  for (const d of deliver) (toChains[d.chain] ??= []).push(d.chain.startsWith('eip155:') ? d.token.toLowerCase() : d.token)

  const legFor = (d: MethodDef, deny: string[] = [...MOONPAY_DENY_COUNTRIES, ...MOONPAY_DENY_US_STATES], allowAll?: string[]): LegSpec => ({
    id: d.id,
    kind: 'fiat_onramp',
    methods: [d.method],
    from: { asset: { kind: 'fiat', currencies: d.currencies }, location: ['user_account'] },
    to: { asset: { kind: 'crypto', chains: toChains }, location: ['address'] },
    regions: { allow: allowAll ?? d.countries ?? ['*'], deny: d.countries ? deny.filter((c) => c.includes('-')) : deny },
    eta: d.eta,
    surfaces: [opts.surface === 'iframe' ? 'IFRAME' : 'REDIRECT'],
    requires: ['provider_kyc'],
  })
  const legs = defs.map((d) => legFor(d))

  function def(legId: string): MethodDef {
    const d = byId.get(legId)
    if (!d) throw new OpenRampException(openRampError('BAD_REQUEST', { message: `Unknown MoonPay leg ${legId}` }), 400)
    return d
  }

  /** The asset MoonPay delivers for `asset`. NO_QUOTES when MoonPay does not deliver that token on that chain (never another token). */
  function deliverAssetFor(asset: Asset | undefined): MoonPayDeliverAsset {
    return requireDeliverAsset(deliver, asset, 'MoonPay')
  }

  const assetOf = deliverableToAsset

  /** Per-asset restrictions (e.g. usdc_base is not sold in New York or Canada) */
  function checkAssetRegion(d: MoonPayDeliverAsset, ctx: AdapterContext) {
    const country = ctx.session.country?.toUpperCase()
    const region = ctx.session.region?.toUpperCase()
    const state = country === 'US' && region?.startsWith('US-') ? region.slice(3) : undefined
    if ((country && d.notAllowedCountries?.includes(country)) || (state && d.notAllowedUSStates?.includes(state))) {
      throw new OpenRampException(openRampError('REGION_UNSUPPORTED', { message: `MoonPay does not sell ${d.symbol ?? d.currencyCode} on this network in your region.`, recovery: 'choose_other' }), 422)
    }
  }

  async function signedWidgetUrl(params: Array<[string, string | undefined]>): Promise<string> {
    const q = new URLSearchParams()
    for (const [k, v] of params) if (v !== undefined && v !== '') q.append(k, v)
    const search = `?${q.toString()}`
    const signature = await hmacSha256(opts.secretKey, search, 'base64')
    return `${widgetUrl}/${search}&signature=${encodeURIComponent(signature)}`
  }

  function eventFrom(tx: MpTransaction, refOverride?: string): LegEvent | undefined {
    const ref = refOverride ?? tx.externalTransactionId ?? undefined
    if (!ref) return undefined
    const code = tx.currency?.code ?? tx.currencyCode
    const d = deliver.find((x) => x.currencyCode === code)
    const output = d && tx.quoteCurrencyAmount !== undefined && tx.quoteCurrencyAmount !== null ? { value: dec(tx.quoteCurrencyAmount, d.decimals ?? 8), asset: assetOf(d) } : undefined
    switch (tx.status) {
      case 'completed':
        return { ref, status: 'succeeded', ...(tx.cryptoTransactionId ? { txHash: tx.cryptoTransactionId } : {}), ...(output ? { output } : {}) }
      case 'failed':
        return { ref, status: 'failed', error: openRampError('PAYMENT_FAILED', { message: 'The MoonPay purchase did not complete.', recovery: 'retry_payment' }) }
      case 'pending':
        return { ref, status: 'processing', ...(output ? { output } : {}) }
      case 'waitingPayment':
      case 'waitingAuthorization':
        return { ref, status: 'requires_action' }
      default:
        return undefined
    }
  }

  return createAdapter({
    id: 'moonpay',
    env,
    name: 'MoonPay',
    legs,

    async catalog(_input, ctx) {
      let countries = await ctx.shared.get<MpCountry[]>('countries')
      if (!countries) {
        countries = await fetchJson<MpCountry[]>(ctx.fetch, `${apiUrl}/v3/countries`)
        if (!Array.isArray(countries) || !countries.length) {
          throw new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message: 'MoonPay returned no countries.' }), 502)
        }
        await ctx.shared.put('countries', countries, COUNTRIES_TTL_SEC)
      }
      const allowed = countries.filter((c) => c.isBuyAllowed ?? c.isAllowed).map((c) => c.alpha2.toUpperCase())
      const deniedStates = countries.flatMap((c) => (c.states ?? []).filter((s) => (s.isBuyAllowed ?? s.isAllowed) === false).map((s) => `${c.alpha2.toUpperCase()}-${s.code.toUpperCase()}`))
      return defs
        .map((d) => {
          const allow = d.countries ? d.countries.filter((c) => allowed.includes(c)) : allowed
          return legFor(d, deniedStates, allow)
        })
        .filter((l) => l.regions.allow.length)
    },

    async quote(input, ctx) {
      const d = def(input.leg.legId)
      const target = deliverAssetFor(input.leg.to.asset.kind === 'crypto' ? input.leg.to.asset : undefined)
      checkAssetRegion(target, ctx)
      const fiatAsset = input.amountIn?.asset ?? input.leg.from.asset
      const fiat = (fiatAsset.kind === 'fiat' ? fiatAsset.currency : opts.baseCurrencyDefault ?? 'USD').toUpperCase()
      const q = new URLSearchParams({ apiKey: opts.publishableKey, baseCurrencyCode: fiat.toLowerCase(), paymentMethod: d.paymentMethod, areFeesIncluded: 'true' })
      if (input.amountIn) q.set('baseCurrencyAmount', roundTo(input.amountIn.value, 2))
      else if (input.amountOut) q.set('quoteCurrencyAmount', input.amountOut.value)
      else throw new OpenRampException(openRampError('BAD_REQUEST', { message: 'MoonPay quotes need an amount.' }))
      if (opts.extraFeePercentage !== undefined) q.set('extraFeePercentage', String(opts.extraFeePercentage))
      const address = input.deliverTo?.address ?? (ctx.destination.type === 'crypto' ? ctx.destination.address : undefined)
      if (address) q.set('walletAddress', address)
      let res: MpQuote
      try {
        res = await fetchJson<MpQuote>(ctx.fetch, `${apiUrl}/v3/currencies/${encodeURIComponent(target.currencyCode)}/buy_quote?${q}`)
      } catch (e) {
        throw httpErrorToOpenRamp(e, 'MoonPay', { what: 'price this amount', log: ctx.log })
      }
      if (res.quoteCurrencyAmount === undefined || res.totalAmount === undefined) {
        throw new OpenRampException(openRampError('NO_QUOTES', { message: 'MoonPay did not return a quote for this amount.' }), 422)
      }
      const fees: Fee[] = []
      if (res.feeAmount) fees.push({ kind: 'provider', label: 'MoonPay fee', amount: dec(res.feeAmount, 2), currency: fiat })
      if (res.networkFeeAmount) fees.push({ kind: 'network', label: 'Network fee', amount: dec(res.networkFeeAmount, 2), currency: fiat })
      if (res.extraFeeAmount) fees.push({ kind: 'app', label: 'App fee', amount: dec(res.extraFeeAmount, 2), currency: fiat })
      const total = dec(res.totalAmount, 2)
      return {
        adapterId: 'moonpay',
        legId: d.id,
        input: { value: total, asset: { kind: 'fiat', currency: fiat } },
        output: { value: dec(res.quoteCurrencyAmount, target.decimals ?? 8), asset: assetOf(target) },
        fees,
        eta: d.eta,
        expiresAt: res.expiresAt && !Number.isNaN(Date.parse(res.expiresAt)) ? res.expiresAt : new Date(Date.now() + 5 * 60_000).toISOString(),
        data: { currencyCode: target.currencyCode, paymentMethod: d.paymentMethod, fiat, total },
      }
    },

    async start(input, ctx) {
      const d = def(input.leg.legId)
      const data = (input.quote.data ?? {}) as { currencyCode?: string; paymentMethod?: string; fiat?: string; total?: string }
      const target = deliverAssetFor(input.quote.output.asset.kind === 'crypto' ? input.quote.output.asset : undefined)
      const walletAddress = input.deliverTo?.address ?? (ctx.destination.type === 'crypto' ? ctx.destination.address : undefined)
      if (!walletAddress) throw new OpenRampException(openRampError('BAD_REQUEST', { message: 'MoonPay needs a wallet address to deliver to.' }))
      const fiat = input.quote.input.asset.kind === 'fiat' ? input.quote.input.asset.currency : data.fiat ?? opts.baseCurrencyDefault ?? 'USD'
      // externalTransactionId routes webhooks and status checks back to this leg.
      const ref = `ork_${randomHex(12)}`
      const url = await signedWidgetUrl([
        ['apiKey', opts.publishableKey],
        ['currencyCode', data.currencyCode ?? target.currencyCode],
        ['walletAddress', walletAddress],
        ['baseCurrencyCode', fiat.toLowerCase()],
        ['baseCurrencyAmount', roundTo(input.quote.input.value, 2)],
        ['lockAmount', 'true'],
        ['paymentMethod', data.paymentMethod ?? d.paymentMethod],
        ['externalTransactionId', ref],
        ['externalCustomerId', ctx.session.userId],
        ['email', ctx.session.email],
        ['redirectURL', ctx.urls.returnUrl],
        ['showWalletAddressForm', 'false'],
        ['theme', opts.theme],
      ])
      const surface: Surface =
        opts.surface === 'iframe'
          ? { kind: 'IFRAME', url, origin: widgetOrigin, allow: IFRAME_ALLOW, height: 640, provider: 'MoonPay' }
          : { kind: 'REDIRECT', url, popup: true, provider: 'MoonPay' }
      return { state: 'PAYMENT', surface, transitions: [awaitPoll(POLL)], status: 'requires_action', ref }
    },

    async status(input, ctx) {
      let res: MpTransaction | MpTransaction[]
      try {
        res = await fetchJson<MpTransaction | MpTransaction[]>(ctx.fetch, `${apiUrl}/v1/transactions/ext/${encodeURIComponent(input.ref)}?apiKey=${encodeURIComponent(opts.publishableKey)}`)
      } catch (e) {
        // No transaction yet: the user has not paid in the widget.
        if (httpStatus(e) === 404) return legStepFromEvent(undefined, input.ref, POLL)
        throw httpErrorToOpenRamp(e, 'MoonPay', { what: 'find this purchase', noQuoteStatuses: [], log: ctx.log })
      }
      const list = Array.isArray(res) ? res : [res]
      // Several transactions can share one external id (a retry in the widget): the newest decides.
      const tx = list[list.length - 1]
      return legStepFromEvent(tx ? eventFrom(tx, input.ref) : undefined, input.ref, POLL)
    },

    webhook: {
      // Without the webhookKey, no webhook can verify (see `resultChannels`).
      configured: !!opts.webhookKey,
      async verify(req, rawBody, ctx) {
        if (!opts.webhookKey) {
          ctx.log.warn('moonpay: webhookKey is not set; rejecting webhook')
          return false
        }
        const header = req.headers.get('moonpay-signature-v2')
        if (!header) return false
        const parts = parseSigHeader(header)
        const t = Number(parts.t)
        if (!parts.t || !parts.s || !Number.isFinite(t)) return false
        if (Math.abs(Date.now() / 1000 - t) > WEBHOOK_TOLERANCE_SEC) return false
        // TO VERIFY: hex output (inferred from the 64-hex-char example in the docs)
        const expected = await hmacSha256(opts.webhookKey, `${parts.t}.${rawBody}`, 'hex')
        return timingSafeEqual(parts.s.toLowerCase(), expected)
      },
      async parse(rawBody, ctx) {
        let body: { type?: string; data?: MpTransaction }
        try {
          body = JSON.parse(rawBody) as typeof body
        } catch {
          ctx.log.warn('moonpay: webhook body is not JSON')
          return []
        }
        if (!body.type?.startsWith('transaction_') || !body.data) return []
        const ev = eventFrom(body.data)
        return ev ? [ev] : []
      },
    },

    async health(ctx) {
      try {
        await fetchJson(ctx.fetch, `${apiUrl}/v3/currencies/usdc/limits?apiKey=${encodeURIComponent(opts.publishableKey)}&baseCurrencyCode=usd`)
        return { ok: true }
      } catch (e) {
        return { ok: false, detail: String((e as Error)?.message ?? e).slice(0, 200) }
      }
    },
  })
}
