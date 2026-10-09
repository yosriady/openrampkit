// Bridge adapter (https://apidocs.bridge.xyz). Bridge is a Stripe company.
//
// Deposits: virtual bank accounts. The user sends ACH, wire, SEPA, SPEI, Pix or Faster Payments to a
// virtual account that Bridge opens for the user. Bridge converts the fiat to USDC and sends it on chain
// to the destination address.
// - KYC first. Bridge needs a customer with approved KYC and the endorsement for the rail
//   (`base` for USD, `sepa`, `spei`, `pix`, `faster_payments`). The adapter creates a KYC link
//   (POST /v0/kyc_links) and sends the user to Bridge's hosted ToS and KYC pages (REDIRECT, state KYC).
//   When the app already has a Bridge customer id, it gives it with the `customer` hook.
// - Then POST /v0/customers/{id}/virtual_accounts, and the modal shows the bank details (BANK_FIELDS,
//   or a QR of the Pix BR Code for BRL).
// - Status: GET /v0/customers/{id}/virtual_accounts/{va}/history, and `virtual_account.activity` webhooks.
//   A virtual account is persistent: one account per customer, currency, chain and address. The leg takes
//   the first deposit after the session started that no other session claimed.
//
// Withdrawals (to a bank): POST /v0/customers/{id}/external_accounts with the payout account from a FORM,
// then POST /v0/transfers with a USDC source and an ACH, wire or SEPA destination. The user sends the USDC
// to `source_deposit_instructions.to_address` (WALLET_TX). Status: GET /v0/transfers/{id} and `transfer`
// webhooks. Transfers are one per session, so they fit better than liquidation addresses here.
//
// Every POST sends `Idempotency-Key` (Bridge requires it on every POST). Auth: `Api-Key` header.
// Webhooks: `X-Webhook-Signature: t=<ms>,v0=<base64>`, RSA PKCS#1 v1.5 over SHA-256(SHA-256(`${t}.${body}`))
// with the endpoint's public key (PEM). Bridge suggests a 10 minute age limit.
//
// We store only Bridge ids (customer, KYC link, virtual account, external account, transfer), never
// names, emails or bank account numbers.
//
// Server-side only. Web-standard APIs only (fetch, WebCrypto), so it runs on Cloudflare Workers.

import { POLL as POLLS, awaitPoll, claimOnce, createAdapter, erc20TransferData, fetchJson, findDeliverAsset, httpErrorToOpenRamp, importRsaPublicKey, randomHex, resolveEnv, rsaVerify } from '@openrampkit/adapter'
import type { AdapterContext, AdapterEnv, LegEvent, QuoteInput, StartInput } from '@openrampkit/adapter'
import {
  OpenRampException,
  USDC,
  bps as applyBps,
  cmp,
  evmChainId,
  fromScaled,
  isDecimal,
  isSolanaChain,
  minorUnits,
  openRampError,
  roundTo,
  sub,
  toBaseUnits,
  toScaled,
} from '@openrampkit/core'
import type { Amount, CryptoAsset, FieldSpec, Fee, LegQuote, LegSpec, LegStatus, LegStep, PollSpec, StepSub, Surface, TxRequest } from '@openrampkit/core'

export type BridgeCustomerHint = {
  /** An existing Bridge customer id. The adapter skips the KYC link and checks this customer. */
  customerId?: string
  /** For a new KYC link. When `fullName` or `email` is missing, the modal asks the user. */
  fullName?: string
  email?: string
}

export type BridgeOptions = {
  /** Bridge API key (`sk-test-...` in the sandbox). Sent as the `Api-Key` header. */
  apiKey: string
  /** The webhook endpoint's public key (PEM), from POST /v0/webhooks or the dashboard */
  webhookPublicKey: string
  /** Default 'production' (https://api.bridge.xyz). 'sandbox' uses https://api.sandbox.bridge.xyz. */
  env?: AdapterEnv
  /** API base URL without `/v0`. Overrides `env`. */
  apiUrl?: string
  /** Your fee in percent of each deposit and payout, as a decimal string ('0.5' = 0.5%). Sent as `developer_fee_percent`. */
  developerFeePercent?: string
  /**
   * Bridge's own fee for quotes, in basis points. Bridge pricing is per contract and the API has no fee
   * quote, so set it to your contract rate. Default 0. Exchange rates for EUR, MXN, BRL and GBP already
   * include Bridge's FX fee.
   */
  bridgeFeeBps?: number
  /** Offer only these legs (ids, e.g. `usd-ach`, `eur-sepa`, `payout-usd-ach`) */
  legs?: string[]
  /** Add the withdraw legs (USDC to a bank account). Default true. */
  withdraw?: boolean
  /** Look up the Bridge customer, or the name and email for a new KYC link, for one of your users. */
  customer?: (user: { userId: string; email?: string }) => Promise<BridgeCustomerHint | undefined>
}

// ---------- rails, chains and regions ----------

type DepositRail = {
  id: string
  method: string
  currency: string
  endorsement: string
  /** Minimum in the source currency. Deposits under 1 USD are microdeposits and are never onramped. */
  min: string
  max?: string
  eta: { min: number; max: number }
}

type PayoutRail = { id: string; method: string; currency: string; endorsement: string; rail: 'ach' | 'wire' | 'sepa'; min: string; eta: { min: number; max: number } }

const DAY = 86_400

/**
 * Deposit rails. Minimums from https://apidocs.bridge.xyz/platform/orchestration/more/rail-specific
 * (the stricter of that page and the payment routes table). Pix: 500,000 USD per customer per month.
 * TO VERIFY: the ETAs (Bridge publishes no settlement times per rail in the API docs).
 */
export const BRIDGE_DEPOSIT_RAILS: DepositRail[] = [
  { id: 'usd-ach', method: 'ach', currency: 'USD', endorsement: 'base', min: '1', eta: { min: DAY, max: 3 * DAY } },
  { id: 'usd-wire', method: 'bank_transfer', currency: 'USD', endorsement: 'base', min: '1', eta: { min: 3600, max: 2 * DAY } },
  { id: 'eur-sepa', method: 'sepa', currency: 'EUR', endorsement: 'sepa', min: '1', eta: { min: 600, max: 2 * DAY } },
  { id: 'mxn-spei', method: 'spei', currency: 'MXN', endorsement: 'spei', min: '50', eta: { min: 300, max: 3600 } },
  // TO VERIFY: `pix` or `pix_onramp` as the endorsement for Pix deposits (both are in EndorsementType).
  { id: 'brl-pix', method: 'pix', currency: 'BRL', endorsement: 'pix', min: '10', eta: { min: 60, max: 3600 } },
  { id: 'gbp-fps', method: 'faster_payments', currency: 'GBP', endorsement: 'faster_payments', min: '2', eta: { min: 60, max: 7200 } },
]

/** Payout rails (USDC to a bank account). Only US accounts and IBANs: the docs show external account bodies for these two. */
export const BRIDGE_PAYOUT_RAILS: PayoutRail[] = [
  { id: 'payout-usd-ach', method: 'ach', currency: 'USD', endorsement: 'base', rail: 'ach', min: '1', eta: { min: DAY, max: 3 * DAY } },
  // TO VERIFY: the wire payout minimum (the routes table lists 1).
  { id: 'payout-usd-wire', method: 'bank_transfer', currency: 'USD', endorsement: 'base', rail: 'wire', min: '1', eta: { min: 3600, max: 2 * DAY } },
  { id: 'payout-eur-sepa', method: 'sepa', currency: 'EUR', endorsement: 'sepa', rail: 'sepa', min: '1', eta: { min: 600, max: 2 * DAY } },
]

type BridgeChain = { chain: string; rail: string; usdc: string }

const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'

/** USDC networks, with Bridge's `payment_rail` name (PaymentRail enum in the OpenAPI spec). */
export const BRIDGE_CHAINS: BridgeChain[] = [
  { chain: 'eip155:8453', rail: 'base', usdc: USDC['eip155:8453']! },
  { chain: 'eip155:1', rail: 'ethereum', usdc: USDC['eip155:1']! },
  { chain: 'eip155:42161', rail: 'arbitrum', usdc: USDC['eip155:42161']! },
  { chain: 'eip155:10', rail: 'optimism', usdc: USDC['eip155:10']! },
  { chain: 'eip155:137', rail: 'polygon', usdc: USDC['eip155:137']! },
  { chain: 'eip155:43114', rail: 'avalanche_c_chain', usdc: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e' },
  { chain: SOLANA, rail: 'solana', usdc: USDC[SOLANA]! },
]

/** USDC on each Bridge network, for `findDeliverAsset` */
const DELIVERABLE = BRIDGE_CHAINS.map((c) => ({ chain: c.chain, token: c.usdc, c }))

/**
 * Countries and regions where Bridge does not serve customers
 * (https://apidocs.bridge.xyz/platform/customers/compliance/supported-countries-list, 2026-10-05):
 * "unavailable" (DZ, BI, CN, JP, TN), the prohibited list (ISO3 AFG, BLR, COD, CUB, PSE, IRN, IRQ, LBN, LBY,
 * MMR, PRK, RUS, SOM, SSD, SDN, SYR, VEN, YEM) and New York residents.
 */
export const BRIDGE_DENY = [
  'DZ', 'BI', 'CN', 'JP', 'TN',
  'AF', 'BY', 'CD', 'CU', 'PS', 'IR', 'IQ', 'LB', 'LY', 'MM', 'KP', 'RU', 'SO', 'SS', 'SD', 'SY', 'VE', 'YE',
  'US-NY',
]

/** Bank transfers take days: poll slowly, and keep going for 5 days (the server sweep continues after that). */
const BANK_POLL: PollSpec = { intervalMs: 5000, backoff: 1.5, maxIntervalMs: 60_000, giveUpAfterMs: 5 * DAY * 1000 }
const KYC_POLL: PollSpec = POLLS.checkout
const REC_TTL_SEC = 30 * DAY
const RATE_TTL_SEC = 30
/** "reject events older than 10 minutes" */
const WEBHOOK_TOLERANCE_MS = 10 * 60_000

// ---------- Bridge objects ----------

type KycLink = {
  id: string
  customer_id?: string | null
  kyc_link?: string
  tos_link?: string
  kyc_status?: string
  tos_status?: string
}

type Customer = { id: string; status?: string; endorsements?: Array<{ name: string; status: string }> }

type DepositInstructions = {
  currency?: string
  bank_name?: string
  bank_address?: string
  bank_routing_number?: string
  bank_account_number?: string
  bank_beneficiary_name?: string
  bank_beneficiary_address?: string
  payment_rails?: string[]
  iban?: string
  bic?: string
  account_holder_name?: string
  clabe?: string
  br_code?: string
  account_number?: string
  sort_code?: string
  deposit_message?: string
}

type VirtualAccount = { id: string; status?: string; source_deposit_instructions?: DepositInstructions }

type VaEvent = {
  id: string
  type: string
  virtual_account_id?: string
  amount?: string
  currency?: string
  deposit_id?: string
  destination_tx_hash?: string
  created_at?: string
  receipt?: { final_amount?: string; destination_tx_hash?: string }
}

type Transfer = {
  id: string
  state: string
  client_reference_id?: string | null
  amount?: string
  source_deposit_instructions?: { to_address?: string | null; amount?: string; currency?: string; payment_rail?: string }
  receipt?: { final_amount?: string; destination_tx_hash?: string; source_tx_hash?: string }
}

type WebhookEnvelope = { event_id?: string; event_category?: string; event_type?: string; event_object_id?: string; event_object?: Record<string, unknown> }

/** What the adapter keeps per leg (in `shared`, so webhooks find it). Bridge ids only. */
type LegRec = {
  kind: 'deposit' | 'payout'
  legId: string
  userId: string
  email?: string
  customerId?: string
  kycLinkId?: string
  /** ms; deposits before this time belong to earlier sessions */
  since: number
  input: Amount
  /** Deposit: the USDC asset and the address Bridge delivers to */
  asset: CryptoAsset
  address?: string
  vaId?: string
  instructions?: DepositInstructions
  /** Payout */
  fromAddress?: string
  externalAccountId?: string
  transferId?: string
  payTo?: string
  payAmount?: string
  txHash?: string
}

type UserRec = { customerId?: string; kycLinkId?: string }

// ---------- helpers ----------

const WORK = 18
/** Exact decimal division `a / b` */
function div(a: string, b: string): string {
  return fromScaled((toScaled(a, WORK) * 10n ** BigInt(WORK)) / toScaled(b, WORK), WORK)
}

function dec(s: string | null | undefined): string | undefined {
  return typeof s === 'string' && isDecimal(s) ? s : undefined
}

const kycRejected = () => openRampError('KYC_REJECTED', { message: 'Bridge could not verify your identity.', recovery: 'choose_other' })

/** Parse `t=<ms>,v0=<base64>` */
export function parseBridgeSignature(header: string): { t?: string; v0: string[] } {
  const out: { t?: string; v0: string[] } = { v0: [] }
  for (const part of header.split(',')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k === 't') out.t = v
    else if (k === 'v0') out.v0.push(v)
  }
  return out
}

/** Import an SPKI public key in PEM form ("-----BEGIN PUBLIC KEY-----") or base64. Accepts `\n` escapes from env files. */
export async function importBridgePublicKey(pem: string): Promise<CryptoKey> {
  return importRsaPublicKey(pem)
}

/**
 * Verify a Bridge webhook signature. Bridge signs SHA-256(`${t}.${body}`) with RSA PKCS#1 v1.5 and SHA-256,
 * so the signed message is the first digest (WebCrypto hashes it a second time).
 */
export async function verifyBridgeSignature(key: CryptoKey, header: string, rawBody: string, now = Date.now()): Promise<boolean> {
  const { t, v0 } = parseBridgeSignature(header)
  const ts = Number(t)
  if (!t || !v0.length || !Number.isFinite(ts)) return false
  if (Math.abs(now - ts) > WEBHOOK_TOLERANCE_MS) return false
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${t}.${rawBody}`)))
  for (const sig of v0) if (await rsaVerify(key, digest, sig)) return true
  return false
}

// ---------- the adapter ----------

export function bridge(opts: BridgeOptions) {
  const env = resolveEnv('bridge', opts.env, undefined, 'production')
  const api = (opts.apiUrl ?? (env === 'sandbox' ? 'https://api.sandbox.bridge.xyz' : 'https://api.bridge.xyz')).replace(/\/+$/, '')
  const pick = <T extends { id: string }>(list: T[]) => list.filter((r) => !opts.legs || opts.legs.includes(r.id))
  const depositRails = pick(BRIDGE_DEPOSIT_RAILS)
  const payoutRails = opts.withdraw === false ? [] : pick(BRIDGE_PAYOUT_RAILS)
  if (!depositRails.length && !payoutRails.length) throw new Error('bridge: `legs` selects no known leg')
  if (opts.developerFeePercent !== undefined && !isDecimal(opts.developerFeePercent)) throw new Error('bridge: developerFeePercent must be a decimal string')
  const usdcChains = Object.fromEntries(BRIDGE_CHAINS.map((c) => [c.chain, [c.usdc]]))
  const regions = { allow: ['*'], deny: BRIDGE_DENY }

  const legs: LegSpec[] = [
    ...depositRails.map<LegSpec>((r) => ({
      id: r.id,
      kind: 'fiat_onramp',
      methods: [r.method],
      from: { asset: { kind: 'fiat', currencies: [r.currency] }, location: ['user_account'] },
      to: { asset: { kind: 'crypto', chains: usdcChains }, location: ['address'] },
      regions,
      limits: { min: r.min, currency: r.currency },
      eta: r.eta,
      surfaces: r.currency === 'BRL' ? ['QR', 'REDIRECT', 'FORM'] : ['BANK_FIELDS', 'REDIRECT', 'FORM'],
      requires: ['provider_kyc'],
    })),
    ...payoutRails.map<LegSpec>((r) => ({
      id: r.id,
      kind: 'crypto_offramp',
      methods: [r.method],
      from: { asset: { kind: 'crypto', chains: usdcChains }, location: ['user_wallet', 'address'] },
      to: { asset: { kind: 'fiat', currencies: [r.currency] }, location: ['user_account'] },
      regions,
      limits: { min: r.min, currency: 'USDC' },
      eta: r.eta,
      surfaces: ['FORM', 'WALLET_TX', 'REDIRECT'],
      requires: ['provider_kyc'],
    })),
  ]
  const depositById = new Map(depositRails.map((r) => [r.id, r]))
  const payoutById = new Map(payoutRails.map((r) => [r.id, r]))

  let keyPromise: Promise<CryptoKey> | undefined

  // ---------- HTTP ----------

  async function call<T>(ctx: Pick<AdapterContext, 'fetch' | 'log'>, method: 'GET' | 'POST', path: string, what: string, body?: unknown, idem?: string): Promise<T> {
    if (method === 'POST' && !idem) throw new Error('bridge: every POST needs an Idempotency-Key')
    try {
      return await fetchJson<T>(ctx.fetch, `${api}/v0${path}`, {
        method,
        headers: {
          'Api-Key': opts.apiKey,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(idem ? { 'Idempotency-Key': idem } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
    } catch (e) {
      throw httpErrorToOpenRamp(e, 'Bridge', { what, log: ctx.log })
    }
  }

  const recKey = (ref: string) => `leg:${ref}`
  const userKey = (userId: string) => `user:${userId}`

  async function loadRec(ref: string, ctx: Pick<AdapterContext, 'shared'>): Promise<LegRec> {
    const rec = await ctx.shared.get<LegRec>(recKey(ref))
    if (!rec) throw new OpenRampException(openRampError('NOT_FOUND', { message: 'This Bridge payment is not known.' }), 404)
    return rec
  }

  async function saveRec(ref: string, rec: LegRec, ctx: Pick<AdapterContext, 'shared'>) {
    await ctx.shared.put(recKey(ref), rec, REC_TTL_SEC)
    if (rec.customerId || rec.kycLinkId) {
      await ctx.shared.put(userKey(rec.userId), { ...(rec.customerId ? { customerId: rec.customerId } : {}), ...(rec.kycLinkId ? { kycLinkId: rec.kycLinkId } : {}) } satisfies UserRec, REC_TTL_SEC)
    }
  }

  // ---------- quotes ----------

  /** Units of `to` per unit of `from`, from GET /v0/exchange_rates (`buy_rate` includes Bridge's FX fee). */
  async function rate(from: string, to: string, ctx: Pick<AdapterContext, 'fetch' | 'log' | 'shared'>): Promise<string> {
    if (from === to) return '1'
    const key = `rate:${from}:${to}`
    const cached = await ctx.shared.get<string>(key)
    if (cached) return cached
    const r = await call<{ buy_rate?: string; midmarket_rate?: string }>(ctx, 'GET', `/exchange_rates?from=${from}&to=${to}`, 'price this currency')
    // TO VERIFY: `buy_rate` is "the rate for buying the target currency, including Bridge's fee". We read it
    // as the rate the user gets when converting `from` into `to`.
    const v = dec(r.buy_rate) ?? dec(r.midmarket_rate)
    if (!v || cmp(v, '0') <= 0) throw new OpenRampException(openRampError('NO_QUOTES', { message: 'Bridge returned no exchange rate.' }), 422)
    await ctx.shared.put(key, v, RATE_TTL_SEC)
    return v
  }

  /** Fees in percent of the input (developer fee) and in bps (Bridge fee, from the options) */
  function feeFraction(): string {
    const dev = opts.developerFeePercent ? div(opts.developerFeePercent, '100') : '0'
    const bridgeFee = opts.bridgeFeeBps ? div(String(opts.bridgeFeeBps), '10000') : '0'
    return fromScaled(toScaled(dev, WORK) + toScaled(bridgeFee, WORK), WORK)
  }

  function feesFor(amount: string, currency: string, digits: number): Fee[] {
    const fees: Fee[] = []
    if (opts.bridgeFeeBps) fees.push({ kind: 'provider', label: 'Bridge fee', amount: roundTo(applyBps(amount, opts.bridgeFeeBps), digits), currency })
    if (opts.developerFeePercent && cmp(opts.developerFeePercent, '0') > 0) {
      fees.push({ kind: 'app', label: 'App fee', amount: roundTo(div(toScaledMul(amount, opts.developerFeePercent), '100'), digits), currency })
    }
    return fees
  }

  function toScaledMul(a: string, b: string): string {
    return fromScaled((toScaled(a, WORK) * toScaled(b, WORK)) / 10n ** BigInt(WORK), WORK)
  }

  /** The Bridge network for USDC on `asset`'s chain. NO_QUOTES for another chain or another token (never USDC instead). */
  function chainFor(asset: CryptoAsset | undefined): BridgeChain {
    const d = findDeliverAsset(DELIVERABLE, asset)
    if (!d) throw new OpenRampException(openRampError('NO_QUOTES', { message: 'Bridge does not deliver this token on this network.', recovery: 'choose_other' }), 422)
    return d.c
  }

  function usdcAsset(c: BridgeChain): CryptoAsset {
    return { kind: 'crypto', chain: c.chain, token: c.usdc, symbol: 'USDC', decimals: 6 }
  }

  function checkLimits(amount: string, min: string, max: string | undefined, currency: string) {
    if (cmp(amount, min) < 0) throw new OpenRampException(openRampError('AMOUNT_TOO_LOW', { message: `The minimum for this method is ${min} ${currency}.` }), 422)
    if (max && cmp(amount, max) > 0) throw new OpenRampException(openRampError('AMOUNT_TOO_HIGH', { message: `The maximum for this method is ${max} ${currency}.` }), 422)
  }

  async function depositQuote(r: DepositRail, input: QuoteInput, ctx: AdapterContext): Promise<LegQuote> {
    const c = chainFor(input.leg.to.asset.kind === 'crypto' ? input.leg.to.asset : undefined)
    const cur = r.currency
    const digits = minorUnits(cur)
    const usdPer = await rate(cur.toLowerCase(), 'usd', ctx)
    const keep = sub('1', feeFraction())
    let fiat: string
    if (input.amountIn) {
      fiat = roundTo(input.amountIn.value, digits)
    } else {
      const out = input.amountOut?.value ?? '0'
      // out = fiat * keep * usdPer, rounded up to the fiat minor unit so that the user gets at least `out`
      const raw = div(div(out, usdPer), keep)
      const rounded = roundTo(raw, digits)
      fiat = cmp(rounded, raw) < 0 ? roundTo(fromScaled(toScaled(rounded, digits) + 1n, digits), digits) : rounded
    }
    checkLimits(fiat, r.min, r.max, cur)
    const output = roundTo(toScaledMul(toScaledMul(fiat, keep), usdPer), 6)
    return {
      adapterId: 'bridge',
      legId: r.id,
      input: { value: fiat, asset: { kind: 'fiat', currency: cur } },
      output: { value: output, asset: usdcAsset(c) },
      fees: feesFor(fiat, cur, digits),
      eta: r.eta,
      // Bridge has no rate lock; the rate moves about every 30 s. The bank transfer settles later at the rate of that day.
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      limits: { min: r.min, ...(r.max ? { max: r.max } : {}), currency: cur },
      data: { nonce: randomHex(8) },
    }
  }

  async function payoutQuote(r: PayoutRail, input: QuoteInput, ctx: AdapterContext): Promise<LegQuote> {
    const src = input.leg.from.asset.kind === 'crypto' ? input.leg.from.asset : input.amountIn?.asset.kind === 'crypto' ? input.amountIn.asset : undefined
    const c = chainFor(src)
    const cur = r.currency
    const digits = minorUnits(cur)
    const perUsd = await rate('usd', cur.toLowerCase(), ctx)
    const keep = sub('1', feeFraction())
    let usdc: string
    if (input.amountIn) {
      usdc = roundTo(input.amountIn.value, 6)
    } else {
      usdc = roundTo(div(div(input.amountOut?.value ?? '0', perUsd), keep), 6)
    }
    checkLimits(usdc, r.min, undefined, 'USDC')
    const output = roundTo(toScaledMul(toScaledMul(usdc, keep), perUsd), digits)
    return {
      adapterId: 'bridge',
      legId: r.id,
      input: { value: usdc, asset: usdcAsset(c) },
      output: { value: output, asset: { kind: 'fiat', currency: cur } },
      fees: feesFor(usdc, 'USDC', 6),
      eta: r.eta,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      limits: { min: r.min, currency: 'USDC' },
      data: { nonce: randomHex(8) },
    }
  }

  // ---------- KYC ----------

  const KYC_FIELDS: Record<'full_name' | 'email', FieldSpec> = {
    full_name: { id: 'full_name', label: 'Full legal name', type: 'text', required: true },
    email: { id: 'email', label: 'Email', type: 'email', required: true },
  }

  function kycFormStep(ref: string, missing: Array<'full_name' | 'email'>): LegStep {
    return {
      state: 'KYC',
      sub: 'kyc_details',
      status: 'awaiting_user',
      ref,
      surface: { kind: 'FORM', fields: missing.map((m) => KYC_FIELDS[m]) },
      transitions: [{ name: 'submit_kyc', kind: 'SUBMIT', label: 'Continue to verification' }],
    }
  }

  function redirectStep(ref: string, url: string, sub: StepSub): LegStep {
    if (!/^https:\/\//.test(url)) throw new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message: 'Bridge returned an unsafe verification link.' }), 502)
    return { state: 'KYC', sub, status: 'awaiting_user', ref, surface: { kind: 'REDIRECT', url, popup: true, provider: 'Bridge' }, transitions: [awaitPoll(KYC_POLL)] }
  }

  const reviewStep = (ref: string): LegStep => ({ state: 'KYC', sub: 'kyc_review', status: 'processing', ref, transitions: [awaitPoll(KYC_POLL)] })
  const failStep = (ref: string, error = kycRejected()): LegStep => ({ state: 'FAILED', status: 'failed', ref, transitions: [], error })

  async function createKycLink(ref: string, rec: LegRec, endorsement: string, fullName: string, email: string, ctx: AdapterContext): Promise<KycLink> {
    const link = await call<KycLink>(
      ctx,
      'POST',
      '/kyc_links',
      'start identity verification',
      { full_name: fullName, email, type: 'individual', endorsements: [endorsement], redirect_uri: ctx.urls.returnUrl },
      ctx.idempotencyKey(`bridge:kyc:${ref}`),
    )
    rec.kycLinkId = link.id
    if (link.customer_id) rec.customerId = link.customer_id
    await saveRec(ref, rec, ctx)
    return link
  }

  /**
   * The KYC step the user must take now, or undefined when the customer is approved for `endorsement`.
   * Order: the customer from the hook or an earlier session, then the KYC link, then a new KYC link
   * (with a FORM first when the name or the email is unknown).
   */
  async function kycGate(ref: string, rec: LegRec, endorsement: string, ctx: AdapterContext, hint?: BridgeCustomerHint): Promise<LegStep | undefined> {
    if (!rec.customerId && !rec.kycLinkId) {
      const known = await ctx.shared.get<UserRec>(userKey(rec.userId))
      const h = hint ?? (opts.customer ? await opts.customer({ userId: rec.userId, ...(rec.email ? { email: rec.email } : {}) }) : undefined)
      const customerId = h?.customerId ?? known?.customerId
      if (customerId) rec.customerId = customerId
      // Keep the earlier KYC link when it belongs to this customer: it is where the user adds a missing endorsement.
      if (known?.kycLinkId && (!h?.customerId || h.customerId === known.customerId)) rec.kycLinkId = known.kycLinkId
      if (!rec.customerId && !rec.kycLinkId) {
        const fullName = h?.fullName?.trim()
        const email = (h?.email ?? rec.email)?.trim()
        if (!fullName || !email) {
          await saveRec(ref, rec, ctx)
          return kycFormStep(ref, [...(!fullName ? (['full_name'] as const) : []), ...(!email ? (['email'] as const) : [])])
        }
        const link = await createKycLink(ref, rec, endorsement, fullName, email, ctx)
        return linkStep(ref, rec, link, endorsement, ctx)
      }
      await saveRec(ref, rec, ctx)
    }
    if (!rec.customerId && rec.kycLinkId) {
      const link = await call<KycLink>(ctx, 'GET', `/kyc_links/${encodeURIComponent(rec.kycLinkId)}`, 'check identity verification')
      return linkStep(ref, rec, link, endorsement, ctx)
    }
    return customerStep(ref, rec, endorsement, ctx)
  }

  async function linkStep(ref: string, rec: LegRec, link: KycLink, endorsement: string, ctx: AdapterContext): Promise<LegStep | undefined> {
    if (link.kyc_status === 'rejected' || link.kyc_status === 'offboarded') return failStep(ref)
    if (link.tos_status !== 'approved' && link.tos_link) return redirectStep(ref, link.tos_link, 'kyc_terms')
    if (link.kyc_status === 'approved' && link.customer_id) {
      if (rec.customerId !== link.customer_id) {
        rec.customerId = link.customer_id
        await saveRec(ref, rec, ctx)
      }
      return customerStep(ref, rec, endorsement, ctx, link)
    }
    if (link.kyc_link && ['not_started', 'incomplete', 'awaiting_questionnaire', 'awaiting_ubo', undefined].includes(link.kyc_status)) {
      return redirectStep(ref, link.kyc_link, 'kyc_verify')
    }
    return reviewStep(ref)
  }

  async function customerStep(ref: string, rec: LegRec, endorsement: string, ctx: AdapterContext, link?: KycLink): Promise<LegStep | undefined> {
    const c = await call<Customer>(ctx, 'GET', `/customers/${encodeURIComponent(rec.customerId!)}`, 'check your account')
    if (c.status === 'rejected' || c.status === 'offboarded') return failStep(ref)
    if (c.status === 'paused' || c.status === 'deposits_restricted') {
      return failStep(ref, openRampError('PROVIDER_DECLINED', { message: 'Bridge cannot take payments on this account now. Contact support.', recovery: 'contact_support' }))
    }
    const e = c.endorsements?.find((x) => x.name === endorsement)
    if (c.status === 'active' && (!c.endorsements || e?.status === 'approved')) return undefined
    if (e?.status === 'revoked') return failStep(ref)
    // Not approved yet (or the rail's endorsement needs more steps): send the user back to the KYC link when we have one.
    // TO VERIFY: how to add an endorsement to a customer that was approved without it (a new KYC link with the endorsement?).
    if (link?.kyc_link && c.status !== 'under_review') return redirectStep(ref, link.kyc_link, 'kyc_verify')
    if (!link && rec.kycLinkId) {
      const l = await call<KycLink>(ctx, 'GET', `/kyc_links/${encodeURIComponent(rec.kycLinkId)}`, 'check identity verification')
      if (l.kyc_link && c.status !== 'under_review' && l.kyc_status !== 'under_review') return redirectStep(ref, l.kyc_link, 'kyc_verify')
    }
    return reviewStep(ref)
  }

  // ---------- deposits ----------

  function bankFields(i: DepositInstructions, amount: string, currency: string): Surface {
    const f: Array<{ label: string; value: string; copy: boolean }> = []
    const add = (label: string, value: string | undefined, copy = true) => {
      if (value) f.push({ label, value, copy })
    }
    add('Amount', `${amount} ${currency}`)
    add('Bank name', i.bank_name, false)
    add('Routing number', i.bank_routing_number)
    add('Account number', i.bank_account_number ?? i.account_number)
    add('Sort code', i.sort_code)
    add('IBAN', i.iban)
    add('BIC', i.bic)
    add('CLABE', i.clabe)
    add('Beneficiary', i.bank_beneficiary_name ?? i.account_holder_name)
    add('Beneficiary address', i.bank_beneficiary_address, false)
    add('Bank address', i.bank_address, false)
    add('Reference', i.deposit_message)
    return { kind: 'BANK_FIELDS', fields: f }
  }

  function depositSurface(rec: LegRec): Surface {
    const i = rec.instructions ?? {}
    const cur = rec.input.asset.kind === 'fiat' ? rec.input.asset.currency : 'USD'
    if (i.br_code) return { kind: 'QR', payload: i.br_code, amount: rec.input.value, currency: cur, method: 'pix' }
    return bankFields(i, rec.input.value, cur)
  }

  const depositPaymentStep = (ref: string, rec: LegRec): LegStep => ({
    state: 'PAYMENT',
    sub: 'bank_details',
    status: 'awaiting_user',
    ref,
    surface: depositSurface(rec),
    transitions: [awaitPoll(BANK_POLL)],
  })

  /** One virtual account per customer, currency, chain and address, reused across sessions. */
  async function ensureVirtualAccount(ref: string, rec: LegRec, r: DepositRail, ctx: AdapterContext): Promise<void> {
    const c = chainFor(rec.asset)
    const vaKey = `va:${rec.customerId}:${r.currency}:${c.rail}:${rec.address}`
    let va = await ctx.shared.get<{ id: string; instructions: DepositInstructions }>(vaKey)
    if (!va) {
      const created = await call<VirtualAccount>(
        ctx,
        'POST',
        `/customers/${encodeURIComponent(rec.customerId!)}/virtual_accounts`,
        'open a bank account for you',
        {
          source: { currency: r.currency.toLowerCase() },
          destination: { currency: 'usdc', payment_rail: c.rail, address: rec.address },
          ...(opts.developerFeePercent ? { developer_fee_percent: opts.developerFeePercent } : {}),
        },
        ctx.idempotencyKey(`bridge:va:${ref}`),
      )
      if (!created.id || !created.source_deposit_instructions) throw new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message: 'Bridge did not return bank details.' }), 502)
      va = { id: created.id, instructions: created.source_deposit_instructions }
      await ctx.shared.put(vaKey, va, REC_TTL_SEC)
    }
    rec.vaId = va.id
    rec.instructions = va.instructions
    await saveRec(ref, rec, ctx)
    // Webhooks for this account go to the newest session that shows it.
    await ctx.shared.put(`vaRef:${va.id}`, ref, REC_TTL_SEC)
  }

  /** Map a virtual account event of one deposit to a leg event. Returns undefined for non-payment events. */
  function vaEvent(ref: string, rec: LegRec, ev: VaEvent): LegEvent | undefined {
    const hash = ev.destination_tx_hash ?? ev.receipt?.destination_tx_hash
    switch (ev.type) {
      case 'funds_scheduled':
      case 'funds_received':
      case 'in_review':
      case 'payment_submitted':
      case 'refund_in_flight':
        return { ref, status: 'processing', ...(hash ? { txHash: hash } : {}) }
      case 'payment_processed': {
        // "For outgoing events such as payment_submitted and payment_processed, this is the amount of funds sent to the destination."
        const out = dec(ev.receipt?.final_amount) ?? dec(ev.amount)
        return { ref, status: 'succeeded', ...(hash ? { txHash: hash } : {}), ...(out ? { output: { value: out, asset: rec.asset } } : {}) }
      }
      // TO VERIFY: the docs table says `refunded`, the OpenAPI enum says `refund`. Accept both.
      case 'refund':
      case 'refunded':
        return { ref, status: 'refunded' }
      case 'refund_failed':
        return { ref, status: 'failed', error: openRampError('DELIVERY_FAILED', { message: 'Bridge could not deliver or refund this deposit. Contact support.', recovery: 'contact_support' }) }
      default:
        return undefined // microdeposit, account_update, activation, deactivation
    }
  }

  const RANK: Record<string, number> = { payment_processed: 5, refund: 5, refunded: 5, refund_failed: 5, refund_in_flight: 4, payment_submitted: 3, in_review: 2, funds_received: 1, funds_scheduled: 0 }

  /** Claim a deposit for this leg. The first leg that sees a deposit keeps it. */
  function claim(ref: string, depositId: string, ctx: Pick<AdapterContext, 'shared'>): Promise<boolean> {
    return claimOnce(ctx.shared, `dep:${depositId}`, ref, REC_TTL_SEC)
  }

  function after(ev: VaEvent, rec: LegRec): boolean {
    const t = ev.created_at ? Date.parse(ev.created_at) : NaN
    // A minute of slack for clock skew between Bridge and this server.
    return Number.isFinite(t) && t >= rec.since - 60_000
  }

  async function depositStatus(ref: string, rec: LegRec, ctx: AdapterContext): Promise<LegStep> {
    const res = await call<{ data?: VaEvent[] }>(
      ctx,
      'GET',
      `/customers/${encodeURIComponent(rec.customerId!)}/virtual_accounts/${encodeURIComponent(rec.vaId!)}/history?limit=50`,
      'check your deposit',
    )
    const byDeposit = new Map<string, VaEvent[]>()
    for (const ev of res.data ?? []) {
      if (!ev.deposit_id || RANK[ev.type] === undefined || !after(ev, rec)) continue
      ;(byDeposit.get(ev.deposit_id) ?? byDeposit.set(ev.deposit_id, []).get(ev.deposit_id)!).push(ev)
    }
    // Oldest deposit first: the first deposit after the session started belongs to it.
    const deposits = [...byDeposit.entries()].sort((a, b) => minTime(a[1]) - minTime(b[1]))
    for (const [depositId, events] of deposits) {
      if (!(await claim(ref, depositId, ctx))) continue
      const best = [...events].sort((a, b) => (RANK[b.type] ?? -1) - (RANK[a.type] ?? -1))[0]!
      const le = vaEvent(ref, rec, best)
      if (le) return stepFromEvent(le)
    }
    return depositPaymentStep(ref, rec)
  }

  function minTime(events: VaEvent[]): number {
    return Math.min(...events.map((e) => Date.parse(e.created_at ?? '') || 0))
  }

  // ---------- payouts ----------

  function payoutFields(r: PayoutRail): FieldSpec[] {
    const names: FieldSpec[] = [
      { id: 'first_name', label: 'First name', type: 'text', required: true },
      { id: 'last_name', label: 'Last name', type: 'text', required: true },
    ]
    const address: FieldSpec[] = [
      { id: 'street_line_1', label: 'Street address', type: 'text', required: true },
      { id: 'city', label: 'City', type: 'text', required: true },
      { id: 'postal_code', label: 'Postal code', type: 'text', required: true },
    ]
    if (r.currency === 'USD') {
      return [
        ...names,
        { id: 'bank_name', label: 'Bank name', type: 'text', required: true },
        { id: 'routing_number', label: 'Routing number', type: 'text', required: true },
        { id: 'account_number', label: 'Account number', type: 'text', required: true },
        { id: 'checking_or_savings', label: 'Account type', type: 'select', required: true, options: [{ value: 'checking', label: 'Checking' }, { value: 'savings', label: 'Savings' }] },
        ...address,
        { id: 'state', label: 'State (2 letters)', type: 'text', required: true },
      ]
    }
    return [
      ...names,
      { id: 'iban', label: 'IBAN', type: 'text', required: true },
      { id: 'bic', label: 'BIC', type: 'text', required: true },
      ...address,
      { id: 'country', label: 'Country (3-letter code, e.g. DEU)', type: 'text', required: true },
    ]
  }

  const payoutFormStep = (ref: string, r: PayoutRail): LegStep => ({
    state: 'PAYMENT',
    sub: 'payout_account',
    status: 'awaiting_user',
    ref,
    surface: { kind: 'FORM', fields: payoutFields(r) },
    transitions: [{ name: 'submit_details', kind: 'SUBMIT', label: 'Continue' }],
  })

  function sendStep(ref: string, rec: LegRec): LegStep {
    const a = rec.asset
    const amount = toBaseUnits(rec.payAmount ?? rec.input.value, 6)
    const tx: TxRequest = isSolanaChain(a.chain)
      ? { kind: 'solana', type: 'transfer', to: rec.payTo!, mint: a.token, amount, decimals: 6 }
      : { to: a.token, data: erc20TransferData(rec.payTo!, amount), value: '0', chainId: evmChainId(a.chain)! }
    return {
      state: 'PAYMENT',
      sub: 'send_crypto',
      status: 'awaiting_user',
      ref,
      surface: { kind: 'WALLET_TX', chain: a.chain, txs: [tx] },
      transitions: [{ name: 'submit_tx', kind: 'SURFACE_RESULT', expects: 'tx_hash' }],
    }
  }

  function field(inputs: Record<string, unknown> | undefined, id: string): string {
    const v = inputs?.[id]
    return typeof v === 'string' ? v.trim() : ''
  }

  function bad(message: string): OpenRampException {
    return new OpenRampException(openRampError('BAD_REQUEST', { message }), 400)
  }

  /** The POST body for an external account, from the FORM inputs. Validates the formats. */
  function externalAccountBody(r: PayoutRail, inputs: Record<string, unknown> | undefined): Record<string, unknown> {
    for (const f of payoutFields(r)) if (!field(inputs, f.id)) throw bad(`Enter the ${f.label.toLowerCase()}.`)
    const v = (id: string) => field(inputs, id)
    const owner = { account_owner_type: 'individual', account_owner_name: `${v('first_name')} ${v('last_name')}`, first_name: v('first_name'), last_name: v('last_name') }
    if (r.currency === 'USD') {
      if (!/^\d{9}$/.test(v('routing_number'))) throw bad('Enter a valid 9-digit routing number.')
      if (!/^\d{4,17}$/.test(v('account_number'))) throw bad('Enter a valid account number.')
      if (!['checking', 'savings'].includes(v('checking_or_savings'))) throw bad('Choose checking or savings.')
      if (!/^[A-Za-z]{2}$/.test(v('state'))) throw bad('Enter the state as 2 letters.')
      return {
        currency: 'usd',
        account_type: 'us',
        bank_name: v('bank_name'),
        ...owner,
        account: { routing_number: v('routing_number'), account_number: v('account_number'), checking_or_savings: v('checking_or_savings') },
        address: { street_line_1: v('street_line_1'), city: v('city'), state: v('state').toUpperCase(), postal_code: v('postal_code'), country: 'USA' },
      }
    }
    const iban = v('iban').replace(/\s+/g, '').toUpperCase()
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) throw bad('Enter a valid IBAN.')
    if (!/^[A-Za-z0-9]{8}([A-Za-z0-9]{3})?$/.test(v('bic'))) throw bad('Enter a valid BIC.')
    if (!/^[A-Za-z]{3}$/.test(v('country'))) throw bad('Enter the country as a 3-letter code, for example DEU.')
    const country = v('country').toUpperCase()
    return {
      currency: 'eur',
      account_type: 'iban',
      ...owner,
      iban: { account_number: iban, bic: v('bic').toUpperCase(), country },
      address: { street_line_1: v('street_line_1'), city: v('city'), postal_code: v('postal_code'), country },
    }
  }

  async function createTransfer(ref: string, rec: LegRec, r: PayoutRail, ctx: AdapterContext): Promise<void> {
    const c = chainFor(rec.asset)
    const t = await call<Transfer>(
      ctx,
      'POST',
      '/transfers',
      'start the payout',
      {
        amount: rec.input.value,
        on_behalf_of: rec.customerId,
        client_reference_id: ref,
        ...(opts.developerFeePercent ? { developer_fee_percent: opts.developerFeePercent } : {}),
        source: { payment_rail: c.rail, currency: 'usdc', ...(rec.fromAddress ? { from_address: rec.fromAddress } : {}) },
        destination: { payment_rail: r.rail, currency: r.currency.toLowerCase(), external_account_id: rec.externalAccountId },
        // TO VERIFY: without a known sender, `allow_any_from_address` lets Bridge take the USDC from any address.
        ...(rec.fromAddress ? {} : { features: { allow_any_from_address: true } }),
      },
      ctx.idempotencyKey(`bridge:transfer:${ref}`),
    )
    const to = t.source_deposit_instructions?.to_address
    if (!t.id || !to) throw new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message: 'Bridge did not return a deposit address.' }), 502)
    rec.transferId = t.id
    rec.payTo = to
    rec.payAmount = dec(t.source_deposit_instructions?.amount) ?? rec.input.value
    await saveRec(ref, rec, ctx)
    await ctx.shared.put(`tr:${t.id}`, ref, REC_TTL_SEC)
  }

  function transferEvent(ref: string, rec: LegRec | undefined, t: Transfer): LegEvent | undefined {
    const hash = t.receipt?.destination_tx_hash ?? t.receipt?.source_tx_hash
    switch (t.state) {
      case 'awaiting_funds':
        return undefined
      case 'in_review':
      case 'funds_received':
      case 'payment_submitted':
      case 'refund_in_flight':
        return { ref, status: 'processing' }
      case 'payment_processed': {
        const out = dec(t.receipt?.final_amount)
        const cur = rec && payoutById.get(rec.legId)?.currency
        return { ref, status: 'succeeded', ...(hash ? { txHash: hash } : {}), ...(out && cur ? { output: { value: out, asset: { kind: 'fiat', currency: cur } } } : {}) }
      }
      case 'refunded':
        return { ref, status: 'refunded' }
      case 'canceled':
      case 'error':
      case 'undeliverable':
      case 'returned':
      case 'refund_failed':
      case 'missing_return_policy':
        return { ref, status: 'failed', error: openRampError('DELIVERY_FAILED', { message: `Bridge could not pay out (${t.state}). Contact support.`, recovery: 'contact_support' }) }
      default:
        return { ref, status: 'processing' }
    }
  }

  async function payoutStatus(ref: string, rec: LegRec, ctx: AdapterContext): Promise<LegStep> {
    const t = await call<Transfer>(ctx, 'GET', `/transfers/${encodeURIComponent(rec.transferId!)}`, 'check the payout')
    const ev = transferEvent(ref, rec, t)
    if (!ev) return rec.txHash ? { state: 'PROCESSING', sub: 'confirming', status: 'processing', ref, txHash: rec.txHash, transitions: [awaitPoll(BANK_POLL)] } : sendStep(ref, rec)
    return stepFromEvent(ev)
  }

  // ---------- the state machine ----------

  function stepFromEvent(ev: LegEvent): LegStep {
    const extra = { ref: ev.ref, ...(ev.txHash ? { txHash: ev.txHash } : {}), ...(ev.output ? { output: ev.output } : {}) }
    const map: Record<LegStatus, LegStep> = {
      pending: { state: 'PROCESSING', status: 'processing', transitions: [awaitPoll(BANK_POLL)], ...extra },
      awaiting_user: { state: 'PAYMENT', status: 'awaiting_user', transitions: [awaitPoll(BANK_POLL)], ...extra },
      processing: { state: 'PROCESSING', sub: 'settling', status: 'processing', transitions: [awaitPoll(BANK_POLL)], ...extra },
      succeeded: { state: 'COMPLETED', status: 'succeeded', transitions: [], ...extra },
      failed: { state: 'FAILED', status: 'failed', transitions: [], ...extra, ...(ev.error ? { error: ev.error } : {}) },
      refunded: { state: 'REFUNDED', status: 'refunded', transitions: [], ...extra },
      expired: { state: 'EXPIRED', status: 'expired', transitions: [], ...extra },
      reversed: { state: 'REVERSED', status: 'reversed', transitions: [], ...extra },
    }
    return map[ev.status]
  }

  /** Move the leg as far as it can go now, and return the step for the user. */
  async function advance(ref: string, rec: LegRec, ctx: AdapterContext, hint?: BridgeCustomerHint): Promise<LegStep> {
    if (rec.kind === 'deposit') {
      const r = depositById.get(rec.legId)!
      if (!rec.vaId) {
        const gate = await kycGate(ref, rec, r.endorsement, ctx, hint)
        if (gate) return gate
        await ensureVirtualAccount(ref, rec, r, ctx)
        return depositPaymentStep(ref, rec)
      }
      return depositStatus(ref, rec, ctx)
    }
    const r = payoutById.get(rec.legId)!
    if (!rec.transferId) {
      if (!rec.externalAccountId) {
        const gate = await kycGate(ref, rec, r.endorsement, ctx, hint)
        if (gate) return gate
        await saveRec(ref, rec, ctx)
        return payoutFormStep(ref, r)
      }
      await createTransfer(ref, rec, r, ctx)
      return sendStep(ref, rec)
    }
    return payoutStatus(ref, rec, ctx)
  }

  function railOf(legId: string): { deposit?: DepositRail; payout?: PayoutRail } {
    const deposit = depositById.get(legId)
    const payout = payoutById.get(legId)
    if (!deposit && !payout) throw new OpenRampException(openRampError('BAD_REQUEST', { message: `Unknown Bridge leg ${legId}` }), 400)
    return { ...(deposit ? { deposit } : {}), ...(payout ? { payout } : {}) }
  }

  return createAdapter({
    id: 'bridge',
    env,
    name: 'Bridge',
    legs,

    async quote(input, ctx) {
      const { deposit, payout } = railOf(input.leg.legId)
      return deposit ? depositQuote(deposit, input, ctx) : payoutQuote(payout!, input, ctx)
    },

    async start(input: StartInput, ctx) {
      const { deposit } = railOf(input.leg.legId)
      const ref = `brg_${randomHex(10)}`
      const out = input.quote.output.asset
      const src = input.quote.input.asset
      let rec: LegRec
      if (deposit) {
        if (out.kind !== 'crypto') throw new OpenRampException(openRampError('BAD_REQUEST', { message: 'Bridge deposits deliver USDC.' }), 400)
        const address = input.deliverTo?.address ?? (ctx.destination.type === 'crypto' ? ctx.destination.address : undefined)
        if (!address) throw new OpenRampException(openRampError('BAD_REQUEST', { message: 'Bridge needs a wallet address to deliver to.' }), 400)
        rec = { kind: 'deposit', legId: input.leg.legId, userId: ctx.session.userId, since: Date.now(), input: input.quote.input, asset: out, address }
      } else {
        if (src.kind !== 'crypto') throw new OpenRampException(openRampError('BAD_REQUEST', { message: 'Bridge payouts take USDC.' }), 400)
        const from = input.source?.address
        rec = { kind: 'payout', legId: input.leg.legId, userId: ctx.session.userId, since: Date.now(), input: input.quote.input, asset: src, ...(from ? { fromAddress: from } : {}) }
      }
      if (ctx.session.email) rec.email = ctx.session.email
      await saveRec(ref, rec, ctx)
      return advance(ref, rec, ctx)
    },

    async transition({ ref, name, inputs }, ctx) {
      const rec = await loadRec(ref, ctx)
      if (name === 'submit_kyc') {
        if (rec.customerId || rec.kycLinkId) return advance(ref, rec, ctx)
        const fullName = field(inputs, 'full_name')
        const email = field(inputs, 'email') || rec.email || ''
        if (fullName.length < 2) throw bad('Enter your full legal name.')
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Enter a valid email address.')
        // The hook may know the customer by now; the form answers fill in only what it does not give.
        const h = opts.customer ? await opts.customer({ userId: rec.userId, email }) : undefined
        return advance(ref, rec, ctx, { ...h, fullName: h?.fullName ?? fullName, email: h?.email ?? email })
      }
      if (name === 'submit_details') {
        const r = payoutById.get(rec.legId)
        if (!r) throw bad('This leg has no payout account.')
        if (rec.externalAccountId) return advance(ref, rec, ctx)
        if (!rec.customerId) return advance(ref, rec, ctx)
        const ea = await call<{ id: string }>(
          ctx,
          'POST',
          `/customers/${encodeURIComponent(rec.customerId)}/external_accounts`,
          'add this bank account',
          externalAccountBody(r, inputs),
          ctx.idempotencyKey(`bridge:ea:${ref}`),
        )
        if (!ea.id) throw new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message: 'Bridge did not save the bank account.' }), 502)
        rec.externalAccountId = ea.id
        await saveRec(ref, rec, ctx)
        return advance(ref, rec, ctx)
      }
      if (name === 'submit_tx') {
        if (rec.kind !== 'payout' || !rec.transferId) throw new OpenRampException(openRampError('BAD_REQUEST', { message: 'Enter the payout account first.' }), 409)
        const txHash = typeof inputs?.txHash === 'string' ? inputs.txHash : undefined
        if (txHash) {
          rec.txHash = txHash
          await saveRec(ref, rec, ctx)
        }
        return { state: 'PROCESSING', sub: 'confirming', status: 'processing', ref, transitions: [awaitPoll(BANK_POLL)], ...(txHash ? { txHash } : {}) }
      }
      throw new OpenRampException(openRampError('BAD_REQUEST', { message: `Transition ${name} is not supported.` }), 409)
    },

    async status({ ref }, ctx) {
      const rec = await loadRec(ref, ctx)
      return advance(ref, rec, ctx)
    },

    webhook: {
      // Without the webhookPublicKey, no webhook can verify (see `resultChannels`).
      configured: !!opts.webhookPublicKey,
      async verify(req, rawBody, ctx) {
        // An empty key would accept nothing useful; refuse clearly (for example an unset environment variable).
        if (!opts.webhookPublicKey) {
          ctx.log.warn('bridge: webhookPublicKey is not set; rejecting webhook')
          return false
        }
        const header = req.headers.get('x-webhook-signature')
        if (!header) return false
        try {
          keyPromise ??= importBridgePublicKey(opts.webhookPublicKey)
          return await verifyBridgeSignature(await keyPromise, header, rawBody)
        } catch (e) {
          keyPromise = undefined
          ctx.log.warn('bridge: webhook verification failed', { error: String((e as Error)?.message ?? e).slice(0, 200) })
          return false
        }
      },

      async parse(rawBody, ctx) {
        let env: WebhookEnvelope
        try {
          env = JSON.parse(rawBody) as WebhookEnvelope
        } catch {
          ctx.log.warn('bridge: webhook body is not JSON')
          return []
        }
        const obj = env.event_object ?? {}
        if (env.event_category === 'virtual_account.activity') {
          const ev = obj as unknown as VaEvent
          if (!ev.virtual_account_id || !ev.deposit_id) return []
          const ref = await ctx.shared.get<string>(`vaRef:${ev.virtual_account_id}`)
          if (!ref) return []
          const rec = await ctx.shared.get<LegRec>(recKey(ref))
          if (!rec || !after(ev, rec) || !(await claim(ref, ev.deposit_id, ctx))) return []
          const le = vaEvent(ref, rec, ev)
          return le ? [le] : []
        }
        if (env.event_category === 'transfer') {
          const t = obj as unknown as Transfer
          const ref = t.client_reference_id ?? (t.id ? await ctx.shared.get<string>(`tr:${t.id}`) : undefined)
          if (!ref || !t.state) return []
          const rec = await ctx.shared.get<LegRec>(recKey(ref))
          const le = transferEvent(ref, rec, t)
          return le ? [le] : []
        }
        // kyc_link and customer events: the status poll moves the KYC step on.
        return []
      },
    },
  })
}

