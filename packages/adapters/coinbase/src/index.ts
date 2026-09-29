// Coinbase Onramp adapter (https://docs.cdp.coinbase.com/onramp).
//
// - Quote and URL: POST https://api.cdp.coinbase.com/platform/v2/onramp/sessions ("Create an onramp
//   session"). With paymentAmount + paymentCurrency + paymentMethod + country (+ subdivision in the US)
//   it returns both a quote and a single-use one-click onramp URL (pay.coinbase.com).
// - Status: GET https://api.developer.coinbase.com/onramp/v1/buy/user/{partnerUserRef}/transactions.
// - Webhooks: CDP webhook subscriptions (onramp.transaction.*), signed in the `X-Hook0-Signature`
//   header. Pass the subscription's `metadata.secret` as `webhookSecret`.
// - Auth: CDP API key JWT (Ed25519 or ES256), signed with WebCrypto (see jwt.ts).
//
// Note: Coinbase ended guest checkout (card / Apple Pay without a Coinbase account) in the hosted
// widget on 2026-06-30. The hosted flow now needs a Coinbase account. Guest Apple Pay / Google Pay
// moved to the Headless Onramp API (Create Onramp Order), which this adapter does not implement yet.
//
// Server-side only. Web-standard APIs only (fetch, WebCrypto), so it runs on Cloudflare Workers.

import { POLL as POLLS, awaitPoll, createAdapter, fetchJson, hmacSha256, httpErrorToOrk, legStepFromEvent, randomHex, timingSafeEqual } from '@openrampkit/adapter'
import type { AdapterContext, LegEvent, Logger } from '@openrampkit/adapter'
import { OrkException, USDC, isDecimal, orkError, roundTo } from '@openrampkit/core'
import type { CryptoAsset, Fee, LegSpec, PollSpec } from '@openrampkit/core'
import { cdpJwt, importCdpKey } from './jwt.js'
import type { CdpKey } from './jwt.js'

export { cdpJwt, importCdpKey, sec1ToPkcs8 } from './jwt.js'

export type CoinbaseOptions = {
  /** CDP Secret API key id (the `name`/`id` of the key) */
  apiKeyId: string
  /** CDP Secret API key secret: base64 Ed25519 (default in the CDP portal) or EC PEM */
  apiKeySecret: string
  /** CDP project id. Not needed by the session API; kept for apps that also build legacy URLs. */
  appId?: string
  /** Secret of the CDP webhook subscription (onramp.transaction.* events) */
  webhookSecret?: string
  /** Default https://api.cdp.coinbase.com */
  cdpApiUrl?: string
  /** Default https://api.developer.coinbase.com */
  onrampApiUrl?: string
  /** Country used when the session has none. Default 'US'. */
  defaultCountry?: string
  /**
   * US state used for quotes when the session has no region (Coinbase needs `subdivision` for US quotes).
   * TO VERIFY: OpenRampKit's AdapterContext does not carry the session region yet.
   */
  defaultSubdivision?: string
  /** Use sandbox transactions (partnerUserRef prefixed with "sandbox-"). Default: !session.livemode */
  sandbox?: boolean
}

const POLL: PollSpec = POLLS.checkout
/** Reuse the URL made at quote time only while its session token is fresh (tokens last 5 minutes). */
const URL_REUSE_MS = 4 * 60_000

const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
const SOLANA_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

/** CAIP-2 chain -> Coinbase network name. TO VERIFY: names for arbitrum/optimism/polygon via Buy Options API. */
export const COINBASE_NETWORKS: Record<string, string> = {
  'eip155:8453': 'base',
  'eip155:1': 'ethereum',
  'eip155:42161': 'arbitrum',
  'eip155:10': 'optimism',
  'eip155:137': 'polygon',
  [SOLANA]: 'solana',
}

const USDC_TOKENS: Record<string, string> = { ...USDC, [SOLANA]: SOLANA_USDC }

/** Fiat currencies for the hosted onramp. TO VERIFY per country with the Buy Options API. */
const FIATS = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'SGD', 'CHF']

/** Our method id -> Coinbase paymentMethod. google_pay has no own value in the session API (TO VERIFY). */
const PAYMENT_METHOD: Record<string, string> = { card: 'CARD', apple_pay: 'APPLE_PAY', google_pay: 'CARD' }

type CbAmount = { value?: string; amount?: string; currency: string }
type CbTransaction = {
  status?: string
  tx_hash?: string
  txHash?: string
  purchase_amount?: CbAmount | string
  purchaseAmount?: CbAmount | string
  purchase_network?: string
  purchaseNetwork?: string
  destinationNetwork?: string
  partner_user_ref?: string
  partnerUserRef?: string
  failure_reason?: string
  transaction_id?: string
  eventType?: string
}
type CbSessionResponse = {
  session?: { onrampUrl?: string }
  quote?: {
    paymentTotal: string
    paymentSubtotal: string
    paymentCurrency: string
    purchaseAmount: string
    purchaseCurrency: string
    destinationNetwork: string
    fees: Array<{ type: string; amount: string; currency: string }>
    exchangeRate: string
  }
}

function amountValue(a: CbAmount | string | undefined): string | undefined {
  if (a === undefined) return undefined
  const v = typeof a === 'string' ? a : a.value ?? a.amount
  return v && isDecimal(v) ? v : undefined
}

export function coinbase(opts: CoinbaseOptions) {
  const cdpApi = new URL(opts.cdpApiUrl ?? 'https://api.cdp.coinbase.com')
  const onrampApi = new URL(opts.onrampApiUrl ?? 'https://api.developer.coinbase.com')
  let keyPromise: Promise<CdpKey> | undefined
  const key = () => (keyPromise ??= importCdpKey(opts.apiKeySecret))

  async function cdp<T>(ctx: Pick<AdapterContext, 'fetch'>, base: URL, method: 'GET' | 'POST', path: string, query = '', body?: unknown): Promise<T> {
    const jwt = await cdpJwt({ apiKeyId: opts.apiKeyId, key: await key(), method, host: base.host, path })
    return fetchJson<T>(ctx.fetch, `${base.origin}${path}${query}`, {
      method,
      headers: { authorization: `Bearer ${jwt}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }

  /** 400 and 422 mean "not for this request"; 401, 403 and 404 mean our key or setup is wrong. */
  function toOrk(e: unknown, what: string, log?: Pick<Logger, 'warn'>): OrkException {
    return httpErrorToOrk(e, 'Coinbase', { what, noQuoteStatuses: [400, 422], ...(log ? { log } : {}) })
  }

  const toChains: Record<string, string[]> = Object.fromEntries(
    Object.keys(COINBASE_NETWORKS)
      .filter((c) => USDC_TOKENS[c])
      .map((c) => [c, [USDC_TOKENS[c]!.toLowerCase()]]),
  )

  const leg = (method: 'card' | 'apple_pay' | 'google_pay'): LegSpec => ({
    id: method,
    kind: 'fiat_onramp',
    methods: [method],
    from: { asset: { kind: 'fiat', currencies: FIATS }, location: ['user_account'] },
    to: { asset: { kind: 'crypto', chains: toChains }, location: ['address'] },
    // "Coinbase Onramp is available in all countries in which Coinbase operates except Japan."
    regions: { allow: ['*'], deny: ['JP'] },
    eta: { min: 60, max: 900 },
    surfaces: ['REDIRECT'],
    requires: ['provider_account', 'provider_kyc'],
    capabilities: ['webhooks', 'polling'],
  })
  const legs: LegSpec[] = [leg('card'), leg('apple_pay'), leg('google_pay')]

  function target(asset: CryptoAsset | undefined): { chain: string; network: string; asset: CryptoAsset } {
    const chain = asset && asset.chain !== '*' && COINBASE_NETWORKS[asset.chain] ? asset.chain : 'eip155:8453'
    return { chain, network: COINBASE_NETWORKS[chain]!, asset: { kind: 'crypto', chain, token: USDC_TOKENS[chain]!, symbol: 'USDC', decimals: 6 } }
  }

  function chainForNetwork(network: string | undefined): string | undefined {
    return Object.entries(COINBASE_NETWORKS).find(([, n]) => n === network)?.[0]
  }

  function subdivision(ctx: AdapterContext, country: string): string | undefined {
    const region = ctx.session.region
    if (region?.toUpperCase().startsWith(`${country}-`)) return region.slice(country.length + 1).toUpperCase()
    return country === 'US' ? opts.defaultSubdivision : undefined
  }

  function partnerUserRef(ctx: AdapterContext): string {
    const sandbox = opts.sandbox ?? !ctx.session.livemode
    // Must be under 50 characters
    return `${sandbox ? 'sandbox-' : ''}ork-${randomHex(10)}`
  }

  async function createSession(ctx: AdapterContext, p: {
    network: string
    address: string
    paymentCurrency: string
    paymentAmount?: string
    purchaseAmount?: string
    paymentMethod?: string
    country?: string
    subdivision?: string
    ref: string
  }): Promise<CbSessionResponse> {
    const body = {
      purchaseCurrency: 'USDC',
      destinationNetwork: p.network,
      destinationAddress: p.address,
      ...(p.paymentAmount ? { paymentAmount: roundTo(p.paymentAmount, 2) } : {}),
      ...(p.purchaseAmount ? { purchaseAmount: p.purchaseAmount } : {}),
      paymentCurrency: p.paymentCurrency,
      ...(p.paymentMethod ? { paymentMethod: p.paymentMethod } : {}),
      ...(p.country ? { country: p.country } : {}),
      ...(p.subdivision ? { subdivision: p.subdivision } : {}),
      redirectUrl: ctx.urls.returnUrl,
      partnerUserRef: p.ref,
    }
    return cdp<CbSessionResponse>(ctx, cdpApi, 'POST', '/platform/v2/onramp/sessions', '', body)
  }

  function deliverAddress(ctx: AdapterContext, deliverTo?: { address: string }): string {
    const a = deliverTo?.address ?? (ctx.destination.type === 'crypto' ? ctx.destination.address : undefined)
    if (!a) throw new OrkException(orkError('BAD_REQUEST', { message: 'Coinbase needs a wallet address to deliver to.' }))
    return a
  }

  function eventFrom(tx: CbTransaction, refOverride?: string): LegEvent | undefined {
    const ref = refOverride ?? tx.partnerUserRef ?? tx.partner_user_ref
    if (!ref) return undefined
    const status = tx.status ?? ''
    const hash = tx.txHash ?? tx.tx_hash
    const txHash = hash && hash !== '0x' ? hash : undefined
    const chain = chainForNetwork(tx.purchaseNetwork ?? tx.purchase_network ?? tx.destinationNetwork)
    const amount = amountValue(tx.purchaseAmount ?? tx.purchase_amount)
    const output = chain && amount ? { amount, asset: target({ kind: 'crypto', chain, token: '' }).asset } : undefined
    if (status === 'ONRAMP_TRANSACTION_STATUS_SUCCESS' || status === 'ONRAMP_ORDER_STATUS_COMPLETED' || tx.eventType === 'onramp.transaction.success') {
      return { ref, status: 'succeeded', ...(txHash ? { txHash } : {}), ...(output ? { output } : {}) }
    }
    if (status.endsWith('_FAILED') || tx.eventType === 'onramp.transaction.failed') {
      return { ref, status: 'failed', error: orkError('PAYMENT_FAILED', { message: 'The Coinbase purchase did not complete.', recovery: 'retry_payment' }) }
    }
    return { ref, status: 'processing' }
  }

  return createAdapter({
    id: 'coinbase',
    name: 'Coinbase',
    legs,

    async catalog(input, ctx) {
      // Countries and payment methods from the Buy Config API, cached for a day.
      // TO VERIFY: response shape ({ data: { countries } } in the guide, { countries } in the API spec).
      type Config = { countries?: Array<{ id: string; payment_methods?: Array<{ id: string }> }> }
      let cfg = await ctx.shared.get<Config>('config')
      if (!cfg) {
        const res = await cdp<Config & { data?: Config }>(ctx, onrampApi, 'GET', '/onramp/v1/buy/config')
        cfg = res.data ?? res
        await ctx.shared.put('config', cfg, 24 * 60 * 60)
      }
      const countries = cfg.countries ?? []
      const allowFor = (l: LegSpec) => {
        const pm = PAYMENT_METHOD[l.id]!
        return countries.filter((c) => (c.payment_methods ?? []).some((m) => m.id?.toUpperCase() === pm)).map((c) => c.id.toUpperCase())
      }
      const refined = legs.map((l) => ({ ...l, regions: { allow: allowFor(l), deny: l.regions.deny } }))
      // No country lists any of our methods: the config format is not what we expect, so keep the static legs.
      if (!refined.some((l) => l.regions.allow.length)) return legs
      // A method no country supports is not offered at all.
      return refined.filter((l) => l.regions.allow.length)
    },

    async quote(input, ctx) {
      const fiat = input.amountIn?.asset ?? input.leg.from.asset
      if (fiat.kind !== 'fiat') throw new OrkException(orkError('BAD_REQUEST', { message: 'Coinbase quotes need a fiat amount.' }))
      const t = target(input.leg.to.asset.kind === 'crypto' ? input.leg.to.asset : undefined)
      const country = (ctx.session.country ?? opts.defaultCountry ?? 'US').toUpperCase()
      const sub = subdivision(ctx, country)
      const ref = partnerUserRef(ctx)
      const paymentMethod = PAYMENT_METHOD[input.leg.legId] ?? 'CARD'
      let res: CbSessionResponse
      try {
        res = await createSession(ctx, {
          network: t.network,
          address: deliverAddress(ctx, input.deliverTo),
          paymentCurrency: fiat.currency.toUpperCase(),
          ...(input.amountIn ? { paymentAmount: input.amountIn.amount } : { purchaseAmount: input.amountOut?.amount ?? '0' }),
          paymentMethod,
          country,
          ...(sub ? { subdivision: sub } : {}),
          ref,
        })
      } catch (e) {
        throw toOrk(e, 'price this amount', ctx.log)
      }
      const q = res.quote
      if (!q) throw new OrkException(orkError('NO_QUOTES', { message: 'Coinbase did not return a quote for this amount.' }), 422)
      const fees: Fee[] = q.fees.map((f) => ({
        kind: f.type === 'FEE_TYPE_NETWORK' ? 'network' : 'provider',
        label: f.type === 'FEE_TYPE_NETWORK' ? 'Network fee' : 'Coinbase fee',
        amount: f.amount,
        currency: f.currency,
      }))
      return {
        adapterId: 'coinbase',
        legId: input.leg.legId,
        input: { amount: q.paymentTotal, asset: { kind: 'fiat', currency: q.paymentCurrency } },
        output: { amount: q.purchaseAmount, asset: t.asset },
        fees,
        eta: legs[0]!.eta,
        data: { ref, onrampUrl: res.session?.onrampUrl, createdAt: Date.now(), network: t.network, paymentMethod, country, ...(sub ? { subdivision: sub } : {}) },
      }
    },

    async start(input, ctx) {
      const data = (input.quote.data ?? {}) as {
        ref?: string
        onrampUrl?: string
        createdAt?: number
        network?: string
        paymentMethod?: string
        country?: string
        subdivision?: string
      }
      let ref = data.ref
      let url = data.onrampUrl
      // The quote's URL is single-use and its session token expires after 5 minutes: make a new one when stale.
      if (!url || !ref || !data.createdAt || Date.now() - data.createdAt > URL_REUSE_MS) {
        ref = partnerUserRef(ctx)
        const t = target(input.quote.output.asset.kind === 'crypto' ? input.quote.output.asset : undefined)
        const fiat = input.quote.input.asset.kind === 'fiat' ? input.quote.input.asset.currency : 'USD'
        try {
          // Keep the quoted method and location, so the new URL opens on the method the user chose.
          const res = await createSession(ctx, {
            network: data.network ?? t.network,
            address: deliverAddress(ctx, input.deliverTo),
            paymentCurrency: fiat,
            paymentAmount: input.quote.input.amount,
            ...(data.paymentMethod ? { paymentMethod: data.paymentMethod } : {}),
            ...(data.country ? { country: data.country } : {}),
            ...(data.subdivision ? { subdivision: data.subdivision } : {}),
            ref,
          })
          url = res.session?.onrampUrl
        } catch (e) {
          throw toOrk(e, 'start the purchase', ctx.log)
        }
        if (!url) throw new OrkException(orkError('PROVIDER_UNAVAILABLE', { message: 'Coinbase did not return a checkout URL.' }), 502)
      }
      return {
        state: 'PAYMENT',
        surface: { kind: 'REDIRECT', url, popup: true, provider: 'Coinbase' },
        transitions: [awaitPoll(POLL)],
        status: 'awaiting_user',
        ref,
      }
    },

    async status(input, ctx) {
      // TO VERIFY: query parameter casing (the API spec says pageSize; the guide says page_size).
      const path = `/onramp/v1/buy/user/${encodeURIComponent(input.ref)}/transactions`
      let res: { transactions?: CbTransaction[] }
      try {
        res = await cdp(ctx, onrampApi, 'GET', path, '?pageSize=1')
      } catch (e) {
        throw toOrk(e, 'find this purchase', ctx.log)
      }
      const tx = res.transactions?.[0]
      return legStepFromEvent(tx ? eventFrom(tx, input.ref) : undefined, input.ref, POLL)
    },

    webhook: {
      async verify(req, rawBody, ctx) {
        if (!opts.webhookSecret) {
          ctx.log.warn('coinbase: webhookSecret is not set; rejecting webhook')
          return false
        }
        const header = req.headers.get('x-hook0-signature')
        if (!header) return false
        const parts = Object.fromEntries(
          header.split(',').map((kv) => {
            const i = kv.indexOf('=')
            return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()]
          }),
        ) as Record<string, string>
        const t = Number(parts.t)
        if (!parts.t || !parts.v0 || !Number.isFinite(t)) return false
        if (Math.abs(Date.now() / 1000 - t) > 5 * 60) return false
        // v0 = hex HMAC-SHA256 over "{t}.{body}"
        const expected = await hmacSha256(opts.webhookSecret, `${parts.t}.${rawBody}`, 'hex')
        return timingSafeEqual(parts.v0.toLowerCase(), expected)
      },
      async parse(rawBody, ctx) {
        let tx: CbTransaction
        try {
          tx = JSON.parse(rawBody) as CbTransaction
        } catch {
          ctx.log.warn('coinbase: webhook body is not JSON')
          return []
        }
        if (tx.eventType && !tx.eventType.startsWith('onramp.')) return []
        const ev = eventFrom(tx)
        return ev ? [ev] : []
      },
    },

    async health() {
      try {
        await key()
        return { ok: true }
      } catch (e) {
        return { ok: false, detail: `Invalid CDP key: ${String((e as Error)?.message ?? e).slice(0, 150)}` }
      }
    },
  })
}
