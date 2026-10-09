// Xendit adapter: fiat pay-in to the merchant's own Xendit account (Payments API v3).
// QR rails (QRIS, QR Ph, PromptPay, PayNow QR as SGQR) and e-wallets (GCash, DANA, OVO, MoMo, ZaloPay, ...).
// No crypto: the destination is `{ type: 'merchant', currency }`.
// Docs: https://docs.xendit.co/apidocs/create-payment-request , payment webhook, get payment request.

import { awaitPoll, createAdapter, fetchJson, httpErrorToOpenRamp, quoteExpiresAt, resolveEnv, statusMap, timingSafeEqual, webhookBodyKey } from '@openrampkit/adapter'
import type { AdapterContext, AdapterEnv, LegEvent } from '@openrampkit/adapter'
import { OpenRampException, add, bps as applyBps, cmp, minorUnits, openRampError, roundTo, sub } from '@openrampkit/core'
import type { Fee, LegQuote, LegSpec, LegStatus, LegStep, PollSpec, Surface } from '@openrampkit/core'

export type XenditOptions = {
  /** Secret API key (xnd_development_... or xnd_production_...) */
  secretKey: string
  /** Webhook verification token from Dashboard > Settings > Webhooks */
  webhookToken: string
  /** Sub-account id for xenPlatform (sent as `for-user-id`) */
  forUserId?: string
  apiUrl?: string
  /** Optional fee model for quotes, per method: bps and/or fixed amount in the payment currency. */
  fees?: Record<string, { bps?: number; fixed?: string }>
  /** Payment expiry in minutes for QR codes (default 15) */
  expiryMinutes?: number
  /** Limit which methods to offer */
  methods?: string[]
  /**
   * 'sandbox' (test mode) or 'production' (live mode). Default: from the key prefix (`xnd_development_`:
   * sandbox; `xnd_production_`: production). A value that does not agree with the key throws.
   */
  env?: AdapterEnv
}

/** The Xendit mode of a secret key, from its prefix */
export function xenditKeyEnv(key: string): AdapterEnv | undefined {
  if (key.startsWith('xnd_development_')) return 'sandbox'
  if (key.startsWith('xnd_production_')) return 'production'
  return undefined
}

type Channel = { country: string; currency: string; method: string; code: string; min: string; max: string; kind: 'qr' | 'ewallet' }

/** OpenRampKit method id to Xendit channel code, per country. Limits from Xendit channel pages. */
export const XENDIT_CHANNELS: Channel[] = [
  // Indonesia
  { country: 'ID', currency: 'IDR', method: 'qris', code: 'QRIS', min: '1', max: '10000000', kind: 'qr' },
  { country: 'ID', currency: 'IDR', method: 'dana', code: 'DANA', min: '1', max: '10000000', kind: 'ewallet' },
  { country: 'ID', currency: 'IDR', method: 'ovo', code: 'OVO', min: '100', max: '10000000', kind: 'ewallet' },
  { country: 'ID', currency: 'IDR', method: 'shopeepay', code: 'SHOPEEPAY', min: '1', max: '10000000', kind: 'ewallet' },
  // Philippines
  { country: 'PH', currency: 'PHP', method: 'qrph', code: 'QRPH', min: '1', max: '50000', kind: 'qr' },
  { country: 'PH', currency: 'PHP', method: 'gcash', code: 'GCASH', min: '1', max: '100000', kind: 'ewallet' },
  { country: 'PH', currency: 'PHP', method: 'maya', code: 'PAYMAYA', min: '1', max: '100000', kind: 'ewallet' },
  { country: 'PH', currency: 'PHP', method: 'grabpay', code: 'GRABPAY', min: '1', max: '100000', kind: 'ewallet' },
  // Thailand
  { country: 'TH', currency: 'THB', method: 'promptpay', code: 'PROMPTPAY', min: '1', max: '700000', kind: 'qr' },
  { country: 'TH', currency: 'THB', method: 'truemoney', code: 'TRUEMONEY', min: '1', max: '100000', kind: 'ewallet' },
  // Malaysia (DuitNow QR: TO VERIFY channel code with Xendit)
  { country: 'MY', currency: 'MYR', method: 'touchngo', code: 'TOUCHNGO', min: '1', max: '10000', kind: 'ewallet' },
  { country: 'MY', currency: 'MYR', method: 'grabpay', code: 'GRABPAY', min: '1', max: '10000', kind: 'ewallet' },
  // Vietnam (VietQR: TO VERIFY; not in Xendit's public channel list as of 2026-09)
  { country: 'VN', currency: 'VND', method: 'momo', code: 'MOMO', min: '1000', max: '50000000', kind: 'ewallet' },
  { country: 'VN', currency: 'VND', method: 'zalopay', code: 'ZALOPAY', min: '1000', max: '50000000', kind: 'ewallet' },
  // Singapore: PayNow QR has channel code SGQR, not PAYNOW (https://docs.xendit.co/docs/paynow-qr, read 2026-10-09).
  // With PAYNOW, test mode answered 400 API_VALIDATION_ERROR "API endpoint and method is not supported".
  { country: 'SG', currency: 'SGD', method: 'paynow', code: 'SGQR', min: '0.01', max: '200000', kind: 'qr' },
]

const POLL: PollSpec = { intervalMs: 2500, backoff: 1.2, maxIntervalMs: 10_000, giveUpAfterMs: 30 * 60_000 }
const API_VERSION = '2024-11-11'

type XenditAction = { type: string; descriptor: string; value: string }
type XenditPaymentRequest = {
  payment_request_id: string
  reference_id: string
  /** ACCEPTING_PAYMENTS, REQUIRES_ACTION, AUTHORIZED, CANCELED, EXPIRED, SUCCEEDED or FAILED (see `STATUS`) */
  status: string
  currency: string
  request_amount: number
  channel_code: string
  actions?: XenditAction[]
  failure_code?: string
}

/** Xendit payment request status to leg status. An unknown status is not in the table (see `toStep`). */
const STATUS = statusMap<LegStatus>('Xendit', {
  ACCEPTING_PAYMENTS: 'requires_action',
  REQUIRES_ACTION: 'requires_action',
  AUTHORIZED: 'processing',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELED: 'failed',
  EXPIRED: 'expired',
})

const legId = (c: Channel) => `${c.country.toLowerCase()}-${c.method}`

export function xendit(opts: XenditOptions) {
  const keyEnv = xenditKeyEnv(opts.secretKey)
  const env = resolveEnv('xendit', opts.env, undefined, keyEnv)
  if (opts.env && keyEnv && opts.env !== keyEnv) throw new Error(`xendit: env is '${opts.env}', but secretKey is a ${keyEnv === 'sandbox' ? 'test mode (xnd_development_)' : 'live mode (xnd_production_)'} key`)
  const api = (opts.apiUrl ?? 'https://api.xendit.co').replace(/\/$/, '')
  const channels = XENDIT_CHANNELS.filter((c) => !opts.methods || opts.methods.includes(c.method))
  const byLeg = new Map(channels.map((c) => [legId(c), c]))
  const auth = `Basic ${btoa(`${opts.secretKey}:`)}`

  const legs: LegSpec[] = channels.map((c) => ({
    id: legId(c),
    kind: 'fiat_payin',
    methods: [c.method],
    from: { asset: { kind: 'fiat', currencies: [c.currency] }, location: ['user_account'] },
    to: { asset: { kind: 'fiat', currencies: [c.currency] }, location: ['merchant_account'] },
    regions: { allow: [c.country], deny: [] },
    limits: { min: c.min, max: c.max, currency: c.currency },
    eta: c.kind === 'qr' ? { min: 5, max: 60 } : { min: 10, max: 120 },
    surfaces: c.kind === 'qr' ? ['QR'] : ['REDIRECT', 'DEEPLINK'],
  }))

  function channelFor(id: string): Channel {
    const c = byLeg.get(id)
    if (!c) throw new OpenRampException(openRampError('BAD_REQUEST', { message: `Unknown Xendit leg ${id}` }), 400)
    return c
  }

  function feesFor(c: Channel, amount: string): Fee[] {
    const f = opts.fees?.[c.method]
    if (!f) return []
    let total = '0'
    if (f.bps) total = add(total, applyBps(amount, f.bps))
    if (f.fixed) total = add(total, f.fixed)
    return [{ kind: 'provider', label: 'Xendit fee', amount: { value: roundTo(total, minorUnits(c.currency)), asset: { kind: 'fiat', currency: c.currency } }, included: true }]
  }

  async function call<T>(ctx: Pick<AdapterContext, 'fetch' | 'log'>, method: 'GET' | 'POST', path: string, body?: unknown, idem?: string, c?: Channel): Promise<T> {
    try {
      return await fetchJson<T>(ctx.fetch, `${api}${path}`, {
        method,
        headers: {
          authorization: auth,
          'api-version': API_VERSION,
          ...(opts.forUserId ? { 'for-user-id': opts.forUserId } : {}),
          ...(idem ? { 'idempotency-key': idem } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    } catch (e) {
      throw toOpenRamp(e, ctx, c)
    }
  }

  /**
   * Map a failed Xendit call. Two answers mean our setup is wrong, not the payment: a retry or another
   * amount cannot fix them, so they are not retryable and the operator gets a log line that says what to do.
   * - 403 INVALID_MERCHANT_SETTINGS ("payment channel has not been activated"): activate the channel in the
   *   Xendit Dashboard (in test mode for development keys).
   * - 400 API_VALIDATION_ERROR on a payment request for a channel ("... not supported for 'X' channel code"):
   *   the channel code or request body does not match the Xendit API for that channel.
   */
  function toOpenRamp(e: unknown, ctx: Pick<AdapterContext, 'log'>, c?: Channel): OpenRampException {
    const status = (e as { status?: number }).status
    const errBody = (e as { body?: { error_code?: string; message?: string } }).body
    const code = errBody?.error_code
    const msg = errBody?.message
    if (status === 429) return new OpenRampException(openRampError('RATE_LIMITED'), 429)
    const name = c ? `${c.method} (${c.code}, ${c.country})` : 'this channel'
    const setup = (operator: string) => {
      ctx.log.error(operator, { status, error_code: code, message: msg?.slice(0, 200) })
      return new OpenRampException(
        openRampError('PROVIDER_UNAVAILABLE', { message: 'This payment method is not set up for this app yet. Try another method.', retryable: false, recovery: 'choose_other' }),
        502,
      )
    }
    if (status === 403 && code === 'INVALID_MERCHANT_SETTINGS') {
      return setup(`xendit: channel ${name} is not activated for this Xendit account. Activate the payment channel in the Xendit Dashboard (in test mode for xnd_development_ keys), then try again.`)
    }
    if (status === 400 && code === 'API_VALIDATION_ERROR' && c && /channel/i.test(msg ?? '')) {
      return setup(`xendit: Xendit refused the payment request for channel ${name}: ${(msg ?? '').slice(0, 200)}. Check the channel code and request body for this channel in the Xendit API reference.`)
    }
    // Other 401 and 403 answers refuse our key or its permissions: a setup error, not a payment decline.
    if (status === 401 || status === 403) {
      return httpErrorToOpenRamp(e, 'Xendit', {
        what: `call the API for ${name}`,
        log: ctx.log,
        setupHint: `Xendit answered ${code ?? 'with no error code'}. Check secretKey (xnd_development_ for test mode, xnd_production_ for live mode) and the API key permissions in the Xendit Dashboard.`,
      })
    }
    // Other 4xx answers are about this payment (amount, account, channel state): a decline.
    if (status && status >= 400 && status < 500) return new OpenRampException(openRampError('PROVIDER_DECLINED', { message: msg ? `Xendit: ${msg}`.slice(0, 200) : 'Xendit declined this payment.' }), 422)
    return new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message: 'Xendit is not available right now.' }), 502)
  }

  function surfaceFor(pr: XenditPaymentRequest, c: Channel, amount: string): Surface | undefined {
    const actions = pr.actions ?? []
    const qr = actions.find((a) => a.descriptor === 'QR_STRING')
    if (qr) {
      return {
        kind: 'QR',
        payload: qr.value,
        amount,
        currency: c.currency,
        reference: pr.reference_id.slice(-10).toUpperCase(),
        method: c.method,
        expiresAt: new Date(Date.now() + (opts.expiryMinutes ?? 15) * 60_000).toISOString(),
      }
    }
    const deeplink = actions.find((a) => a.descriptor === 'DEEPLINK_URL')
    const web = actions.find((a) => a.descriptor === 'WEB_URL')
    if (web) return { kind: 'REDIRECT', url: web.value, popup: true, provider: 'Xendit' }
    if (deeplink) return { kind: 'DEEPLINK', url: deeplink.value, appName: c.method.toUpperCase() }
    return undefined
  }

  /**
   * The leg step for a payment request. A status that is not in `STATUS` keeps the last known one
   * (`last`, from the session store): it never becomes `processing` by default. With no known status
   * yet, the user is still paying.
   */
  function toStep(pr: XenditPaymentRequest, c: Channel, amount: string, ctx: Pick<AdapterContext, 'log'>, last?: LegStatus): LegStep {
    const known = STATUS(pr.status, ctx.log)
    const status = known ?? (last === 'processing' ? 'processing' : 'requires_action')
    const ids = { ref: pr.payment_request_id, providerRef: pr.payment_request_id }
    if (status === 'requires_action') {
      // An unknown status shows no new surface: the UI keeps the current one.
      const surface = known ? surfaceFor(pr, c, amount) : undefined
      return { status, action: { kind: 'payment', ...(surface ? { surface } : {}), transitions: [awaitPoll(POLL)] }, ...ids }
    }
    return {
      status,
      ...ids,
      ...(status === 'failed' ? { error: openRampError('PAYMENT_FAILED', { ...(pr.failure_code ? { message: `The payment failed (${pr.failure_code}).` } : {}) }) } : {}),
      ...(status === 'expired' ? { error: openRampError('QUOTE_EXPIRED', { message: 'The payment expired. Start again.' }) } : {}),
    }
  }

  /** `toStep`, and keep a known status in the session store for the next unknown one */
  async function stepAndKeep(pr: XenditPaymentRequest, c: Channel, amount: string, ctx: Pick<AdapterContext, 'log' | 'store'>): Promise<LegStep> {
    const known = STATUS(pr.status)
    const last = known ? undefined : await ctx.store.get<LegStatus>('last-status')
    const step = toStep(pr, c, amount, ctx, last)
    if (known) await ctx.store.put('last-status', known)
    return step
  }

  return createAdapter({
    id: 'xendit',
    ...(env ? { env } : {}),
    name: 'Xendit',
    legs,

    async quote({ leg, amountIn }): Promise<LegQuote> {
      const c = channelFor(leg.legId)
      const amount = roundTo(amountIn?.value ?? '0', minorUnits(c.currency))
      if (cmp(amount, c.min) < 0) throw new OpenRampException(openRampError('AMOUNT_TOO_LOW', { message: `The minimum for this method is ${c.min} ${c.currency}.` }), 422)
      if (cmp(amount, c.max) > 0) throw new OpenRampException(openRampError('AMOUNT_TOO_HIGH', { message: `The maximum for this method is ${c.max} ${c.currency}.` }), 422)
      const fees = feesFor(c, amount)
      const net = fees.reduce((acc, f) => (f.amount ? sub(acc, f.amount.value) : acc), amount)
      return {
        adapterId: 'xendit',
        legId: leg.legId,
        input: { value: amount, asset: { kind: 'fiat', currency: c.currency } },
        output: { value: roundTo(net, minorUnits(c.currency)), asset: { kind: 'fiat', currency: c.currency } },
        fees,
        // `firm`: a same-currency pay-in with no rate. The payment request is for exactly `input`, and the
        // output is `input` minus the fee from the options (the merchant's Xendit pricing).
        guarantee: 'firm',
        eta: legs.find((l) => l.id === leg.legId)!.eta,
        expiresAt: quoteExpiresAt(10),
        limits: { min: c.min, max: c.max, currency: c.currency },
        // A new key per quote: "Try again" after a failure creates a new payment request,
        // while a retried start for the same quote reuses the first one.
        data: { nonce: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}` },
      }
    },

    async start({ leg, quote }, ctx): Promise<LegStep> {
      const c = channelFor(leg.legId)
      const amount = quote.input.value
      const referenceId = `${ctx.session.id}-${Date.now().toString(36)}`
      const pr = await call<XenditPaymentRequest>(
        ctx,
        'POST',
        '/v3/payment_requests',
        {
          reference_id: referenceId,
          type: 'PAY',
          country: c.country,
          currency: c.currency,
          request_amount: Number(amount),
          capture_method: 'AUTOMATIC',
          channel_code: c.code,
          channel_properties: { success_return_url: ctx.urls.returnUrl, failure_return_url: ctx.urls.returnUrl },
          description: 'Deposit',
          metadata: { openramp_session: ctx.session.id, user_id: ctx.session.userId },
        },
        ctx.idempotencyKey(`xendit:${leg.legId}:${String((quote.data as { nonce?: string } | undefined)?.nonce ?? 'start')}`),
        c,
      )
      await ctx.store.put('pr', { id: pr.payment_request_id, leg: leg.legId, amount })
      return stepAndKeep(pr, c, amount, ctx)
    },

    async status({ leg, ref }, ctx): Promise<LegStep> {
      const c = channelFor(leg.legId)
      const pr = await call<XenditPaymentRequest>(ctx, 'GET', `/v3/payment_requests/${encodeURIComponent(ref)}`, undefined, undefined, c)
      return stepAndKeep(pr, c, String(pr.request_amount), ctx)
    },

    webhook: {
      async verify(req) {
        const token = req.headers.get('x-callback-token') ?? ''
        return token.length > 0 && timingSafeEqual(token, opts.webhookToken)
      },
      // Xendit sends a fixed callback token and no timestamp or signature. The server keeps the body
      // hash for 7 days and drops a repeat.
      replayKey: async (_req, raw) => webhookBodyKey(raw),
      async parse(raw, ctx): Promise<LegEvent[]> {
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          ctx.log.warn('xendit: webhook body is not JSON')
          return []
        }
        const body = parsed as { event?: string; data?: { payment_request_id?: string; status?: string; request_amount?: number; currency?: string; failure_code?: string } }
        const d = body.data
        if (!d?.payment_request_id) return []
        const eventId = (await webhookBodyKey(raw)).slice(0, 32)
        if (body.event === 'payment.capture' || d.status === 'SUCCEEDED') {
          // No output: Xendit reports the gross request amount, while the quote's output is net of fees.
          return [{ ref: d.payment_request_id, providerRef: d.payment_request_id, status: 'succeeded', eventId }]
        }
        if (body.event === 'payment.failure' || d.status === 'FAILED') {
          return [{ ref: d.payment_request_id, providerRef: d.payment_request_id, status: 'failed', eventId, error: openRampError('PAYMENT_FAILED', { ...(d.failure_code ? { message: `The payment failed (${d.failure_code}).` } : {}) }) }]
        }
        return []
      },
    },
  })
}
