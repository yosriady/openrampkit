// Stripe Link headless crypto onramp adapter. Stripe calls it the Embedded Components onramp
// (https://docs.stripe.com/crypto/onramp/embedded-components). The user signs in to Link, and the
// purchase runs in the app's own screens. Stripe only shows small parts: the Link sign-in (OTP and
// consent), the Payment Element, identity documents and 3DS.
//
// Flow (https://docs.stripe.com/crypto/onramp/embedded-components-integration-guide?platform=web):
// 1. Auth. POST https://login.link.com/v1/link_auth_intent (JSON: email, oauth_client_id, oauth_scopes)
//    gives `lai_...`. A 404 means "no Link account for this email": the client registers the user with
//    the SDK (`registerLinkUser`), then we try again. The client shows `authenticate(linkAuthIntentId)`,
//    which gives `crypto_customer_id` (`crc_...`). Then POST /v1/link_auth_intent/{id}/tokens gives the
//    OAuth access token (1 hour). We seal it (AES-256-GCM) in the session store and never send it to the
//    client. We never ask for or keep the refresh token: when the access token expires, the user signs in again.
// 2. KYC. GET /v1/crypto/customers/{crc} (with `Stripe-OAuth-Token`). When KYC is missing, the client
//    sends it with the SDK (`submitKycInfo`): the identity data never passes through this server.
// 3. Wallet. GET /v1/crypto/customers/{crc}/crypto_consumer_wallets. When the address is not on file,
//    the client registers it with the SDK (`registerWalletAddress`).
// 4. Payment method. The client shows the Payment Element (`collectPaymentMethod`) and sends us the
//    crypto payment token (`cpt_...`).
// 5. Session. POST /v1/crypto/onramp_sessions with `ui_mode=headless`, the customer, the payment token,
//    the amount, USDC, the network and the wallet. A 400 `crypto_onramp_missing_document_verification`
//    asks for identity documents first (`verifyDocuments`).
// 6. Checkout. The SDK's `performCheckout` callback calls our `checkout` transition, which calls
//    POST /v1/crypto/onramp_sessions/{id}/checkout and gives the SDK the `client_secret` (for 3DS).
// 7. Result. GET /v1/crypto/onramp_sessions/{id}, and the `crypto.onramp_session.updated` webhook
//    (`Stripe-Signature: t=...,v1=...`, hex HMAC-SHA256 of `{t}.{body}`, 5 minute tolerance).
//
// Every api.stripe.com call sends `Authorization: Bearer <secret key>` and the preview
// `Stripe-Version: 2026-09-30.endive;crypto_onramp_beta=v2`. The API is in private preview: no call
// works, also in a sandbox, until Stripe finishes onboarding (feature gates, Link as a payment method,
// and the OAuth client id). US only, not New York.
//
// Server-side only. Web-standard APIs only (fetch, WebCrypto), so it runs on Cloudflare Workers.

import {
  POLL as POLLS,
  awaitPoll,
  claimOnce,
  createAdapter,
  fetchJson,
  httpErrorToOpenRamp,
  httpStatus,
  providerMessage,
  quoteExpiresAt,
  randomHex,
  requireDeliverAsset,
  resolveEnv,
  statusMap,
  verifyTimestampedHmac,
} from '@openrampkit/adapter'
import type { AdapterContext, AdapterEnv, LegEvent, Logger } from '@openrampkit/adapter'
import { OpenRampException, SOLANA_MAINNET, timingSafeEqual, SOLANA_USDC_MINT, TEMPO_MAINNET, TEMPO_USDC, USDC, isDecimal, openRampError, roundTo } from '@openrampkit/core'
import type { Amount, Asset, CryptoAsset, Fee, LegSpec, LegStatus, LegStep, PollSpec, StepDetailCode, Surface, Transition } from '@openrampkit/core'
import { seal, sealKey, unseal } from './seal.js'

export type StripeLinkOptions = {
  /** Secret key (sk_live_... or sk_test_...) of the account that Stripe onboarded for the Embedded Components onramp */
  secretKey: string
  /** Publishable key (pk_...). The client SDK (`@stripe/crypto`) needs it. */
  publishableKey: string
  /** The Link OAuth client id that Stripe gives you at onboarding */
  oauthClientId: string
  /** Webhook endpoint secret (whsec_...) for `crypto.onramp_session.updated` */
  webhookSecret: string
  /**
   * Secret for the key that encrypts the Link access token in the session store (at least 32
   * characters). Default: a key derived from `secretKey`. Set your own so that a leak of the store and
   * of one key is not enough.
   */
  tokenKey?: string
  /**
   * Only the session's own `email` (set by the app at session creation) may sign in to Link. With
   * true, a session with no email cannot start this leg, and the email FORM never shows. Default
   * false: a session with no email asks the user for one. A session email is always locked: the
   * client cannot change it.
   */
  requireSessionEmail?: boolean
  /** Limit the legs (card, apple_pay, google_pay, ach) */
  methods?: string[]
  /** Default https://api.stripe.com */
  apiUrl?: string
  /** Default https://login.link.com */
  linkUrl?: string
  /** The `Stripe-Version` header. Default `2026-09-30.endive;crypto_onramp_beta=v2` (from the guide). */
  stripeVersion?: string
  /** 'sandbox' or 'production'. Default: from the key prefix. A value that does not agree with the key throws. */
  env?: AdapterEnv
}

export const STRIPE_VERSION = '2026-09-30.endive;crypto_onramp_beta=v2'

/** The OAuth scopes for the onramp (the guide's example). `auth.persist_login:read` is for mobile apps only. */
export const LINK_OAUTH_SCOPES = 'kyc.status:read,crypto:ramp'

/** The Stripe mode of a secret or restricted key, from its prefix */
export function stripeKeyEnv(key: string): AdapterEnv | undefined {
  if (/^(sk|rk)_test_/.test(key)) return 'sandbox'
  if (/^(sk|rk)_live_/.test(key)) return 'production'
  return undefined
}

type Network = 'ethereum' | 'base' | 'arbitrum' | 'polygon' | 'solana' | 'tempo'
type DeliverAsset = { chain: string; token: string; network: Network; sandbox: boolean }

/**
 * USDC per network, from the guide's "Supported networks and currencies" table (2026-10-16). Live mode
 * also lists Sui, World Chain and Celo, which the kit does not route yet. In a sandbox only Solana,
 * Ethereum and Base work.
 */
export const STRIPE_LINK_DELIVER_ASSETS: DeliverAsset[] = [
  { chain: 'eip155:8453', token: USDC['eip155:8453']!, network: 'base', sandbox: true },
  { chain: 'eip155:1', token: USDC['eip155:1']!, network: 'ethereum', sandbox: true },
  { chain: SOLANA_MAINNET, token: SOLANA_USDC_MINT, network: 'solana', sandbox: true },
  { chain: 'eip155:42161', token: USDC['eip155:42161']!, network: 'arbitrum', sandbox: false },
  { chain: 'eip155:137', token: USDC['eip155:137']!, network: 'polygon', sandbox: false },
  // USDC.e on Tempo; Stripe's currency code is still `usdc`
  { chain: TEMPO_MAINNET, token: TEMPO_USDC, network: 'tempo', sandbox: false },
]

type MethodDef = {
  id: string
  /** `payment_method_types` for `collectPaymentMethod` */
  types: Array<'card' | 'us_bank_account'>
  wallets: { applePay: 'auto' | 'never'; googlePay: 'auto' | 'never' }
  detail: StepDetailCode
  eta: { min: number; max: number }
}
const INSTANT = { min: 60, max: 900 }
/**
 * `collectPaymentMethod` takes `payment_method_types` `card` and `us_bank_account` (ACH), and
 * `wallets.applePay` and `wallets.googlePay` (verified in the guide's SDK reference).
 */
export const STRIPE_LINK_METHODS: MethodDef[] = [
  { id: 'card', types: ['card'], wallets: { applePay: 'never', googlePay: 'never' }, detail: 'card_details', eta: INSTANT },
  { id: 'apple_pay', types: ['card'], wallets: { applePay: 'auto', googlePay: 'never' }, detail: 'card_details', eta: INSTANT },
  { id: 'google_pay', types: ['card'], wallets: { applePay: 'never', googlePay: 'auto' }, detail: 'card_details', eta: INSTANT },
  // TO VERIFY: the delivery time of ACH (the default `settlement_speed` is `instant`).
  { id: 'ach', types: ['us_bank_account'], wallets: { applePay: 'never', googlePay: 'never' }, detail: 'bank_details', eta: { min: 300, max: 5 * 86400 } },
]

/** "The Embedded Components onramp is only available to users in the US (excluding New York)." */
const ALLOW = ['US']
const DENY = ['US-NY']

const POLL: PollSpec = POLLS.checkout
const TOLERANCE_SEC = 5 * 60
/** How long we keep the leg record (not the token) */
const RECORD_TTL_SEC = 24 * 3600
/** How long a change holds the lease of a leg (longer than its Stripe calls). After a crash, the leg is free again after it. */
const LEASE_TTL_SEC = 120
/** The access token lives 1 hour. We drop it a little sooner, so a call never starts with a dead token. */
const TOKEN_MARGIN_SEC = 60
/** Webhooks find the leg of an onramp session through this shared key when metadata is missing */
const SESSION_INDEX_TTL_SEC = 7 * 24 * 3600

type Stage = 'email' | 'register' | 'authenticate' | 'kyc' | 'kyc_review' | 'documents' | 'wallet' | 'payment_method' | 'checkout'

/** What we keep per leg in the session store. No secret: the token is sealed under its own key. */
type LegRecord = {
  /** `{session id}:{user id}` of the session that started the leg. Every load checks it. */
  owner: string
  legId: string
  stage: Stage
  network: Network
  wallet: string
  sourceCurrency: string
  sourceAmount?: string
  destinationAmount?: string
  nonce: string
  email?: string
  /** The email came from the app (the session) or a finished sign-in, so the client cannot change it */
  emailLocked?: boolean
  authIntentId?: string
  /** SHA-256 (hex) of the client key that finished the Link sign-in. Later Link calls need the same key. */
  keyHash?: string
  customerId?: string
  paymentToken?: string
  onrampSessionId?: string
  /**
   * The change counter of the record. A change of the leg (a transition, or a status check that moves
   * it) first takes the lease `l:{ref}:{v}` (one atomic claim), and adds 1 at its end. So two changes
   * that read the same record cannot both run: the second gets a 409. Records without it are at 0.
   */
  v?: number
}

type NetworkQuote = {
  destination_amount?: string
  destination_currency?: string
  destination_network?: string
  fees?: { network_fee_monetary?: string; transaction_fee_monetary?: string }
  source_total_amount?: string
}
type QuotesResponse = { destination_network_quotes?: Record<string, NetworkQuote[]> }
type OnrampSession = {
  id: string
  client_secret?: string
  status?: string
  livemode?: boolean
  metadata?: Record<string, string> | null
  transaction_details?: {
    destination_amount?: string | null
    destination_currency?: string | null
    destination_network?: string | null
    transaction_id?: string | null
  } | null
}
type CryptoCustomer = {
  id?: string
  kyc_tiers?: Array<{ tier?: string; verification_status?: string }>
  verifications?: Array<{ type?: string; status?: string }>
}
type ConsumerWallet = { id?: string; wallet_address?: string; network?: string }

/** Stripe onramp session statuses (the guide: initialized > requires_payment > fulfillment_processing > fulfillment_complete, or rejected) */
const STATUS = statusMap<{ status: LegStatus; detail?: StepDetailCode }>('Stripe Link', {
  initialized: { status: 'requires_action' },
  requires_payment: { status: 'requires_action' },
  fulfillment_processing: { status: 'processing', detail: 'processing' },
  fulfillment_complete: { status: 'succeeded' },
  rejected: { status: 'failed' },
})

const EMAIL = /^[^\s@]{1,200}@[^\s@]{1,200}\.[^\s@]{2,}$/
const CUSTOMER_ID = /^crc_[A-Za-z0-9]{1,200}$/
const PAYMENT_TOKEN = /^cpt_[A-Za-z0-9]{1,200}$/
/** A client key: 32 to 128 URL-safe characters that the client makes at random and keeps in memory */
const CLIENT_KEY = /^[A-Za-z0-9_-]{32,128}$/

/**
 * The input that binds the Link sign-in to one client. The client makes a random key (for example 32
 * random bytes in base64url), sends it with `link_authenticated`, and sends the same key with every
 * later transition. The key is never in a step, so another holder of a session credential (a pay link,
 * another device) cannot use the Link token of the user who signed in.
 */
export const STRIPE_LINK_CLIENT_KEY = 'clientKey'

async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Names of the transitions the client calls. The renderer calls them from the Stripe SDK callbacks. */
export const STRIPE_LINK_TRANSITIONS = {
  email: 'submit_email',
  registered: 'link_registered',
  authenticated: 'link_authenticated',
  kyc: 'kyc_submitted',
  documents: 'documents_verified',
  wallet: 'wallet_registered',
  paymentMethod: 'payment_method_collected',
  checkout: 'checkout',
} as const

/** The stages from which each transition may run. Anything else is a 409. */
const TRANSITION_STAGES: Record<string, Stage[]> = {
  [STRIPE_LINK_TRANSITIONS.email]: ['email', 'register', 'authenticate'],
  [STRIPE_LINK_TRANSITIONS.registered]: ['register'],
  [STRIPE_LINK_TRANSITIONS.authenticated]: ['authenticate'],
  [STRIPE_LINK_TRANSITIONS.kyc]: ['kyc', 'kyc_review'],
  [STRIPE_LINK_TRANSITIONS.documents]: ['documents', 'kyc_review'],
  [STRIPE_LINK_TRANSITIONS.wallet]: ['wallet'],
  [STRIPE_LINK_TRANSITIONS.paymentMethod]: ['payment_method'],
  [STRIPE_LINK_TRANSITIONS.checkout]: ['checkout'],
}

function num(s: string | undefined | null): string | undefined {
  return s && isDecimal(s) ? s : undefined
}

/** Stripe form encoding: nested keys like `metadata[ork_ref]` and arrays like `destination_networks[]` */
function form(params: Array<[string, string | undefined]>): string {
  const q = new URLSearchParams()
  for (const [k, v] of params) if (v !== undefined && v !== '') q.append(k, v)
  return q.toString()
}

function bad(message: string, status = 400): OpenRampException {
  return new OpenRampException(openRampError('BAD_REQUEST', { message }), status)
}

/**
 * The KYC state of a crypto customer. The guide says to look for a `verifications` entry with type
 * `kyc_verified` and status `not_started`; the API reference shows `kyc_tiers` (`l0`, `l1`, `l2`) with a
 * `verification_status`. We read both.
 * TO VERIFY: the status values other than `not_started` and `verified` (we read `pending` and
 * `processing` as a review, and `rejected` and `failed` as a refusal).
 */
export function kycState(c: CryptoCustomer, tier: 'l1' | 'l2' = 'l1'): 'collect' | 'review' | 'rejected' | 'ok' {
  const v = tier === 'l1' ? c.verifications?.find((x) => x.type === 'kyc_verified')?.status : undefined
  const t = c.kyc_tiers?.find((x) => x.tier === tier)?.verification_status
  const s = v ?? t
  if (!s) return 'ok'
  if (s === 'not_started' || s === 'unverified') return 'collect'
  if (s === 'pending' || s === 'processing') return 'review'
  if (s === 'rejected' || s === 'failed') return 'rejected'
  return 'ok'
}

/**
 * A chain transaction hash (EVM hex or a Solana signature). The checkout example shows
 * `transaction_id: "cxt_..."`, a Stripe id, so only a value that looks like a hash becomes a transaction.
 * TO VERIFY: whether `transaction_id` holds the chain hash after `fulfillment_complete`.
 */
const CHAIN_HASH = /^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{64,90})$/

export function stripeLink(opts: StripeLinkOptions) {
  const keyEnv = stripeKeyEnv(opts.secretKey)
  const env = resolveEnv('stripe-link', opts.env, undefined, keyEnv)
  if (opts.env && keyEnv && opts.env !== keyEnv) throw new Error(`stripe-link: env is '${opts.env}', but secretKey is a ${keyEnv === 'sandbox' ? 'test mode' : 'live mode'} key`)
  if (!opts.oauthClientId) throw new Error('stripe-link: oauthClientId is required (Stripe gives it at onboarding)')
  if (opts.tokenKey !== undefined && opts.tokenKey.length < 32) throw new Error('stripe-link: tokenKey must have at least 32 characters')
  const api = (opts.apiUrl ?? 'https://api.stripe.com').replace(/\/+$/, '')
  const link = (opts.linkUrl ?? 'https://login.link.com').replace(/\/+$/, '')
  const version = opts.stripeVersion ?? STRIPE_VERSION
  const auth = `Bearer ${opts.secretKey}`
  const defs = STRIPE_LINK_METHODS.filter((m) => !opts.methods || opts.methods.includes(m.id))
  if (!defs.length) throw new Error('stripe-link: `methods` selects no known leg')
  const assets = STRIPE_LINK_DELIVER_ASSETS.filter((d) => env !== 'sandbox' || d.sandbox)
  const toChains: Record<string, string[]> = {}
  for (const d of assets) (toChains[d.chain] ??= []).push(d.chain.startsWith('eip155:') ? d.token.toLowerCase() : d.token)
  let keyPromise: Promise<CryptoKey> | undefined
  const tokenKey = () => (keyPromise ??= sealKey(opts.tokenKey ?? `stripe-link:${opts.secretKey}`))

  const legs: LegSpec[] = defs.map((d) => ({
    id: d.id,
    kind: 'fiat_onramp',
    methods: [d.id],
    from: { asset: { kind: 'fiat', currencies: ['USD'] }, location: ['user_account'] },
    to: { asset: { kind: 'crypto', chains: toChains }, location: ['address'] },
    regions: { allow: ALLOW, deny: DENY },
    eta: d.eta,
    // Only PROVIDER_SDK: the planner then offers the legs only to a client with a provider renderer.
    // (The email FORM is a fallback for a session without an email; a renderer client shows FORMs too.)
    surfaces: ['PROVIDER_SDK'],
    requires: ['provider_account', 'provider_kyc', 'otp'],
  }))
  const byId = new Map(defs.map((d) => [d.id, d]))

  function assetOf(d: DeliverAsset): CryptoAsset {
    return { kind: 'crypto', chain: d.chain, token: d.token, symbol: 'USDC', decimals: 6 }
  }

  function deliverFor(asset: Asset | undefined): DeliverAsset {
    return requireDeliverAsset(assets, asset, 'Stripe')
  }

  /** 400s about the customer's country mean "not in your region"; other 4xx about the request mean "no quote". */
  function toOpenRamp(e: unknown, what: string, log: Pick<Logger, 'warn'>): OpenRampException {
    const code = (e as { body?: { error?: { code?: string } } })?.body?.error?.code ?? ''
    if (code === 'crypto_onramp_unsupported_country' || code === 'crypto_onramp_unsupportable_customer') {
      return new OpenRampException(openRampError('REGION_UNSUPPORTED', { message: 'Stripe cannot sell crypto to you in your region.', recovery: 'choose_other' }), 422)
    }
    return httpErrorToOpenRamp(e, 'Stripe', { what, noQuoteStatuses: [400, 422], log })
  }

  /** An api.stripe.com call. The OAuth token goes in `Stripe-OAuth-Token` when the call is for a user. */
  async function stripeCall<T>(ctx: Pick<AdapterContext, 'fetch'>, method: 'GET' | 'POST', path: string, o: { body?: string; token?: string; idem?: string } = {}): Promise<T> {
    return fetchJson<T>(ctx.fetch, `${api}${path}`, {
      method,
      headers: {
        authorization: auth,
        'stripe-version': version,
        ...(o.token ? { 'stripe-oauth-token': o.token } : {}),
        ...(o.body !== undefined ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...(o.idem ? { 'idempotency-key': o.idem } : {}),
      },
      ...(o.body !== undefined ? { body: o.body } : {}),
    })
  }

  // ---------- leg record and token ----------

  const recKey = (ref: string) => `r:${ref}`
  const tokKey = (ref: string) => `t:${ref}`

  const ownerOf = (ctx: Pick<AdapterContext, 'session'>) => `${ctx.session.id}:${ctx.session.userId}`
  const gone = () => new OpenRampException(openRampError('SESSION_EXPIRED', { message: 'This Stripe purchase is no longer open. Start again.' }), 410)

  async function loadRecord(ctx: AdapterContext, ref: string): Promise<LegRecord> {
    const rec = await ctx.store.get<LegRecord>(recKey(ref))
    if (!rec) throw gone()
    // A record of another session or another app user (for example a shared or copied store) is never used.
    if (rec.owner !== ownerOf(ctx)) {
      ctx.log.warn('stripe-link: leg record of another session or user; refused', { ref })
      throw gone()
    }
    return rec
  }

  async function saveRecord(ctx: AdapterContext, ref: string, rec: LegRecord): Promise<void> {
    await ctx.store.put(recKey(ref), rec, RECORD_TTL_SEC)
  }

  /**
   * Take the lease of the leg at the version of `rec`: one atomic claim (`claimOnce` on
   * `l:{ref}:{v}`), so exactly one change runs from a given record. A change that read an older record
   * loses too, because its version was taken. Returns the release, which adds 1 to the version (the
   * next change can then run), or undefined when another change holds or held this version.
   * Atomic on stores with `putIfAbsent` (memory, Redis, Durable Object). On Workers KV it writes, then
   * reads back, which catches most races but not all.
   */
  async function lease(ctx: AdapterContext, ref: string, rec: LegRecord): Promise<(() => Promise<void>) | undefined> {
    const v = rec.v ?? 0
    if (!(await claimOnce(ctx.store, `l:${ref}:${v}`, randomHex(12), LEASE_TTL_SEC))) return undefined
    return async () => {
      // Only the holder writes while it holds the lease, so this read and write do not race.
      const cur = await ctx.store.get<LegRecord>(recKey(ref))
      if (cur && (cur.v ?? 0) === v) await saveRecord(ctx, ref, { ...cur, v: v + 1 })
    }
  }

  /** Run one change of the leg under its lease (see `lease`). Another change of the same record gets a 409. */
  async function exclusive<T>(ctx: AdapterContext, ref: string, rec: LegRecord, fn: () => Promise<T>): Promise<T> {
    const release = await lease(ctx, ref, rec)
    if (!release) {
      ctx.log.warn('stripe-link: another request changes this leg; refused', { ref })
      throw bad('Another request is changing this purchase. Try again.', 409)
    }
    try {
      return await fn()
    } finally {
      await release()
    }
  }

  /**
   * The additional data of a sealed token: the session, the app user, the leg ref and the crypto
   * customer that the token was checked for. A token opens only for that user, leg and customer.
   */
  const tokenAad = (ctx: Pick<AdapterContext, 'session'>, ref: string, customerId: string) => `${ctx.session.id}\n${ctx.session.userId}\n${ref}\n${customerId}`

  async function putToken(ctx: AdapterContext, ref: string, customerId: string, token: string, expiresIn: number | undefined): Promise<void> {
    const ttl = Math.max(1, Math.min(3600, Number.isFinite(expiresIn) && expiresIn! > 0 ? expiresIn! : 3600) - TOKEN_MARGIN_SEC)
    await ctx.store.put(tokKey(ref), await seal(await tokenKey(), token, tokenAad(ctx, ref, customerId)), ttl)
  }

  async function getToken(ctx: AdapterContext, ref: string, rec: LegRecord): Promise<string | undefined> {
    if (!rec.customerId) return undefined
    return unseal(await tokenKey(), await ctx.store.get(tokKey(ref)), tokenAad(ctx, ref, rec.customerId))
  }

  /** Forget the token as soon as the leg needs it no more. ScopedKV has no delete: overwrite it with a 1 second TTL. */
  async function dropToken(ctx: AdapterContext, ref: string): Promise<void> {
    await ctx.store.put(tokKey(ref), null, 1)
  }

  // ---------- steps ----------

  function sdk(params: Record<string, unknown>): Surface {
    return { kind: 'PROVIDER_SDK', provider: 'stripe-link', params: { publishableKey: opts.publishableKey, ...params } }
  }

  function submit(name: string, label = 'Continue'): Transition {
    return { name, kind: 'SUBMIT', label }
  }

  /** The step of a stage before the onramp session exists */
  function stageStep(ref: string, rec: LegRecord): LegStep {
    const T = STRIPE_LINK_TRANSITIONS
    const d = byId.get(rec.legId) ?? defs[0]!
    const base = { status: 'requires_action' as const, ref }
    switch (rec.stage) {
      case 'email':
        return {
          ...base,
          action: { kind: 'auth', surface: { kind: 'FORM', fields: [{ id: 'email', label: 'Email', type: 'email', required: true }] }, transitions: [submit(T.email)] },
        }
      case 'register':
        // No Link account for this email: the client collects the phone number (and the name) and calls `registerLinkUser`.
        return { ...base, action: { kind: 'auth', surface: sdk({ step: 'register_link_user', email: rec.email, country: 'US' }), transitions: [submit(T.registered)] } }
      case 'authenticate':
        return { ...base, action: { kind: 'auth', surface: sdk({ step: 'authenticate', linkAuthIntentId: rec.authIntentId }), transitions: [submit(T.authenticated)] } }
      case 'kyc':
        return { ...base, detail: { code: 'kyc_details' }, action: { kind: 'kyc', surface: sdk({ step: 'submit_kyc_info' }), transitions: [submit(T.kyc)] } }
      case 'kyc_review':
        return { status: 'processing', phase: 'kyc', ref, detail: { code: 'kyc_review' }, poll: POLL }
      case 'documents':
        return { ...base, detail: { code: 'kyc_verify' }, action: { kind: 'kyc', surface: sdk({ step: 'verify_documents' }), transitions: [submit(T.documents)] } }
      case 'wallet':
        return { ...base, action: { kind: 'payment', surface: sdk({ step: 'register_wallet_address', walletAddress: rec.wallet, network: rec.network }), transitions: [submit(T.wallet)] } }
      case 'payment_method':
        return {
          ...base,
          detail: { code: d.detail },
          action: { kind: 'payment', surface: sdk({ step: 'collect_payment_method', paymentMethodTypes: d.types, wallets: d.wallets }), transitions: [submit(T.paymentMethod)] },
        }
      case 'checkout':
        return checkoutStep(ref, rec)
    }
  }

  function checkoutStep(ref: string, rec: LegRecord, clientSecret?: string): LegStep {
    return {
      status: 'requires_action',
      ref,
      ...(rec.onrampSessionId ? { providerRef: rec.onrampSessionId } : {}),
      action: {
        kind: 'payment',
        // The SDK's `performCheckout` callback needs the `client_secret` of the last checkout call.
        surface: sdk({ step: 'perform_checkout', onrampSessionId: rec.onrampSessionId, ...(clientSecret ? { clientSecret } : {}) }),
        transitions: [submit(STRIPE_LINK_TRANSITIONS.checkout, 'Pay'), awaitPoll(POLL)],
      },
    }
  }

  /** A leg step from an onramp session. `undefined` for an unknown status. */
  function sessionStep(s: OnrampSession, ref: string, rec: LegRecord | undefined, log: Pick<Logger, 'warn'>): LegStep | undefined {
    const m = STATUS(s.status, log)
    if (!m) return undefined
    const td = s.transaction_details ?? {}
    const d = assets.find((x) => x.network === td.destination_network) ?? STRIPE_LINK_DELIVER_ASSETS.find((x) => x.network === td.destination_network)
    const amount = num(td.destination_amount)
    const output: Amount | undefined = d && amount && (td.destination_currency ?? 'usdc').toLowerCase() === 'usdc' ? { value: amount, asset: assetOf(d) } : undefined
    const base = { ref, providerRef: s.id, ...(m.detail ? { detail: { code: m.detail, providerStatus: s.status! } } : {}) }
    switch (m.status) {
      case 'succeeded':
        return {
          ...base,
          status: 'succeeded',
          ...(td.transaction_id && CHAIN_HASH.test(td.transaction_id) ? { transactions: [{ role: 'destination' as const, hash: td.transaction_id, ...(d ? { chain: d.chain } : {}) }] } : {}),
          ...(output ? { output } : {}),
        }
      case 'processing':
        return { ...base, status: 'processing', ...(output ? { output } : {}) }
      case 'failed':
        return { ...base, status: 'failed', error: openRampError('PROVIDER_DECLINED', { message: 'Stripe declined this purchase.', recovery: 'choose_other' }) }
      default:
        if (rec) return { ...checkoutStep(ref, { ...rec, onrampSessionId: s.id }, s.client_secret), providerRef: s.id }
        // A webhook: no surface; the UI keeps the checkout.
        return { ...base, status: 'requires_action' }
    }
  }

  // ---------- flow ----------

  /** Create a LinkAuthIntent for `rec.email`. Moves to `authenticate`, or to `register` when Link has no account for the email. */
  async function startAuth(ctx: AdapterContext, ref: string, rec: LegRecord): Promise<LegStep> {
    let intent: { id?: string }
    try {
      intent = await fetchJson<{ id?: string }>(ctx.fetch, `${link}/v1/link_auth_intent`, {
        method: 'POST',
        headers: { authorization: auth, 'content-type': 'application/json' },
        body: JSON.stringify({ email: rec.email, oauth_client_id: opts.oauthClientId, oauth_scopes: LINK_OAUTH_SCOPES }),
      })
    } catch (e) {
      const st = httpStatus(e)
      // 404: "the provided email has no active Link customer" (or our OAuth client is unknown)
      if (st === 404 && rec.stage !== 'register') {
        const next = { ...rec, stage: 'register' as const }
        await saveRecord(ctx, ref, next)
        return stageStep(ref, next)
      }
      // 409: "The Link customer previously revoked the connection with this partner."
      if (st === 409) {
        return { status: 'failed', ref, error: openRampError('PROVIDER_DECLINED', { message: 'Your Link account does not allow this app. Connect it again in Link, or choose another method.', recovery: 'choose_other' }) }
      }
      throw httpErrorToOpenRamp(e, 'Stripe Link', { what: 'start the Link sign-in', noQuoteStatuses: [400], log: ctx.log })
    }
    if (!intent.id) throw new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message: 'Link did not return a sign-in intent.' }), 502)
    const next: LegRecord = { ...rec, stage: 'authenticate', authIntentId: intent.id }
    await saveRecord(ctx, ref, next)
    return stageStep(ref, next)
  }

  /**
   * The token for a call, or a step back to the Link sign-in when it has expired (we keep no refresh
   * token, so the user signs in again).
   */
  async function tokenOrSignIn(ctx: AdapterContext, ref: string, rec: LegRecord): Promise<{ token: string } | { step: LegStep }> {
    const token = await getToken(ctx, ref, rec)
    if (token) return { token }
    return { step: await signInAgain(ctx, ref, rec) }
  }

  /** Forget the token and the client key, and start a new Link sign-in for the same email. */
  async function signInAgain(ctx: AdapterContext, ref: string, rec: LegRecord): Promise<LegStep> {
    await dropToken(ctx, ref)
    const next: LegRecord = { ...rec }
    delete next.keyHash
    delete next.authIntentId
    if (!next.email) {
      next.stage = 'email'
      await saveRecord(ctx, ref, next)
      return stageStep(ref, next)
    }
    return startAuth(ctx, ref, { ...next, stage: 'authenticate' })
  }

  /**
   * The token for a transition from the client that finished the sign-in: the client must send the
   * same `clientKey`. Another client (a pay link, another device) gets a new Link sign-in, which needs
   * the account owner's one-time code. The old token is dropped, so nobody can use it.
   */
  async function clientToken(ctx: AdapterContext, ref: string, rec: LegRecord, key: string): Promise<{ token: string } | { step: LegStep }> {
    if (!rec.keyHash || !CLIENT_KEY.test(key) || !timingSafeEqual(await sha256Hex(key), rec.keyHash)) {
      // Once the onramp session exists, a 3DS check may still be open on the right client: refuse, and
      // keep the leg as it is. Before that, start a new sign-in.
      if (rec.onrampSessionId) {
        ctx.log.warn('stripe-link: checkout without the client key of the Link sign-in; refused', { ref })
        throw bad('Only the device that signed in to Link can pay. To pay here, start the payment again.', 403)
      }
      ctx.log.warn('stripe-link: transition without the client key of the Link sign-in; signing in again', { ref })
      return { step: await signInAgain(ctx, ref, rec) }
    }
    return tokenOrSignIn(ctx, ref, rec)
  }

  /** After the sign-in, and after each KYC step: the KYC check, then the wallet check. */
  async function afterAuth(ctx: AdapterContext, ref: string, rec: LegRecord, token: string, known?: CryptoCustomer): Promise<LegStep> {
    let customer: CryptoCustomer
    if (known) customer = known
    else {
      try {
        customer = await stripeCall<CryptoCustomer>(ctx, 'GET', `/v1/crypto/customers/${encodeURIComponent(rec.customerId!)}`, { token })
      } catch (e) {
        throw toOpenRamp(e, 'check your identity status', ctx.log)
      }
    }
    const kyc = kycState(customer)
    if (kyc === 'rejected') {
      await dropToken(ctx, ref)
      return { status: 'failed', ref, error: openRampError('KYC_REJECTED', { recovery: 'choose_other' }) }
    }
    if (kyc === 'collect' || kyc === 'review') {
      const next: LegRecord = { ...rec, stage: kyc === 'collect' ? 'kyc' : 'kyc_review' }
      await saveRecord(ctx, ref, next)
      return stageStep(ref, next)
    }
    return walletCheck(ctx, ref, rec, token)
  }

  /** Skip the wallet step when the address is already on file for the network. */
  async function walletCheck(ctx: AdapterContext, ref: string, rec: LegRecord, token: string): Promise<LegStep> {
    let list: { data?: ConsumerWallet[] }
    try {
      list = await stripeCall<{ data?: ConsumerWallet[] }>(ctx, 'GET', `/v1/crypto/customers/${encodeURIComponent(rec.customerId!)}/crypto_consumer_wallets`, { token })
    } catch (e) {
      throw toOpenRamp(e, 'check your wallets', ctx.log)
    }
    const evm = rec.network !== 'solana'
    // TO VERIFY: the list shape (`data` with `wallet_address` and `network`, like other Stripe lists).
    const known = (list.data ?? []).some((w) => w.network === rec.network && !!w.wallet_address && (evm ? w.wallet_address.toLowerCase() === rec.wallet.toLowerCase() : w.wallet_address === rec.wallet))
    const next: LegRecord = { ...rec, stage: known ? 'payment_method' : 'wallet' }
    await saveRecord(ctx, ref, next)
    return stageStep(ref, next)
  }

  /** POST /v1/crypto/onramp_sessions with `ui_mode=headless` */
  async function createSession(ctx: AdapterContext, ref: string, rec: LegRecord, token: string): Promise<LegStep> {
    const body = form([
      ['ui_mode', 'headless'],
      ['crypto_customer_id', rec.customerId],
      ['payment_token', rec.paymentToken],
      ['source_amount', rec.sourceAmount],
      ['destination_amount', rec.sourceAmount ? undefined : rec.destinationAmount],
      ['source_currency', rec.sourceCurrency],
      ['destination_currency', 'usdc'],
      ['destination_currencies[]', 'usdc'],
      ['destination_network', rec.network],
      ['destination_networks[]', rec.network],
      ['wallet_address', rec.wallet],
      ['customer_ip_address', ctx.session.ip],
      ['metadata[ork_ref]', ref],
      ['metadata[ork_session]', ctx.session.id],
      ['metadata[ork_leg]', rec.legId],
    ])
    let s: OnrampSession
    try {
      s = await stripeCall<OnrampSession>(ctx, 'POST', '/v1/crypto/onramp_sessions', { body, token, idem: ctx.idempotencyKey(`stripe-link:${rec.nonce}:${rec.paymentToken}`) })
    } catch (e) {
      const code = (e as { body?: { error?: { code?: string } } })?.body?.error?.code
      if (httpStatus(e) === 400 && code === 'crypto_onramp_missing_document_verification') {
        const next: LegRecord = { ...rec, stage: 'documents' }
        await saveRecord(ctx, ref, next)
        return stageStep(ref, next)
      }
      throw toOpenRamp(e, 'start the purchase', ctx.log)
    }
    if (!s.id) throw new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message: 'Stripe did not return an onramp session.' }), 502)
    const next: LegRecord = { ...rec, stage: 'checkout', onrampSessionId: s.id }
    await saveRecord(ctx, ref, next)
    await ctx.shared.put(`cos:${s.id}`, ref, SESSION_INDEX_TTL_SEC)
    const step = sessionStep(s, ref, next, ctx.log) ?? checkoutStep(ref, next)
    if (step.status !== 'requires_action') await dropToken(ctx, ref)
    return step
  }

  /** `kyc_review` on a status poll: a new sign-in, the next KYC step, or the onramp session (under the lease) */
  async function reviewCheck(ctx: AdapterContext, ref: string, rec: LegRecord): Promise<LegStep> {
    const t = await tokenOrSignIn(ctx, ref, rec)
    if ('step' in t) return t.step
    if (rec.paymentToken) {
      let customer: CryptoCustomer
      try {
        customer = await stripeCall<CryptoCustomer>(ctx, 'GET', `/v1/crypto/customers/${encodeURIComponent(rec.customerId!)}`, { token: t.token })
      } catch (e) {
        throw toOpenRamp(e, 'check your identity status', ctx.log)
      }
      const l2 = kycState(customer, 'l2')
      if (l2 === 'ok') return createSession(ctx, ref, rec, t.token)
      if (l2 === 'review') return stageStep(ref, rec)
      const next: LegRecord = { ...rec, stage: 'documents' }
      await saveRecord(ctx, ref, next)
      return stageStep(ref, next)
    }
    return afterAuth(ctx, ref, rec, t.token)
  }

  return createAdapter({
    id: 'stripe-link',
    ...(env ? { env } : {}),
    name: 'Stripe',
    legs,

    async quote(input, ctx) {
      const d = byId.get(input.leg.legId)
      if (!d) throw new OpenRampException(openRampError('BAD_REQUEST', { message: `Unknown Stripe Link leg ${input.leg.legId}` }), 400)
      const target = deliverFor(input.leg.to.asset.kind === 'crypto' ? input.leg.to.asset : undefined)
      const fiatAsset = input.amountIn?.asset ?? input.leg.from.asset
      const fiat = (fiatAsset.kind === 'fiat' ? fiatAsset.currency : 'USD').toLowerCase()
      // TO VERIFY: EUR. The guide mentions EU sessions (`source_currency=eur`), but says the onramp is US only.
      if (fiat !== 'usd') throw new OpenRampException(openRampError('NO_QUOTES', { message: 'Stripe Link takes USD only.' }), 422)
      const q = form([
        ['ui_mode', 'headless'],
        ['source_currency', fiat],
        ['source_amount', input.amountIn ? roundTo(input.amountIn.value, 2) : undefined],
        ['destination_amount', !input.amountIn ? input.amountOut?.value : undefined],
        ['destination_currencies[]', 'usdc'],
        ['destination_networks[]', target.network],
      ])
      let res: QuotesResponse
      try {
        res = await stripeCall<QuotesResponse>(ctx, 'GET', `/v1/crypto/onramp_quotes?${q}`)
      } catch (e) {
        throw toOpenRamp(e, 'price this amount', ctx.log)
      }
      const nq = (res.destination_network_quotes?.[target.network] ?? []).find((x) => (x.destination_currency ?? '').toLowerCase() === 'usdc')
      const out = num(nq?.destination_amount)
      const total = num(nq?.source_total_amount)
      if (!nq || !out || !total) throw new OpenRampException(openRampError('NO_QUOTES', { message: 'Stripe did not return a quote for this amount.' }), 422)
      // "transaction and network fees are added on top of source_amount, so source_total_amount is the total"
      const fiatAmt = (value: string): Amount => ({ value, asset: { kind: 'fiat', currency: 'USD' } })
      const fees: Fee[] = []
      const txFee = num(nq.fees?.transaction_fee_monetary)
      const netFee = num(nq.fees?.network_fee_monetary)
      if (txFee) fees.push({ kind: 'provider', label: 'Stripe fee', amount: fiatAmt(txFee), included: true })
      if (netFee) fees.push({ kind: 'network', label: 'Network fee', amount: fiatAmt(netFee), included: true })
      return {
        adapterId: 'stripe-link',
        legId: d.id,
        input: fiatAmt(total),
        output: { value: out, asset: assetOf(target) },
        fees,
        // "Quotes are informational, and Stripe sets the final amount when you create the session."
        guarantee: 'estimate',
        eta: d.eta,
        expiresAt: quoteExpiresAt(5),
        data: {
          network: target.network,
          sourceCurrency: fiat,
          ...(input.amountIn ? { sourceAmount: roundTo(input.amountIn.value, 2) } : { destinationAmount: out }),
          nonce: randomHex(8),
        },
      }
    },

    async start(input, ctx) {
      const data = (input.quote.data ?? {}) as { network?: Network; sourceCurrency?: string; sourceAmount?: string; destinationAmount?: string; nonce?: string }
      const target = deliverFor(input.quote.output.asset.kind === 'crypto' ? input.quote.output.asset : undefined)
      const wallet = input.deliverTo?.address ?? (ctx.destination.type === 'crypto' ? ctx.destination.address : undefined)
      if (!wallet) throw bad('Stripe needs a wallet address to deliver to.')
      const ref = `slk_${randomHex(12)}`
      // The app's email is locked: the client cannot replace it. A malformed app email is an error,
      // never a reason to ask the client for another one.
      const sessionEmail = ctx.session.email?.trim()
      if (sessionEmail && !EMAIL.test(sessionEmail)) throw bad('The session email is not valid for Link.')
      if (!sessionEmail && opts.requireSessionEmail) throw bad('Stripe Link needs the session email. Create the session with an email.')
      const email = sessionEmail || undefined
      const rec: LegRecord = {
        owner: ownerOf(ctx),
        legId: input.leg.legId,
        stage: email ? 'authenticate' : 'email',
        network: data.network ?? target.network,
        wallet,
        sourceCurrency: data.sourceCurrency ?? 'usd',
        ...(data.sourceAmount ? { sourceAmount: data.sourceAmount } : { destinationAmount: data.destinationAmount ?? input.quote.output.value }),
        nonce: data.nonce ?? randomHex(8),
        ...(email ? { email, emailLocked: true } : {}),
      }
      await saveRecord(ctx, ref, rec)
      return email ? startAuth(ctx, ref, rec) : stageStep(ref, rec)
    },

    async transition({ ref, name, inputs }, ctx) {
      const T = STRIPE_LINK_TRANSITIONS
      const rec = await loadRecord(ctx, ref)
      const str = (k: string) => (typeof inputs?.[k] === 'string' ? (inputs[k] as string).trim() : '')
      const allowed = TRANSITION_STAGES[name]
      if (!allowed) throw bad(`Unknown transition ${name}.`, 409)
      // Each transition runs only from its own stage: a client cannot skip the KYC, wallet or payment method step.
      if (!allowed.includes(rec.stage)) throw bad(`Transition ${name} is not allowed now.`, 409)
      const key = str(STRIPE_LINK_CLIENT_KEY)
      // One change at a time: two transitions that read the same record (two `link_authenticated` calls
      // with their own keys, two checkouts, a checkout and a new sign-in) cannot both run.
      return exclusive(ctx, ref, rec, async () => {
        switch (name) {
          case T.email: {
            // The app's email (and the email of a finished sign-in) never changes.
            if (rec.emailLocked || opts.requireSessionEmail) throw bad('The email of this purchase cannot be changed.', 409)
            const email = str('email')
            if (!EMAIL.test(email)) throw bad('Enter a valid email address.')
            return startAuth(ctx, ref, { ...rec, email, stage: 'authenticate' })
          }
          case T.registered:
            if (!rec.email) throw bad('Enter your email first.', 409)
            return startAuth(ctx, ref, { ...rec, stage: 'authenticate' })
          case T.authenticated: {
            if (!rec.authIntentId) throw bad('Sign in to Link first.', 409)
            const customerId = str('cryptoCustomerId')
            if (!CUSTOMER_ID.test(customerId)) throw bad('Link did not give a customer id.')
            if (!CLIENT_KEY.test(key)) throw bad(`Send a random \`${STRIPE_LINK_CLIENT_KEY}\` of 32 to 128 URL-safe characters.`)
            let tokens: { access_token?: string; expires_in?: number }
            try {
              // The exchange works only after the account owner approved this intent in the Link SDK (one-time code and consent).
              tokens = await fetchJson<{ access_token?: string; expires_in?: number }>(ctx.fetch, `${link}/v1/link_auth_intent/${encodeURIComponent(rec.authIntentId)}/tokens`, {
                method: 'POST',
                headers: { authorization: auth },
              })
            } catch (e) {
              // 403: "LinkAuthIntent hasn't been consented by the user" (also a setup problem; the log says which)
              if (httpStatus(e) === 403) ctx.log.warn('stripe-link: token exchange refused', { message: providerMessage(e) })
              throw httpErrorToOpenRamp(e, 'Stripe Link', { what: 'finish the Link sign-in', noQuoteStatuses: [400, 404], log: ctx.log })
            }
            if (!tokens.access_token) throw new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message: 'Link did not return an access token.' }), 502)
            // The client gives the crypto customer id. Before we keep the token or use the id, check that
            // the token of this sign-in can read that customer, and that Stripe answers with the same id.
            let customer: CryptoCustomer | undefined
            try {
              customer = await stripeCall<CryptoCustomer>(ctx, 'GET', `/v1/crypto/customers/${encodeURIComponent(customerId)}`, { token: tokens.access_token })
            } catch (e) {
              const st = httpStatus(e)
              if (st !== 401 && st !== 403 && st !== 404) throw toOpenRamp(e, 'check your identity status', ctx.log)
            }
            if (!customer || customer.id !== customerId) {
              ctx.log.warn('stripe-link: the crypto customer id does not belong to the Link sign-in; signing in again', { ref })
              // The intent is used up. Start a new sign-in. The token is never stored.
              return signInAgain(ctx, ref, rec)
            }
            // Only the access token: a refresh token in the response is dropped here and never stored.
            await putToken(ctx, ref, customerId, tokens.access_token, tokens.expires_in)
            // The intent is used up: forget its id. The email is now the one of a signed-in account: lock it.
            const next: LegRecord = { ...rec, customerId, stage: 'kyc', emailLocked: true, keyHash: await sha256Hex(key) }
            delete next.authIntentId
            await saveRecord(ctx, ref, next)
            return afterAuth(ctx, ref, next, tokens.access_token, customer)
          }
          case T.kyc:
          case T.documents: {
            if (!rec.customerId) throw bad('Sign in to Link first.', 409)
            const t = await clientToken(ctx, ref, rec, key)
            if ('step' in t) return t.step
            if (name === T.documents && rec.paymentToken) {
              // After an identity challenge: retry the session when the documents are verified.
              let customer: CryptoCustomer
              try {
                customer = await stripeCall<CryptoCustomer>(ctx, 'GET', `/v1/crypto/customers/${encodeURIComponent(rec.customerId)}`, { token: t.token })
              } catch (e) {
                throw toOpenRamp(e, 'check your identity status', ctx.log)
              }
              const l2 = kycState(customer, 'l2')
              if (l2 === 'ok') return createSession(ctx, ref, rec, t.token)
              if (l2 === 'review') {
                const next: LegRecord = { ...rec, stage: 'kyc_review' }
                await saveRecord(ctx, ref, next)
                return stageStep(ref, next)
              }
              // Not verified: "call verifyDocuments again"
              const next: LegRecord = { ...rec, stage: 'documents' }
              await saveRecord(ctx, ref, next)
              return stageStep(ref, next)
            }
            return afterAuth(ctx, ref, rec, t.token)
          }
          case T.wallet: {
            if (!rec.customerId) throw bad('Sign in to Link first.', 409)
            const t = await clientToken(ctx, ref, rec, key)
            if ('step' in t) return t.step
            // The address is always the leg's own (set by the server at start), never an input.
            const step = await walletCheck(ctx, ref, rec, t.token)
            if (step.action?.transitions[0]?.name === T.wallet) throw bad('Stripe does not list this wallet for your Link account yet. Try again.', 409)
            return step
          }
          case T.paymentMethod: {
            if (!rec.customerId) throw bad('Sign in to Link first.', 409)
            const paymentToken = str('paymentToken')
            if (!PAYMENT_TOKEN.test(paymentToken)) throw bad('Stripe did not give a payment token.')
            const t = await clientToken(ctx, ref, rec, key)
            if ('step' in t) return t.step
            return createSession(ctx, ref, { ...rec, paymentToken }, t.token)
          }
          case T.checkout: {
            if (!rec.onrampSessionId) throw bad('There is no purchase to pay yet.', 409)
            const t = await clientToken(ctx, ref, rec, key)
            if ('step' in t) return t.step
            // "For users paying with ACH, you also need to pass mandate_data and collect the user's ip address and user agent."
            // TO VERIFY: the mandate_data keys (the guide names the parameter only; these are the usual Stripe keys).
            const ach = byId.get(rec.legId)?.types.includes('us_bank_account')
            const ua = str('userAgent').slice(0, 500)
            if (ach && (!ctx.session.ip || !ua)) throw bad('ACH needs your IP address and browser user agent for the mandate.')
            const body = ach
              ? form([
                  ['mandate_data[customer_acceptance][type]', 'online'],
                  ['mandate_data[customer_acceptance][online][ip_address]', ctx.session.ip],
                  ['mandate_data[customer_acceptance][online][user_agent]', ua],
                ])
              : undefined
            let s: OnrampSession
            try {
              // The SDK calls again after a next action (3DS), and each call is a new attempt: the key has the
              // record version, which each checkout moves on. Two calls from the same version (only possible
              // where the lease is not atomic, on Workers KV) send the same key, so Stripe runs one checkout.
              s = await stripeCall<OnrampSession>(ctx, 'POST', `/v1/crypto/onramp_sessions/${encodeURIComponent(rec.onrampSessionId)}/checkout`, {
                token: t.token,
                idem: ctx.idempotencyKey(`stripe-link:checkout:${rec.onrampSessionId}:${rec.v ?? 0}`),
                ...(body ? { body } : {}),
              })
            } catch (e) {
              throw toOpenRamp(e, 'take the payment', ctx.log)
            }
            const step = sessionStep(s, ref, rec, ctx.log) ?? checkoutStep(ref, rec, s.client_secret)
            if (step.status !== 'requires_action') await dropToken(ctx, ref)
            return step
          }
          default:
            throw bad(`Unknown transition ${name}.`, 409)
        }
      })
    },

    async status(input, ctx) {
      const rec = await loadRecord(ctx, input.ref)
      if (rec.onrampSessionId) {
        let s: OnrampSession
        try {
          // TO VERIFY: whether a retrieve needs `Stripe-OAuth-Token`. We send it while we still have it.
          const token = await getToken(ctx, input.ref, rec)
          s = await stripeCall<OnrampSession>(ctx, 'GET', `/v1/crypto/onramp_sessions/${encodeURIComponent(rec.onrampSessionId)}`, token ? { token } : {})
        } catch (e) {
          throw toOpenRamp(e, 'find this purchase', ctx.log)
        }
        // An unknown status is no event: the leg keeps its checkout step.
        const step = sessionStep(s, input.ref, rec, ctx.log) ?? checkoutStep(input.ref, rec)
        if (step.status !== 'requires_action') {
          await dropToken(ctx, input.ref)
          return step
        }
        // A status poll has no surface: the client keeps the one it has (with its client secret).
        return { ...step, action: { kind: 'payment', transitions: step.action!.transitions } }
      }
      if (rec.stage === 'kyc_review' && rec.customerId) {
        // This check can move the leg (a new sign-in, the onramp session): only under the lease. When a
        // transition holds it, the poll changes nothing and the next poll checks again.
        const release = await lease(ctx, input.ref, rec)
        if (!release) return stageStep(input.ref, rec)
        try {
          return await reviewCheck(ctx, input.ref, rec)
        } finally {
          await release()
        }
      }
      return stageStep(input.ref, rec)
    },

    async cancel(input, ctx) {
      // No cancel call in the API: forget the token, so nothing can use it after the user left.
      await dropToken(ctx, input.ref)
    },

    webhook: {
      configured: !!opts.webhookSecret,
      async verify(req, rawBody, ctx) {
        // An empty key would let anyone sign (for example an unset environment variable).
        if (!opts.webhookSecret) {
          ctx.log.warn('stripe-link: webhookSecret is not set; rejecting webhook')
          return false
        }
        // `t=<unix s>,v1=<hex HMAC-SHA256 over "{t}.{body}">`; every v1 is tried (secret rotation)
        return verifyTimestampedHmac({ secret: opts.webhookSecret, rawBody, header: req.headers.get('stripe-signature'), toleranceSec: TOLERANCE_SEC })
      },
      async replayKey(_req, rawBody) {
        try {
          const id = (JSON.parse(rawBody) as { id?: unknown }).id
          return typeof id === 'string' && id ? `evt:${id}` : undefined
        } catch {
          return undefined
        }
      },
      async parse(rawBody, ctx) {
        let ev: { id?: string; type?: string; data?: { object?: OnrampSession } }
        try {
          ev = JSON.parse(rawBody) as typeof ev
        } catch {
          ctx.log.warn('stripe-link: webhook body is not JSON')
          return []
        }
        if (ev.type !== 'crypto.onramp_session.updated') return []
        const s = ev.data?.object
        if (!s?.id) return []
        // Only sessions this adapter made. Our own index (written when we created the session) wins. The
        // metadata ref is used only when the index entry has expired; when both exist, they must agree.
        const meta = s.metadata?.ork_ref
        const metaRef = typeof meta === 'string' && /^slk_[0-9a-f]{24}$/.test(meta) ? meta : undefined
        const indexed = await ctx.shared.get<string>(`cos:${s.id}`)
        if (indexed && meta !== undefined && meta !== indexed) {
          ctx.log.warn('stripe-link: webhook metadata ref does not match the session index; ignored', { onrampSession: s.id })
          return []
        }
        const ref = indexed ?? metaRef
        if (!ref) return []
        const step = sessionStep(s, ref, undefined, ctx.log)
        if (!step) return []
        const out: LegEvent = { ...step, ref, ...(ev.id ? { eventId: ev.id } : {}) }
        return [out]
      },
    },
  })
}
