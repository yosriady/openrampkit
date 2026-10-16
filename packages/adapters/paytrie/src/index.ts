// PayTrie adapter: buy USDC with CAD by Interac e-Transfer, for users in Canada, through the PayTrie
// Platform API v2 (https://docs.paytrie.com/v2). The purchase runs in the app's own screens; PayTrie
// shows only its sign-up page and its KYC page (Sumsub).
//
// Flow (all from the v2 docs, 2026-10-16, except where marked TO VERIFY):
// 1. Account. GET /v2/users?email= (x-api-key) gives the PayTrie user id, or an empty list. With no
//    account, the user signs up on the PayTrie page (https://app.paytrie.com/SignupEmail), then comes back.
// 2. Sign-in. POST /v2/auth/login-codes { email } emails a 4-digit code (always 202). POST
//    /v2/auth/login-codes/verify { email, code } gives a JWT access token (`expiresIn` 3600). We seal it
//    (AES-256-GCM) in the session store and never send it to the client. No refresh token exists: when it
//    expires, the user asks for a new code.
// 3. KYC. GET /v2/users/{id} gives `status` (initial, active, verified, rejected, inactive, upload,
//    in-review). Before `verified`, GET /v2/users/{id}/kyc-url gives the PayTrie KYC page (Sumsub). The
//    kit never sees or stores KYC data.
// 4. Quote. GET /v2/quotes?leftSideLabel=CAD&leftSideValue=..&rightSideLabel=USDC-BASE gives `quoteId`,
//    `rightSideValue` and a fee `breakdown`. A `quoteId` prices the transaction when it is less than about
//    10 minutes old; after that PayTrie uses its latest rate.
// 5. Order. POST /v2/transactions { leftSideLabel, leftSideValue, rightSideLabel, wallet, quoteId,
//    externalSessionId } with the user's token. The answer has the transaction `id`, `status`
//    (`awaiting-fiat`) and `rmtId`, the Interac reference. The user pays by Interac e-Transfer within 1 hour.
// 6. Result. GET /v2/transactions/{id} (with the user's token), and the `transaction.update` webhook
//    (`X-Paytrie-Timestamp`, `X-Paytrie-Signature: v1=<hex HMAC-SHA256 of "{timestamp}.{body}">`).
//    PayTrie sends each webhook once and does not retry.
//
// Every call sends `x-api-key`. Limits: 10 to 9,999 CAD per transaction for the Platform API, 9,999 CAD
// per 24 hours, 3 open transactions per user. PayTrie documents no sandbox host.
//
// Server-side only. Web-standard APIs only (fetch, WebCrypto), so it runs on Cloudflare Workers.

import {
  POLL as POLLS,
  awaitPoll,
  claimOnce,
  createAdapter,
  deliverableToAsset,
  fetchJson,
  httpErrorToOpenRamp,
  httpStatus,
  legStepFromEvent,
  quoteExpiresAt,
  randomHex,
  requireDeliverAsset,
  resolveEnv,
  statusMap,
  verifyTimestampedHmac,
  webhookBodyKey,
} from '@openrampkit/adapter'
import type { AdapterContext, AdapterEnv, DeliverableAsset, LegEvent, Logger } from '@openrampkit/adapter'
import { OpenRampException, SOLANA_MAINNET, USDC, fromScaled, isDecimal, isWebUrl, openRampError, roundTo, toScaled } from '@openrampkit/core'
import type { Amount, Fee, FieldSpec, LegSpec, LegStatus, LegStep, OpenRampErrorCode, PollSpec, StepDetailCode, Surface, Transition } from '@openrampkit/core'
import { seal, sealKey, unseal } from './seal.js'

/** A token PayTrie delivers, with its PayTrie label (`rightSideLabel`), for example `USDC-BASE` */
export type PaytrieDeliverAsset = DeliverableAsset & { label: string }

export type PaytrieOptions = {
  /** Developer API key (`x-api-key`), from support@paytrie.com. Server-side only. */
  apiKey: string
  /**
   * Webhook signing secret (`whsec_...`), returned by the first `PUT /v2/webhook-configurations` or by the
   * rotate call. Without it, every webhook is rejected and the adapter relies on status checks.
   */
  webhookSecret?: string
  /**
   * 'production' (the default, https://api.paytrie.com). PayTrie documents no sandbox host: 'sandbox'
   * needs `apiUrl` (a test host that PayTrie gives you).
   */
  env?: AdapterEnv
  /** Override the API host */
  apiUrl?: string
  /**
   * Secret for the key that encrypts the user's PayTrie access token in the session store (at least 32
   * characters). Default: a key derived from `apiKey`. Set your own so that a leak of the store and of
   * one key is not enough.
   */
  tokenKey?: string
  /**
   * Only the session's own `email` (set by the app at session creation) may sign in to PayTrie. With
   * true, a session with no email cannot start this leg. Default false: a session with no email asks
   * the user for one. A session email is always locked: the client cannot change it.
   */
  requireSessionEmail?: boolean
  /** Tokens PayTrie may deliver, most preferred first. Default: USDC on Base, Ethereum, Arbitrum, Optimism, Polygon and Solana. */
  deliverAssets?: PaytrieDeliverAsset[]
  /** The PayTrie sign-up page for users with no account. Default https://app.paytrie.com/SignupEmail */
  signupUrl?: string
}

/** USDC labels from the Price Quotes page (2026-10-16). Celo, Avalanche, BNB and SX also exist; add them with `deliverAssets`. */
export const PAYTRIE_DELIVER_ASSETS: PaytrieDeliverAsset[] = [
  { chain: 'eip155:8453', token: USDC['eip155:8453']!, label: 'USDC-BASE', symbol: 'USDC', decimals: 6 },
  { chain: 'eip155:1', token: USDC['eip155:1']!, label: 'USDC-ETH', symbol: 'USDC', decimals: 6 },
  { chain: 'eip155:42161', token: USDC['eip155:42161']!, label: 'USDC-ARB', symbol: 'USDC', decimals: 6 },
  { chain: 'eip155:10', token: USDC['eip155:10']!, label: 'USDC-OP', symbol: 'USDC', decimals: 6 },
  { chain: 'eip155:137', token: USDC['eip155:137']!, label: 'USDC-POLY', symbol: 'USDC', decimals: 6 },
  { chain: SOLANA_MAINNET, token: USDC[SOLANA_MAINNET]!, label: 'USDC-SOL', symbol: 'USDC', decimals: 6 },
]

/** "Transactions created through the Platform API are accepted down to $10 CAD" (Limits page) */
export const PAYTRIE_MIN_CAD = '10'
/** "Per transaction: up to $9,999 CAD" (Limits page; GET /v2/limits can be higher per account) */
export const PAYTRIE_MAX_CAD = '9999'

/** Names of the transitions the client calls */
export const PAYTRIE_TRANSITIONS = {
  email: 'submit_email',
  signedUp: 'signed_up',
  sendCode: 'send_code',
  code: 'submit_code',
  resend: 'resend_code',
  kycDone: 'kyc_done',
} as const

type Stage = 'email' | 'signup' | 'signin' | 'code' | 'kyc' | 'kyc_review' | 'payment'

/** The stages from which each transition may run. Anything else is a 409. */
const TRANSITION_STAGES: Record<string, Stage[]> = {
  [PAYTRIE_TRANSITIONS.email]: ['email', 'signup'],
  [PAYTRIE_TRANSITIONS.signedUp]: ['signup'],
  [PAYTRIE_TRANSITIONS.sendCode]: ['signin'],
  [PAYTRIE_TRANSITIONS.code]: ['code'],
  [PAYTRIE_TRANSITIONS.resend]: ['code'],
  [PAYTRIE_TRANSITIONS.kycDone]: ['kyc', 'kyc_review'],
}

/** What we keep per leg in the session store. No secret: the token is sealed under its own key. No KYC data. */
type LegRecord = {
  /** `{session id}:{user id}` of the session that started the leg. Every load checks it. */
  owner: string
  legId: string
  stage: Stage
  /** Set by the server at start (`deliverTo` or the session destination). Never a client input. */
  wallet: string
  chain: string
  /** PayTrie label of the token, e.g. `USDC-BASE` */
  label: string
  /** CAD the user pays (`leftSideValue`) */
  cad: string
  quoteId?: number
  quotedAt?: number
  email?: string
  /** The email came from the app (the session) or a finished sign-in, so the client cannot change it */
  emailLocked?: boolean
  userId?: string
  /** `accessibleBy` lists `apiKey`: our API key alone reads this user's transactions */
  apiKeyAccess?: boolean
  codesSent: number
  wrongCodes: number
  kycUrl?: string
  /** When the KYC link expires (ms) */
  kycUntil?: number
  /** Each transaction creation claims `c:{ref}:{createAttempt}` once. A clean refusal moves it on. */
  createAttempt: number
  txId?: string
  rmtId?: string
  /** The change counter (see `lease`) */
  v?: number
}

/** The shared index of our transactions. Webhooks find the leg only through it. */
type TxIndex = { ref: string; wallet: string; chain: string; label: string }

/** GET /v2/quotes `data` */
type PtQuote = {
  quoteId?: number
  leftSideLabel?: string
  leftSideValue?: number | string
  rightSideLabel?: string
  rightSideValue?: number | string
  breakdown?: { paytrieFee?: number | string; gasFee?: number | string }
}

/** A transaction (POST /v2/transactions, GET /v2/transactions/{id}) */
type PtTransaction = {
  id?: string
  status?: string
  leftSideLabel?: string
  leftSideValue?: number | string
  rightSideLabel?: string
  rightSideValue?: number | string
  wallet?: string
  paymentType?: string
  paymentId?: string | null
  rmtId?: string | null
}

/** The `transaction.update` webhook payload */
type PtTxPayload = PtTransaction & { transactionId?: string; externalSessionId?: string | null }

type PtEnvelope = { id?: string; eventId?: string; apiVersion?: string; type?: string; payload?: PtTxPayload }

const POLL: PollSpec = POLLS.checkout
const QUOTE_TTL_MIN = 5
/** "When provided and still fresh (within ~10 minutes), the transaction is priced against that exact quote." We stop at 9. */
const QUOTE_ID_FRESH_MS = 9 * 60_000
/** Interac e-Transfer: minutes after the user pays. TO VERIFY with a live order. */
const ETA = { min: 600, max: 4 * 3600 }
const TOLERANCE_SEC = 5 * 60
const RECORD_TTL_SEC = 24 * 3600
const LEASE_TTL_SEC = 120
/** The access token lives 1 hour. We drop it a little sooner, so a call never starts with a dead token. */
const TOKEN_MARGIN_SEC = 60
/** How long webhooks can find a transaction's leg */
const INDEX_TTL_SEC = 30 * 24 * 3600
/** Wrong codes before the user must ask for a new code, and codes per leg */
export const PAYTRIE_MAX_WRONG_CODES = 5
export const PAYTRIE_MAX_CODES = 3

const EMAIL = /^[^\s@]{1,200}@[^\s@]{1,200}\.[^\s@]{2,}$/
const CODE = /^\d{4}$/
const ID = /^[A-Za-z0-9-]{1,64}$/
/** A chain transaction hash (EVM hex or a Solana signature). The docs example has `paymentId: "pay_123456789"`, which is not one. */
const CHAIN_HASH = /^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{64,90})$/

/**
 * PayTrie transaction statuses (Transactions page). Buy statuses only; the sell statuses
 * (`awaiting-crypto`, `sending-fiat`) and anything new are unknown: the leg keeps its current step.
 * Only `complete` is a success.
 */
const STATUS = statusMap<{ status: LegStatus; detail?: StepDetailCode }>('PayTrie', {
  'awaiting-fiat': { status: 'requires_action', detail: 'bank_details' },
  'processing-fiat': { status: 'processing', detail: 'processing' },
  'finalizing-fiat': { status: 'processing', detail: 'settling' },
  'sending-crypto': { status: 'processing', detail: 'confirming' },
  complete: { status: 'succeeded' },
  cancelled: { status: 'failed' },
  // "Transaction expired before payment (clean timeout)"
  expired: { status: 'expired' },
  // "Expired with funds to reconcile": the user paid late. Not a success; PayTrie support settles it.
  'expired-contact-support': { status: 'failed' },
  refunded: { status: 'refunded' },
  // TO VERIFY: what replaces the transaction. A new transaction id is not ours, so this leg cannot follow it.
  replaced: { status: 'failed' },
})

/** PayTrie user statuses (Webhooks page) */
const USER_KYC: Record<string, 'ok' | 'collect' | 'review' | 'rejected' | 'inactive'> = {
  verified: 'ok',
  // TO VERIFY: whether `active` means "email verified, no KYC yet" (we send the user to KYC).
  initial: 'collect',
  active: 'collect',
  upload: 'collect',
  'in-review': 'review',
  rejected: 'rejected',
  inactive: 'inactive',
}

/** The hex HMAC-SHA256 that PayTrie sends in `X-Paytrie-Signature` (after `v1=`) */
export async function paytrieSignature(secret: string, timestamp: string, rawBody: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}.${rawBody}`)))
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** A provider decimal (string or number) as a decimal string with at most `digits` fraction digits and no trailing zeros */
function dec(v: string | number | null | undefined, digits: number): string | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const s = typeof v === 'number' ? (Number.isFinite(v) ? v.toFixed(digits) : '') : v.trim()
  if (!isDecimal(s)) return undefined
  return fromScaled(toScaled(s, digits), digits)
}

const positive = (v: string | undefined): v is string => v !== undefined && Number(v) > 0

/** The same address: EVM without case, other chains exactly */
function sameAddress(chain: string, a: string | undefined, b: string): boolean {
  if (typeof a !== 'string' || !a) return false
  return chain.startsWith('eip155:') ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** `j***@example.com` */
function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  if (at < 1) return email
  return `${email[0]}***${email.slice(at)}`
}

/** The answer's `data` (v2 wraps every answer in `{ success, data }`) */
function unwrap<T>(res: unknown): T | undefined {
  if (!res || typeof res !== 'object') return undefined
  const r = res as { success?: unknown; data?: unknown }
  if (r.success === false) return undefined
  return r.data as T | undefined
}

/** The first message of a PayTrie error body `{ success: false, errors: [{ field, message }] }` */
function ptMessage(e: unknown): string | undefined {
  const body = (e as { body?: unknown } | undefined)?.body
  const errs = body && typeof body === 'object' ? (body as { errors?: unknown }).errors : undefined
  if (!Array.isArray(errs)) return undefined
  for (const x of errs) {
    const m = x && typeof x === 'object' ? (x as { message?: unknown }).message : undefined
    if (typeof m === 'string' && m.trim()) return m.trim().slice(0, 200)
  }
  return undefined
}

function bad(message: string, status = 400, code: OpenRampErrorCode = 'BAD_REQUEST'): OpenRampException {
  return new OpenRampException(openRampError(code, { message }), status)
}

export function paytrie(opts: PaytrieOptions) {
  if (!opts.apiKey) throw new Error('paytrie: apiKey is required (ask support@paytrie.com for a developer API key)')
  if (opts.tokenKey !== undefined && opts.tokenKey.length < 32) throw new Error('paytrie: tokenKey must have at least 32 characters')
  const env = resolveEnv('paytrie', opts.env, undefined, 'production')
  if (env === 'sandbox' && !opts.apiUrl) throw new Error('paytrie: PayTrie documents no sandbox host. Set apiUrl to the test host that PayTrie gives you, or use env: production.')
  const api = `${(opts.apiUrl ?? 'https://api.paytrie.com').replace(/\/+$/, '')}/v2`
  const signupUrl = opts.signupUrl ?? 'https://app.paytrie.com/SignupEmail'
  if (!isWebUrl(signupUrl)) throw new Error('paytrie: signupUrl must be an https URL')
  const deliver = opts.deliverAssets?.length ? opts.deliverAssets : PAYTRIE_DELIVER_ASSETS
  for (const d of deliver) if (!/^[A-Z0-9]{2,10}-[A-Z0-9]{2,10}$/.test(d.label)) throw new Error(`paytrie: deliverAssets label ${d.label} is not a PayTrie label like USDC-BASE`)
  const toChains: Record<string, string[]> = {}
  for (const d of deliver) (toChains[d.chain] ??= []).push(d.chain.startsWith('eip155:') ? d.token.toLowerCase() : d.token)
  let keyPromise: Promise<CryptoKey> | undefined
  const tokenKey = () => (keyPromise ??= sealKey(opts.tokenKey ?? `paytrie:${opts.apiKey}`))

  const legs: LegSpec[] = [
    {
      id: 'interac',
      kind: 'fiat_onramp',
      methods: ['interac'],
      from: { asset: { kind: 'fiat', currencies: ['CAD'] }, location: ['user_account'] },
      to: { asset: { kind: 'crypto', chains: toChains }, location: ['address'] },
      // PayTrie serves Canadian residents (Interac e-Transfer, CAD only).
      regions: { allow: ['CA'], deny: [] },
      eta: ETA,
      limits: { min: PAYTRIE_MIN_CAD, max: PAYTRIE_MAX_CAD, currency: 'CAD' },
      surfaces: ['BANK_FIELDS', 'OTP', 'FORM', 'REDIRECT'],
      requires: ['provider_account', 'provider_kyc', 'otp'],
    },
  ]

  /** A PayTrie call. `token` is the user's access token; without it only `x-api-key` goes. */
  async function call<T>(ctx: Pick<AdapterContext, 'fetch'>, method: 'GET' | 'POST' | 'PUT', path: string, o: { body?: unknown; token?: string } = {}): Promise<T | undefined> {
    const res = await fetchJson<unknown>(ctx.fetch, `${api}${path}`, {
      method,
      headers: { 'x-api-key': opts.apiKey, ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
      ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
    })
    return unwrap<T>(res)
  }

  const toOpenRamp = (e: unknown, what: string, log: Pick<Logger, 'warn' | 'error'>) =>
    httpErrorToOpenRamp(e, 'PayTrie', { what, log, setupHint: 'Check the PayTrie apiKey (x-api-key) and the host (apiUrl).' })

  // ---------- leg record and token ----------

  const recKey = (ref: string) => `r:${ref}`
  const tokKey = (ref: string) => `t:${ref}`
  const indexKey = (txId: string) => `ptx:${txId}`
  const ownerOf = (ctx: Pick<AdapterContext, 'session'>) => `${ctx.session.id}:${ctx.session.userId}`
  const gone = () => new OpenRampException(openRampError('SESSION_EXPIRED', { message: 'This PayTrie purchase is no longer open. Start again.' }), 410)

  async function loadRecord(ctx: AdapterContext, ref: string): Promise<LegRecord> {
    const rec = await ctx.store.get<LegRecord>(recKey(ref))
    if (!rec) throw gone()
    // A record of another session or another app user (for example a shared or copied store) is never used.
    if (rec.owner !== ownerOf(ctx)) {
      ctx.log.warn('paytrie: leg record of another session or user; refused', { ref })
      throw gone()
    }
    return rec
  }

  const saveRecord = (ctx: AdapterContext, ref: string, rec: LegRecord) => ctx.store.put(recKey(ref), rec, RECORD_TTL_SEC)

  /**
   * Take the lease of the leg at the version of `rec`: one atomic claim (`claimOnce` on `l:{ref}:{v}`),
   * so exactly one change runs from a given record. Returns the release, which adds 1 to the version,
   * or undefined when another change holds or held this version.
   */
  async function lease(ctx: AdapterContext, ref: string, rec: LegRecord): Promise<(() => Promise<void>) | undefined> {
    const v = rec.v ?? 0
    if (!(await claimOnce(ctx.store, `l:${ref}:${v}`, randomHex(12), LEASE_TTL_SEC))) return undefined
    return async () => {
      const cur = await ctx.store.get<LegRecord>(recKey(ref))
      if (cur && (cur.v ?? 0) === v) await saveRecord(ctx, ref, { ...cur, v: v + 1 })
    }
  }

  /** Run one change of the leg under its lease. Another change of the same record gets a 409. */
  async function exclusive<T>(ctx: AdapterContext, ref: string, rec: LegRecord, fn: () => Promise<T>): Promise<T> {
    const release = await lease(ctx, ref, rec)
    if (!release) {
      ctx.log.warn('paytrie: another request changes this leg; refused', { ref })
      throw bad('Another request is changing this purchase. Try again.', 409, 'CONFLICT')
    }
    try {
      return await fn()
    } finally {
      await release()
    }
  }

  /** A sealed token opens only for this session, app user, leg and email. */
  const tokenAad = (ctx: Pick<AdapterContext, 'session'>, ref: string, email: string) => `${ctx.session.id}\n${ctx.session.userId}\n${ref}\n${email}`

  async function putToken(ctx: AdapterContext, ref: string, email: string, token: string, expiresIn: unknown): Promise<void> {
    const life = typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600
    const ttl = Math.max(1, Math.min(3600, life) - TOKEN_MARGIN_SEC)
    await ctx.store.put(tokKey(ref), await seal(await tokenKey(), token, tokenAad(ctx, ref, email)), ttl)
  }

  async function getToken(ctx: AdapterContext, ref: string, rec: LegRecord): Promise<string | undefined> {
    if (!rec.email || !rec.emailLocked) return undefined
    return unseal(await tokenKey(), await ctx.store.get(tokKey(ref)), tokenAad(ctx, ref, rec.email))
  }

  /** ScopedKV has no delete: overwrite the token with a 1 second TTL. */
  const dropToken = (ctx: AdapterContext, ref: string) => ctx.store.put(tokKey(ref), null, 1)

  // ---------- steps ----------

  const submit = (name: string, label = 'Continue', inputs?: FieldSpec[]): Transition => ({ name, kind: 'SUBMIT', label, ...(inputs ? { inputs } : {}) })

  /** The Interac payment details. TO VERIFY with a live order: the user accepts an Interac request (`rmtId`, "request money transfer"). */
  function paymentSurface(rec: LegRecord): Surface {
    const fields = [
      { label: 'Pay with', value: 'Interac e-Transfer', copy: false },
      { label: 'Amount (CAD)', value: rec.cad, copy: true },
      ...(rec.rmtId ? [{ label: 'Interac reference', value: rec.rmtId, copy: true }] : []),
      {
        label: 'How to pay',
        value: `PayTrie sends an Interac e-Transfer request to ${rec.email ? maskEmail(rec.email) : 'your PayTrie email'}. Accept it in your online banking within 1 hour.`,
        copy: false,
      },
    ]
    return { kind: 'BANK_FIELDS', fields }
  }

  function stageStep(ref: string, rec: LegRecord): LegStep {
    const T = PAYTRIE_TRANSITIONS
    const base = { status: 'requires_action' as const, ref }
    switch (rec.stage) {
      case 'email':
        return { ...base, action: { kind: 'auth', surface: { kind: 'FORM', fields: [{ id: 'email', label: 'PayTrie email', type: 'email', required: true }] }, transitions: [submit(T.email)] } }
      case 'signup':
        return {
          ...base,
          action: { kind: 'auth', surface: { kind: 'REDIRECT', url: signupUrl, popup: true, provider: 'PayTrie' }, transitions: [submit(T.signedUp, 'I have a PayTrie account')] },
        }
      case 'signin':
        // The access token expired: the user asks for a new code. A poll never sends an email by itself.
        return { ...base, action: { kind: 'auth', surface: { kind: 'FORM', fields: [] }, transitions: [submit(T.sendCode, 'Email me a PayTrie code')] } }
      case 'code':
        return {
          ...base,
          action: {
            kind: 'auth',
            surface: { kind: 'OTP', channel: 'email', to: rec.email ? maskEmail(rec.email) : '' },
            transitions: [submit(T.code, 'Continue', [{ id: 'code', label: 'Code', type: 'text', required: true }]), submit(T.resend, 'Send a new code')],
          },
        }
      case 'kyc':
        return {
          ...base,
          detail: { code: 'kyc_verify' },
          action: {
            kind: 'kyc',
            surface: { kind: 'REDIRECT', url: rec.kycUrl ?? signupUrl, popup: true, provider: 'PayTrie' },
            transitions: [submit(T.kycDone, 'I finished'), awaitPoll(POLL)],
          },
        }
      case 'kyc_review':
        return { status: 'processing', phase: 'kyc', ref, detail: { code: 'kyc_review' }, poll: POLL }
      case 'payment':
        return {
          ...base,
          ...(rec.txId ? { providerRef: rec.txId } : {}),
          detail: { code: 'bank_details', providerStatus: 'awaiting-fiat' },
          action: { kind: 'payment', surface: paymentSurface(rec), transitions: [awaitPoll(POLL)] },
        }
    }
  }

  /**
   * A leg event from a transaction of this leg. `undefined` for an unknown status, or for a transaction
   * that does not deliver the leg's token to the leg's wallet (fail closed: never a success).
   */
  function txEvent(t: PtTransaction, ref: string, bind: { wallet: string; chain: string; label: string }, txId: string, log: Pick<Logger, 'warn' | 'error'>): LegEvent | undefined {
    if (t.wallet !== undefined && !sameAddress(bind.chain, t.wallet, bind.wallet)) {
      log.error('paytrie: transaction wallet is not the leg wallet; ignored', { ref })
      return undefined
    }
    if (t.rightSideLabel !== undefined && t.rightSideLabel !== bind.label) {
      log.error('paytrie: transaction token is not the leg token; ignored', { ref })
      return undefined
    }
    if (t.leftSideLabel !== undefined && t.leftSideLabel !== 'CAD') return undefined
    const m = STATUS(t.status, log)
    if (!m) return undefined
    // A success must name the leg's wallet and token (a missing field is not enough).
    if (m.status === 'succeeded' && (!sameAddress(bind.chain, t.wallet, bind.wallet) || t.rightSideLabel !== bind.label)) {
      log.error('paytrie: a complete transaction without the leg wallet and token; ignored', { ref })
      return undefined
    }
    const base: LegEvent = { ref, status: m.status, providerRef: txId, ...(m.detail ? { detail: { code: m.detail, providerStatus: t.status! } } : {}) }
    const d = deliver.find((x) => x.label === bind.label && x.chain === bind.chain)
    const value = d ? dec(t.rightSideValue, d.decimals ?? 6) : undefined
    const output: Amount | undefined = d && positive(value) ? { value, asset: deliverableToAsset(d) } : undefined
    const hash = typeof t.paymentId === 'string' && CHAIN_HASH.test(t.paymentId) ? t.paymentId : undefined
    const transactions = hash ? [{ role: 'destination' as const, hash, chain: bind.chain }] : undefined
    switch (m.status) {
      case 'succeeded':
        return { ...base, ...(transactions ? { transactions } : {}), ...(output ? { output } : {}) }
      case 'processing':
        return { ...base, ...(transactions ? { transactions } : {}) }
      case 'failed':
        return {
          ...base,
          error:
            t.status === 'expired-contact-support'
              ? openRampError('PAYMENT_FAILED', { message: 'PayTrie received your payment after the order expired. Contact PayTrie support to settle it.', recovery: 'contact_support' })
              : openRampError('PROVIDER_DECLINED', { message: 'PayTrie cancelled this order. Contact PayTrie support for details.', recovery: 'contact_support' }),
        }
      default:
        return base
    }
  }

  // ---------- flow ----------

  /** GET /v2/users?email=: the user id, or the sign-up step when PayTrie has no account for the email */
  async function findUser(ctx: AdapterContext, ref: string, rec: LegRecord): Promise<LegStep> {
    let list: Array<{ id?: string; accessibleBy?: string[] }> | undefined
    try {
      list = await call<Array<{ id?: string; accessibleBy?: string[] }>>(ctx, 'GET', `/users?email=${encodeURIComponent(rec.email!)}`)
    } catch (e) {
      throw toOpenRamp(e, 'find your PayTrie account', ctx.log)
    }
    const user = Array.isArray(list) ? list.find((u) => typeof u?.id === 'string' && ID.test(u.id)) : undefined
    if (!user) {
      const next: LegRecord = { ...rec, stage: 'signup' }
      await saveRecord(ctx, ref, next)
      return stageStep(ref, next)
    }
    return sendCode(ctx, ref, { ...rec, userId: user.id!, apiKeyAccess: Array.isArray(user.accessibleBy) && user.accessibleBy.includes('apiKey') })
  }

  /** POST /v2/auth/login-codes: email a sign-in code (at most `PAYTRIE_MAX_CODES` per leg) */
  async function sendCode(ctx: AdapterContext, ref: string, rec: LegRecord): Promise<LegStep> {
    if (rec.codesSent >= PAYTRIE_MAX_CODES) throw new OpenRampException(openRampError('RATE_LIMITED', { message: 'Too many PayTrie codes for this purchase. Start again later.' }), 429)
    try {
      // Always 202, also for an unknown email (no account enumeration)
      await call(ctx, 'POST', '/auth/login-codes', { body: { email: rec.email } })
    } catch (e) {
      throw toOpenRamp(e, 'send the sign-in code', ctx.log)
    }
    const next: LegRecord = { ...rec, stage: 'code', codesSent: rec.codesSent + 1, wrongCodes: 0 }
    await saveRecord(ctx, ref, next)
    return stageStep(ref, next)
  }

  /** POST /v2/auth/login-codes/verify, then the KYC check */
  async function verifyCode(ctx: AdapterContext, ref: string, rec: LegRecord, code: string): Promise<LegStep> {
    if (!CODE.test(code)) throw bad('Enter the 4-digit code from the PayTrie email.')
    if (rec.wrongCodes >= PAYTRIE_MAX_WRONG_CODES) throw new OpenRampException(openRampError('RATE_LIMITED', { message: 'Too many wrong codes. Ask for a new code.' }), 429)
    let res: { accessToken?: string; expiresIn?: number } | undefined
    try {
      res = await call<{ accessToken?: string; expiresIn?: number }>(ctx, 'POST', '/auth/login-codes/verify', { body: { email: rec.email, code } })
    } catch (e) {
      const st = httpStatus(e)
      // TO VERIFY: the status of a wrong code (we read 400, 401, 403, 404 and 422 as a wrong or expired code).
      if (st === 400 || st === 401 || st === 403 || st === 404 || st === 422) {
        await saveRecord(ctx, ref, { ...rec, wrongCodes: rec.wrongCodes + 1 })
        throw bad('The code is not right, or it expired. Try again or ask for a new code.')
      }
      throw toOpenRamp(e, 'check the sign-in code', ctx.log)
    }
    if (!res?.accessToken || typeof res.accessToken !== 'string') throw new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message: 'PayTrie did not return an access token.' }), 502)
    // The email is now the one of a signed-in account: lock it.
    const next: LegRecord = { ...rec, emailLocked: true, wrongCodes: 0 }
    await putToken(ctx, ref, next.email!, res.accessToken, res.expiresIn)
    await saveRecord(ctx, ref, next)
    return afterSignIn(ctx, ref, next, res.accessToken)
  }

  /** The user's KYC status, then KYC, review, or the order */
  async function afterSignIn(ctx: AdapterContext, ref: string, rec: LegRecord, token: string): Promise<LegStep> {
    let user: { id?: string; status?: string; accessibleBy?: string[] } | undefined
    try {
      user = await call<{ id?: string; status?: string; accessibleBy?: string[] }>(ctx, 'GET', `/users/${encodeURIComponent(rec.userId!)}`, { token })
    } catch (e) {
      if (httpStatus(e) === 401) return signInAgain(ctx, ref, rec)
      throw toOpenRamp(e, 'check your PayTrie account', ctx.log)
    }
    const kyc = USER_KYC[user?.status ?? '']
    if (!kyc) ctx.log.warn('paytrie: unknown user status; waiting', { status: String(user?.status).slice(0, 32) })
    if (kyc === 'rejected' || kyc === 'inactive') {
      await dropToken(ctx, ref)
      return {
        status: 'failed',
        ref,
        error:
          kyc === 'rejected'
            ? openRampError('KYC_REJECTED', { recovery: 'choose_other' })
            : openRampError('PROVIDER_DECLINED', { message: 'Your PayTrie account is not active. Contact PayTrie support.', recovery: 'choose_other' }),
      }
    }
    if (kyc === 'ok') return createTransaction(ctx, ref, rec, token)
    if (kyc === 'collect') {
      // Keep the KYC link we have; a poll does not ask for a new one.
      if (rec.stage === 'kyc' && rec.kycUrl && (rec.kycUntil ?? 0) > Date.now()) return stageStep(ref, rec)
      let link: { url?: string; expiresAt?: string } | undefined
      try {
        link = await call<{ url?: string; expiresAt?: string }>(ctx, 'GET', `/users/${encodeURIComponent(rec.userId!)}/kyc-url`, { token })
      } catch (e) {
        // 422: the profile needs more data first (for example `additionalInfo` for users 50 or over)
        if (httpStatus(e) === 422) throw bad('PayTrie needs more profile details first. Finish your profile at app.paytrie.com, then try again.', 422, 'PROVIDER_DECLINED')
        if (httpStatus(e) === 401) return signInAgain(ctx, ref, rec)
        throw toOpenRamp(e, 'open identity verification', ctx.log)
      }
      if (!isWebUrl(link?.url)) throw new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message: 'PayTrie did not return a verification link.' }), 502)
      // `expiresAt` from PayTrie, at most 30 minutes; a minute early, so the UI never opens a dead link
      const until = Date.parse(quoteExpiresAt(30, link!.expiresAt ?? null)) - 60_000
      const next: LegRecord = { ...rec, stage: 'kyc', kycUrl: link!.url!, kycUntil: until }
      await saveRecord(ctx, ref, next)
      return stageStep(ref, next)
    }
    // In review, or an unknown status: wait (never an order before `verified`)
    const next: LegRecord = { ...rec, stage: 'kyc_review' }
    await saveRecord(ctx, ref, next)
    return stageStep(ref, next)
  }

  /** Forget the token; the user asks for a new code. */
  async function signInAgain(ctx: AdapterContext, ref: string, rec: LegRecord): Promise<LegStep> {
    await dropToken(ctx, ref)
    const next: LegRecord = { ...rec, stage: 'signin' }
    await saveRecord(ctx, ref, next)
    return stageStep(ref, next)
  }

  /**
   * POST /v2/transactions, exactly once per attempt. The wallet and token are the leg's own (set by
   * the server at start). The answer must name the same wallet, token and amount, or the order is
   * cancelled and the leg fails (fail closed).
   */
  async function createTransaction(ctx: AdapterContext, ref: string, rec: LegRecord, token: string): Promise<LegStep> {
    if (rec.txId) return stageStep(ref, rec)
    // One claim per attempt: two requests (or a request and a poll) can never create two orders.
    // A random claim value: a retry of the same session must not count as the holder.
    if (!(await claimOnce(ctx.store, `c:${ref}:${rec.createAttempt}`, randomHex(12), RECORD_TTL_SEC))) {
      throw bad('This PayTrie order is already being created. Wait a moment.', 409, 'CONFLICT')
    }
    const fresh = rec.quoteId !== undefined && rec.quotedAt !== undefined && Date.now() - rec.quotedAt < QUOTE_ID_FRESH_MS
    const body = {
      leftSideLabel: 'CAD',
      leftSideValue: Number(rec.cad),
      rightSideLabel: rec.label,
      wallet: rec.wallet,
      ...(fresh ? { quoteId: rec.quoteId } : {}),
      externalSessionId: ref,
    }
    let tx: PtTransaction | undefined
    try {
      tx = await call<PtTransaction>(ctx, 'POST', '/transactions', { body, token })
    } catch (e) {
      const st = httpStatus(e)
      if (st === 401) {
        // The token expired: nothing was created. The next attempt may run.
        return signInAgain(ctx, ref, { ...rec, createAttempt: rec.createAttempt + 1 })
      }
      if (st === 400 || st === 422) {
        // A limit or a refusal: nothing was created. "Display the message rather than matching on it."
        await saveRecord(ctx, ref, { ...rec, createAttempt: rec.createAttempt + 1 })
        throw new OpenRampException(openRampError('PROVIDER_DECLINED', { message: `PayTrie: ${ptMessage(e) ?? 'this order is not possible now.'}`, recovery: 'requote' }), 422)
      }
      // A timeout or a 5xx: the order may exist. Never create a second one (the claim stays taken).
      ctx.log.error('paytrie: order creation outcome unknown; the leg fails closed', { ref, status: st })
      await dropToken(ctx, ref)
      return {
        status: 'failed',
        ref,
        error: openRampError('PROVIDER_UNAVAILABLE', { message: 'PayTrie did not confirm the order. Do not pay a PayTrie request for it; contact PayTrie support.', retryable: false, recovery: 'contact_support' }),
      }
    }
    const id = typeof tx?.id === 'string' && ID.test(tx.id) ? tx.id : undefined
    const sameAmount = Math.abs(Number(tx?.leftSideValue) - Number(rec.cad)) < 0.005
    if (!id || !sameAddress(rec.chain, tx!.wallet, rec.wallet) || tx!.rightSideLabel !== rec.label || tx!.leftSideLabel !== 'CAD' || !sameAmount) {
      ctx.log.error('paytrie: the created order does not match the request; cancelling it', { ref, id })
      if (id) {
        try {
          await call(ctx, 'PUT', `/transactions/${encodeURIComponent(id)}/cancel`, { token })
        } catch (e) {
          ctx.log.error('paytrie: cancel of a mismatched order failed', { ref, id, error: String((e as Error)?.message ?? e).slice(0, 200) })
        }
      }
      await dropToken(ctx, ref)
      return { status: 'failed', ref, error: openRampError('PROVIDER_UNAVAILABLE', { message: 'PayTrie returned an order that does not match this purchase. Do not pay it; contact PayTrie support.', retryable: false, recovery: 'contact_support' }) }
    }
    // The index first: webhooks find the leg only through it.
    await ctx.shared.put(indexKey(id), { ref, wallet: rec.wallet, chain: rec.chain, label: rec.label } satisfies TxIndex, INDEX_TTL_SEC)
    const next: LegRecord = { ...rec, stage: 'payment', txId: id, ...(typeof tx!.rmtId === 'string' && tx!.rmtId ? { rmtId: tx!.rmtId.slice(0, 64) } : {}) }
    await saveRecord(ctx, ref, next)
    const ev = txEvent(tx!, ref, next, id, ctx.log)
    if (!ev || ev.status === 'requires_action') return stageStep(ref, next)
    if (ev.status !== 'processing') await dropToken(ctx, ref)
    return legStepFromEvent(ev, ref, POLL)
  }

  /** `kyc` or `kyc_review` on a poll or `kyc_done`: check the user again (under the lease) */
  async function reviewCheck(ctx: AdapterContext, ref: string, rec: LegRecord): Promise<LegStep> {
    const token = await getToken(ctx, ref, rec)
    if (!token) return signInAgain(ctx, ref, rec)
    return afterSignIn(ctx, ref, rec, token)
  }

  return createAdapter({
    id: 'paytrie',
    env,
    name: 'PayTrie',
    legs,

    async quote(input, ctx) {
      if (input.leg.legId !== 'interac') throw bad(`Unknown PayTrie leg ${input.leg.legId}`)
      const target = requireDeliverAsset(deliver, input.leg.to.asset.kind === 'crypto' ? input.leg.to.asset : undefined, 'PayTrie')
      const fiatAsset = input.amountIn?.asset ?? input.leg.from.asset
      if (fiatAsset.kind !== 'fiat' || fiatAsset.currency.toUpperCase() !== 'CAD') throw new OpenRampException(openRampError('NO_QUOTES', { message: 'PayTrie takes CAD only.', recovery: 'choose_other' }), 422)
      const q = new URLSearchParams({ leftSideLabel: 'CAD', rightSideLabel: target.label })
      const bounds = (cad: string) => {
        if (Number(cad) < Number(PAYTRIE_MIN_CAD)) throw new OpenRampException(openRampError('AMOUNT_TOO_LOW', { message: `The PayTrie minimum is ${PAYTRIE_MIN_CAD} CAD.`, recovery: 'requote' }), 422)
        if (Number(cad) > Number(PAYTRIE_MAX_CAD)) throw new OpenRampException(openRampError('AMOUNT_TOO_HIGH', { message: `The PayTrie maximum is ${PAYTRIE_MAX_CAD} CAD.`, recovery: 'requote' }), 422)
      }
      if (input.amountIn) {
        const cad = roundTo(input.amountIn.value, 2)
        bounds(cad)
        q.set('leftSideValue', cad)
      } else if (input.amountOut) {
        q.set('rightSideValue', roundTo(input.amountOut.value, Math.min(6, target.decimals ?? 6)))
      } else throw bad('PayTrie quotes need an amount.')
      let r: PtQuote | undefined
      try {
        r = await call<PtQuote>(ctx, 'GET', `/quotes?${q}`)
      } catch (e) {
        const st = httpStatus(e)
        if (st === 400 || st === 422) throw new OpenRampException(openRampError('NO_QUOTES', { message: `PayTrie: ${ptMessage(e) ?? 'no quote for this amount.'}` }), 422)
        throw toOpenRamp(e, 'price this amount', ctx.log)
      }
      const cad = dec(r?.leftSideValue, 2)
      const out = dec(r?.rightSideValue, target.decimals ?? 6)
      if (!r || r.leftSideLabel !== 'CAD' || r.rightSideLabel !== target.label || !positive(cad) || !positive(out)) {
        throw new OpenRampException(openRampError('NO_QUOTES', { message: 'PayTrie did not return a quote for this amount.' }), 422)
      }
      if (input.amountOut) bounds(cad)
      const fiatAmt = (value: string): Amount => ({ value, asset: { kind: 'fiat', currency: 'CAD' } })
      // The fees are in CAD and inside leftSideValue: the docs example gives (1000 - 5 - 21.5) / 1.3625 = 714.5.
      // TO VERIFY with a live quote that `gasFee` is in CAD.
      const fees: Fee[] = []
      const fee = dec(r.breakdown?.paytrieFee, 2)
      const gas = dec(r.breakdown?.gasFee, 2)
      if (positive(fee)) fees.push({ kind: 'provider', label: 'PayTrie fee', amount: fiatAmt(fee), included: true })
      if (positive(gas)) fees.push({ kind: 'network', label: 'Network fee', amount: fiatAmt(gas), included: true })
      return {
        adapterId: 'paytrie',
        legId: 'interac',
        input: fiatAmt(cad),
        output: { value: out, asset: deliverableToAsset(target) },
        fees,
        // The order is created after the sign-in (and KYC), so the quote id may be stale by then.
        guarantee: 'estimate',
        eta: ETA,
        expiresAt: quoteExpiresAt(QUOTE_TTL_MIN),
        data: { label: target.label, ...(Number.isInteger(r.quoteId) && r.quoteId! > 0 ? { quoteId: r.quoteId } : {}), quotedAt: Date.now() },
      }
    },

    async start(input, ctx) {
      const target = requireDeliverAsset(deliver, input.quote.output.asset.kind === 'crypto' ? input.quote.output.asset : undefined, 'PayTrie')
      if (input.quote.input.asset.kind !== 'fiat' || input.quote.input.asset.currency !== 'CAD') throw bad('PayTrie takes CAD only.')
      const cad = roundTo(input.quote.input.value, 2)
      if (!positive(cad) || Number(cad) < Number(PAYTRIE_MIN_CAD) || Number(cad) > Number(PAYTRIE_MAX_CAD)) throw bad('The amount is outside the PayTrie limits.')
      // The wallet comes from the server only: the hop address, or the session destination.
      const wallet = input.deliverTo?.address ?? (ctx.destination.type === 'crypto' ? ctx.destination.address : undefined)
      if (!wallet || wallet.length > 128) throw bad('PayTrie needs a wallet address to deliver to.')
      const data = (input.quote.data ?? {}) as { quoteId?: unknown; quotedAt?: unknown }
      const ref = `ptr_${randomHex(12)}`
      // The app's email is locked: the client cannot replace it. A malformed app email is an error.
      const sessionEmail = ctx.session.email?.trim()
      if (sessionEmail && !EMAIL.test(sessionEmail)) throw bad('The session email is not valid for PayTrie.')
      if (!sessionEmail && opts.requireSessionEmail) throw bad('PayTrie needs the session email. Create the session with an email.')
      const rec: LegRecord = {
        owner: ownerOf(ctx),
        legId: input.leg.legId,
        // With the app's email, `findUser` moves on at once (to `code` or `signup`).
        stage: sessionEmail ? 'signin' : 'email',
        wallet,
        chain: target.chain,
        // From the leg's own asset table, never from quote data
        label: target.label,
        cad,
        ...(Number.isInteger(data.quoteId) && (data.quoteId as number) > 0 ? { quoteId: data.quoteId as number } : {}),
        ...(typeof data.quotedAt === 'number' ? { quotedAt: data.quotedAt } : {}),
        ...(sessionEmail ? { email: sessionEmail, emailLocked: true } : {}),
        codesSent: 0,
        wrongCodes: 0,
        createAttempt: 0,
      }
      await saveRecord(ctx, ref, rec)
      return sessionEmail ? findUser(ctx, ref, rec) : stageStep(ref, rec)
    },

    async transition({ ref, name, inputs }, ctx) {
      const T = PAYTRIE_TRANSITIONS
      const rec = await loadRecord(ctx, ref)
      const str = (k: string) => (typeof inputs?.[k] === 'string' ? (inputs[k] as string).trim() : '')
      const allowed = TRANSITION_STAGES[name]
      if (!allowed) throw bad(`Unknown transition ${name}.`, 409, 'CONFLICT')
      // Each transition runs only from its own stage: a client cannot skip the sign-in or KYC.
      if (!allowed.includes(rec.stage)) throw bad(`Transition ${name} is not allowed now.`, 409, 'CONFLICT')
      return exclusive(ctx, ref, rec, async () => {
        switch (name) {
          case T.email: {
            if (rec.emailLocked || opts.requireSessionEmail) throw bad('The email of this purchase cannot be changed.', 409, 'CONFLICT')
            const email = str('email')
            if (!EMAIL.test(email)) throw bad('Enter a valid email address.')
            return findUser(ctx, ref, { ...rec, email })
          }
          case T.signedUp:
            return findUser(ctx, ref, rec)
          case T.sendCode:
          case T.resend:
            // No user id yet (the account lookup at start failed): look the account up first.
            return rec.userId ? sendCode(ctx, ref, rec) : findUser(ctx, ref, rec)
          case T.code:
            return verifyCode(ctx, ref, rec, str('code'))
          case T.kycDone:
            return reviewCheck(ctx, ref, rec)
          default:
            throw bad(`Unknown transition ${name}.`, 409, 'CONFLICT')
        }
      })
    },

    async status(input, ctx) {
      const rec = await loadRecord(ctx, input.ref)
      if (rec.stage === 'payment' && rec.txId) {
        const token = await getToken(ctx, input.ref, rec)
        // Without a token, only an integration that PayTrie approved for API key access can read the
        // transaction; the webhook reports the result.
        if (!token && !rec.apiKeyAccess) return legStepFromEvent(undefined, input.ref, POLL)
        let tx: PtTransaction | undefined
        try {
          tx = await call<PtTransaction>(ctx, 'GET', `/transactions/${encodeURIComponent(rec.txId)}`, token ? { token } : {})
        } catch (e) {
          const st = httpStatus(e)
          if (st === 401) {
            await dropToken(ctx, input.ref)
            return legStepFromEvent(undefined, input.ref, POLL)
          }
          if (st === 404) return legStepFromEvent(undefined, input.ref, POLL)
          throw toOpenRamp(e, 'find this order', ctx.log)
        }
        const ev = tx ? txEvent(tx, input.ref, rec, rec.txId, ctx.log) : undefined
        if (ev && ev.status !== 'requires_action' && ev.status !== 'processing') await dropToken(ctx, input.ref)
        // An unknown status is no event: the leg keeps its step. A poll has no surface: the UI keeps the payment details.
        return legStepFromEvent(ev, input.ref, POLL)
      }
      if (rec.stage === 'kyc' || rec.stage === 'kyc_review') {
        // This check can move the leg (a new sign-in, the order): only under the lease. When a
        // transition holds it, the poll changes nothing.
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
      const rec = await ctx.store.get<LegRecord>(recKey(input.ref))
      if (rec && rec.owner === ownerOf(ctx) && rec.txId) {
        const token = await getToken(ctx, input.ref, rec)
        if (token || rec.apiKeyAccess) {
          try {
            await call(ctx, 'PUT', `/transactions/${encodeURIComponent(rec.txId)}/cancel`, token ? { token } : {})
          } catch (e) {
            ctx.log.warn('paytrie: cancel failed; the order expires after 1 hour', { ref: input.ref, error: String((e as Error)?.message ?? e).slice(0, 200) })
          }
        }
      }
      await dropToken(ctx, input.ref)
    },

    webhook: {
      // Without the signing secret, no webhook can verify (see `resultChannels`).
      configured: !!opts.webhookSecret,
      async verify(req, rawBody, ctx) {
        // An empty secret would let anyone sign (for example an unset environment variable).
        if (!opts.webhookSecret) {
          ctx.log.warn('paytrie: webhookSecret is not set; rejecting webhook')
          return false
        }
        const ts = req.headers.get('x-paytrie-timestamp')?.trim()
        const header = req.headers.get('x-paytrie-signature')
        if (!ts || !/^\d{1,12}$/.test(ts) || !header) return false
        // `v1=<hex>`. Only v1 values count (a value with no prefix, or another version, never verifies).
        const sigs = header
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.startsWith('v1='))
          .map((s) => s.slice(3))
          .filter((s) => /^[0-9a-fA-F]{64}$/.test(s))
        for (const sig of sigs) {
          if (await verifyTimestampedHmac({ secret: opts.webhookSecret, rawBody, header: sig, timestamp: ts, toleranceSec: TOLERANCE_SEC })) return true
        }
        return false
      },
      async replayKey(_req, rawBody) {
        // The envelope `id` ("use it as an idempotency key"). TO VERIFY: the transaction example names it `eventId`.
        try {
          const env = JSON.parse(rawBody) as PtEnvelope
          const id = env?.id ?? env?.eventId
          if (typeof id === 'string' && id) return `paytrie:${id}`
        } catch {
          // not JSON: hash the body
        }
        return webhookBodyKey(rawBody)
      },
      async parse(rawBody, ctx) {
        let env: PtEnvelope
        try {
          env = JSON.parse(rawBody) as PtEnvelope
        } catch {
          ctx.log.warn('paytrie: webhook body is not JSON')
          return []
        }
        // `user.update` gives no leg event: status() reads the user when the leg waits for KYC.
        if (!env || typeof env !== 'object' || env.type !== 'transaction.update' || (env.apiVersion !== undefined && env.apiVersion !== 'v2')) return []
        const p = env.payload
        const txId = p?.transactionId
        if (!p || typeof txId !== 'string' || !ID.test(txId)) return []
        // Only our own index (written when we created the order) finds the leg. `externalSessionId` is not
        // trusted alone: a widget URL can carry any value. When both exist, they must agree.
        const idx = await ctx.shared.get<TxIndex>(indexKey(txId))
        if (!idx) return []
        if (p.externalSessionId != null && p.externalSessionId !== idx.ref) {
          ctx.log.warn('paytrie: webhook externalSessionId does not match the order index; ignored', { transactionId: txId })
          return []
        }
        const ev = txEvent(p, idx.ref, idx, txId, ctx.log)
        if (!ev) return []
        const id = env.id ?? env.eventId
        return [{ ...ev, ...(typeof id === 'string' && id ? { eventId: `paytrie:${id}` } : {}) }]
      },
    },

    async health(ctx) {
      try {
        // An authenticated call that changes nothing. 404 (no webhook URL yet) still means the key works. TO VERIFY.
        await call(ctx, 'GET', '/webhook-configurations')
        return { ok: true }
      } catch (e) {
        if (httpStatus(e) === 404) return { ok: true }
        return { ok: false, detail: String((e as Error)?.message ?? e).slice(0, 200) }
      }
    },
  })
}
