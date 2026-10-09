// The flow transition table, stored as data. Server, client and the adapter test kit all read it.
// Rule: terminality comes from this table, never from counting transitions.

import type { LegStatus, StateName, Step } from './types.js'

export type TableEntry = {
  /** States a step in this state may move to */
  next: StateName[]
  terminal: boolean
}

export const TRANSITION_TABLE: Record<StateName, TableEntry> = {
  SELECT_METHOD: { next: ['QUOTE', 'BLOCKED', 'EXPIRED'], terminal: false },
  QUOTE: { next: ['SELECT_METHOD', 'AUTH', 'KYC', 'PAYMENT', 'PROCESSING', 'BLOCKED', 'EXPIRED'], terminal: false },
  AUTH: { next: ['KYC', 'PAYMENT', 'FAILED', 'EXPIRED'], terminal: false },
  KYC: { next: ['KYC', 'PAYMENT', 'FAILED', 'EXPIRED'], terminal: false },
  PAYMENT: { next: ['PAYMENT', 'PROCESSING', 'COMPLETED', 'FAILED', 'EXPIRED', 'QUOTE'], terminal: false },
  PROCESSING: { next: ['PROCESSING', 'PAYMENT', 'COMPLETED', 'FAILED', 'REFUNDED', 'REVERSED', 'EXPIRED'], terminal: false },
  // A provider can refund or reverse a payment after it completed (a chargeback).
  COMPLETED: { next: ['REVERSED'], terminal: true },
  FAILED: { next: ['SELECT_METHOD'], terminal: true },
  // A payment that arrives after the session expired (webhook, or the sweep's grace poll) moves it on.
  EXPIRED: { next: ['PROCESSING', 'COMPLETED'], terminal: true },
  REFUNDED: { next: [], terminal: true },
  REVERSED: { next: [], terminal: true },
  BLOCKED: { next: ['SELECT_METHOD'], terminal: true },
}

export const TABLE_VERSION = 1

export function isTerminal(state: StateName): boolean {
  return TRANSITION_TABLE[state].terminal
}

export function isLegalMove(from: StateName, to: StateName): boolean {
  return from === to || TRANSITION_TABLE[from].next.includes(to)
}

export const TERMINAL_LEG_STATUSES: LegStatus[] = ['succeeded', 'failed', 'refunded', 'expired', 'reversed']

export function isLegTerminal(status: LegStatus): boolean {
  return TERMINAL_LEG_STATUSES.includes(status)
}

/**
 * The order of leg statuses. A provider event can move a leg only to a status of the same rank or a
 * higher rank, so a late or repeated event cannot move the leg back (for example `pending` after
 * `processing`).
 */
export const LEG_STATUS_RANK: Record<LegStatus, number> = {
  pending: 0,
  awaiting_user: 1,
  processing: 2,
  succeeded: 3,
  failed: 3,
  expired: 3,
  refunded: 4,
  reversed: 4,
}

/**
 * True when a provider event may move a leg from `from` to `to`. A leg that is not final moves to the
 * same status or to a status of a higher rank. A final leg does not move, with one exception: a
 * `succeeded` leg can become `refunded` or `reversed` (the provider took the payment back).
 */
export function isLegalLegMove(from: LegStatus, to: LegStatus): boolean {
  if (isLegTerminal(from)) return from === 'succeeded' && (to === 'refunded' || to === 'reversed')
  return LEG_STATUS_RANK[to] >= LEG_STATUS_RANK[from]
}

/** Validate a step's shape against the table. Returns a list of problems (empty when valid). */
export function validateStep(step: Pick<Step, 'state' | 'transitions'>): string[] {
  const problems: string[] = []
  const entry = TRANSITION_TABLE[step.state]
  if (!entry) return [`Unknown state ${step.state}`]
  if (entry.terminal && step.transitions.some((t) => t.kind === 'AWAIT')) {
    problems.push(`Terminal state ${step.state} must not have AWAIT transitions`)
  }
  const names = new Set<string>()
  for (const t of step.transitions) {
    if (names.has(t.name)) problems.push(`Duplicate transition ${t.name}`)
    names.add(t.name)
  }
  return problems
}
