// Conformance checks any adapter can run in its own tests.

import { isDecimal, isStepDetailCode, stateFor, validateStep } from '@openrampkit/core'
import type { LegQuote, LegStatus, LegStep } from '@openrampkit/core'
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
  }
  return out
}

export function checkLegQuote(q: LegQuote): ConformanceProblem[] {
  const out: ConformanceProblem[] = []
  if (!isDecimal(q.input.value)) out.push({ where: 'quote.input', problem: 'not a decimal string' })
  if (!isDecimal(q.output.value)) out.push({ where: 'quote.output', problem: 'not a decimal string' })
  for (const f of q.fees) {
    if (f.amount === null) continue
    if (!f.amount || typeof f.amount !== 'object' || typeof f.amount.value !== 'string' || !isDecimal(f.amount.value)) out.push({ where: `fee ${f.label}`, problem: 'amount is not null and not an Amount with a decimal string' })
  }
  if (typeof q.expiresAt !== 'string' || Number.isNaN(Date.parse(q.expiresAt))) out.push({ where: 'quote.expiresAt', problem: 'not an ISO date' })
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
