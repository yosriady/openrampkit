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
// Coinbase ended guest checkout (card / Apple Pay without a Coinbase account) in the hosted widget on
// 2026-06-30. The hosted flow now needs a Coinbase account. Guest Apple Pay is the Headless Onramp API
// (https://docs.cdp.coinbase.com/onramp/headless-onramp/overview), enabled with `guestCheckout`:
// - Quote: POST https://api.cdp.coinbase.com/platform/v2/onramp/orders with `isQuote: true`.
// - Start: the same call with `isQuote: false` returns `paymentLink.url`, shown in an IFRAME.
// - Status: GET https://api.cdp.coinbase.com/platform/v2/onramp/orders/{orderId}.
// US users only, Apple Pay only on the web (Google Pay is for Android WebViews).
//
// Server-side only. Web-standard APIs only (fetch, WebCrypto), so it runs on Cloudflare Workers.

import { POLL as POLLS, awaitPoll, cachedJson, createAdapter, deliverableToAsset, fetchJson, httpErrorToOpenRamp, legStepFromEvent, quoteExpiresAt, randomHex, requireDeliverAsset, resolveEnv, verifyTimestampedHmac } from '@openrampkit/adapter'
import type { AdapterContext, AdapterEnv, LegEvent, Logger, QuoteInput, StartInput } from '@openrampkit/adapter'
import { OpenRampException, USDC, isDecimal, openRampError, roundTo } from '@openrampkit/core'
import type { Asset, CryptoAsset, Fee, LegQuote, LegSpec, LegStep, PollSpec } from '@openrampkit/core'
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
   * Used only when the session has no region (ISO 3166-2, from `CreateSessionInput.region` or geo headers).
   */
  defaultSubdivision?: string
  /**
   * 'sandbox': sandbox transactions (partnerUserRef prefixed with "sandbox-"). 'production': real ones.
   * Default: each session's `livemode` decides.
   */
  env?: AdapterEnv
  /** @deprecated Use `env`. `true` is `env: 'sandbox'`, `false` is `env: 'production'`. */
  sandbox?: boolean
  /**
   * Coinbase `paymentMethod` of the `coinbase_account` leg: the user's fiat balance (`FIAT_WALLET`, default)
   * or crypto balance (`CRYPTO_WALLET`). In the hosted flow the user can still pick another balance.
   */
  accountBalance?: 'FIAT_WALLET' | 'CRYPTO_WALLET'
  /**
   * Guest Apple Pay with the Headless Onramp API (no Coinbase account, US only). Off when not set.
   * Your CDP app must be approved for Onramp, and `domain` must be on the Onramp domain allowlist.
   */
  guestCheckout?: GuestCheckoutOptions
}

export type GuestCheckoutOptions = {
  /** Domain of the page that shows the modal (the Apple Pay iframe), e.g. `app.example.com` */
  domain: string
  /**
   * Contact details that your app verified with OTP (standard headless mode). Return undefined, or leave
   * this out, for embedded orders: Coinbase then collects and verifies them in the frame. Embedded
   * orders need account enablement by Coinbase.
   */
  verifiedContact?: (ctx: AdapterContext) => GuestContact | undefined | Promise<GuestContact | undefined>
}

/** Fields of the Create Onramp Order API for a user that your app verified */
export type GuestContact = {
  email: string
  /** E.164, a real US cell number (not VoIP) */
  phoneNumber: string
  /** ISO time when the user accepted the Coinbase Guest Checkout Terms, User Agreement and Privacy Policy */
  agreementAcceptedAt: string
  /** ISO time of the phone OTP check. Coinbase needs a new check every 60 days. */
  phoneNumberVerifiedAt?: string
  /** From the Onramp Verification APIs, in place of your own OTP */
  smsVerificationId?: string
  emailVerificationId?: string
}

const POLL: PollSpec = POLLS.checkout
/** Reuse the URL made at quote time only while its session token is fresh (tokens last 5 minutes). */
const URL_REUSE_MS = 4 * 60_000
/** Origin of Coinbase payment links (https://docs.cdp.coinbase.com/api-reference/v2/rest-api/onramp/create-an-onramp-order) */
const PAY_ORIGIN = 'https://pay.coinbase.com'
/** A `userAuthToken` is valid for 60 days (headless overview, "Embedded orders") */
const USER_AUTH_TOKEN_TTL_SEC = 60 * 86400
/** Guest checkout limits: "Up to $2.5K weekly for cards" (Onramp overview), minimum about 5 USD (Onramp FAQ) */
const GUEST_LIMITS = { min: '5', max: '2500', currency: 'USD' }

const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
const SOLANA_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

/**
 * CAIP-2 chain -> Coinbase network name. `base`, `ethereum`, `polygon` and `solana` appear in the CDP docs
 * (Onramp Layer 2 networks page, Buy Options API). TO VERIFY: `arbitrum` and `optimism`, and USDC on them,
 * with the Buy Options API.
 */
export const COINBASE_NETWORKS: Record<string, string> = {
  'eip155:8453': 'base',
  'eip155:1': 'ethereum',
  'eip155:42161': 'arbitrum',
  'eip155:10': 'optimism',
  'eip155:137': 'polygon',
  [SOLANA]: 'solana',
}

const USDC_TOKENS: Record<string, string> = { ...USDC, [SOLANA]: SOLANA_USDC }

/** The tokens Coinbase delivers: USDC on each supported network */
const DELIVERABLE = Object.keys(COINBASE_NETWORKS).map((chain) => ({ chain, token: USDC_TOKENS[chain]!, symbol: 'USDC', decimals: 6 }))

/** Fiat currencies for the hosted onramp. TO VERIFY per country with the Buy Options API. */
const FIATS = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'SGD', 'CHF']

/**
 * Our leg id -> Coinbase `paymentMethod` in the v2 session API. Its enum is CARD, ACH, APPLE_PAY, PAYPAL,
 * FIAT_WALLET, CRYPTO_WALLET (https://docs.cdp.coinbase.com/api-reference/v2/rest-api/onramp/create-an-onramp-session).
 * The enum has no Google Pay value, so google_pay is sent as CARD. PayPal is sell only at Coinbase, so it is not
 * a leg (https://docs.cdp.coinbase.com/onramp/additional-resources/payment-methods).
 * `coinbase_account` (the user's Coinbase balance) is set per adapter, see `accountBalance`.
 */
const PAYMENT_METHOD: Record<string, string> = { card: 'CARD', apple_pay: 'APPLE_PAY', google_pay: 'CARD', ach: 'ACH' }

/**
 * Our leg id -> payment method ids in the v1 Buy Config API (match without case). The v1 ids differ from the
 * session API: ACH is `ACH_BANK_ACCOUNT` and the crypto balance is `CRYPTO_ACCOUNT` (Onramp API spec, PaymentMethodType).
 */
const CONFIG_METHODS: Record<string, string[]> = {
  card: ['CARD'],
  apple_pay: ['APPLE_PAY'],
  google_pay: ['CARD'],
  ach: ['ACH_BANK_ACCOUNT'],
  coinbase_account: ['FIAT_WALLET', 'CRYPTO_ACCOUNT'],
}

/** Leg id of guest Apple Pay (Headless Onramp API, `GUEST_CHECKOUT_APPLE_PAY`) */
const GUEST_APPLE_PAY = 'guest_apple_pay'

type CoinbaseLeg = 'card' | 'apple_pay' | 'google_pay' | 'ach' | 'coinbase_account'

type CbAmount = { value?: string; amount?: string; currency: string }
type CbTransaction = {
  status?: string
  orderId?: string
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
/** `OnrampOrder` of the v2 order API */
type CbOrder = {
  orderId?: string
  status?: string
  paymentTotal?: string
  paymentCurrency?: string
  purchaseAmount?: string
  destinationNetwork?: string
  txHash?: string
  partnerUserRef?: string
  fees?: Array<{ type: string; amount: string; currency: string }>
}
type CbOrderResponse = { order?: CbOrder; paymentLink?: { url?: string; paymentLinkType?: string }; userAuthToken?: string }

/** Order statuses where the user still has to act (verify, then pay) */
const ORDER_WAITING = ['ONRAMP_ORDER_STATUS_PENDING_AUTH', 'ONRAMP_ORDER_STATUS_PENDING_VERIFICATION', 'ONRAMP_ORDER_STATUS_PENDING_PAYMENT']

/**
 * Create Onramp Order `errorType` values that are about the user, not our setup
 * (https://docs.cdp.coinbase.com/api-reference/v2/rest-api/onramp/create-an-onramp-order, 400 and 429 examples).
 */
const GUEST_ERRORS: Record<string, { code: 'REGION_UNSUPPORTED' | 'PROVIDER_DECLINED' | 'AMOUNT_TOO_HIGH'; message: string }> = {
  guest_region_forbidden: { code: 'REGION_UNSUPPORTED', message: 'Coinbase guest checkout is not available in your region.' },
  guest_permission_denied: { code: 'PROVIDER_DECLINED', message: 'Coinbase does not allow guest checkout for this user.' },
  guest_transaction_limit: { code: 'AMOUNT_TOO_HIGH', message: 'This amount is above your weekly Coinbase guest limit.' },
  guest_transaction_count: { code: 'PROVIDER_DECLINED', message: 'You reached the Coinbase guest checkout transaction limit.' },
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
  const env = resolveEnv('coinbase', opts.env, { value: opts.sandbox === undefined ? undefined : opts.sandbox ? 'sandbox' : 'production', option: 'sandbox' }, undefined)
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
  function toOpenRamp(e: unknown, what: string, log?: Pick<Logger, 'warn'>): OpenRampException {
    return httpErrorToOpenRamp(e, 'Coinbase', { what, noQuoteStatuses: [400, 422], ...(log ? { log } : {}) })
  }

  const toChains: Record<string, string[]> = Object.fromEntries(
    Object.keys(COINBASE_NETWORKS)
      .filter((c) => USDC_TOKENS[c])
      .map((c) => [c, [USDC_TOKENS[c]!.toLowerCase()]]),
  )

  const leg = (method: CoinbaseLeg, extra: Partial<LegSpec> = {}): LegSpec => ({
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
    ...extra,
  })
  const legs: LegSpec[] = [
    leg('card'),
    leg('apple_pay'),
    leg('google_pay'),
    // ACH_BANK_ACCOUNT: US only (Coinbase payment methods page, see PAYMENT_METHOD)
    leg('ach', { from: { asset: { kind: 'fiat', currencies: ['USD'] }, location: ['user_account'] }, regions: { allow: ['US'], deny: [] }, eta: { min: 300, max: 5 * 86400 } }),
    // The user's Coinbase balance: FIAT_WALLET / CRYPTO_ACCOUNT, "All countries in which Coinbase operates
    // except Japan" (payment methods page). No Coinbase fee to send an existing crypto balance (Onramp FAQ).
    // TO VERIFY: that the session API returns a quote for FIAT_WALLET and CRYPTO_WALLET with a fiat paymentCurrency.
    leg('coinbase_account'),
  ]
  const accountMethod = opts.accountBalance ?? 'FIAT_WALLET'
  const guest = opts.guestCheckout
  if (guest) {
    // Headless Onramp: "US-only" with a valid US phone number. USD only (TO VERIFY: the API takes
    // `paymentCurrency`, but the docs show only USD for US users).
    legs.push({
      id: GUEST_APPLE_PAY,
      kind: 'fiat_onramp',
      methods: ['apple_pay'],
      from: { asset: { kind: 'fiat', currencies: ['USD'] }, location: ['user_account'] },
      to: { asset: { kind: 'crypto', chains: toChains }, location: ['address'] },
      regions: { allow: ['US'], deny: [] },
      limits: GUEST_LIMITS,
      eta: { min: 30, max: 900 },
      surfaces: ['IFRAME'],
    })
  }

  /** USDC on a chain that Coinbase delivers to */
  function usdcOn(chain: string): CryptoAsset {
    return deliverableToAsset(DELIVERABLE.find((d) => d.chain === chain)!)
  }

  /** What Coinbase delivers for `asset`: USDC on a supported chain. NO_QUOTES for another token or chain (never USDC on Base instead). */
  function target(asset: Asset | undefined): { chain: string; network: string; asset: CryptoAsset } {
    const d = requireDeliverAsset(DELIVERABLE, asset, 'Coinbase')
    return { chain: d.chain, network: COINBASE_NETWORKS[d.chain]!, asset: deliverableToAsset(d) }
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
    const sandbox = env ? env === 'sandbox' : !ctx.session.livemode
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

  async function createOrder(ctx: AdapterContext, p: {
    network: string
    address: string
    paymentAmount?: string
    purchaseAmount?: string
    ref: string
    isQuote: boolean
    userAuthToken?: string
  }): Promise<CbOrderResponse> {
    const contact = guest?.verifiedContact ? await guest.verifiedContact(ctx) : undefined
    const locale = ctx.session.locale
    const body = {
      paymentCurrency: 'USD',
      purchaseCurrency: 'USDC',
      paymentMethod: 'GUEST_CHECKOUT_APPLE_PAY',
      destinationAddress: p.address,
      destinationNetwork: p.network,
      partnerUserRef: p.ref,
      ...(p.paymentAmount ? { paymentAmount: roundTo(p.paymentAmount, 2) } : {}),
      ...(p.purchaseAmount ? { purchaseAmount: p.purchaseAmount } : {}),
      isQuote: p.isQuote,
      domain: guest!.domain,
      ...(ctx.session.ip ? { clientIp: ctx.session.ip } : {}),
      ...(locale && /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(locale) ? { locale } : {}),
      // No contact: an embedded order, where Coinbase verifies the user in the frame.
      ...(contact ?? {}),
      ...(!contact && p.userAuthToken ? { userAuthToken: p.userAuthToken } : {}),
    }
    return cdp<CbOrderResponse>(ctx, cdpApi, 'POST', '/platform/v2/onramp/orders', '', body)
  }

  /** Map a Create Onramp Order error: guest limits and regions are about the user, others as usual */
  function orderError(e: unknown, what: string, log: Pick<Logger, 'warn'>): OpenRampException {
    if (e instanceof OpenRampException) return e
    const body = (e as { body?: unknown } | undefined)?.body
    const type = body && typeof body === 'object' ? (body as { errorType?: unknown }).errorType : undefined
    const known = typeof type === 'string' ? GUEST_ERRORS[type] : undefined
    if (known) return new OpenRampException(openRampError(known.code, { message: known.message, recovery: 'choose_other' }), 422)
    return toOpenRamp(e, what, log)
  }

  /** Key of the reusable `userAuthToken` of one user and wallet. A token only skips OTP for the same wallet. */
  const authTokenKey = (ctx: AdapterContext, address: string) => `uat:${ctx.session.userId}:${address.toLowerCase()}`

  function deliverAddress(ctx: AdapterContext, deliverTo?: { address: string }): string {
    const a = deliverTo?.address ?? (ctx.destination.type === 'crypto' ? ctx.destination.address : undefined)
    if (!a) throw new OpenRampException(openRampError('BAD_REQUEST', { message: 'Coinbase needs a wallet address to deliver to.' }))
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
    const output = chain && amount ? { value: amount, asset: usdcOn(chain) } : undefined
    if (status === 'ONRAMP_TRANSACTION_STATUS_SUCCESS' || status === 'ONRAMP_ORDER_STATUS_COMPLETED' || tx.eventType === 'onramp.transaction.success') {
      return { ref, status: 'succeeded', ...(txHash ? { txHash } : {}), ...(output ? { output } : {}) }
    }
    if (status.endsWith('_FAILED') || tx.eventType === 'onramp.transaction.failed') {
      return { ref, status: 'failed', error: openRampError('PAYMENT_FAILED', { message: 'The Coinbase purchase did not complete.', recovery: 'retry_payment' }) }
    }
    // A headless order before payment: the user is still in the frame
    if (ORDER_WAITING.includes(status)) return { ref, status: 'requires_action' }
    return { ref, status: 'processing' }
  }

  // Coinbase states its fees in the payment currency, and paymentTotal (the quote input) is the
  // subtotal plus the fees, so each fee is included.
  function feesOf(list: Array<{ type: string; amount: string; currency: string }> | undefined): Fee[] {
    return (list ?? []).map((f) => ({
      kind: f.type === 'FEE_TYPE_NETWORK' ? 'network' : 'provider',
      label: f.type === 'FEE_TYPE_NETWORK' ? 'Network fee' : 'Coinbase fee',
      amount: { value: f.amount, asset: { kind: 'fiat', currency: f.currency } },
      included: true,
    }))
  }

  async function guestQuote(input: QuoteInput, ctx: AdapterContext, currency: string, t: ReturnType<typeof target>): Promise<LegQuote> {
    if (currency.toUpperCase() !== 'USD') throw new OpenRampException(openRampError('BAD_REQUEST', { message: 'Coinbase guest checkout takes USD only.' }))
    let res: CbOrderResponse
    try {
      res = await createOrder(ctx, {
        network: t.network,
        address: deliverAddress(ctx, input.deliverTo),
        ...(input.amountIn ? { paymentAmount: input.amountIn.value } : { purchaseAmount: input.amountOut?.value ?? '0' }),
        ref: partnerUserRef(ctx),
        isQuote: true,
      })
    } catch (e) {
      throw orderError(e, 'price this amount', ctx.log)
    }
    const o = res.order
    if (!o?.paymentTotal || !o.purchaseAmount) throw new OpenRampException(openRampError('NO_QUOTES', { message: 'Coinbase did not return a quote for this amount.' }), 422)
    return {
      adapterId: 'coinbase',
      legId: GUEST_APPLE_PAY,
      input: { value: o.paymentTotal, asset: { kind: 'fiat', currency: o.paymentCurrency ?? 'USD' } },
      output: { value: o.purchaseAmount, asset: t.asset },
      fees: feesOf(o.fees),
      // A Coinbase order quote is indicative: Coinbase sets the crypto price when the user pays.
      guarantee: 'estimate',
      eta: legs.find((l) => l.id === GUEST_APPLE_PAY)!.eta,
      expiresAt: quoteExpiresAt(5),
      limits: GUEST_LIMITS,
      data: { network: t.network },
    }
  }

  async function guestStart(input: StartInput, ctx: AdapterContext): Promise<LegStep> {
    const data = (input.quote.data ?? {}) as { network?: string }
    const t = target(input.quote.output.asset.kind === 'crypto' ? input.quote.output.asset : undefined)
    const address = deliverAddress(ctx, input.deliverTo)
    const ref = partnerUserRef(ctx)
    const tokenKey = authTokenKey(ctx, address)
    const saved = await ctx.shared.get<string>(tokenKey)
    let res: CbOrderResponse
    try {
      res = await createOrder(ctx, {
        network: data.network ?? t.network,
        address,
        paymentAmount: input.quote.input.value,
        ref,
        isQuote: false,
        ...(saved ? { userAuthToken: saved } : {}),
      })
    } catch (e) {
      throw orderError(e, 'start the purchase', ctx.log)
    }
    const link = res.paymentLink?.url
    const orderId = res.order?.orderId
    if (!link || !orderId) throw new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message: 'Coinbase did not return a payment link.' }), 502)
    await ctx.store.put(`order:${ref}`, orderId, 7 * 86400)
    // "Store it ... replacing any older value" (embedded orders)
    if (res.userAuthToken && res.userAuthToken !== saved) await ctx.shared.put(tokenKey, res.userAuthToken, USER_AUTH_TOKEN_TTL_SEC)
    // Sandbox orders: a fake Apple Pay sheet, allowed on http://localhost without domain setup
    const url = ref.startsWith('sandbox-') ? `${link}${link.includes('?') ? '&' : '?'}useApplePaySandbox=true` : link
    let origin = PAY_ORIGIN
    try {
      origin = new URL(url).origin
    } catch {
      // Keep the default origin. The server rejects a surface URL that is not https.
    }
    return {
      state: 'PAYMENT',
      surface: {
        kind: 'IFRAME',
        url,
        origin,
        // The iframe needs `allow=payment` and `referrerpolicy="no-referrer"` (Headless Onramp, web app requirements).
        // The docs also ask for `sandbox="allow-scripts allow-same-origin"`. The modal sandbox has these tokens and
        // more (forms, popups). TO VERIFY: that Coinbase accepts the extra sandbox tokens.
        allow: 'payment',
        referrerPolicy: 'no-referrer',
        height: 600,
        provider: 'Coinbase',
        messages: {
          typeField: 'eventName',
          // commit_success: the payment started. polling_success: the crypto was sent.
          completed: ['onramp_api.commit_success', 'onramp_api.polling_success'],
          // Not load_error: on the web, ERROR_CODE_GUEST_APPLE_PAY_NOT_SUPPORTED falls back to a QR code.
          failed: ['onramp_api.commit_error', 'onramp_api.polling_error', 'onramp_api.session_error'],
          closed: ['onramp_api.cancel'],
        },
      },
      transitions: [awaitPoll(POLL)],
      status: 'requires_action',
      ref,
    }
  }

  return createAdapter({
    id: 'coinbase',
    ...(env ? { env } : {}),
    name: 'Coinbase',
    legs,

    async catalog(input, ctx) {
      // Countries and payment methods from the Buy Config API, cached for a day. The API spec
      // (GetBuyConfigResponse) has `{ countries }`; the older `{ data: { countries } }` shape is accepted too.
      type Config = { countries?: Array<{ id: string; payment_methods?: Array<{ id: string }> }> }
      const cfg = await cachedJson<Config>(ctx.shared, 'config', 24 * 60 * 60, async () => {
        const res = await cdp<Config & { data?: Config }>(ctx, onrampApi, 'GET', '/onramp/v1/buy/config')
        return res.data ?? res
      })
      const countries = cfg.countries ?? []
      const allowFor = (l: LegSpec) => {
        const pms = CONFIG_METHODS[l.id]!
        const ids = countries.filter((c) => (c.payment_methods ?? []).some((m) => pms.includes(m.id?.toUpperCase()))).map((c) => c.id.toUpperCase())
        // A leg with fixed countries (ACH: US) stays inside them
        return l.regions.allow.includes('*') ? ids : ids.filter((c) => l.regions.allow.includes(c))
      }
      // Guest Apple Pay is not a hosted method: it keeps its static US region.
      const hosted = legs.filter((l) => l.id !== GUEST_APPLE_PAY)
      const fixed = legs.filter((l) => l.id === GUEST_APPLE_PAY)
      const refined = hosted.map((l) => ({ ...l, regions: { allow: allowFor(l), deny: l.regions.deny } }))
      // No country lists any of our methods: the config format is not what we expect, so keep the static legs.
      if (!refined.some((l) => l.regions.allow.length)) return legs
      // A method no country supports is not offered at all.
      return [...refined.filter((l) => l.regions.allow.length), ...fixed]
    },

    async quote(input, ctx) {
      const fiat = input.amountIn?.asset ?? input.leg.from.asset
      if (fiat.kind !== 'fiat') throw new OpenRampException(openRampError('BAD_REQUEST', { message: 'Coinbase quotes need a fiat amount.' }))
      const t = target(input.leg.to.asset.kind === 'crypto' ? input.leg.to.asset : undefined)
      if (input.leg.legId === GUEST_APPLE_PAY) return guestQuote(input, ctx, fiat.currency, t)
      const country = (ctx.session.country ?? opts.defaultCountry ?? 'US').toUpperCase()
      const sub = subdivision(ctx, country)
      const ref = partnerUserRef(ctx)
      const paymentMethod = input.leg.legId === 'coinbase_account' ? accountMethod : PAYMENT_METHOD[input.leg.legId] ?? 'CARD'
      let res: CbSessionResponse
      try {
        res = await createSession(ctx, {
          network: t.network,
          address: deliverAddress(ctx, input.deliverTo),
          paymentCurrency: fiat.currency.toUpperCase(),
          ...(input.amountIn ? { paymentAmount: input.amountIn.value } : { purchaseAmount: input.amountOut?.value ?? '0' }),
          paymentMethod,
          country,
          ...(sub ? { subdivision: sub } : {}),
          ref,
        })
      } catch (e) {
        throw toOpenRamp(e, 'price this amount', ctx.log)
      }
      const q = res.quote
      if (!q) throw new OpenRampException(openRampError('NO_QUOTES', { message: 'Coinbase did not return a quote for this amount.' }), 422)
      const fees = feesOf(q.fees)
      return {
        adapterId: 'coinbase',
        legId: input.leg.legId,
        input: { value: q.paymentTotal, asset: { kind: 'fiat', currency: q.paymentCurrency } },
        output: { value: q.purchaseAmount, asset: t.asset },
        fees,
        // A Coinbase session quote is indicative: Coinbase sets the crypto price when the user pays.
        guarantee: 'estimate',
        eta: (legs.find((l) => l.id === input.leg.legId) ?? legs[0]!).eta,
        // The session token behind the quote's onramp URL expires after 5 minutes.
        expiresAt: quoteExpiresAt(5),
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
      if (input.leg.legId === GUEST_APPLE_PAY) return guestStart(input, ctx)
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
            paymentAmount: input.quote.input.value,
            ...(data.paymentMethod ? { paymentMethod: data.paymentMethod } : {}),
            ...(data.country ? { country: data.country } : {}),
            ...(data.subdivision ? { subdivision: data.subdivision } : {}),
            ref,
          })
          url = res.session?.onrampUrl
        } catch (e) {
          throw toOpenRamp(e, 'start the purchase', ctx.log)
        }
        if (!url) throw new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message: 'Coinbase did not return a checkout URL.' }), 502)
      }
      return {
        state: 'PAYMENT',
        surface: { kind: 'REDIRECT', url, popup: true, provider: 'Coinbase' },
        transitions: [awaitPoll(POLL)],
        status: 'requires_action',
        ref,
      }
    },

    async status(input, ctx) {
      // A headless order: GET /v2/onramp/orders/{orderId} (orderId saved at start)
      const orderId = await ctx.store.get<string>(`order:${input.ref}`)
      if (orderId) {
        let res: { order?: CbOrder }
        try {
          res = await cdp(ctx, cdpApi, 'GET', `/platform/v2/onramp/orders/${encodeURIComponent(orderId)}`)
        } catch (e) {
          throw toOpenRamp(e, 'find this purchase', ctx.log)
        }
        return legStepFromEvent(res.order ? eventFrom(res.order as CbTransaction, input.ref) : undefined, input.ref, POLL)
      }
      // `pageSize` (camelCase) as in the Onramp API spec
      const path = `/onramp/v1/buy/user/${encodeURIComponent(input.ref)}/transactions`
      let res: { transactions?: CbTransaction[] }
      try {
        res = await cdp(ctx, onrampApi, 'GET', path, '?pageSize=1')
      } catch (e) {
        throw toOpenRamp(e, 'find this purchase', ctx.log)
      }
      const tx = res.transactions?.[0]
      return legStepFromEvent(tx ? eventFrom(tx, input.ref) : undefined, input.ref, POLL)
    },

    webhook: {
      // Without the webhookSecret, no webhook can verify (see `resultChannels`).
      configured: !!opts.webhookSecret,
      async verify(req, rawBody, ctx) {
        if (!opts.webhookSecret) {
          ctx.log.warn('coinbase: webhookSecret is not set; rejecting webhook')
          return false
        }
        // `t=<unix s>,v0=<hex HMAC-SHA256 over "{t}.{body}">`, within 5 minutes
        return verifyTimestampedHmac({
          secret: opts.webhookSecret,
          rawBody,
          header: req.headers.get('x-hook0-signature'),
          signatureKey: 'v0',
          toleranceSec: 5 * 60,
        })
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
