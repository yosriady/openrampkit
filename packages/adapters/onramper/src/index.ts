// Onramper adapter: aggregated fiat onramp (https://docs.onramper.com).
//
// - Auth: `Authorization: <apiKey>` (no prefix). Production https://api.onramper.com, staging
//   https://api-stg.onramper.com.
// - Catalog: GET /supported/payment-types/{fiat}?type=buy&destination=<crypto id>&country=
// - Quote: GET /quotes/{fiat}/{crypto}?amount=&paymentMethod=&type=buy&country=&walletAddress=&platform=web
//   returns one item per onramp. The best payout is the leg quote; the list is in `quote.data.providers`.
// - Start: POST /checkout/v2/intent, signed with "Signature V2" (Ed25519 over a canonical string, headers
//   x-onramper-signature / -timestamp / -nonce, see sign.ts). Returns `redirectUrl` (REDIRECT). The
//   session is single-use, expires after 10 minutes and is bound to the end user's IP (`endUserIpHash`).
// - Webhooks: `X-Onramper-Webhook-Signature` = hex HMAC-SHA256 of the raw body with the webhook secret.
//   V2 checkout returns no transaction id, so webhooks find the leg through `partnerContext` (= our ref).
// - Status: GET /transactions/{transactionId} (headers Authorization and x-onramper-secret). The
//   transaction id is learnt from the first webhook and kept in the shared store.
//
// Server-side only. Web-standard APIs only (fetch, WebCrypto Ed25519), so it runs on Cloudflare Workers.

import {
  POLL as POLLS,
  awaitPoll,
  cachedJson,
  createAdapter,
  decimalFrom,
  deliverableToAsset,
  fetchJson,
  hmacSha256,
  httpErrorToOpenRamp,
  httpStatus,
  legStepFromEvent,
  providerMessage,
  providerSetupError,
  quoteExpiresAt,
  randomHex,
  requireDeliverAsset,
  resolveEnv,
  timingSafeEqual,
  webhookBodyKey,
} from '@openrampkit/adapter'
import type { AdapterContext, AdapterEnv, LegEvent, Logger } from '@openrampkit/adapter'
import { OpenRampException, USDC, cmp, openRampError, roundTo, sub } from '@openrampkit/core'
import type { Asset, CryptoAsset, Fee, LegSpec, PollSpec } from '@openrampkit/core'
import { canonicalJson, importEd25519Key, sha256Hex, signV2 } from './sign.js'

export { canonicalJson, canonicalStringV2, ed25519Sign, importEd25519Key, sha256Hex, signV2 } from './sign.js'

export type OnramperDeliverAsset = { chain: string; token: string; cryptoId: string; network: string; symbol?: string; decimals?: number }

export type OnramperOptions = {
  /** API key (pk_prod_... / pk_test_...) */
  apiKey: string
  /**
   * Ed25519 private key for "Signature V2" (PKCS#8 PEM as in the Onramper docs, or a base64 32-byte seed).
   * Give Onramper the matching public key at onboarding. Required by POST /checkout/v2/intent.
   */
  secretKey: string
  /** Webhook secret from your Onramper CSM: verifies webhooks and is sent as `x-onramper-secret` for status reads. */
  webhookSecret?: string
  /** Provider environment: 'sandbox' (test keys, no real money) or 'production'. The server checks it against `livemode`. */
  env: AdapterEnv
  /** Only these onramps (e.g. ['moonpay', 'banxa']) */
  onramps?: string[]
  /** Assets Onramper may deliver, most preferred first. Default: USDC on Base, Ethereum, Polygon, Arbitrum. */
  deliverAssets?: OnramperDeliverAsset[]
  /** Country used when the session has none. Default 'US'. */
  defaultCountry?: string
  apiUrl?: string
}

type OrQuote = {
  rate?: number
  networkFee?: number
  transactionFee?: number
  payout?: number
  ramp?: string
  paymentMethod?: string
  quoteId?: string
  recommendations?: string[]
  errors?: Array<{ type?: string; errorId?: number; message?: string; minAmount?: number; maxAmount?: number }>
}

type OrPaymentType = { paymentTypeId: string; name?: string; details?: { limits?: Record<string, { min?: number; max?: number }> } }

type OrTransaction = {
  transactionId?: string
  partnerContext?: string
  status?: string
  outAmount?: number | string
  targetCurrency?: string
  transactionHash?: string | null
  onramp?: string
  statusReason?: string
}

const POLL: PollSpec = POLLS.checkout
const CATALOG_TTL_SEC = 60 * 60
const TX_TTL_SEC = 7 * 24 * 60 * 60

/** Live GET /supported (2026-09-29): ids and networks */
export const DEFAULT_DELIVER_ASSETS: OnramperDeliverAsset[] = [
  { chain: 'eip155:8453', token: USDC['eip155:8453']!, cryptoId: 'usdc_base', network: 'base', symbol: 'USDC', decimals: 6 },
  { chain: 'eip155:1', token: USDC['eip155:1']!, cryptoId: 'usdc_ethereum', network: 'ethereum', symbol: 'USDC', decimals: 6 },
  { chain: 'eip155:137', token: USDC['eip155:137']!, cryptoId: 'usdc_polygon', network: 'polygon', symbol: 'USDC', decimals: 6 },
  { chain: 'eip155:42161', token: USDC['eip155:42161']!, cryptoId: 'usdc_arbitrum', network: 'arbitrum', symbol: 'USDC', decimals: 6 },
]

/**
 * Onramper `paymentTypeId` -> OpenRampKit method id. Unknown ids keep their name.
 * Every id here is in the live list GET https://api.onramper.com/supported/payment-types (read 2026-10-04).
 * Per country (live GET /supported/payment-types/{fiat}?type=buy&country=..., 2026-10-04):
 * NL `ideal`, BE `bancontact`, EUR countries `sepainstant` and `openbanking`, GB `fasterpaybank` and
 * `fasterpayopen`, MX `spei`, CO `bancolombia`, CL `khipu`, IN `upi` and `imps`, CA `interacetransfer`,
 * US `iach`, `venmo` and `paypal`, BR `pix`.
 */
export const ONRAMPER_METHOD_IDS: Record<string, string> = {
  creditcard: 'card',
  debitcard: 'card',
  applepay: 'apple_pay',
  googlepay: 'google_pay',
  sepabanktransfer: 'sepa',
  sepainstant: 'sepa_instant',
  banktransfer: 'bank_transfer',
  ach: 'ach',
  iach: 'ach',
  pix: 'pix',
  upi: 'upi',
  imps: 'imps',
  paypal: 'paypal',
  venmo: 'venmo',
  revolutpay: 'revolut_pay',
  interacetransfer: 'interac',
  fasterpaybank: 'faster_payments',
  openbanking: 'open_banking',
  fasterpayopen: 'open_banking',
  ideal: 'ideal',
  bancontact: 'bancontact',
  sofort: 'sofort',
  spei: 'spei',
  bancolombia: 'bancolombia',
  khipu: 'khipu',
  mpesa: 'mpesa',
  alipay: 'alipay',
}

/** Methods whose Onramper id depends on the fiat currency (UK open banking is `fasterpayopen`) */
const PAYMENT_TYPE_BY_CURRENCY: Record<string, Record<string, string>> = {
  open_banking: { GBP: 'fasterpayopen' },
}

export function onramperMethodId(paymentTypeId: string): string {
  return ONRAMPER_METHOD_IDS[paymentTypeId.toLowerCase()] ?? paymentTypeId.toLowerCase()
}

/**
 * Leg id -> Onramper paymentTypeId: the id for this currency when it has its own, else the first id
 * that maps to the leg, else the leg id itself.
 */
export function onramperPaymentType(legId: string, currency?: string): string {
  const byCurrency = currency ? PAYMENT_TYPE_BY_CURRENCY[legId]?.[currency.toUpperCase()] : undefined
  return byCurrency ?? Object.entries(ONRAMPER_METHOD_IDS).find(([, id]) => id === legId)?.[0] ?? legId
}

const SEPA = ['AT', 'BE', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK', 'NO', 'IS', 'LI', 'CH']
const INSTANT = { min: 60, max: 1800 }
const BANK_INSTANT = { min: 120, max: 3600 }

/** Static legs, used when the live catalog is not available. Countries follow core METHOD_COUNTRIES. */
const STATIC: Array<{ id: string; countries?: string[]; currencies: string[] | '*'; eta: { min: number; max: number } }> = [
  { id: 'card', currencies: '*', eta: INSTANT },
  { id: 'apple_pay', currencies: '*', eta: INSTANT },
  { id: 'google_pay', currencies: '*', eta: INSTANT },
  { id: 'sepa', countries: SEPA, currencies: ['EUR'], eta: { min: 3600, max: 3 * 86400 } },
  { id: 'ach', countries: ['US'], currencies: ['USD'], eta: { min: 3600, max: 5 * 86400 } },
  { id: 'pix', countries: ['BR'], currencies: ['BRL'], eta: BANK_INSTANT },
  { id: 'upi', countries: ['IN'], currencies: ['INR'], eta: BANK_INSTANT },
  { id: 'sepa_instant', countries: SEPA, currencies: ['EUR'], eta: BANK_INSTANT },
  { id: 'faster_payments', countries: ['GB'], currencies: ['GBP'], eta: BANK_INSTANT },
  { id: 'open_banking', countries: ['GB', ...SEPA], currencies: ['GBP', 'EUR'], eta: BANK_INSTANT },
  { id: 'ideal', countries: ['NL'], currencies: ['EUR'], eta: BANK_INSTANT },
  { id: 'bancontact', countries: ['BE'], currencies: ['EUR'], eta: BANK_INSTANT },
  { id: 'interac', countries: ['CA'], currencies: ['CAD'], eta: BANK_INSTANT },
  { id: 'spei', countries: ['MX'], currencies: ['MXN'], eta: BANK_INSTANT },
  { id: 'bancolombia', countries: ['CO'], currencies: ['COP'], eta: BANK_INSTANT },
  { id: 'khipu', countries: ['CL'], currencies: ['CLP'], eta: BANK_INSTANT },
  { id: 'imps', countries: ['IN'], currencies: ['INR'], eta: BANK_INSTANT },
]

const dec = decimalFrom

/** Symbols of stablecoins worth one USD: a USD amount and their payout are in comparable units. */
const USD_STABLES = new Set(['USDC', 'USDT', 'USDG', 'PYUSD'])

/**
 * A 401 or 403 from Onramper means our setup is wrong (API key, Signature V2 public key, IP allowlist),
 * not the user's input. A retry cannot fix it. The operator gets an error log that says what to do; the
 * user gets a neutral message and can choose another method.
 * Codes from https://docs.onramper.com/docs/error-codes-troubleshooting (read 2026-10-09). The live staging
 * answer for an API key without a public key was `{"errorId":4011,"message":"No V2 signing key is registered for this API key..."}`.
 */
export function onramperSetupError(e: unknown, log: Pick<Logger, 'error'>, what: string): OpenRampException | undefined {
  const status = httpStatus(e)
  if (status !== 401 && status !== 403) return undefined
  const body = (e as { body?: { errorId?: unknown; code?: unknown; errorCode?: unknown } } | undefined)?.body
  const detail = providerMessage(e)
  const text = [body?.code, body?.errorCode, detail].filter((x) => typeof x === 'string').join(' ')
  let hint: string
  if (body?.errorId === 4011 || /signing key|public key|PUBLIC_KEY_NOT_CONFIGURED/i.test(text)) {
    hint =
      'Onramper has no Signature V2 public key for this API key. Register the Ed25519 public key that matches secretKey with Onramper (in the Onramper dashboard, or through your Onramper account manager or support). Each environment (staging pk_test_, production pk_prod_) needs its own key pair.'
  } else if (/SIGNATURE|TIMESTAMP|NONCE/i.test(text)) {
    hint = 'Onramper refused the Signature V2. Make sure secretKey matches the public key registered for this API key and environment, and that the server clock is correct.'
  } else if (status === 403) {
    hint = 'Onramper refused the request (403). Make sure the server egress IPs and your domains are on your Onramper allowlist.'
  } else {
    hint = 'Onramper refused the API key (401). Make sure apiKey is correct: pk_test_ with env sandbox, pk_prod_ with env production.'
  }
  log.error(`onramper: cannot ${what}. ${hint}`, { status, ...(typeof body?.errorId === 'number' ? { errorId: body.errorId } : {}), ...(detail ? { message: detail.slice(0, 200) } : {}) })
  return providerSetupError('Onramper')
}

export function onramper(opts: OnramperOptions) {
  const env = resolveEnv('onramper', opts.env, undefined, 'production')
  const api = (opts.apiUrl ?? (env === 'sandbox' ? 'https://api-stg.onramper.com' : 'https://api.onramper.com')).replace(/\/+$/, '')
  const deliver = opts.deliverAssets?.length ? opts.deliverAssets : DEFAULT_DELIVER_ASSETS
  const toChains: Record<string, string[]> = {}
  for (const d of deliver) (toChains[d.chain] ??= []).push(d.chain.startsWith('eip155:') ? d.token.toLowerCase() : d.token)
  let keyPromise: Promise<CryptoKey> | undefined
  const key = () => (keyPromise ??= importEd25519Key(opts.secretKey))

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

  /** The asset Onramper delivers for `asset`. NO_QUOTES when Onramper does not deliver that token on that chain (never another token). */
  function deliverFor(asset: Asset | undefined): OnramperDeliverAsset {
    return requireDeliverAsset(deliver, asset, 'Onramper')
  }

  const assetOf = deliverableToAsset

  const get = <T>(ctx: Pick<AdapterContext, 'fetch'>, pathAndQuery: string, extra: Record<string, string> = {}) =>
    fetchJson<T>(ctx.fetch, `${api}${pathAndQuery}`, { headers: { authorization: opts.apiKey, ...extra } })

  function eventFrom(tx: OrTransaction, refOverride?: string): LegEvent | undefined {
    const ref = refOverride ?? tx.partnerContext
    if (!ref) return undefined
    const d = deliver.find((x) => x.cryptoId === tx.targetCurrency?.toLowerCase())
    const output = d && tx.outAmount !== undefined ? { value: dec(tx.outAmount, d.decimals ?? 8), asset: assetOf(d) } : undefined
    // "Statuses might vary among providers": map the documented ones, ignore the rest.
    switch (tx.status?.toLowerCase()) {
      case 'completed':
        return { ref, status: 'succeeded', ...(tx.transactionHash ? { txHash: tx.transactionHash } : {}), ...(output ? { output } : {}) }
      case 'paid':
      case 'pending':
        return { ref, status: 'processing', ...(output ? { output } : {}) }
      case 'new':
        return { ref, status: 'requires_action' }
      case 'failed':
      case 'canceled':
      case 'cancelled':
        return { ref, status: 'failed', error: openRampError('PAYMENT_FAILED', { message: 'The purchase did not complete.', recovery: 'retry_payment' }) }
      default:
        return undefined
    }
  }

  return createAdapter({
    id: 'onramper',
    env,
    name: 'Onramper',
    legs: staticLegs,

    async catalog(input, ctx) {
      const fiat = input.currency.toLowerCase()
      const country = input.country?.toUpperCase()
      const target = deliver[0]!
      const cacheKey = `pt:${fiat}:${country ?? '*'}`
      const types = await cachedJson(
        ctx.shared,
        cacheKey,
        CATALOG_TTL_SEC,
        async () => {
          const q = new URLSearchParams({ type: 'buy', destination: target.cryptoId })
          if (country) q.set('country', country)
          const res = await get<{ message?: OrPaymentType[] }>(ctx, `/supported/payment-types/${encodeURIComponent(fiat)}?${q}`)
          if (!Array.isArray(res.message) || !res.message.length) {
            throw new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message: 'Onramper returned no payment types.' }), 502)
          }
          return res.message
        },
        { valid: (t) => Array.isArray(t) && t.length > 0 },
      )
      const byId = new Map<string, { min?: number; max?: number }>()
      for (const t of types) {
        const id = onramperMethodId(t.paymentTypeId)
        const agg = t.details?.limits?.aggregatedLimit
        const prev = byId.get(id)
        byId.set(id, {
          ...(agg?.min !== undefined || prev?.min !== undefined ? { min: Math.min(agg?.min ?? Infinity, prev?.min ?? Infinity) } : {}),
          ...(agg?.max !== undefined || prev?.max !== undefined ? { max: Math.max(agg?.max ?? 0, prev?.max ?? 0) } : {}),
        })
      }
      return [...byId.entries()].map(([id, lim]) => {
        const s = STATIC.find((x) => x.id === id)
        return leg(id, {
          from: { asset: { kind: 'fiat', currencies: [input.currency.toUpperCase()] }, location: ['user_account'] },
          regions: { allow: country ? [country] : s?.countries ?? ['*'], deny: [] },
          ...(lim.min !== undefined || lim.max !== undefined
            ? { limits: { ...(lim.min !== undefined ? { min: dec(lim.min, 2) } : {}), ...(lim.max !== undefined ? { max: dec(lim.max, 2) } : {}), currency: input.currency.toUpperCase() } }
            : {}),
          ...(s ? { eta: s.eta } : {}),
        })
      })
    },

    async quote(input, ctx) {
      if (!input.amountIn || input.amountIn.asset.kind !== 'fiat') throw new OpenRampException(openRampError('NO_QUOTES', { message: 'Onramper quotes need a fiat amount.' }), 422)
      const fiat = input.amountIn.asset.currency.toLowerCase()
      const target = deliverFor(input.leg.to.asset.kind === 'crypto' ? input.leg.to.asset : undefined)
      const country = (ctx.session.country ?? opts.defaultCountry ?? 'US').toUpperCase()
      const wallet = input.deliverTo?.address ?? (ctx.destination.type === 'crypto' ? ctx.destination.address : undefined)
      const paymentMethod = onramperPaymentType(input.leg.legId, fiat)
      const q = new URLSearchParams({ amount: roundTo(input.amountIn.value, 2), paymentMethod, type: 'buy', country, platform: 'web' })
      if (wallet) q.set('walletAddress', wallet)
      let res: OrQuote[] | { message?: string }
      try {
        res = await get<OrQuote[] | { message?: string }>(ctx, `/quotes/${encodeURIComponent(fiat)}/${encodeURIComponent(target.cryptoId)}?${q}`)
      } catch (e) {
        throw onramperSetupError(e, ctx.log, 'price this amount') ?? httpErrorToOpenRamp(e, 'Onramper', { what: 'price this amount', log: ctx.log })
      }
      const list = Array.isArray(res) ? res : []
      const ok = list.filter((x) => x.ramp && !x.errors?.length && typeof x.payout === 'number' && x.payout > 0 && (!opts.onramps || opts.onramps.includes(x.ramp)))
      if (!ok.length) {
        const err = list.flatMap((x) => x.errors ?? [])[0]
        const msg = err?.message ?? (Array.isArray(res) ? undefined : res.message)
        throw new OpenRampException(openRampError('NO_QUOTES', { message: msg ? `Onramper: ${msg}`.slice(0, 200) : 'No Onramper provider can serve this amount.' }), 422)
      }
      const providers = ok
        .map((x) => ({
          ramp: x.ramp!,
          payout: dec(x.payout, target.decimals ?? 8),
          rate: dec(x.rate, 8),
          transactionFee: dec(x.transactionFee, 2),
          networkFee: dec(x.networkFee, 2),
          // Some onramps (for example guardarian) send no fee fields: their fees are in the rate.
          feesInRate: x.transactionFee === undefined && x.networkFee === undefined,
          ...(x.quoteId ? { quoteId: x.quoteId } : {}),
          ...(x.recommendations?.length ? { recommendations: x.recommendations } : {}),
        }))
        .sort((a, b) => cmp(b.payout, a.payout))
      const best = providers[0]!
      const cur = fiat.toUpperCase()
      const fees: Fee[] = []
      if (best.transactionFee !== '0') fees.push({ kind: 'provider', label: `${best.ramp} fee`, amount: best.transactionFee, currency: cur })
      if (best.networkFee !== '0') fees.push({ kind: 'network', label: 'Network fee', amount: best.networkFee, currency: cur })
      const inputAmount = roundTo(input.amountIn.value, 2)
      if (best.feesInRate) {
        // No fee fields and no reference rate in the response. For USD to a USD stablecoin, the cost is the
        // difference between what the user pays and what arrives. Otherwise the amount is not known: a line
        // with amount '0' and `inRate` keeps the UI from saying "No fees".
        const comparable = cur === 'USD' && USD_STABLES.has((target.symbol ?? '').toUpperCase())
        const diff = comparable ? roundTo(sub(inputAmount, best.payout), 2) : '0'
        if (!comparable || cmp(diff, '0') > 0) fees.push({ kind: 'provider', label: `${best.ramp} fee (included in rate)`, amount: diff, currency: cur, inRate: true })
      }
      return {
        adapterId: 'onramper',
        legId: input.leg.legId,
        input: { value: inputAmount, asset: { kind: 'fiat', currency: cur } },
        output: { value: best.payout, asset: assetOf(target) },
        fees,
        eta: STATIC.find((s) => s.id === input.leg.legId)?.eta ?? { min: 60, max: 1800 },
        expiresAt: quoteExpiresAt(5),
        data: { onramp: best.ramp, providers, paymentMethod, cryptoId: target.cryptoId, network: target.network, fiat, country },
      }
    },

    async start(input, ctx) {
      const data = (input.quote.data ?? {}) as { onramp?: string; paymentMethod?: string; cryptoId?: string; network?: string; fiat?: string; country?: string }
      if (!data.onramp) throw new OpenRampException(openRampError('QUOTE_EXPIRED', { recovery: 'requote' }), 409)
      const target = deliverFor(input.quote.output.asset.kind === 'crypto' ? input.quote.output.asset : undefined)
      const wallet = input.deliverTo?.address ?? (ctx.destination.type === 'crypto' ? ctx.destination.address : undefined)
      if (!wallet) throw new OpenRampException(openRampError('BAD_REQUEST', { message: 'Onramper needs a wallet address to deliver to.' }))
      // The checkout session is bound to the IP of the user who opens it.
      if (!ctx.session.ip) throw new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message: 'Onramper needs the user IP address to start a checkout.' }), 502)
      const ref = `ork_${randomHex(12)}`
      const payload = {
        onramp: data.onramp,
        source: data.fiat ?? (input.quote.input.asset.kind === 'fiat' ? input.quote.input.asset.currency.toLowerCase() : 'usd'),
        destination: data.cryptoId ?? target.cryptoId,
        amount: Number(roundTo(input.quote.input.value, 2)),
        type: 'buy',
        paymentMethod: data.paymentMethod ?? onramperPaymentType(input.leg.legId, input.quote.input.asset.kind === 'fiat' ? input.quote.input.asset.currency : undefined),
        network: data.network ?? target.network,
        wallet: { address: wallet },
        endUserIpHash: await sha256Hex(ctx.session.ip),
        platform: 'web',
        partnerContext: ref,
        externalCustomerId: ctx.session.userId,
        ...(data.country ? { country: data.country } : {}),
        ...(ctx.session.email ? { email: ctx.session.email } : {}),
        supportedParams: { partnerData: { redirectUrl: { success: ctx.urls.returnUrl } } },
      }
      const body = canonicalJson(payload)
      const path = '/checkout/v2/intent'
      let res: { redirectUrl?: string; sessionId?: string }
      try {
        const headers = await signV2(await key(), { apiKey: opts.apiKey, method: 'POST', path, body, timestamp: new Date().toISOString(), nonce: crypto.randomUUID() })
        res = await fetchJson(ctx.fetch, `${api}${path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body })
      } catch (e) {
        throw onramperSetupError(e, ctx.log, 'start the purchase') ?? httpErrorToOpenRamp(e, 'Onramper', { what: 'start the purchase', log: ctx.log })
      }
      if (!res.redirectUrl) throw new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message: 'Onramper did not return a checkout URL.' }), 502)
      if (res.sessionId) await ctx.store.put(`s:${ref}`, { sessionId: res.sessionId }, TX_TTL_SEC)
      return {
        state: 'PAYMENT',
        surface: { kind: 'REDIRECT', url: res.redirectUrl, popup: true, provider: data.onramp },
        transitions: [awaitPoll(POLL)],
        status: 'requires_action',
        ref,
      }
    },

    async status(input, ctx) {
      const txId = await ctx.shared.get<string>(`tx:${input.ref}`)
      // No webhook yet: we do not know the transaction id, so the user is still paying.
      if (!txId || !opts.webhookSecret) return legStepFromEvent(undefined, input.ref, POLL)
      let tx: OrTransaction
      try {
        tx = await get<OrTransaction>(ctx, `/transactions/${encodeURIComponent(txId)}`, { 'x-onramper-secret': opts.webhookSecret })
      } catch (e) {
        throw httpErrorToOpenRamp(e, 'Onramper', { what: 'find this purchase', noQuoteStatuses: [], log: ctx.log })
      }
      return legStepFromEvent(eventFrom(tx, input.ref), input.ref, POLL)
    },

    webhook: {
      // Without the webhookSecret, no webhook can verify (see `resultChannels`).
      configured: !!opts.webhookSecret,
      async verify(req, rawBody, ctx) {
        if (!opts.webhookSecret) {
          ctx.log.warn('onramper: webhookSecret is not set; rejecting webhook')
          return false
        }
        const sig = req.headers.get('x-onramper-webhook-signature')
        if (!sig) return false
        // Onramper signs the body only (no timestamp). `replayKey` lets the server drop a replayed body.
        const expected = await hmacSha256(opts.webhookSecret, rawBody, 'hex')
        return timingSafeEqual(sig.trim().toLowerCase(), expected)
      },
      // The same signed body is the same event: the server keeps the hash for 7 days and drops a repeat.
      replayKey: async (_req, rawBody) => webhookBodyKey(rawBody),
      async parse(rawBody, ctx) {
        let tx: OrTransaction
        try {
          tx = JSON.parse(rawBody) as OrTransaction
        } catch {
          ctx.log.warn('onramper: webhook body is not JSON')
          return []
        }
        if (!tx.partnerContext) return []
        // Keep the transaction id so status() can poll it.
        if (tx.transactionId) await ctx.shared.put(`tx:${tx.partnerContext}`, tx.transactionId, TX_TTL_SEC)
        const ev = eventFrom(tx)
        return ev ? [{ ...ev, eventId: (await webhookBodyKey(rawBody)).slice(0, 32) }] : []
      },
    },

    async health(ctx) {
      try {
        await get(ctx, '/supported?type=buy')
        await key()
        return { ok: true }
      } catch (e) {
        return { ok: false, detail: String((e as Error)?.message ?? e).slice(0, 200) }
      }
    },
  })
}
