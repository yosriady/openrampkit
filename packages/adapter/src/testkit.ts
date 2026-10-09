// Conformance checks any adapter can run in its own tests.

import { isDecimal, isLegTerminal, TRANSITION_TABLE, validateStep } from '@openrampkit/core'
import type { LegQuote, LegStep } from '@openrampkit/core'
import type { Adapter } from './index.js'

export type ConformanceProblem = { where: string; problem: string }

/** The leg capabilities that the server reads (see `LegSpec.capabilities`) */
const KNOWN_CAPABILITIES: string[] = ['settlement', 'surface_after_processing']

export function checkAdapterShape(adapter: Adapter): ConformanceProblem[] {
  const out: ConformanceProblem[] = []
  if (adapter.apiVersion !== 1) out.push({ where: 'apiVersion', problem: `Unsupported apiVersion ${adapter.apiVersion}` })
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

export function checkLegStep(s: LegStep): ConformanceProblem[] {
  const out: ConformanceProblem[] = validateStep(s).map((problem) => ({ where: `step ${s.state}`, problem }))
  const terminal = TRANSITION_TABLE[s.state].terminal
  if (terminal !== isLegTerminal(s.status) && s.state !== 'PROCESSING') {
    // PROCESSING may carry a succeeded leg status while later legs continue
    out.push({ where: `step ${s.state}`, problem: `state terminal=${terminal} but leg status ${s.status}` })
  }
  return out
}
