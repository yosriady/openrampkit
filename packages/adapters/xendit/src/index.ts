// Xendit adapter: fiat pay-in to the merchant's own Xendit account (Payments API v3).
// QR rails (QRIS, QR Ph, PromptPay, PayNow) and e-wallets (GCash, DANA, OVO, MoMo, ZaloPay, ...).
// No crypto: the destination is `{ type: 'merchant', currency }`.
// Docs: https://docs.xendit.co/apidocs/create-payment-request , payment webhook, get payment request.

import { createAdapter, fetchJson, timingSafeEqual } from '@openrampkit/adapter'
import type { AdapterContext, LegEvent } from '@openrampkit/adapter'
import { OrkException, minorUnits, orkError, roundTo, sub, bps as applyBps, add } from '@openrampkit/core'
import type { Fee, LegQuote, LegSpec, LegStatus, LegStep, PollSpec, StateName, Surface } from '@openrampkit/core'

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
  // Singapore (PayNow QR channel code: TO VERIFY)
  { country: 'SG', currency: 'SGD', method: 'paynow', code: 'PAYNOW', min: '1', max: '200000', kind: 'qr' },
]

const POLL: PollSpec = { intervalMs: 2500, backoff: 1.2, maxIntervalMs: 10_000, giveUpAfterMs: 30 * 60_000 }
const API_VERSION = '2024-11-11'

type XenditAction = { type: string; descriptor: string; value: string }
type XenditPaymentRequest = {
  payment_request_id: string
  reference_id: string
  status: 'ACCEPTING_PAYMENTS' | 'REQUIRES_ACTION' | 'AUTHORIZED' | 'CANCELED' | 'EXPIRED' | 'SUCCEEDED' | 'FAILED'
  currency: string
  request_amount: number
  channel_code: string
  actions?: XenditAction[]
  failure_code?: string
}

const STATUS: Record<XenditPaymentRequest['status'], { status: LegStatus; state: StateName }> = {
  ACCEPTING_PAYMENTS: { status: 'awaiting_user', state: 'PAYMENT' },
  REQUIRES_ACTION: { status: 'awaiting_user', state: 'PAYMENT' },
  AUTHORIZED: { status: 'processing', state: 'PROCESSING' },
  SUCCEEDED: { status: 'succeeded', state: 'COMPLETED' },
  FAILED: { status: 'failed', state: 'FAILED' },
  CANCELED: { status: 'failed', state: 'FAILED' },
  EXPIRED: { status: 'expired', state: 'EXPIRED' },
}

const legId = (c: Channel) => `${c.country.toLowerCase()}-${c.method}`

export function xendit(opts: XenditOptions) {
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
    capabilities: ['webhooks', 'polling', 'refunds'],
  }))

  function channelFor(id: string): Channel {
    const c = byLeg.get(id)
    if (!c) throw new OrkException(orkError('BAD_REQUEST', { message: `Unknown Xendit leg ${id}` }), 400)
    return c
  }

  function feesFor(c: Channel, amount: string): Fee[] {
    const f = opts.fees?.[c.method]
    if (!f) return []
    let total = '0'
    if (f.bps) total = add(total, applyBps(amount, f.bps))
    if (f.fixed) total = add(total, f.fixed)
    return [{ kind: 'provider', label: 'Xendit fee', amount: roundTo(total, minorUnits(c.currency)), currency: c.currency }]
  }

  async function call<T>(ctx: Pick<AdapterContext, 'fetch'>, method: 'GET' | 'POST', path: string, body?: unknown, idem?: string): Promise<T> {
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
      const status = (e as { status?: number }).status
      const msg = (e as { body?: { message?: string } }).body?.message
      if (status === 429) throw new OrkException(orkError('RATE_LIMITED'), 429)
      if (status && status >= 400 && status < 500) throw new OrkException(orkError('PROVIDER_DECLINED', { message: msg ? `Xendit: ${msg}`.slice(0, 200) : 'Xendit declined this payment.' }), 422)
      throw new OrkException(orkError('PROVIDER_UNAVAILABLE', { message: 'Xendit is not available right now.' }), 502)
    }
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

  function toStep(pr: XenditPaymentRequest, c: Channel, amount: string): LegStep {
    const m = STATUS[pr.status] ?? { status: 'processing' as const, state: 'PROCESSING' as const }
    const surface = m.status === 'awaiting_user' ? surfaceFor(pr, c, amount) : undefined
    return {
      state: m.state,
      status: m.status,
      ref: pr.payment_request_id,
      ...(surface ? { surface } : {}),
      transitions: m.status === 'awaiting_user' || m.status === 'processing' ? [{ name: 'poll', kind: 'AWAIT', poll: POLL }] : [],
      ...(m.status === 'succeeded' ? { output: { amount: String(pr.request_amount), asset: { kind: 'fiat' as const, currency: pr.currency } } } : {}),
      ...(m.status === 'failed' ? { error: orkError('PAYMENT_FAILED', { ...(pr.failure_code ? { message: `The payment failed (${pr.failure_code}).` } : {}) }) } : {}),
      ...(m.status === 'expired' ? { error: orkError('QUOTE_EXPIRED', { message: 'The payment expired. Start again.' }) } : {}),
    }
  }

  return createAdapter({
    id: 'xendit',
    name: 'Xendit',
    legs,

    async quote({ leg, amountIn }): Promise<LegQuote> {
      const c = channelFor(leg.legId)
      const amount = roundTo(amountIn?.amount ?? '0', minorUnits(c.currency))
      if (Number(amount) < Number(c.min)) throw new OrkException(orkError('AMOUNT_TOO_LOW', { message: `The minimum for this method is ${c.min} ${c.currency}.` }), 422)
      if (Number(amount) > Number(c.max)) throw new OrkException(orkError('AMOUNT_TOO_HIGH', { message: `The maximum for this method is ${c.max} ${c.currency}.` }), 422)
      const fees = feesFor(c, amount)
      const net = fees.reduce((acc, f) => sub(acc, f.amount), amount)
      return {
        adapterId: 'xendit',
        legId: leg.legId,
        input: { amount, asset: { kind: 'fiat', currency: c.currency } },
        output: { amount: roundTo(net, minorUnits(c.currency)), asset: { kind: 'fiat', currency: c.currency } },
        fees,
        eta: legs.find((l) => l.id === leg.legId)!.eta,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        limits: { min: c.min, max: c.max, currency: c.currency },
      }
    },

    async start({ leg, quote }, ctx): Promise<LegStep> {
      const c = channelFor(leg.legId)
      const amount = quote.input.amount
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
        ctx.idempotencyKey(`xendit:${leg.legId}:start`),
      )
      await ctx.store.put('pr', { id: pr.payment_request_id, leg: leg.legId, amount })
      return toStep(pr, c, amount)
    },

    async status({ leg, ref }, ctx): Promise<LegStep> {
      const c = channelFor(leg.legId)
      const pr = await call<XenditPaymentRequest>(ctx, 'GET', `/v3/payment_requests/${encodeURIComponent(ref)}`)
      return toStep(pr, c, String(pr.request_amount))
    },

    webhook: {
      async verify(req) {
        const token = req.headers.get('x-callback-token') ?? ''
        return token.length > 0 && timingSafeEqual(token, opts.webhookToken)
      },
      async parse(raw): Promise<LegEvent[]> {
        const body = JSON.parse(raw) as { event?: string; data?: { payment_request_id?: string; status?: string; request_amount?: number; currency?: string; failure_code?: string } }
        const d = body.data
        if (!d?.payment_request_id) return []
        if (body.event === 'payment.capture' || d.status === 'SUCCEEDED') {
          return [{ ref: d.payment_request_id, status: 'succeeded', ...(d.request_amount !== undefined && d.currency ? { output: { amount: String(d.request_amount), asset: { kind: 'fiat', currency: d.currency } } } : {}) }]
        }
        if (body.event === 'payment.failure' || d.status === 'FAILED') {
          return [{ ref: d.payment_request_id, status: 'failed', error: orkError('PAYMENT_FAILED', { ...(d.failure_code ? { message: `The payment failed (${d.failure_code}).` } : {}) }) }]
        }
        return []
      },
    },
  })
}
