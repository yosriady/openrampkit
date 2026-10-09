// Transak adapter: fiat onramp through the Transak widget (https://docs.transak.com).
//
// - Partner access token: POST {api}/partners/api/v2/refresh-token (headers api-secret, x-api-key;
//   body { apiKey }). Valid 7 days. Calling it again invalidates the previous token, so we cache it.
// - Widget URL: POST {gateway}/api/v2/auth/session with header access-token and { widgetParams }.
//   Query parameters in the widget URL itself are no longer supported. The URL is single-use and
//   valid 5 minutes, so it is created in start().
// - Quotes: GET {api}/api/v1/pricing/public/quotes.
// - Methods and limits per fiat currency: GET {api}/fiat/public/v1/currencies/fiat-currencies.
// - Webhooks: the body is { data: <JWT> }, HS256-signed with the partner access token.
//   Our leg ref is sent as `partnerOrderId` and comes back in `webhookData.partnerOrderId`.
//
// Surface: IFRAME by default. Transak checks the browser Referer header against `referrerDomain`,
// and OpenRampKit's popup-safe /start redirect sends `referrer-policy: no-referrer`, so REDIRECT
// needs a server change first (see the adapter report).
//
// Server-side only. Web-standard APIs only (fetch, WebCrypto), so it runs on Cloudflare Workers.

import { POLL as POLLS, awaitPoll, cachedJson, createAdapter, decimalFrom, deliverableToAsset, fetchJson, httpErrorToOpenRamp, quoteExpiresAt, randomHex, requireDeliverAsset, resolveEnv, timingSafeEqual } from '@openrampkit/adapter'
import type { AdapterContext, AdapterEnv, LegEvent } from '@openrampkit/adapter'
import { OpenRampException, USDC, openRampError } from '@openrampkit/core'
import type { Asset, CryptoAsset, Fee, LegSpec, PollSpec } from '@openrampkit/core'

export type TransakOptions = {
  apiKey: string
  apiSecret: string
  /** Default 'production'. 'sandbox' uses the Transak staging hosts. 'staging' is a deprecated alias of 'sandbox'. */
  env?: AdapterEnv | 'staging'
  /** Your web domain (or mobile package name), registered with Transak. Required by the widget session API. */
  referrerDomain: string
  /** Default 'IFRAME' */
  surface?: 'IFRAME' | 'REDIRECT'
  /** Country used for quotes when the session has none */
  defaultCountry?: string
}

type Urls = { api: string; gateway: string; widget: string }
const URLS: Record<'staging' | 'production', Urls> = {
  staging: { api: 'https://api-stg.transak.com', gateway: 'https://api-gateway-stg.transak.com', widget: 'https://global-stg.transak.com' },
  production: { api: 'https://api.transak.com', gateway: 'https://api-gateway.transak.com', widget: 'https://global.transak.com' },
}

const POLL: PollSpec = POLLS.checkout
const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
const SOLANA_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

/** CAIP-2 chain -> Transak network name. TO VERIFY with GET /cryptocoins (arbitrum/optimism names). */
export const TRANSAK_NETWORKS: Record<string, string> = {
  'eip155:8453': 'base',
  'eip155:1': 'ethereum',
  'eip155:42161': 'arbitrum',
  'eip155:10': 'optimism',
  'eip155:137': 'polygon',
  [SOLANA]: 'solana',
}
const USDC_TOKENS: Record<string, string> = { ...USDC, [SOLANA]: SOLANA_USDC }

/**
 * Transak payment method id -> OpenRampKit method id.
 * - `gbp_bank_transfer` is UK Faster Payments and `pm_open_banking` is open banking ("Easy Bank Transfer",
 *   GBP and EUR). Both are in the live list GET https://api.transak.com/api/v2/currencies/fiat-currencies.
 * - `pm_pse` (Colombia, COP) and `pm_astropay` (ARS, BRL, CLP, MXN, PEN, UYU) are in the example response of
 *   https://docs.transak.com/api/public/get-fiat-currencies. TO VERIFY: they are not in the live list
 *   without a partner key, so they may depend on the partner account.
 * - Open banking countries: https://transak.notion.site/On-Ramp-Payment-Methods-Fees-Other-Details-b0761634feed4b338a69f4f186d906a5
 */
export const TRANSAK_METHOD_IDS: Record<string, string> = {
  credit_debit_card: 'card',
  apple_pay: 'apple_pay',
  google_pay: 'google_pay',
  sepa_bank_transfer: 'sepa',
  gbp_bank_transfer: 'faster_payments',
  pm_open_banking: 'open_banking',
  pm_pse: 'pse',
  pm_astropay: 'astropay',
  pm_wire: 'bank_transfer',
  inr_upi: 'upi',
  pm_upi: 'upi',
  pm_pix: 'pix',
  pm_gcash: 'gcash',
  pm_paymaya: 'maya',
  pm_grabpay: 'grabpay',
  pm_shopeepay: 'shopeepay',
}

/** Static leg id -> Transak payment method id (bank transfer depends on the currency) */
const LEG_PAYMENT_METHOD: Record<string, string> = {
  card: 'credit_debit_card',
  apple_pay: 'apple_pay',
  google_pay: 'google_pay',
  // TO VERIFY: UPI method id (not in the public fiat list; partner-specific)
  upi: 'inr_upi',
  faster_payments: 'gbp_bank_transfer',
  open_banking: 'pm_open_banking',
  pse: 'pm_pse',
}

/** Transak open banking countries (Transak fee table, see TRANSAK_METHOD_IDS) */
const OPEN_BANKING_COUNTRIES = ['GB', 'IE', 'FR', 'DE', 'IT', 'ES', 'NL', 'EE', 'LV', 'LT', 'PT', 'BE', 'PL', 'DK']

function bankTransferId(currency: string): string {
  if (currency === 'EUR') return 'sepa_bank_transfer'
  if (currency === 'GBP') return 'gbp_bank_transfer'
  if (currency === 'USD') return 'pm_wire'
  return 'sepa_bank_transfer' // TO VERIFY: other currencies
}

type FiatCurrency = {
  symbol: string
  isAllowed?: boolean
  supportingCountries?: string[]
  paymentOptions?: Array<{ id: string; name?: string; isActive?: boolean; minAmount?: number; maxAmount?: number }>
}

type PriceResponse = {
  response?: {
    quoteId: string
    fiatCurrency: string
    fiatAmount: number
    cryptoAmount: number
    totalFee?: number
    feeBreakdown?: Array<{ name: string; value: number; id: string }>
    network?: string
    paymentMethod?: string
  }
}

type WebhookOrder = {
  id?: string
  partnerOrderId?: string
  status?: string
  cryptoAmount?: number | string
  cryptocurrency?: string
  network?: string
  transactionHash?: string
}

const dec = decimalFrom

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function bytesToB64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Verify an HS256 JWT with `secret`; returns the claims, or undefined when the signature does not match. */
export async function verifyHs256(token: string, secret: string): Promise<Record<string, unknown> | undefined> {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  const [h, p, s] = parts as [string, string, string]
  let header: { alg?: string }
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)))
  } catch {
    return undefined
  }
  if (header.alg !== 'HS256') return undefined
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${h}.${p}`)))
  if (!timingSafeEqual(bytesToB64url(sig), s)) return undefined
  const claims = decodeClaims(token)
  if (!claims) return undefined
  if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now() - 60_000) return undefined
  return claims
}

/** Decode JWT claims without verifying (only after verifyHs256 passed). */
function decodeClaims(token: string): Record<string, unknown> | undefined {
  try {
    const claims: unknown = JSON.parse(new TextDecoder().decode(b64urlToBytes(token.split('.')[1] ?? '')))
    return claims && typeof claims === 'object' ? (claims as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

type TokenRecord = { token: string; expiresAt: number }

export function transak(opts: TransakOptions) {
  const env = resolveEnv('transak', opts.env === 'staging' ? undefined : opts.env, { value: opts.env === 'staging' ? 'sandbox' : undefined, option: "env: 'staging'" }, 'production')
  const urls = URLS[env === 'sandbox' ? 'staging' : 'production']
  const surfaceKind = opts.surface ?? 'IFRAME'
  /** In-memory copy for webhook verification (webhook handlers get no KV today) */
  let memToken: TokenRecord | undefined
  let refreshing: Promise<TokenRecord> | undefined

  async function accessToken(ctx: Pick<AdapterContext, 'fetch' | 'shared'>): Promise<string> {
    const now = Date.now() / 1000
    const fresh = (t?: TokenRecord) => !!t && t.expiresAt - now > 3600
    if (fresh(memToken)) return memToken!.token
    const stored = await ctx.shared.get<TokenRecord>('accessToken')
    if (fresh(stored)) {
      memToken = stored
      return stored!.token
    }
    // One refresh at a time per instance: a new token invalidates the previous one.
    refreshing ??= (async () => {
      const res = await fetchJson<{ data?: { accessToken?: string; expiresAt?: number } }>(ctx.fetch, `${urls.api}/partners/api/v2/refresh-token`, {
        method: 'POST',
        headers: { 'api-secret': opts.apiSecret, 'x-api-key': opts.apiKey },
        body: JSON.stringify({ apiKey: opts.apiKey }),
      })
      const token = res.data?.accessToken
      if (!token) throw new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message: 'Transak did not return an access token.' }), 502)
      const rec = { token, expiresAt: res.data?.expiresAt ?? Math.floor(Date.now() / 1000) + 6 * 24 * 3600 }
      await ctx.shared.put('accessToken', rec, Math.max(60, Math.floor(rec.expiresAt - Date.now() / 1000)))
      memToken = rec
      return rec
    })().finally(() => {
      refreshing = undefined
    })
    return (await refreshing).token
  }

  const toChains: Record<string, string[]> = Object.fromEntries(Object.keys(TRANSAK_NETWORKS).map((c) => [c, [USDC_TOKENS[c]!.toLowerCase()]]))

  const leg = (id: string, method: string, extra: Partial<LegSpec> = {}): LegSpec => ({
    id,
    kind: 'fiat_onramp',
    methods: [method],
    from: { asset: { kind: 'fiat', currencies: '*' }, location: ['user_account'] },
    to: { asset: { kind: 'crypto', chains: toChains }, location: ['address'] },
    regions: { allow: ['*'], deny: [] },
    eta: { min: 120, max: 1800 },
    surfaces: [surfaceKind],
    requires: ['provider_account', 'provider_kyc'],
    ...extra,
  })

  const legs: LegSpec[] = [
    leg('card', 'card'),
    leg('apple_pay', 'apple_pay'),
    leg('google_pay', 'google_pay'),
    // GBP bank transfers are the `faster_payments` leg
    leg('bank_transfer', 'bank_transfer', { from: { asset: { kind: 'fiat', currencies: ['EUR', 'USD'] }, location: ['user_account'] }, eta: { min: 600, max: 3 * 24 * 3600 } }),
    leg('upi', 'upi', { from: { asset: { kind: 'fiat', currencies: ['INR'] }, location: ['user_account'] }, regions: { allow: ['IN'], deny: [] } }),
    leg('faster_payments', 'faster_payments', { from: { asset: { kind: 'fiat', currencies: ['GBP'] }, location: ['user_account'] }, regions: { allow: ['GB'], deny: [] }, eta: { min: 300, max: 86400 } }),
    leg('open_banking', 'open_banking', { from: { asset: { kind: 'fiat', currencies: ['GBP', 'EUR'] }, location: ['user_account'] }, regions: { allow: OPEN_BANKING_COUNTRIES, deny: [] }, eta: { min: 120, max: 3600 } }),
    leg('pse', 'pse', { from: { asset: { kind: 'fiat', currencies: ['COP'] }, location: ['user_account'] }, regions: { allow: ['CO'], deny: [] }, eta: { min: 120, max: 3600 } }),
  ]

  function paymentMethodFor(legId: string, currency: string): string {
    if (legId === 'bank_transfer') return bankTransferId(currency)
    return LEG_PAYMENT_METHOD[legId] ?? legId
  }

  /** The tokens Transak delivers here: USDC on each supported network */
  const deliverable = Object.keys(TRANSAK_NETWORKS).map((chain) => ({ chain, token: USDC_TOKENS[chain]!, symbol: 'USDC', decimals: 6 }))

  /** What Transak delivers for `asset`: USDC on a supported chain. NO_QUOTES for another token or chain (never USDC on Base instead). */
  function target(asset: Asset | undefined): { network: string; asset: CryptoAsset } {
    const d = requireDeliverAsset(deliverable, asset, 'Transak')
    return { network: TRANSAK_NETWORKS[d.chain]!, asset: deliverableToAsset(d) }
  }

  function eventFrom(claims: Record<string, unknown>): LegEvent | undefined {
    const o = (claims.webhookData ?? claims) as WebhookOrder
    const ref = o.partnerOrderId
    if (!ref) return undefined
    const chain = Object.entries(TRANSAK_NETWORKS).find(([, n]) => n === o.network)?.[0]
    const output = chain && o.cryptoAmount !== undefined ? { value: dec(o.cryptoAmount, 6), asset: deliverableToAsset(deliverable.find((d) => d.chain === chain)!) } : undefined
    switch (o.status) {
      case 'COMPLETED':
        return { ref, status: 'succeeded', ...(o.transactionHash ? { txHash: o.transactionHash } : {}), ...(output ? { output } : {}) }
      case 'FAILED':
      case 'CANCELLED':
        return { ref, status: 'failed', error: openRampError('PAYMENT_FAILED', { message: 'The Transak order did not complete.', recovery: 'retry_payment' }) }
      case 'EXPIRED':
        return { ref, status: 'expired' }
      case 'REFUNDED':
        return { ref, status: 'refunded' }
      case 'PAYMENT_DONE_MARKED_BY_USER':
      case 'PROCESSING':
      case 'PENDING_DELIVERY_FROM_TRANSAK':
      case 'ON_HOLD_PENDING_DELIVERY_FROM_TRANSAK':
        return { ref, status: 'processing' }
      default:
        // AWAITING_PAYMENT_FROM_USER: the user is still in the widget. No state change.
        return undefined
    }
  }

  return createAdapter({
    id: 'transak',
    env,
    name: 'Transak',
    legs,

    async catalog(input, ctx) {
      const list = await cachedJson(ctx.shared, 'fiat', 60 * 60, async () => {
        const res = await fetchJson<{ response?: FiatCurrency[] }>(ctx.fetch, `${urls.api}/fiat/public/v1/currencies/fiat-currencies`)
        // A missing list is a failure, not "no methods": throw (the server then uses the static legs) and do not cache it.
        if (!Array.isArray(res?.response)) throw new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message: 'Transak returned no fiat currency list.' }), 502)
        return res.response
      })
      const cur = list.find((c) => c.symbol.toUpperCase() === input.currency.toUpperCase() && c.isAllowed !== false)
      if (!cur) return []
      const out: LegSpec[] = []
      const seen = new Set<string>()
      for (const pm of cur.paymentOptions ?? []) {
        if (pm.isActive === false) continue
        const method = TRANSAK_METHOD_IDS[pm.id] ?? pm.id.replace(/^pm_/, '')
        // Keep the static leg ids for the common methods, so start() maps them back.
        const staticId = Object.entries(LEG_PAYMENT_METHOD).find(([, v]) => v === pm.id)?.[0]
        const id = staticId ?? (['sepa_bank_transfer', 'gbp_bank_transfer', 'pm_wire'].includes(pm.id) ? 'bank_transfer' : pm.id)
        if (seen.has(id)) continue
        seen.add(id)
        out.push(
          leg(id, method, {
            from: { asset: { kind: 'fiat', currencies: [cur.symbol.toUpperCase()] }, location: ['user_account'] },
            regions: { allow: cur.supportingCountries?.length ? cur.supportingCountries : ['*'], deny: [] },
            limits: { ...(pm.minAmount !== undefined ? { min: dec(pm.minAmount, 2) } : {}), ...(pm.maxAmount !== undefined ? { max: dec(pm.maxAmount, 2) } : {}), currency: cur.symbol.toUpperCase() },
          }),
        )
      }
      return out
    },

    async quote(input, ctx) {
      const fiat = input.amountIn?.asset ?? input.leg.from.asset
      if (fiat.kind !== 'fiat') throw new OpenRampException(openRampError('BAD_REQUEST', { message: 'Transak quotes need a fiat amount.' }))
      const currency = fiat.currency.toUpperCase()
      const t = target(input.leg.to.asset.kind === 'crypto' ? input.leg.to.asset : undefined)
      const paymentMethod = paymentMethodFor(input.leg.legId, currency)
      const q = new URLSearchParams({
        partnerApiKey: opts.apiKey,
        fiatCurrency: currency,
        cryptoCurrency: 'USDC',
        network: t.network,
        isBuyOrSell: 'BUY',
        paymentMethod,
      })
      if (input.amountIn) q.set('fiatAmount', input.amountIn.value)
      else if (input.amountOut) q.set('cryptoAmount', input.amountOut.value)
      const country = ctx.session.country ?? opts.defaultCountry
      if (country) q.set('quoteCountryCode', country.toUpperCase())
      let res: PriceResponse
      try {
        res = await fetchJson<PriceResponse>(ctx.fetch, `${urls.api}/api/v1/pricing/public/quotes?${q}`, { headers: { 'x-api-key': opts.apiKey } })
      } catch (e) {
        throw httpErrorToOpenRamp(e, 'Transak', { what: 'price this amount', log: ctx.log })
      }
      const r = res.response
      if (!r) throw new OpenRampException(openRampError('NO_QUOTES', { message: 'Transak did not return a quote.' }), 422)
      const fees: Fee[] = (r.feeBreakdown ?? [])
        .filter((f) => f.value)
        .map((f) => ({
          kind: f.id.includes('network') ? 'network' : f.id.includes('partner') ? 'app' : 'provider',
          label: f.name,
          amount: dec(f.value, 2),
          currency,
        }))
      return {
        adapterId: 'transak',
        legId: input.leg.legId,
        input: { value: dec(r.fiatAmount, 2), asset: { kind: 'fiat', currency } },
        output: { value: dec(r.cryptoAmount, 6), asset: t.asset },
        fees,
        eta: legs.find((l) => l.id === input.leg.legId)?.eta ?? { min: 120, max: 1800 },
        expiresAt: quoteExpiresAt(10),
        data: { quoteId: r.quoteId, paymentMethod, network: t.network },
      }
    },

    async start(input, ctx) {
      const data = (input.quote.data ?? {}) as { paymentMethod?: string; network?: string }
      const walletAddress = input.deliverTo?.address ?? (ctx.destination.type === 'crypto' ? ctx.destination.address : undefined)
      if (!walletAddress) throw new OpenRampException(openRampError('BAD_REQUEST', { message: 'Transak needs a wallet address to deliver to.' }))
      const currency = input.quote.input.asset.kind === 'fiat' ? input.quote.input.asset.currency : 'USD'
      const t = target(input.quote.output.asset.kind === 'crypto' ? input.quote.output.asset : undefined)
      const ref = `ork_${randomHex(10)}`
      const widgetParams: Record<string, unknown> = {
        apiKey: opts.apiKey,
        referrerDomain: opts.referrerDomain,
        productsAvailed: 'BUY',
        cryptoCurrencyCode: 'USDC',
        network: data.network ?? t.network,
        walletAddress,
        disableWalletAddressForm: true,
        fiatCurrency: currency,
        fiatAmount: Number(input.quote.input.value),
        paymentMethod: data.paymentMethod ?? paymentMethodFor(input.leg.legId, currency),
        hideExchangeScreen: true,
        partnerOrderId: ref,
        partnerCustomerId: ctx.session.userId,
        redirectURL: ctx.urls.returnUrl,
        ...(ctx.session.email ? { email: ctx.session.email } : {}),
        ...(ctx.session.country ? { countryCode: ctx.session.country } : {}),
      }
      let widgetUrl: string | undefined
      try {
        const res = await fetchJson<{ data?: { widgetUrl?: string } }>(ctx.fetch, `${urls.gateway}/api/v2/auth/session`, {
          method: 'POST',
          headers: { 'access-token': await accessToken(ctx), 'x-api-key': opts.apiKey, ...(ctx.session.ip ? { 'x-user-ip': ctx.session.ip } : {}) },
          body: JSON.stringify({ widgetParams }),
        })
        widgetUrl = res.data?.widgetUrl
      } catch (e) {
        ctx.log.warn('transak: create widget URL failed', { error: String((e as Error)?.message ?? e).slice(0, 300) })
        throw new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message: 'Transak could not start the checkout.' }), 502)
      }
      let origin: string
      try {
        origin = new URL(widgetUrl ?? '').origin
      } catch {
        throw new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message: 'Transak did not return a widget URL.' }), 502)
      }
      return {
        state: 'PAYMENT',
        surface:
          surfaceKind === 'IFRAME'
            ? { kind: 'IFRAME', url: widgetUrl!, origin, allow: 'camera; microphone; payment; clipboard-write', height: 625, provider: 'Transak' }
            : // Transak checks the Referer against the partner domain, so keep it on the start redirect.
              { kind: 'REDIRECT', url: widgetUrl!, popup: true, provider: 'Transak', keepReferrer: true },
        transitions: [awaitPoll(POLL)],
        status: 'requires_action',
        ref,
      }
    },

    webhook: {
      async verify(req, rawBody, ctx) {
        let body: { data?: unknown }
        try {
          body = JSON.parse(rawBody)
        } catch {
          return false
        }
        if (typeof body.data !== 'string') return false
        // Transak signs webhooks with the current access token. It is cached in `shared` (the session
        // store), so every server instance can verify. We never fetch a new token here: a new token
        // would cancel the one Transak used to sign.
        const shared = ctx.shared
        const candidates = new Set<string>()
        if (memToken) candidates.add(memToken.token)
        const stored = shared ? await shared.get<TokenRecord>('accessToken') : undefined
        if (stored) candidates.add(stored.token)
        if (!candidates.size) {
          ctx.log.warn('transak: no access token in memory to verify the webhook; see the adapter notes')
          return false
        }
        for (const token of candidates) if (await verifyHs256(body.data, token)) return true
        return false
      },
      async parse(rawBody, ctx) {
        let body: { data?: unknown }
        try {
          body = JSON.parse(rawBody)
        } catch {
          ctx.log.warn('transak: webhook body is not JSON')
          return []
        }
        const claims = typeof body?.data === 'string' ? decodeClaims(body.data) : undefined
        const ev = claims ? eventFrom(claims) : undefined
        return ev ? [ev] : []
      },
    },

    async health(ctx) {
      try {
        const res = await fetchJson<{ response?: unknown[] }>(ctx.fetch, `${urls.api}/fiat/public/v1/currencies/fiat-currencies`)
        return { ok: Array.isArray(res.response) }
      } catch (e) {
        return { ok: false, detail: String((e as Error)?.message ?? e).slice(0, 200) }
      }
    },
  })
}
