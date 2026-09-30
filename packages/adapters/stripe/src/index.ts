// Stripe Crypto Onramp adapter (https://docs.stripe.com/crypto/onramp).
//
// - Quote: GET /v1/crypto/onramp_quotes (API reference; the embedded guide says /v1/crypto/onramp/quotes,
//   so we fall back to that path on a 404). Fees come back as `network_fee_monetary` and
//   `transaction_fee_monetary`; `source_total_amount` is what the user pays.
// - Start: POST /v1/crypto/onramp_sessions (form-encoded) with the wallet address locked, the
//   destination currency and network, and the source amount. The session gives a `client_secret`
//   for the embedded onramp (@stripe/crypto: loadStripeOnramp(publishableKey).createSession({ clientSecret }))
//   and, when Stripe returns one, a `redirect_url` to the Stripe-hosted onramp (crypto.link.com).
// - Surface: PROVIDER_SDK { provider: 'stripe', params: { clientSecret, publishableKey, sessionId, redirectUrl } }
//   by default, or REDIRECT to `redirect_url` with `surface: 'redirect'`.
// - Status: GET /v1/crypto/onramp_sessions/{id}.
// - Webhooks: `crypto.onramp_session.updated`, `Stripe-Signature: t=...,v1=...` = hex HMAC-SHA256 over
//   `${t}.${rawBody}` with the endpoint secret (whsec_...), 5 minute tolerance.
// - Needs Stripe approval for the onramp (limited beta). US (not Hawaii) and EU.
//
// Server-side only. Web-standard APIs only (fetch, WebCrypto, btoa), so it runs on Cloudflare Workers.

import {
  POLL as POLLS,
  awaitPoll,
  createAdapter,
  fetchJson,
  hmacSha256,
  httpErrorToOrk,
  httpStatus,
  legStepFromEvent,
  randomHex,
  timingSafeEqual,
} from '@openrampkit/adapter'
import type { AdapterContext, LegEvent, Logger } from '@openrampkit/adapter'
import { OrkException, USDC, isDecimal, orkError, roundTo } from '@openrampkit/core'
import type { CryptoAsset, Fee, LegSpec, PollSpec, Surface } from '@openrampkit/core'

export type StripeOptions = {
  /** Secret key (sk_live_... or sk_test_...). A restricted key with onramp access also works. */
  secretKey: string
  /** Publishable key (pk_...), passed to the client for the embedded onramp */
  publishableKey: string
  /** Webhook endpoint secret (whsec_...) for `crypto.onramp_session.updated` */
  webhookSecret: string
  /** 'sdk' (default): PROVIDER_SDK surface for the embedded onramp. 'redirect': the Stripe-hosted onramp page. */
  surface?: 'sdk' | 'redirect'
  /** Limit the legs (card, apple_pay, google_pay, ach) */
  methods?: string[]
  /** Default https://api.stripe.com */
  apiUrl?: string
}

type StripeNetwork = 'ethereum' | 'base' | 'polygon' | 'solana' | 'avalanche'

type DeliverAsset = {
  chain: string
  token: string
  network: StripeNetwork
  /** Countries or ISO 3166-2 regions where Stripe does not sell this asset; 'EU' means every EU country */
  deny: string[]
}

const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
const AVALANCHE = 'eip155:43114'

/**
 * USDC per network. Restrictions from https://docs.stripe.com/crypto/onramp (2026-09-29):
 * "Not supported in the EU: ETH (Base), MATIC, AVAX, USDC (Solana), USDC (Polygon), USDC (Avalanche), USDC (Base)";
 * "XLM, USDC (Stellar), USDC (Avalanche) and USDC (Polygon) are not available in New York".
 */
export const STRIPE_DELIVER_ASSETS: DeliverAsset[] = [
  { chain: 'eip155:8453', token: USDC['eip155:8453']!, network: 'base', deny: ['EU'] },
  { chain: 'eip155:1', token: USDC['eip155:1']!, network: 'ethereum', deny: [] },
  { chain: 'eip155:137', token: USDC['eip155:137']!, network: 'polygon', deny: ['EU', 'US-NY'] },
  { chain: SOLANA, token: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', network: 'solana', deny: ['EU'] },
  { chain: AVALANCHE, token: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e', network: 'avalanche', deny: ['EU', 'US-NY'] },
]

export const EU = ['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK']

/**
 * Key under `wallet_addresses[...]` per network. The session object lists Base as `base_network`.
 * TO VERIFY: the request key for Base (`base_network` assumed; the docs only show the response).
 */
const WALLET_KEY: Record<StripeNetwork, string> = { ethereum: 'ethereum', base: 'base_network', polygon: 'polygon', solana: 'solana', avalanche: 'avalanche' }

type StripeMoney = { amount?: string; currency?: string } | string | null | undefined
type NetworkQuote = {
  id?: string
  destination_amount?: string
  destination_currency?: string
  destination_network?: string
  fees?: { network_fee_monetary?: string; transaction_fee_monetary?: string }
  source_total_amount?: string
}
type QuotesResponse = { destination_network_quotes?: Record<string, NetworkQuote[]>; source_amount?: string; source_currency?: string }
type OnrampSession = {
  id: string
  object?: string
  client_secret?: string
  redirect_url?: string | null
  status?: 'initialized' | 'rejected' | 'requires_payment' | 'fulfillment_processing' | 'fulfillment_complete' | string
  livemode?: boolean
  metadata?: Record<string, string>
  transaction_details?: {
    destination_amount?: string | null
    destination_currency?: string | null
    destination_network?: string | null
    source_amount?: string | null
    source_currency?: string | null
    transaction_id?: string | null
    wallet_address?: string | null
    fees?: { network_fee_amount?: StripeMoney; transaction_fee_amount?: StripeMoney } | null
  }
}

const POLL: PollSpec = POLLS.checkout
const TOLERANCE_SEC = 5 * 60

type MethodDef = { id: string; currencies: string[]; countries: string[]; eta: { min: number; max: number } }
const INSTANT = { min: 60, max: 900 }
// TO VERIFY: the method list (card, Apple Pay, Google Pay, ACH) comes from Stripe marketing pages, not the API docs.
// The Stripe onramp UI picks the payment method itself; the legs only tell the planner what to show.
export const STRIPE_METHODS: MethodDef[] = [
  { id: 'card', currencies: ['USD', 'EUR'], countries: ['US', ...EU], eta: INSTANT },
  { id: 'apple_pay', currencies: ['USD', 'EUR'], countries: ['US', ...EU], eta: INSTANT },
  { id: 'google_pay', currencies: ['USD', 'EUR'], countries: ['US', ...EU], eta: INSTANT },
  { id: 'ach', currencies: ['USD'], countries: ['US'], eta: { min: 300, max: 5 * 86400 } },
]

/** "only available in the EU and the US (excluding Hawaii)" */
const DENY = ['US-HI']

function num(s: string | undefined | null): string | undefined {
  return s && isDecimal(s) ? s : undefined
}

function money(m: StripeMoney): string | undefined {
  if (!m) return undefined
  return num(typeof m === 'string' ? m : m.amount)
}

/** Stripe form encoding: nested keys like `wallet_addresses[base_network]` and arrays like `destination_networks[]` */
function form(params: Array<[string, string | undefined]>): string {
  const q = new URLSearchParams()
  for (const [k, v] of params) if (v !== undefined && v !== '') q.append(k, v)
  return q.toString()
}

export function parseStripeSignature(header: string): { t?: string; v1: string[] } {
  const out: { t?: string; v1: string[] } = { v1: [] }
  for (const part of header.split(',')) {
    const i = part.indexOf('=')
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k === 't') out.t = v
    else if (k === 'v1') out.v1.push(v)
  }
  return out
}

export function stripe(opts: StripeOptions) {
  const api = (opts.apiUrl ?? 'https://api.stripe.com').replace(/\/+$/, '')
  const auth = `Basic ${btoa(`${opts.secretKey}:`)}`
  const surfaceKind = opts.surface === 'redirect' ? 'REDIRECT' : 'PROVIDER_SDK'
  const defs = STRIPE_METHODS.filter((m) => !opts.methods || opts.methods.includes(m.id))
  if (!defs.length) throw new Error('stripe: `methods` selects no known leg')
  const toChains: Record<string, string[]> = {}
  for (const d of STRIPE_DELIVER_ASSETS) (toChains[d.chain] ??= []).push(d.chain.startsWith('eip155:') ? d.token.toLowerCase() : d.token)

  const legs: LegSpec[] = defs.map((d) => ({
    id: d.id,
    kind: 'fiat_onramp',
    methods: [d.id],
    from: { asset: { kind: 'fiat', currencies: d.currencies }, location: ['user_account'] },
    to: { asset: { kind: 'crypto', chains: toChains }, location: ['address'] },
    regions: { allow: d.countries, deny: DENY },
    eta: d.eta,
    surfaces: [surfaceKind],
    requires: ['provider_kyc'],
    capabilities: ['webhooks', 'polling', 'exact_output'],
  }))
  const byId = new Map(defs.map((d) => [d.id, d]))

  function deliverFor(asset: CryptoAsset | undefined): DeliverAsset {
    if (asset && asset.chain !== '*') {
      const f = STRIPE_DELIVER_ASSETS.find((d) => d.chain === asset.chain && (d.chain.startsWith('eip155:') ? d.token.toLowerCase() === asset.token.toLowerCase() : d.token === asset.token))
      if (f) return f
    }
    return STRIPE_DELIVER_ASSETS[0]!
  }

  function assetOf(d: DeliverAsset): CryptoAsset {
    return { kind: 'crypto', chain: d.chain, token: d.token, symbol: 'USDC', decimals: 6 }
  }

  function checkRegion(d: DeliverAsset, ctx: AdapterContext) {
    const country = ctx.session.country?.toUpperCase()
    const region = ctx.session.region?.toUpperCase()
    const hit = d.deny.some((x) => (x === 'EU' ? !!country && EU.includes(country) : x.includes('-') ? region === x : country === x))
    if (hit) {
      throw new OrkException(orkError('REGION_UNSUPPORTED', { message: `Stripe does not sell USDC on ${d.network} in your region.`, recovery: 'choose_other' }), 422)
    }
  }

  /** 400s about the customer's country mean "not in your region"; other 4xx about the request mean "no quote". */
  function toOrk(e: unknown, what: string, log: Pick<Logger, 'warn'>): OrkException {
    const code = ((e as { body?: { error?: { code?: string } } })?.body?.error?.code) ?? ''
    if (code === 'crypto_onramp_unsupported_country' || code === 'crypto_onramp_unsupportable_customer') {
      return new OrkException(orkError('REGION_UNSUPPORTED', { message: 'Stripe cannot sell crypto to you in your region.', recovery: 'choose_other' }), 422)
    }
    return httpErrorToOrk(e, 'Stripe', { what, noQuoteStatuses: [400, 422], log })
  }

  async function call<T>(ctx: Pick<AdapterContext, 'fetch'>, method: 'GET' | 'POST', path: string, body?: string, idem?: string): Promise<T> {
    return fetchJson<T>(ctx.fetch, `${api}${path}`, {
      method,
      headers: {
        authorization: auth,
        ...(body !== undefined ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...(idem ? { 'idempotency-key': idem } : {}),
      },
      ...(body !== undefined ? { body } : {}),
    })
  }

  function eventFrom(s: OnrampSession, refOverride?: string): LegEvent | undefined {
    const ref = refOverride ?? s.id
    if (!ref) return undefined
    const td = s.transaction_details ?? {}
    const d = STRIPE_DELIVER_ASSETS.find((x) => x.network === td.destination_network || (x.network === 'base' && td.destination_network === 'base_network'))
    const amount = num(td.destination_amount)
    const output = d && amount && (td.destination_currency ?? 'usdc').toLowerCase() === 'usdc' ? { amount, asset: assetOf(d) } : undefined
    switch (s.status) {
      case 'fulfillment_complete':
        return { ref, status: 'succeeded', ...(td.transaction_id ? { txHash: td.transaction_id } : {}), ...(output ? { output } : {}) }
      case 'fulfillment_processing':
        return { ref, status: 'processing', ...(output ? { output } : {}) }
      case 'rejected':
        return { ref, status: 'failed', error: orkError('PROVIDER_DECLINED', { message: 'Stripe declined this purchase.', recovery: 'choose_other' }) }
      case 'initialized':
      case 'requires_payment':
        return { ref, status: 'awaiting_user' }
      default:
        return undefined
    }
  }

  return createAdapter({
    id: 'stripe',
    name: 'Stripe',
    legs,

    async quote(input, ctx) {
      const d = byId.get(input.leg.legId)
      if (!d) throw new OrkException(orkError('BAD_REQUEST', { message: `Unknown Stripe leg ${input.leg.legId}` }), 400)
      const target = deliverFor(input.leg.to.asset.kind === 'crypto' ? input.leg.to.asset : undefined)
      checkRegion(target, ctx)
      const fiatAsset = input.amountIn?.asset ?? input.leg.from.asset
      const fiat = (fiatAsset.kind === 'fiat' ? fiatAsset.currency : 'USD').toLowerCase()
      if (fiat !== 'usd' && fiat !== 'eur') throw new OrkException(orkError('NO_QUOTES', { message: 'Stripe takes USD or EUR only.' }), 422)
      const q = form([
        ['source_currency', fiat],
        ['source_amount', input.amountIn ? roundTo(input.amountIn.amount, 2) : undefined],
        ['destination_amount', !input.amountIn ? input.amountOut?.amount : undefined],
        ['destination_currencies[]', 'usdc'],
        ['destination_networks[]', target.network],
      ])
      let res: QuotesResponse
      try {
        try {
          res = await call<QuotesResponse>(ctx, 'GET', `/v1/crypto/onramp_quotes?${q}`)
        } catch (e) {
          // TO VERIFY: the API reference and the embedded guide name different paths.
          if (httpStatus(e) !== 404) throw e
          res = await call<QuotesResponse>(ctx, 'GET', `/v1/crypto/onramp/quotes?${q}`)
        }
      } catch (e) {
        throw toOrk(e, 'price this amount', ctx.log)
      }
      const quotes = res.destination_network_quotes ?? {}
      const list = quotes[target.network] ?? quotes[WALLET_KEY[target.network]] ?? []
      const nq = list.find((x) => (x.destination_currency ?? '').toLowerCase() === 'usdc')
      const out = num(nq?.destination_amount)
      const total = num(nq?.source_total_amount)
      if (!nq || !out || !total) throw new OrkException(orkError('NO_QUOTES', { message: 'Stripe did not return a quote for this amount.' }), 422)
      const cur = fiat.toUpperCase()
      const fees: Fee[] = []
      const txFee = num(nq.fees?.transaction_fee_monetary)
      const netFee = num(nq.fees?.network_fee_monetary)
      if (txFee) fees.push({ kind: 'provider', label: 'Stripe fee', amount: txFee, currency: cur })
      if (netFee) fees.push({ kind: 'network', label: 'Network fee', amount: netFee, currency: cur })
      return {
        adapterId: 'stripe',
        legId: d.id,
        input: { amount: total, asset: { kind: 'fiat', currency: cur } },
        output: { amount: out, asset: assetOf(target) },
        fees,
        eta: d.eta,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        data: {
          network: target.network,
          sourceCurrency: fiat,
          ...(input.amountIn ? { sourceAmount: roundTo(input.amountIn.amount, 2) } : { destinationAmount: out }),
          nonce: randomHex(8),
        },
      }
    },

    async start(input, ctx) {
      const data = (input.quote.data ?? {}) as { network?: StripeNetwork; sourceCurrency?: string; sourceAmount?: string; destinationAmount?: string; nonce?: string }
      const target = deliverFor(input.quote.output.asset.kind === 'crypto' ? input.quote.output.asset : undefined)
      const network = data.network ?? target.network
      const wallet = input.deliverTo?.address ?? (ctx.destination.type === 'crypto' ? ctx.destination.address : undefined)
      if (!wallet) throw new OrkException(orkError('BAD_REQUEST', { message: 'Stripe needs a wallet address to deliver to.' }))
      const body = form([
        [`wallet_addresses[${WALLET_KEY[network]}]`, wallet],
        ['lock_wallet_address', 'true'],
        ['destination_currency', 'usdc'],
        ['destination_network', network],
        ['destination_currencies[]', 'usdc'],
        ['destination_networks[]', network],
        ['source_currency', data.sourceCurrency ?? (input.quote.input.asset.kind === 'fiat' ? input.quote.input.asset.currency.toLowerCase() : 'usd')],
        ['source_amount', data.sourceAmount],
        ['destination_amount', data.sourceAmount ? undefined : data.destinationAmount ?? input.quote.output.amount],
        ['customer_ip_address', ctx.session.ip],
        ['metadata[ork_session]', ctx.session.id],
        ['metadata[ork_leg]', input.leg.legId],
      ])
      let s: OnrampSession
      try {
        s = await call<OnrampSession>(ctx, 'POST', '/v1/crypto/onramp_sessions', body, ctx.idempotencyKey(`stripe:${data.nonce ?? randomHex(8)}`))
      } catch (e) {
        throw toOrk(e, 'start the purchase', ctx.log)
      }
      if (!s.id || !s.client_secret) throw new OrkException(orkError('PROVIDER_UNAVAILABLE', { message: 'Stripe did not return an onramp session.' }), 502)
      if (s.status === 'rejected') {
        return { state: 'FAILED', status: 'failed', transitions: [], ref: s.id, error: orkError('PROVIDER_DECLINED', { message: 'Stripe declined this purchase.', recovery: 'choose_other' }) }
      }
      let surface: Surface
      if (opts.surface === 'redirect' && s.redirect_url) {
        surface = { kind: 'REDIRECT', url: s.redirect_url, popup: true, provider: 'Stripe' }
      } else {
        if (opts.surface === 'redirect') ctx.log.warn('stripe: session has no redirect_url; using the embedded onramp')
        surface = {
          kind: 'PROVIDER_SDK',
          provider: 'stripe',
          params: { clientSecret: s.client_secret, publishableKey: opts.publishableKey, sessionId: s.id, ...(s.redirect_url ? { redirectUrl: s.redirect_url } : {}) },
        }
      }
      return { state: 'PAYMENT', surface, transitions: [awaitPoll(POLL)], status: 'awaiting_user', ref: s.id }
    },

    async status(input, ctx) {
      let s: OnrampSession
      try {
        s = await call<OnrampSession>(ctx, 'GET', `/v1/crypto/onramp_sessions/${encodeURIComponent(input.ref)}`)
      } catch (e) {
        throw toOrk(e, 'find this purchase', ctx.log)
      }
      return legStepFromEvent(eventFrom(s, input.ref), input.ref, POLL)
    },

    webhook: {
      async verify(req, rawBody, ctx) {
        // An empty key would let anyone sign (for example an unset environment variable).
        if (!opts.webhookSecret) {
          ctx.log.warn('stripe: webhookSecret is not set; rejecting webhook')
          return false
        }
        const header = req.headers.get('stripe-signature')
        if (!header) return false
        const { t, v1 } = parseStripeSignature(header)
        const ts = Number(t)
        if (!t || !v1.length || !Number.isFinite(ts)) return false
        if (Math.abs(Date.now() / 1000 - ts) > TOLERANCE_SEC) return false
        const expected = await hmacSha256(opts.webhookSecret, `${t}.${rawBody}`, 'hex')
        return v1.some((s) => timingSafeEqual(s.toLowerCase(), expected))
      },
      async parse(rawBody, ctx) {
        let ev: { type?: string; data?: { object?: OnrampSession } }
        try {
          ev = JSON.parse(rawBody) as typeof ev
        } catch {
          ctx.log.warn('stripe: webhook body is not JSON')
          return []
        }
        // The docs name the event `crypto.onramp_session.updated`; accept the underscore form too.
        if (ev.type !== 'crypto.onramp_session.updated' && ev.type !== 'crypto.onramp_session_updated') return []
        const s = ev.data?.object
        if (!s?.id) return []
        const out = eventFrom(s)
        return out ? [out] : []
      },
    },
  })
}
