// Peer Pay adapter: US P2P payment-app rails (Venmo, Cash App, Zelle, Chime, PayPal) and Wise / Revolut
// (USD, EUR, GBP) into USDC on Base, through the hosted Peer Pay checkout (https://docs.pay.peer.xyz).
//
// OPT-IN. Peer is a peer-to-peer marketplace: a seller escrows USDC on Base, the buyer pays that seller
// in a payment app, and a TEE attestation of the payment releases the USDC. There is no licensed
// provider or KYC step between the buyer and the seller; liquidity is thin and moves; Venmo and PayPal
// payments can be charged back after settlement (paid from the merchant's stake); and paying strangers
// for crypto may breach the payment apps' terms. The factory refuses to build without `enabled: true`.
//
// - Quote: POST /api/v1/merchants/me/quotes/availability (the REST form of checkQuoteAvailability), scoped
//   to one rail with `enabledRails`. No availability: NO_QUOTES. The USDC estimate comes from the public
//   Peer orderbook (GET https://api.zkp2p.xyz/v3/orderbook, best price that fits the amount) or 1:1 for
//   USD, minus the plan fee (`feeBps`, default 295 = the Base plan's 2.95%).
// - Start: POST /api/v1/orders in fiat mode with `enabledRails: [rail]`, `destinationAddress` = deliverTo,
//   `destinationChainId` 8453 and `idempotencyKey`. The checkout URL is `https://pay.peer.xyz/?order=&token=`
//   (+ `method=<rail>` to preselect, + `embed=true` in an iframe), as built by @zkp2p/pay-sdk 4.0.1.
// - Status: GET /api/v1/orders/{orderId} (no key; the order id is the credential).
// - Webhooks: `X-Webhook-Signature` = lowercase hex HMAC-SHA256 over `${X-Webhook-Timestamp}.${rawBody}`,
//   5 minute tolerance. ORDER_FULFILLED (or any event with order status FULFILLED) completes the leg with
//   `netSettledUsdcAmount` and `fulfillTransaction`; ORDER_CANCELLED fails it; payment attempts that
//   expire, fail or are cancelled keep the leg waiting (a late settlement can still fulfil the order).
// - Catalog: optional liquidity check on the public orderbook hides rails with no sellers for the currency.
//
// Server-side only. Web-standard APIs only (fetch, WebCrypto), so it runs on Cloudflare Workers.

import {
  POLL as POLLS,
  awaitPoll,
  createAdapter,
  fetchJson,
  hmacSha256,
  httpErrorToOpenRamp,
  legStepFromEvent,
  randomHex,
  resolveEnv,
  timingSafeEqual,
} from '@openrampkit/adapter'
import type { AdapterContext, AdapterEnv, LegEvent, Logger } from '@openrampkit/adapter'
import { OpenRampException, USDC, bps, cmp, fromScaled, isDecimal, openRampError, roundTo, sub, toScaled } from '@openrampkit/core'
import type { CryptoAsset, Fee, LegSpec, PollSpec, Surface } from '@openrampkit/core'

export type PeerRail = 'venmo' | 'cashapp' | 'zelle' | 'chime' | 'paypal' | 'revolut' | 'wise'

export type PeerOptions = {
  /** Must be `true`. Peer is a P2P marketplace; read the notes at the top of this file first. */
  enabled: true
  /** Merchant API key (Settings, Developer). Sandbox and live keys are separate. */
  apiKey: string
  /** Webhook signing secret (`responseObject.secret` from POST /api/v1/webhooks) */
  webhookSecret: string
  /**
   * Which key you pass: 'sandbox' or 'production'. Sandbox and production use the same hosts with separate keys,
   * webhooks and secrets. 'live' is a deprecated alias of 'production'.
   */
  env: AdapterEnv | 'live'
  /** Rails to offer. Default: all of venmo, cashapp, zelle, chime, paypal, revolut, wise. */
  rails?: string[]
  /** Who pays the Peer fee and the seller's spread. Default: the merchant setting (we assume MERCHANT for estimates). */
  feePayer?: 'MERCHANT' | 'PAYEE' | 'SPLIT'
  /** With feePayer SPLIT: the buyer share of fees in bps (0 to 10000, steps of 1000) */
  buyerFeeShareBps?: number
  /** Plan fee for estimates, in bps. Default 295 (Base plan 2.95%; Pro is 495). */
  feeBps?: number
  /** 'redirect' (default, a popup) or 'iframe' (embedded checkout) */
  surface?: 'redirect' | 'iframe'
  /** Hide rails with no orderbook liquidity in catalog(). Default true. */
  liquidityCheck?: boolean
  /** Default https://api.pay.peer.xyz */
  apiUrl?: string
  /** Default https://pay.peer.xyz */
  checkoutUrl?: string
  /** Public orderbook API. Default https://api.zkp2p.xyz */
  orderbookUrl?: string
}

type RailDef = { rail: PeerRail; method: string; currencies: string[]; countries: string[] | '*' }

const EEA = ['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK']

/**
 * Rails and currencies with live liquidity on 2026-09-29 (docs/design/landscape.md "Peer"): USD on every
 * rail; EUR and GBP on Wise and Revolut. Rail ids from https://docs.pay.peer.xyz/reference/payment-platforms.
 */
export const PEER_RAILS: RailDef[] = [
  { rail: 'venmo', method: 'venmo', currencies: ['USD'], countries: ['US'] },
  { rail: 'cashapp', method: 'cash_app', currencies: ['USD'], countries: ['US'] },
  { rail: 'zelle', method: 'zelle', currencies: ['USD'], countries: ['US'] },
  { rail: 'chime', method: 'chime', currencies: ['USD'], countries: ['US'] },
  // TO VERIFY: PayPal liquidity outside USD
  { rail: 'paypal', method: 'paypal', currencies: ['USD'], countries: ['US'] },
  { rail: 'revolut', method: 'revolut', currencies: ['USD', 'EUR', 'GBP'], countries: ['US', 'GB', ...EEA] },
  { rail: 'wise', method: 'wise', currencies: ['USD', 'EUR', 'GBP'], countries: '*' },
]

const BASE = 'eip155:8453'
const BASE_USDC: CryptoAsset = { kind: 'crypto', chain: BASE, token: USDC[BASE]!, symbol: 'USDC', decimals: 6 }
const POLL: PollSpec = POLLS.checkout
const TOLERANCE_SEC = 5 * 60
const ORDERBOOK_TTL_SEC = 5 * 60
const ORDER_TTL_SEC = 7 * 24 * 60 * 60
/** Platform minimum per order: 10 USDC (createCheckout errors: AMOUNT_BELOW_MIN) */
const MIN_USDC = '10'

export const PEER_OPT_IN_ERROR =
  'peer: this adapter is opt-in. Peer Pay settles through a peer-to-peer marketplace: buyers pay individual ' +
  'sellers on Venmo, Cash App, Zelle, PayPal, Wise or Revolut, with no licensed onramp or KYC between them. ' +
  'Liquidity is thin and changes by the minute, Venmo and PayPal payments can be charged back after settlement, ' +
  'and paying strangers for crypto may breach the payment apps\' terms. Check your compliance position, then pass ' +
  '`enabled: true` to peer({ ... }).'

type Envelope<T> = { success?: boolean; message?: string; responseObject?: T | null; statusCode?: number; errorCode?: string }

type Availability = {
  available: boolean
  quoteCount?: number
  nearbySuggestions?: { below?: Array<{ suggestedAmount: string; rail?: string }>; above?: Array<{ suggestedAmount: string; rail?: string }> } | null
}

type PeerPayment = {
  id?: string
  status?: 'CREATED' | 'SETTLED' | 'CANCELLED' | 'EXPIRED' | 'FAILED' | string
  rail?: string
  netSettledUsdcAmount?: string | null
  fulfillTransaction?: string | null
}

type PeerOrder = {
  id: string
  status?: 'CREATED' | 'PARTIALLY_FULFILLED' | 'FULFILLED' | 'CANCELLED' | string
  requestedUsdcAmount?: string
  remainingUsdcAmount?: string
  destinationChainId?: string | number
  netSettledUsdcAmount?: string | null
}

type OrderbookEntry = {
  price?: string
  conversionRate?: string
  availableTokenAmount?: string
  intentAmountMin?: string
  intentAmountMax?: string
  paymentPlatform?: string
  currency?: string
}

function sanitizeKey(k: string): string {
  // idempotencyKey: 8 to 128 letters, digits, underscores or hyphens
  const s = k.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128)
  return s.length >= 8 ? s : s.padEnd(8, '_')
}

/** Round to USDC's 6 decimals and drop trailing zeros */
function usdc(s: string): string {
  return fromScaled(toScaled(roundTo(s, 6), 6), 6)
}

function dec(s: string | null | undefined): string | undefined {
  return typeof s === 'string' && isDecimal(s) ? s : undefined
}

export function peer(opts: PeerOptions) {
  if ((opts as { enabled?: unknown } | undefined)?.enabled !== true) throw new Error(PEER_OPT_IN_ERROR)
  if (!opts.apiKey) throw new Error('peer: apiKey is required')
  if (!opts.webhookSecret) throw new Error('peer: webhookSecret is required (Peer reports settlement only by webhook)')
  const env = resolveEnv('peer', opts.env === 'live' ? undefined : opts.env, { value: opts.env === 'live' ? 'production' : undefined, option: "env: 'live'" }, undefined)
  const api = (opts.apiUrl ?? 'https://api.pay.peer.xyz').replace(/\/+$/, '')
  const checkoutBase = (opts.checkoutUrl ?? 'https://pay.peer.xyz').replace(/\/+$/, '')
  const checkoutOrigin = new URL(checkoutBase).origin
  const orderbookApi = (opts.orderbookUrl ?? 'https://api.zkp2p.xyz').replace(/\/+$/, '')
  const feeBps = opts.feeBps ?? 295
  const defs = PEER_RAILS.filter((r) => !opts.rails || opts.rails.includes(r.rail))
  if (!defs.length) throw new Error(`peer: \`rails\` selects no known rail (known: ${PEER_RAILS.map((r) => r.rail).join(', ')})`)
  const byRail = new Map(defs.map((d) => [d.rail as string, d]))
  const surfaceKind = opts.surface === 'iframe' ? 'IFRAME' : 'REDIRECT'

  const legFor = (d: RailDef, currencies: string[] = d.currencies): LegSpec => ({
    id: d.rail,
    kind: 'fiat_onramp',
    methods: [d.method],
    from: { asset: { kind: 'fiat', currencies }, location: ['user_account'] },
    to: { asset: { kind: 'crypto', chains: { [BASE]: [USDC[BASE]!] } }, location: ['address'] },
    regions: { allow: d.countries === '*' ? ['*'] : d.countries, deny: [] },
    limits: { min: MIN_USDC, currency: 'USD' },
    // One payment window is 1 hour; settlement follows the attestation.
    eta: { min: 120, max: 3600 },
    surfaces: [surfaceKind],
  })
  const legs = defs.map((d) => legFor(d))

  function def(legId: string): RailDef {
    const d = byRail.get(legId)
    if (!d) throw new OpenRampException(openRampError('BAD_REQUEST', { message: `Unknown Peer rail ${legId}` }), 400)
    return d
  }

  function toOpenRamp(e: unknown, what: string, log: Pick<Logger, 'warn'>): OpenRampException {
    const code = (e as { body?: { errorCode?: string } } | undefined)?.body?.errorCode
    if (code === 'AMOUNT_BELOW_MIN' || code === 'AMOUNT_BELOW_MERCHANT_MIN') return new OpenRampException(openRampError('AMOUNT_TOO_LOW'), 422)
    if (code === 'AMOUNT_ABOVE_MERCHANT_MAX' || code === 'MERCHANT_MONTHLY_VOLUME_LIMIT_EXCEEDED' || code === 'MERCHANT_MONTHLY_ORDER_LIMIT_EXCEEDED') {
      return new OpenRampException(openRampError('AMOUNT_TOO_HIGH', { message: 'Peer cannot take this amount right now.', recovery: 'choose_other' }), 422)
    }
    if (code === 'NO_ELIGIBLE_PAYMENT_RAILS') return new OpenRampException(openRampError('NO_QUOTES', { message: 'Peer: this payment app is not enabled for the merchant.' }), 422)
    return httpErrorToOpenRamp(e, 'Peer', { what, log })
  }

  async function payApi<T>(ctx: Pick<AdapterContext, 'fetch'>, method: 'GET' | 'POST', path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
    const res = await fetchJson<Envelope<T>>(ctx.fetch, `${api}${path}`, {
      method,
      headers: { 'x-api-key': opts.apiKey, ...extra },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    if (res.success === false || res.responseObject == null) {
      throw Object.assign(new Error(`Peer: ${res.message ?? 'empty response'}`), { status: 502, body: res })
    }
    return res.responseObject
  }

  async function orderbook(ctx: Pick<AdapterContext, 'fetch' | 'shared'>, rail: string, currency: string): Promise<OrderbookEntry[]> {
    const key = `ob:${rail}:${currency}`
    const cached = await ctx.shared.get<OrderbookEntry[]>(key)
    if (cached) return cached
    const q = new URLSearchParams({ currency, paymentPlatform: rail, chainId: '8453', sortBy: 'price', sortDirection: 'asc', limit: '50' })
    const res = await fetchJson<Envelope<{ entries?: OrderbookEntry[] }>>(ctx.fetch, `${orderbookApi}/v3/orderbook?${q}`)
    const entries = (res.responseObject?.entries ?? []).filter((e) => (e.paymentPlatform ?? rail) === rail)
    await ctx.shared.put(key, entries, ORDERBOOK_TTL_SEC)
    return entries
  }

  /** Gross USDC for `fiat` at the best orderbook price that can fill it (price: fiat per USDC, 18 decimals) */
  function estimateFromBook(entries: OrderbookEntry[], fiat: string): string | undefined {
    let best: string | undefined
    for (const e of entries) {
      const raw = e.price ?? e.conversionRate
      if (!raw || !/^\d+$/.test(raw) || raw === '0') continue
      const tokens = fromScaled((toScaled(fiat, 18) * 10n ** 18n) / BigInt(raw), 18)
      const units = toScaled(tokens, 6)
      const min = e.intentAmountMin && /^\d+$/.test(e.intentAmountMin) ? BigInt(e.intentAmountMin) : 0n
      const max = e.intentAmountMax && /^\d+$/.test(e.intentAmountMax) ? BigInt(e.intentAmountMax) : undefined
      const avail = e.availableTokenAmount && /^\d+$/.test(e.availableTokenAmount) ? BigInt(e.availableTokenAmount) : undefined
      if (units < min || (max !== undefined && units > max) || (avail !== undefined && units > avail)) continue
      if (!best || cmp(tokens, best) > 0) best = tokens
    }
    return best
  }

  function eventFrom(order: PeerOrder, payment: PeerPayment | null | undefined): LegEvent | undefined {
    const ref = order.id
    if (!ref) return undefined
    switch (order.status) {
      case 'FULFILLED': {
        const net = dec(payment?.netSettledUsdcAmount) ?? dec(order.netSettledUsdcAmount)
        const txHash = payment?.fulfillTransaction ?? undefined
        return { ref, status: 'succeeded', ...(txHash ? { txHash } : {}), ...(net ? { output: { value: net, asset: BASE_USDC } } : {}) }
      }
      case 'PARTIALLY_FULFILLED':
        return { ref, status: 'processing' }
      case 'CANCELLED':
        return { ref, status: 'failed', error: openRampError('PAYMENT_FAILED', { message: 'The Peer order was cancelled.', recovery: 'choose_other' }) }
      default:
        // CREATED: the user has not paid yet, or a payment attempt expired / failed / was cancelled and
        // the user can still pay (late settlement can still fulfil the order).
        return undefined
    }
  }

  return createAdapter({
    id: 'peer',
    env,
    name: 'Peer',
    legs,

    async catalog(input, ctx) {
      const currency = input.currency.toUpperCase()
      const candidates = defs.filter((d) => d.currencies.includes(currency))
      if (opts.liquidityCheck === false) return candidates.map((d) => legFor(d, [currency]))
      const out: LegSpec[] = []
      for (const d of candidates) {
        // A failed orderbook call throws: the server then keeps the static legs.
        const entries = await orderbook(ctx, d.rail, currency)
        if (entries.length) out.push(legFor(d, [currency]))
      }
      return out
    },

    async quote(input, ctx) {
      const d = def(input.leg.legId)
      if (!input.amountIn || input.amountIn.asset.kind !== 'fiat') throw new OpenRampException(openRampError('NO_QUOTES', { message: 'Peer quotes need a fiat amount.' }), 422)
      const currency = input.amountIn.asset.currency.toUpperCase()
      if (!d.currencies.includes(currency)) throw new OpenRampException(openRampError('NO_QUOTES', { message: `Peer has no ${currency} on this payment app.` }), 422)
      const amount = roundTo(input.amountIn.value, 2)
      if (currency === 'USD' && cmp(amount, MIN_USDC) < 0) throw new OpenRampException(openRampError('AMOUNT_TOO_LOW', { message: `The minimum on Peer is ${MIN_USDC} USD.` }), 422)
      const wallet = input.deliverTo?.address ?? (ctx.destination.type === 'crypto' ? ctx.destination.address : undefined)
      if (!wallet) throw new OpenRampException(openRampError('BAD_REQUEST', { message: 'Peer needs a wallet address to deliver to.' }))

      let avail: Availability
      try {
        avail = await payApi<Availability>(ctx, 'POST', '/api/v1/merchants/me/quotes/availability', {
          amount,
          quoteMode: 'exact-fiat',
          enabledRails: [d.rail],
          destinationChainId: '8453',
          destinationToken: 'USDC',
          destinationAddress: wallet,
          fiatCurrency: currency,
          nearbyQuotesCount: 2,
        })
      } catch (e) {
        throw toOpenRamp(e, 'price this amount', ctx.log)
      }
      if (!avail.available) {
        const near = [...(avail.nearbySuggestions?.below ?? []), ...(avail.nearbySuggestions?.above ?? [])].map((s) => s.suggestedAmount).filter((s) => isDecimal(s))
        const hint = near.length ? ` Try ${near.slice(0, 3).map((s) => roundTo(s, 2)).join(' or ')} ${currency}.` : ''
        throw new OpenRampException(openRampError('NO_QUOTES', { message: `Peer has no ${d.rail} liquidity for this amount right now.${hint}` }), 422)
      }

      // Estimate: the orderbook price that fills the amount (includes the seller's spread), else 1:1 for USD.
      let gross: string | undefined
      try {
        gross = estimateFromBook(await orderbook(ctx, d.rail, currency), amount)
      } catch (e) {
        ctx.log.warn('peer: orderbook unavailable; estimating without it', { error: String((e as Error)?.message ?? e).slice(0, 200) })
      }
      if (!gross && currency === 'USD') gross = amount
      if (!gross) throw new OpenRampException(openRampError('NO_QUOTES', { message: `Peer could not price ${currency} on ${d.rail} right now.` }), 422)

      const fees: Fee[] = []
      let inputAmount = amount
      let output: string
      if (opts.feePayer === 'PAYEE') {
        // Buyer pays: checkout grosses the price up so the full principal settles.
        inputAmount = roundTo(fromScaled((toScaled(amount, 18) * 10_000n) / BigInt(10_000 - feeBps), 18), 2)
        fees.push({ kind: 'provider', label: 'Peer fee', amount: roundTo(sub(inputAmount, amount), 2), currency })
        output = usdc(gross)
      } else {
        // Merchant pays (default) or split (TO VERIFY: split is estimated like merchant pays): fee comes off the USDC.
        const fee = usdc(bps(gross, feeBps))
        fees.push({ kind: 'provider', label: 'Peer fee', amount: fee, currency: 'USDC' })
        output = usdc(sub(gross, fee))
      }
      return {
        adapterId: 'peer',
        legId: d.rail,
        input: { value: inputAmount, asset: { kind: 'fiat', currency } },
        output: { value: output, asset: BASE_USDC },
        fees,
        eta: { min: 120, max: 3600 },
        // Availability is advisory and reserves nothing.
        expiresAt: new Date(Date.now() + 2 * 60_000).toISOString(),
        limits: { min: MIN_USDC, currency: 'USD' },
        data: { rail: d.rail, currency, amount, nonce: randomHex(8), ...(avail.quoteCount !== undefined ? { quoteCount: avail.quoteCount } : {}) },
      }
    },

    async start(input, ctx) {
      const d = def(input.leg.legId)
      const data = (input.quote.data ?? {}) as { rail?: string; currency?: string; amount?: string; nonce?: string }
      const wallet = input.deliverTo?.address ?? (ctx.destination.type === 'crypto' ? ctx.destination.address : undefined)
      if (!wallet) throw new OpenRampException(openRampError('BAD_REQUEST', { message: 'Peer needs a wallet address to deliver to.' }))
      const currency = data.currency ?? (input.quote.input.asset.kind === 'fiat' ? input.quote.input.asset.currency : 'USD')
      const amount = data.amount ?? roundTo(input.quote.input.value, 2)
      const idem = sanitizeKey(ctx.idempotencyKey(`peer-${d.rail}-${data.nonce ?? randomHex(8)}`))
      const saved = await ctx.store.get<{ ref: string; url: string }>(`idem:${idem}`)
      let ref: string
      let url: string
      if (saved) {
        ref = saved.ref
        url = saved.url
      } else {
        let res: { order?: PeerOrder; orderToken?: string | null; idempotentReplay?: boolean }
        try {
          res = await payApi(ctx, 'POST', '/api/v1/orders', {
            requestedFiatAmount: amount,
            requestedFiatCurrency: currency,
            destinationAddress: wallet,
            destinationChainId: 8453,
            destinationToken: 'USDC',
            enabledRails: [d.rail],
            successUrl: ctx.urls.returnUrl,
            cancelUrl: ctx.urls.returnUrl,
            // Keep the quoted amount: a resized order would not match the quote.
            dynamicOrdersEnabled: false,
            ...(opts.feePayer ? { feePayer: opts.feePayer } : {}),
            ...(opts.feePayer === 'SPLIT' && opts.buyerFeeShareBps !== undefined ? { buyerFeeShareBps: opts.buyerFeeShareBps } : {}),
            idempotencyKey: idem,
            notes: { openrampSessionId: ctx.session.id, openrampUserId: ctx.session.userId, env },
          }, { 'idempotency-key': idem })
        } catch (e) {
          throw toOpenRamp(e, 'start the order', ctx.log)
        }
        if (!res.order?.id || !res.orderToken) {
          // An idempotent replay has no token and we lost the first URL: the user must start again.
          throw new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message: 'Peer did not return a checkout link. Start again.' }), 502)
        }
        ref = res.order.id
        const u = new URL(`${checkoutBase}/`)
        u.searchParams.set('order', ref)
        u.searchParams.set('token', res.orderToken)
        u.searchParams.set('method', d.rail)
        url = u.toString()
        await ctx.store.put(`idem:${idem}`, { ref, url }, ORDER_TTL_SEC)
      }
      let surface: Surface
      if (opts.surface === 'iframe') {
        const u = new URL(url)
        u.searchParams.set('embed', 'true')
        surface = {
          kind: 'IFRAME',
          url: u.toString(),
          origin: checkoutOrigin,
          // Checkout opens the payment apps in a new tab: a sandboxed iframe needs allow-popups and allow-popups-to-escape-sandbox.
          allow: 'clipboard-write',
          height: 720,
          provider: 'Peer',
          messages: { origin: checkoutOrigin, completed: ['checkout.success'], failed: ['checkout.failed'], closed: ['checkout.closed'] },
        }
      } else {
        surface = { kind: 'REDIRECT', url, popup: true, provider: 'Peer' }
      }
      return { state: 'PAYMENT', surface, transitions: [awaitPoll(POLL)], status: 'requires_action', ref }
    },

    async status(input, ctx) {
      let res: { order?: PeerOrder; currentPayment?: PeerPayment | null }
      try {
        res = await payApi(ctx, 'GET', `/api/v1/orders/${encodeURIComponent(input.ref)}`)
      } catch (e) {
        throw toOpenRamp(e, 'find this order', ctx.log)
      }
      return legStepFromEvent(res.order ? eventFrom({ ...res.order, id: input.ref }, res.currentPayment) : undefined, input.ref, POLL)
    },

    webhook: {
      async verify(req, rawBody) {
        const sig = req.headers.get('x-webhook-signature')
        const ts = req.headers.get('x-webhook-timestamp')
        if (!sig || !ts || !/^\d+$/.test(ts)) return false
        if (Math.abs(Date.now() / 1000 - Number(ts)) > TOLERANCE_SEC) return false
        const expected = await hmacSha256(opts.webhookSecret, `${ts}.${rawBody}`, 'hex')
        return timingSafeEqual(sig.trim().toLowerCase(), expected)
      },
      async parse(rawBody, ctx) {
        let ev: { type?: string; data?: { order?: PeerOrder | null; payment?: PeerPayment | null; test?: boolean } }
        try {
          ev = JSON.parse(rawBody) as typeof ev
        } catch {
          ctx.log.warn('peer: webhook body is not JSON')
          return []
        }
        const order = ev.data?.order
        if (ev.data?.test || !order?.id) return []
        switch (ev.type) {
          case 'ORDER_FULFILLED':
          case 'PAYMENT_SETTLED': {
            const out = eventFrom(order, ev.data?.payment)
            return out ? [out] : []
          }
          case 'ORDER_CANCELLED':
            return [eventFrom({ ...order, status: 'CANCELLED' }, null)!]
          case 'PAYMENT_CHARGEBACKED':
          case 'ORDER_CHARGEBACKED':
          case 'ORDER_PARTIALLY_CHARGEBACKED':
            ctx.log.warn('peer: chargeback on a settled order', { orderId: order.id, type: ev.type })
            return []
          default:
            // PAYMENT_CREATED / _FAILED / _EXPIRED / _CANCELLED, ORDER_CREATED, ORDER_RESIZED, bridge and refund
            // events do not change the leg: the user can still pay.
            return []
        }
      },
    },

    async health(ctx) {
      try {
        await payApi(ctx, 'GET', '/api/v1/integration/status')
        return { ok: true }
      } catch (e) {
        return { ok: false, detail: String((e as Error)?.message ?? e).slice(0, 200) }
      }
    },
  })
}
