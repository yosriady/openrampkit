// Conformance checks any adapter can run in its own tests.

import { isDecimal, isStepDetailCode, sameToken, stateFor, validateStep } from '@openrampkit/core'
import type { Asset, LegQuote, LegStatus, LegStep } from '@openrampkit/core'
import { ADAPTER_API_VERSION } from './index.js'
import type { Adapter } from './index.js'

export type ConformanceProblem = { where: string; problem: string }

/** The leg capabilities that the server reads (see `LegSpec.capabilities`) */
const KNOWN_CAPABILITIES: string[] = ['settlement', 'surface_after_processing']

export function checkAdapterShape(adapter: Adapter): ConformanceProblem[] {
  const out: ConformanceProblem[] = []
  if (adapter.apiVersion !== ADAPTER_API_VERSION) out.push({ where: 'apiVersion', problem: `Unsupported apiVersion ${adapter.apiVersion} (this kit checks version ${ADAPTER_API_VERSION})` })
  if (!adapter.legs.length) out.push({ where: 'legs', problem: 'Adapter declares no legs' })
  for (const leg of adapter.legs) {
    if (leg.eta.min > leg.eta.max) out.push({ where: `leg ${leg.id}`, problem: 'eta.min > eta.max' })
    if (!leg.surfaces.length) out.push({ where: `leg ${leg.id}`, problem: 'No surfaces declared' })
    if (!leg.regions.allow.length) out.push({ where: `leg ${leg.id}`, problem: 'Region policy allows nothing' })
    for (const c of (leg.capabilities ?? []) as string[]) {
      if (!KNOWN_CAPABILITIES.includes(c)) out.push({ where: `leg ${leg.id}`, problem: `Unknown capability ${c} (only settlement and surface_after_processing; results come from status() and webhook)` })
    }
    if (leg.limits) {
      for (const k of ['min', 'max'] as const) {
        const v = leg.limits[k]
        if (v !== undefined && !isDecimal(v)) out.push({ where: `leg ${leg.id}`, problem: `limits.${k} is not a decimal string` })
      }
    }
    // Declared capabilities and surfaces need the methods that serve them.
    const caps = (leg.capabilities ?? []) as string[]
    if (caps.includes('surface_after_processing') && !adapter.webhook) {
      out.push({ where: `leg ${leg.id}`, problem: 'capability surface_after_processing needs a webhook (only a provider event can reopen the surface)' })
    }
    if (caps.includes('settlement') && (leg.to.asset.kind !== 'crypto' || !leg.to.location.includes('address'))) {
      out.push({ where: `leg ${leg.id}`, problem: 'capability settlement needs a crypto `to` asset delivered to an address' })
    }
    const needsTransition = leg.surfaces.filter((k) => k === 'FORM' || k === 'OTP' || k === 'WALLET_TX')
    if (needsTransition.length && !adapter.transition) {
      out.push({ where: `leg ${leg.id}`, problem: `surface ${needsTransition.join(', ')} needs transition() (the UI submits the form, the code or the tx hash)` })
    }
  }
  if (adapter.legs.length && !adapter.status && !(adapter.webhook && adapter.webhook.configured !== false)) {
    out.push({ where: 'adapter', problem: 'no status() and no configured webhook: a leg cannot learn its result' })
  }
  return out
}

/** True when `a` is a usable asset: an ISO 4217 fiat code, or a CAIP-2 chain with a token */
function validAsset(a: Asset | undefined): boolean {
  if (!a || typeof a !== 'object') return false
  if (a.kind === 'fiat') return typeof a.currency === 'string' && /^[A-Z]{3}$/.test(a.currency)
  if (a.kind === 'crypto') return typeof a.chain === 'string' && /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/.test(a.chain) && typeof a.token === 'string' && a.token.length > 0
  return false
}

/** Same asset: the same fiat currency, or the same chain and token. A wildcard (`*`) matches anything. */
export function sameQuotedAsset(a: Asset, b: Asset): boolean {
  if (a.kind === 'fiat' && b.kind === 'fiat') return a.currency === '*' || b.currency === '*' || a.currency.toUpperCase() === b.currency.toUpperCase()
  if (a.kind === 'crypto' && b.kind === 'crypto') {
    if (a.chain === '*' || b.chain === '*') return true
    return a.chain === b.chain && (a.token === '*' || b.token === '*' || sameToken(a.chain, a.token, b.token))
  }
  return false
}

export function checkLegQuote(q: LegQuote): ConformanceProblem[] {
  const out: ConformanceProblem[] = []
  if (!isDecimal(q.input.value)) out.push({ where: 'quote.input', problem: 'not a decimal string' })
  if (!isDecimal(q.output.value)) out.push({ where: 'quote.output', problem: 'not a decimal string' })
  for (const f of q.fees) {
    if (typeof f.included !== 'boolean') out.push({ where: `fee ${f.label}`, problem: 'included is not a boolean' })
    if (f.amount === null) continue
    if (!f.amount || typeof f.amount !== 'object' || typeof f.amount.value !== 'string' || !isDecimal(f.amount.value)) out.push({ where: `fee ${f.label}`, problem: 'amount is not null and not an Amount with a decimal string' })
    else if (!validAsset(f.amount.asset)) out.push({ where: `fee ${f.label}`, problem: 'amount has no valid asset (an ISO 4217 currency, or a CAIP-2 chain and a token); use null when the provider does not say the fee' })
  }
  if (typeof q.expiresAt !== 'string' || Number.isNaN(Date.parse(q.expiresAt))) out.push({ where: 'quote.expiresAt', problem: 'not an ISO date' })
  else if (Date.parse(q.expiresAt) <= Date.now()) out.push({ where: 'quote.expiresAt', problem: 'is not in the future' })
  if (!['firm', 'min_output', 'estimate'].includes(q.guarantee)) out.push({ where: 'quote.guarantee', problem: `unknown guarantee ${String(q.guarantee)}` })
  if (q.guarantee === 'min_output' && !q.minOutput) out.push({ where: 'quote.minOutput', problem: 'guarantee min_output without minOutput' })
  if (q.minOutput) {
    if (!isDecimal(q.minOutput.value)) out.push({ where: 'quote.minOutput', problem: 'not a decimal string' })
    else if (!sameQuotedAsset(q.minOutput.asset, q.output.asset)) out.push({ where: 'quote.minOutput', problem: 'not in the asset of output' })
  }
  if (q.slippageBps !== undefined && (!Number.isInteger(q.slippageBps) || q.slippageBps < 0 || q.slippageBps > 10_000)) out.push({ where: 'quote.slippageBps', problem: 'not an integer from 0 to 10000' })
  return out
}

/** Every leg status (`LegStatus`) */
export const LEG_STATUSES: readonly LegStatus[] = ['pending', 'requires_action', 'processing', 'succeeded', 'failed', 'refunded', 'expired', 'reversed']

const ACTION_KINDS = ['auth', 'kyc', 'payment']
const TX_ROLES = ['approval', 'source', 'destination', 'settlement', 'refund']

/**
 * Check one leg step against the adapter contract v2: a known status; an action (with a known kind and
 * transitions) with `requires_action` and with no other status; a phase only while pending or
 * processing; a detail code from `STEP_DETAIL_CODES`; well formed transactions; and the transitions
 * against the flow table.
 */
export function checkLegStep(s: LegStep): ConformanceProblem[] {
  const where = `step ${s.status}`
  if (!LEG_STATUSES.includes(s.status)) return [{ where, problem: `unknown leg status ${String(s.status)}` }]
  const legacy = s as LegStep & { state?: unknown; sub?: unknown; txHash?: unknown; sourceTxHash?: unknown; surface?: unknown; transitions?: unknown }
  const out: ConformanceProblem[] = []
  for (const k of ['state', 'sub', 'txHash', 'sourceTxHash', 'surface', 'transitions'] as const) {
    if (legacy[k] !== undefined) out.push({ where, problem: `has the adapter API v1 field ${k} (v2: status, action, detail, transactions)` })
  }
  if (s.status === 'requires_action') {
    if (!s.action) out.push({ where, problem: 'requires_action without an action' })
    else {
      if (!ACTION_KINDS.includes(s.action.kind)) out.push({ where, problem: `unknown action kind ${String(s.action.kind)}` })
      if (!Array.isArray(s.action.transitions)) out.push({ where, problem: 'action without transitions' })
    }
  } else if (s.action) out.push({ where, problem: `an action with status ${s.status} (only requires_action has one)` })
  if (s.phase && s.status !== 'processing' && s.status !== 'pending') out.push({ where, problem: `phase ${s.phase} with status ${s.status} (only pending or processing)` })
  if (s.phase && s.phase !== 'auth' && s.phase !== 'kyc') out.push({ where, problem: `unknown phase ${String(s.phase)}` })
  if (s.detail && !isStepDetailCode(s.detail.code)) out.push({ where, problem: `detail code ${String(s.detail.code)} is not in STEP_DETAIL_CODES` })
  for (const t of s.transactions ?? []) {
    if (!TX_ROLES.includes(t.role)) out.push({ where, problem: `transaction role ${String(t.role)} (hop is set by the server)` })
    if (typeof t.hash !== 'string' || !t.hash) out.push({ where, problem: 'transaction without a hash' })
  }
  out.push(...validateStep({ state: stateFor(s), transitions: s.action?.transitions ?? [] }).map((problem) => ({ where, problem })))
  return out
}
