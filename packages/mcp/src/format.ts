// Compact, agent-friendly views of server objects. No secrets, no provider internals.

import type { Amount, Fee, MethodOption, OpenRampError, PublicQuote, PublicSession, Surface } from '@openrampkit/core'

export const TERMINAL = new Set(['succeeded', 'failed', 'canceled', 'expired', 'refunded', 'reversed'])

export function amountText(a: Amount): string {
  const unit = a.asset.kind === 'fiat' ? a.asset.currency : (a.asset.symbol ?? a.asset.token)
  return `${a.value} ${unit}`
}

export function amountCurrency(a: Amount): string {
  return a.asset.kind === 'fiat' ? a.asset.currency : (a.asset.symbol ?? a.asset.token)
}

const eta = (e: { min: number; max: number }) => {
  const m = (s: number) => (s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`)
  return e.min === e.max ? m(e.min) : `${m(e.min)}-${m(e.max)}`
}

export function methodView(m: MethodOption) {
  return {
    method: m.method,
    name: m.name,
    kind: m.kind,
    available: m.group !== 'unavailable',
    ...(m.reason ? { reason: m.reason.message } : {}),
    eta: eta(m.eta),
    ...(m.limits ? { limits: `${m.limits.min ?? '0'} to ${m.limits.max ?? 'any'} ${m.limits.currency}` } : {}),
    providers: m.providers,
  }
}

export function quoteView(q: PublicQuote) {
  return {
    method: q.method,
    provider: q.provider,
    pay: amountText(q.input),
    receive: amountText(q.output),
    // A fiat onramp or a bridge may only estimate the output. `min_output`: `min_receive` is guaranteed.
    guarantee: q.guarantee,
    ...(q.minOutput ? { min_receive: amountText(q.minOutput) } : {}),
    ...(q.slippageBps !== undefined ? { slippage_bps: q.slippageBps } : {}),
    fees: q.fees.map(feeText),
    eta: eta(q.eta),
    ...(q.badges?.length ? { badges: q.badges } : {}),
    expires_at: q.expiresAt,
  }
}

/** One fee line: the amount (or "amount not given"), and whether the quote already counts it */
export function feeText(f: Fee): string {
  const where = f.included ? 'included in rate' : 'charged on top'
  return f.amount ? `${amountText(f.amount)} ${f.label} (${where})` : `${f.label}: amount not given (${where})`
}

export function errorView(e: OpenRampError) {
  return { code: e.code, message: e.message }
}

/** Payment instructions a person can follow without the pay page (QR, bank fields, deposit address). */
export function paymentView(s: Surface | undefined) {
  if (!s) return undefined
  switch (s.kind) {
    case 'QR':
      return { kind: 'QR', qr_payload: s.payload, amount: `${s.amount} ${s.currency}`, ...(s.reference ? { reference: s.reference } : {}), ...(s.expiresAt ? { expires_at: s.expiresAt } : {}) }
    case 'BANK_FIELDS':
      return { kind: 'BANK_FIELDS', fields: s.fields.map((f) => ({ label: f.label, value: f.value })) }
    case 'DEPOSIT_ADDRESS':
      return { kind: 'DEPOSIT_ADDRESS', chain: s.chain, token: s.symbol ?? s.token, address: s.address, ...(s.min ? { min: s.min } : {}), ...(s.memo ? { memo: s.memo } : {}) }
    case 'REDIRECT':
    case 'DEEPLINK':
      return { kind: s.kind, url: s.url }
    default:
      return { kind: s.kind, note: 'Open pay_url to continue.' }
  }
}

export function sessionView(s: PublicSession) {
  const r = s.result
  return {
    session_id: s.id,
    direction: s.direction,
    status: s.status,
    state: s.step.state,
    done: TERMINAL.has(s.status),
    ...(r
      ? {
          method: r.method,
          provider: r.provider,
          paid: amountText(r.input),
          received: amountText(r.output),
          received_confirmed: r.outputConfirmed,
          ...(r.txHashes.length ? { tx_hashes: r.txHashes } : {}),
          ...(r.sourceTxHashes?.length ? { source_tx_hashes: r.sourceTxHashes } : {}),
        }
      : {}),
    ...(s.destination?.type === 'fiat' ? { payout_currency: s.destination.currency } : {}),
    ...(s.amountBounds ? { bounds: boundsText(s.amountBounds) } : {}),
    ...(s.step.error ? { error: errorView(s.step.error) } : {}),
    // A failed attempt: the person can try again with another method (or the same one).
    ...(s.status === 'requires_payment_method' && s.lastError ? { attempt_failed: true, last_error: errorView(s.lastError) } : {}),
    expires_at: s.expiresAt,
  }
}

export function boundsText(b: { min?: string; max?: string; currency: string }): string {
  if (b.min && b.max && b.min === b.max) return `exactly ${b.max} ${b.currency}`
  if (b.min && b.max) return `${b.min} to ${b.max} ${b.currency}`
  if (b.max) return `up to ${b.max} ${b.currency}`
  return `at least ${b.min} ${b.currency}`
}
