// Swapped adapter: fiat onramp through the Swapped.com widget in an iframe (https://docs.swapped.com).
//
// - Payment methods come from GET /api/v1/merchant/get_payment_methods (keyed by country).
//   One leg per `payment_group` (card, Apple Pay, Google Pay, SEPA, VietQR, MoMo, GCash, ...).
// - Quotes come from POST /api/v1/merchant/pricing (public, needs only the public key).
// - The widget URL is signed: base64 HMAC-SHA256 of the query string (with the leading '?')
//   using the secret key, appended last as `&signature=`.
// - Order status comes from order notifications (webhooks) sent to `responseUrl`, signed with
//   the `signature` header (base64 HMAC-SHA256 of the raw body with the secret key).
//
// How webhooks find the session: Swapped echoes only `external_customer_id` back in callbacks
// (`external_transaction_id` is deprecated). So we set `externalCustomerId` to the leg ref,
// `<userId>.<random>`. The user id stays visible as the prefix in the Swapped dashboard.
//
// Server-side only. Web-standard APIs only (fetch, WebCrypto), so it runs on Cloudflare Workers.

import {
  POLL as POLLS,
  awaitPoll,
  createAdapter,
  decimalFrom,
  fetchJson,
  hmacSha256,
  httpErrorToOrk,
  legStepFromEvent,
  randomHex,
  timingSafeEqual,
} from '@openrampkit/adapter'
import type { AdapterContext, LegEvent } from '@openrampkit/adapter'
import { OrkException, USDC, orkError, roundTo } from '@openrampkit/core'
import type { Amount, CryptoAsset, Fee, LegSpec, LegStep, PollSpec } from '@openrampkit/core'

export type SwappedDeliverAsset = {
  /** CAIP-2 chain */
  chain: string
  /** Token address (lowercase for EVM) */
  token: string
  /** Swapped `currencyCode`, e.g. USDC_BASE (see docs "Supported Cryptocurrencies") */
  currencyCode: string
  symbol?: string
  decimals?: number
}

export type SwappedOptions = {
  /** Public key (pk_...). Used as `apiKey` in the widget URL and the merchant APIs. */
  publicKey: string
  /** Secret key (sk_...). Signs widget URLs and verifies order notifications. */
  secretKey: string
  /** Default 'production'. Sandbox uses https://sandbox.swapped.com (BTC/ETH testnets and test cards only). */
  env?: 'sandbox' | 'production'
  /** Widget base URL. Default https://widget.swapped.com (production) or https://sandbox.swapped.com (sandbox). */
  widgetUrl?: string
  /** Merchant API base URL. Default: same as `widgetUrl`. */
  apiUrl?: string
  /** Order markup in percent, 0 to 5 (e.g. 0.5 = 0.5%) */
  markup?: number
  /**
   * Assets Swapped may deliver, most preferred first. Default: USDC on Base, Arbitrum, Polygon and Ethereum.
   * The planner uses the first as the hop asset when the destination needs a bridge.
   */
  deliverAssets?: SwappedDeliverAsset[]
  /** Country used for pricing when the session has none. Default 'US'. */
  defaultCountry?: string
  /**
   * Poll POST /api/v1/merchant/get_transactions for order status in addition to webhooks.
   * Default false. TO VERIFY: the request signature format (see `status()`).
   */
  statusPolling?: boolean
}

type SwappedMethod = {
  id: number
  name: string
  fee: number
  slug: string
  currency: string[]
  base_fee?: { base_fee?: number } | null
  disabled: boolean
  min_amount?: number
  max_amount?: number
  payment_group: string
  img_url?: string
}

type SwappedPricing = {
  success: boolean
  message?: string
  data?: {
    crypto_amount: number
    crypto_currency: string
    crypto_unit_price?: number
    network_fee?: number
    network_fee_local?: number
    fiat_amount_incl_fees_local?: number
    fiat_amount_excl_fees_local?: number
    fiat_currency?: string
    markup_fiat_value?: number
    processing_fee?: number
    payment_group?: string
  }
}

type SwappedNotification = {
  order_id?: string
  order_status?: 'payment_pending' | 'order_completed' | 'order_broadcasted' | 'order_cancelled' | string
  order_crypto?: string
  order_crypto_amount?: string | number
  order_crypto_address?: string
  external_customer_id?: string | null
  transaction_id?: string
  network?: string
}

const POLL: PollSpec = POLLS.checkout
const ORDER_TTL_SEC = 7 * 24 * 60 * 60
const METHODS_TTL_SEC = 60 * 60
const IFRAME_ALLOW = 'accelerometer; autoplay; camera; encrypted-media; gyroscope; payment; clipboard-read; clipboard-write'
/** Swapped: "Due to regulatory reasons, users from Texas won't be able to use stablecoins." */
const REGIONS = { allow: ['*'], deny: ['US-TX'] }

export const DEFAULT_DELIVER_ASSETS: SwappedDeliverAsset[] = [
  { chain: 'eip155:8453', token: USDC['eip155:8453']!, currencyCode: 'USDC_BASE', symbol: 'USDC', decimals: 6 },
  { chain: 'eip155:42161', token: USDC['eip155:42161']!, currencyCode: 'USDC_ARBITRUM', symbol: 'USDC', decimals: 6 },
  { chain: 'eip155:137', token: USDC['eip155:137']!, currencyCode: 'USDC_POLYGON', symbol: 'USDC', decimals: 6 },
  { chain: 'eip155:1', token: USDC['eip155:1']!, currencyCode: 'USDC_ETHEREUM', symbol: 'USDC', decimals: 6 },
]

/** Swapped `payment_group` -> OpenRampKit method id. Unknown groups keep their own name. */
export const SWAPPED_METHOD_IDS: Record<string, string> = {
  creditcard: 'card',
  'apple-pay': 'apple_pay',
  applepay: 'apple_pay',
  'google-pay': 'google_pay',
  googlepay: 'google_pay',
  'bank-transfer': 'bank_transfer',
  banktransfer: 'bank_transfer',
  sepa: 'sepa',
  vietqr: 'vietqr',
  momo: 'momo',
  zalo: 'zalopay',
  zalopay: 'zalopay',
  gcash: 'gcash',
  maya: 'maya',
  gopay: 'gopay',
  dana: 'dana',
  ovo: 'ovo',
  grabpay: 'grabpay',
  promptpay: 'promptpay',
  touchngo: 'touchngo',
  pix: 'pix',
  upi: 'upi',
}

export function swappedMethodId(group: string): string {
  return SWAPPED_METHOD_IDS[group] ?? group
}

const dec = decimalFrom

export function swapped(opts: SwappedOptions) {
  const env = opts.env ?? 'production'
  const widgetUrl = (opts.widgetUrl ?? (env === 'sandbox' ? 'https://sandbox.swapped.com' : 'https://widget.swapped.com')).replace(/\/+$/, '')
  const apiUrl = (opts.apiUrl ?? widgetUrl).replace(/\/+$/, '')
  const widgetOrigin = new URL(widgetUrl).origin
  const deliver = opts.deliverAssets?.length ? opts.deliverAssets : DEFAULT_DELIVER_ASSETS
  const toChains: Record<string, string[]> = {}
  for (const d of deliver) (toChains[d.chain] ??= []).push(d.chain.startsWith('eip155:') ? d.token.toLowerCase() : d.token)

  const leg = (group: string, extra: Partial<LegSpec> = {}): LegSpec => ({
    id: group,
    kind: 'fiat_onramp',
    methods: [swappedMethodId(group)],
    from: { asset: { kind: 'fiat', currencies: '*' }, location: ['user_account'] },
    to: { asset: { kind: 'crypto', chains: toChains }, location: ['address'] },
    regions: REGIONS,
    limits: { min: '7', max: '100000', currency: 'EUR' },
    eta: { min: 120, max: 1800 },
    surfaces: ['IFRAME'],
    requires: ['provider_account', 'provider_kyc'],
    capabilities: ['webhooks', ...(opts.statusPolling ? (['polling'] as const) : [])],
    ...extra,
  })

  /** Used when the live catalog is not available */
  const staticLegs: LegSpec[] = [leg('creditcard'), leg('apple-pay'), leg('google-pay')]

  function deliverAssetFor(asset: Amount['asset'] | undefined): SwappedDeliverAsset {
    if (asset?.kind === 'crypto' && asset.chain !== '*') {
      const found = deliver.find((d) => d.chain === asset.chain && (d.chain.startsWith('eip155:') ? d.token.toLowerCase() === asset.token.toLowerCase() : d.token === asset.token))
      if (found) return found
    }
    return deliver[0]!
  }

  function assetOf(d: SwappedDeliverAsset): CryptoAsset {
    return { kind: 'crypto', chain: d.chain, token: d.token, ...(d.symbol ? { symbol: d.symbol } : {}), ...(d.decimals !== undefined ? { decimals: d.decimals } : {}) }
  }

  async function methodsByCountry(ctx: Pick<AdapterContext, 'fetch' | 'shared'>): Promise<Record<string, SwappedMethod[]>> {
    const cached = await ctx.shared.get<Record<string, SwappedMethod[]>>('methods')
    if (cached) return cached
    const res = await fetchJson<{ success?: boolean; message?: string; data?: Record<string, SwappedMethod[]> | SwappedMethod[] }>(
      ctx.fetch,
      `${apiUrl}/api/v1/merchant/get_payment_methods?apiKey=${encodeURIComponent(opts.publicKey)}`,
    )
    // A refused or empty answer is a failure, not "no methods": throw (the server then uses the
    // static legs) and do not cache it.
    if (res.success === false || !res.data || typeof res.data !== 'object') {
      throw new OrkException(orkError('PROVIDER_UNAVAILABLE', { message: `Swapped returned no payment methods${res.message ? `: ${res.message}` : ''}.`.slice(0, 200) }), 502)
    }
    // The live API returns { data: { [country]: Method[] } }. The docs show a flat list; accept both.
    const data = Array.isArray(res.data) ? { '*': res.data } : res.data
    await ctx.shared.put('methods', data, METHODS_TTL_SEC)
    return data
  }

  async function signedWidgetUrl(params: Array<[string, string | undefined]>): Promise<string> {
    const q = new URLSearchParams()
    for (const [k, v] of params) if (v !== undefined && v !== '') q.append(k, v)
    const search = `?${q.toString()}`
    const signature = await hmacSha256(opts.secretKey, search, 'base64')
    return `${widgetUrl}/${search}&signature=${encodeURIComponent(signature)}`
  }

  function assetByCode(code: string | undefined): CryptoAsset | undefined {
    const d = deliver.find((x) => x.currencyCode === code)
    return d ? assetOf(d) : undefined
  }

  function eventFrom(n: SwappedNotification): LegEvent | undefined {
    const ref = n.external_customer_id ?? undefined
    if (!ref) return undefined
    const asset = assetByCode(n.order_crypto)
    const output = asset && n.order_crypto_amount !== undefined ? { amount: dec(n.order_crypto_amount, 8), asset } : undefined
    switch (n.order_status) {
      case 'order_broadcasted':
        return { ref, status: 'succeeded', ...(n.transaction_id ? { txHash: n.transaction_id } : {}), ...(output ? { output } : {}) }
      case 'order_completed':
        // Paid and bought, but not yet sent on chain.
        return { ref, status: 'processing', ...(output ? { output } : {}) }
      case 'order_cancelled':
        return { ref, status: 'failed', error: orkError('PAYMENT_FAILED', { message: 'The order was cancelled or the payment failed.', recovery: 'retry_payment' }) }
      default:
        // payment_pending: the user is still paying inside the widget. No state change.
        return undefined
    }
  }

  return createAdapter({
    id: 'swapped',
    name: 'Swapped',
    legs: staticLegs,

    async catalog(input, ctx) {
      const byCountry = await methodsByCountry(ctx)
      const currency = input.currency.toUpperCase()
      const groups = new Map<string, { countries: Set<string>; min?: number; max?: number }>()
      const countries = input.country ? [input.country.toUpperCase()] : Object.keys(byCountry)
      for (const country of countries) {
        for (const m of byCountry[country] ?? []) {
          if (m.disabled || !m.currency?.map((c) => c.toUpperCase()).includes(currency)) continue
          const g = groups.get(m.payment_group) ?? { countries: new Set<string>() }
          if (country !== '*') g.countries.add(country)
          if (typeof m.min_amount === 'number') g.min = g.min === undefined ? m.min_amount : Math.min(g.min, m.min_amount)
          if (typeof m.max_amount === 'number') g.max = g.max === undefined ? m.max_amount : Math.max(g.max, m.max_amount)
          groups.set(m.payment_group, g)
        }
      }
      return [...groups.entries()].map(([group, g]) =>
        leg(group, {
          regions: { allow: g.countries.size ? [...g.countries] : ['*'], deny: REGIONS.deny },
          // Swapped limits are in EUR
          limits: { ...(g.min !== undefined ? { min: dec(g.min, 2) } : {}), ...(g.max !== undefined ? { max: dec(g.max, 2) } : {}), currency: 'EUR' },
        }),
      )
    },

    async quote(input, ctx) {
      const group = input.leg.legId
      const target = deliverAssetFor(input.leg.to.asset)
      const fiatAsset = input.amountIn?.asset ?? input.leg.from.asset
      if (fiatAsset.kind !== 'fiat') throw new OrkException(orkError('BAD_REQUEST', { message: 'Swapped quotes need a fiat amount.' }))
      const region = (ctx.session.country ?? opts.defaultCountry ?? 'US').toUpperCase()
      const body = {
        api_key: opts.publicKey,
        payment_method: group,
        fiat_currency: fiatAsset.currency.toUpperCase(),
        ...(input.amountIn ? { fiat_amount: Number(input.amountIn.amount) } : {}),
        crypto_currency: target.currencyCode,
        ...(!input.amountIn && input.amountOut ? { crypto_amount: Number(input.amountOut.amount) } : {}),
        region,
        ...(opts.markup !== undefined ? { markup: opts.markup } : {}),
      }
      let res: SwappedPricing
      try {
        res = await fetchJson<SwappedPricing>(ctx.fetch, `${apiUrl}/api/v1/merchant/pricing`, { method: 'POST', body: JSON.stringify(body) })
      } catch (e) {
        throw httpErrorToOrk(e, 'Swapped', { what: 'price this amount', log: ctx.log })
      }
      const d = res.data
      if (!res.success || !d) {
        throw new OrkException(orkError('NO_QUOTES', { message: res.message ? `Swapped: ${res.message}`.slice(0, 200) : 'Swapped could not price this amount.' }), 422)
      }
      const fiat = fiatAsset.currency.toUpperCase()
      const fees: Fee[] = []
      if (d.processing_fee) fees.push({ kind: 'provider', label: 'Swapped fee', amount: dec(d.processing_fee, 2), currency: fiat })
      if (d.network_fee_local) fees.push({ kind: 'network', label: 'Network fee', amount: dec(d.network_fee_local, 2), currency: fiat })
      if (d.markup_fiat_value) fees.push({ kind: 'app', label: 'App fee', amount: dec(d.markup_fiat_value, 2), currency: fiat })
      const inputAmount = input.amountIn?.amount ?? dec(d.fiat_amount_incl_fees_local, 2)
      return {
        adapterId: 'swapped',
        legId: group,
        input: { amount: inputAmount, asset: { kind: 'fiat', currency: fiat } },
        output: { amount: dec(d.crypto_amount, target.decimals ?? 8), asset: assetOf(target) },
        fees,
        eta: input.leg.legId === 'creditcard' || input.leg.legId.endsWith('-pay') ? { min: 120, max: 900 } : { min: 120, max: 1800 },
        // Swapped prices move with the market; the widget shows the final price.
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        data: { group, currencyCode: target.currencyCode, fiat, fiatAmount: inputAmount, region },
      }
    },

    async start(input, ctx) {
      const data = (input.quote.data ?? {}) as Record<string, string>
      const target = deliverAssetFor(input.quote.output.asset)
      const walletAddress = input.deliverTo?.address ?? (ctx.destination.type === 'crypto' ? ctx.destination.address : undefined)
      if (!walletAddress) throw new OrkException(orkError('BAD_REQUEST', { message: 'Swapped needs a wallet address to deliver to.' }))
      const fiat = input.quote.input.asset.kind === 'fiat' ? input.quote.input.asset.currency : data.fiat
      const ref = `${ctx.session.userId}.${randomHex(6)}`
      const url = await signedWidgetUrl([
        ['apiKey', opts.publicKey],
        ['currencyCode', data.currencyCode ?? target.currencyCode],
        ['walletAddress', walletAddress],
        ['method', data.group ?? input.leg.legId],
        ['baseCurrencyCode', fiat],
        ['baseCurrencyAmount', roundTo(input.quote.input.amount, 2)],
        ['lockBaseCurrency', 'true'],
        ['externalCustomerId', ref],
        ['email', ctx.session.email],
        ['baseCountry', ctx.session.country],
        ['redirectUrl', ctx.urls.returnUrl],
        ['responseUrl', ctx.urls.webhookUrl],
        ['markup', opts.markup !== undefined ? String(opts.markup) : undefined],
      ])
      await ctx.store.put(`o:${ref}`, { since: Date.now(), currencyCode: data.currencyCode ?? target.currencyCode }, ORDER_TTL_SEC)
      return {
        state: 'PAYMENT',
        surface: { kind: 'IFRAME', url, origin: widgetOrigin, allow: IFRAME_ALLOW, height: 560, provider: 'Swapped', messages: { completed: ['SWAPPED_ORDER_DATA'] } },
        transitions: [awaitPoll(POLL)],
        status: 'awaiting_user',
        ref,
      }
    },

    ...(opts.statusPolling
      ? {
          // TO VERIFY: get_transactions signature = base64 HMAC-SHA256(secretKey, JSON body without `signature`),
          // per the docs assistant. Not tested against the live API (the sandbox key was rejected).
          async status(input: { ref: string }, ctx: AdapterContext): Promise<LegStep> {
            const rec = await ctx.store.get<{ since: number }>(`o:${input.ref}`)
            const body: Record<string, unknown> = {
              apiKey: opts.publicKey,
              timestamp: new Date().toISOString(),
              limit: 100,
              ...(rec ? { start_date: new Date(rec.since - 60_000).toISOString() } : {}),
            }
            const signature = await hmacSha256(opts.secretKey, JSON.stringify(body), 'base64')
            let res: { data?: { orders?: Array<SwappedNotification & { order_status: string }> } }
            try {
              res = await fetchJson(ctx.fetch, `${apiUrl}/api/v1/merchant/get_transactions`, { method: 'POST', body: JSON.stringify({ ...body, signature }) })
            } catch (e) {
              throw httpErrorToOrk(e, 'Swapped', { what: 'find this order', log: ctx.log })
            }
            const order = res.data?.orders?.find((o) => o.external_customer_id === input.ref)
            if (!order) return legStepFromEvent(undefined, input.ref, POLL)
            // get_transactions has no `order_broadcasted`; a set transaction_id means it was broadcast.
            const status = order.order_status === 'order_completed' && order.transaction_id ? 'order_broadcasted' : order.order_status
            return legStepFromEvent(eventFrom({ ...order, order_status: status, external_customer_id: input.ref }), input.ref, POLL)
          },
        }
      : {}),

    webhook: {
      async verify(req, rawBody) {
        const sig = req.headers.get('signature')
        if (!sig) return false
        const expected = await hmacSha256(opts.secretKey, rawBody, 'base64')
        return timingSafeEqual(sig.trim(), expected)
      },
      async parse(rawBody, ctx) {
        let n: SwappedNotification
        try {
          n = JSON.parse(rawBody) as SwappedNotification
        } catch {
          ctx.log.warn('swapped: webhook body is not JSON')
          return []
        }
        const ev = eventFrom(n)
        if (!ev && !n.external_customer_id) ctx.log.warn('swapped: notification without external_customer_id', { orderId: n.order_id })
        return ev ? [ev] : []
      },
    },

    async health(ctx) {
      try {
        const res = await fetchJson<{ success?: boolean }>(ctx.fetch, `${apiUrl}/api/v1/merchant/get_payment_methods?apiKey=${encodeURIComponent(opts.publicKey)}`)
        return { ok: res.success !== false }
      } catch (e) {
        return { ok: false, detail: String((e as Error)?.message ?? e).slice(0, 200) }
      }
    },
  })
}
