// Stored-record schema 2 to 3: the adapter contract v2 shapes (see `migrateRecord` in store.ts).

import { isDecimal, isLegTerminal, isStepDetailCode } from '@openrampkit/core'
import type { Amount, Asset, Fee, LegQuote, LegStatus, LegStep, LegTransaction, OpenRampError, Quote, Step, StepDetail, Surface, Transition } from '@openrampkit/core'
import type { SessionRecord } from './store.js'

/** A schema 2 fee: a free currency string, and `inRate` with amount '0' for "amount not given" */
type FeeV2 = { kind: Fee['kind']; label: string; amount: string; currency: string; inRate?: boolean }

const isFeeV2 = (f: unknown): f is FeeV2 => !!f && typeof f === 'object' && typeof (f as FeeV2).amount === 'string'

/** The asset of a schema 2 fee currency: a matching asset of the quote, else a fiat code */
function feeAsset(currency: string, assets: Asset[]): Asset | undefined {
  const cur = String(currency ?? '').toUpperCase()
  const hit = assets.find((a) => (a.kind === 'fiat' ? a.currency.toUpperCase() === cur : a.symbol?.toUpperCase() === cur))
  if (hit) return hit
  return /^[A-Z]{3}$/.test(cur) ? { kind: 'fiat', currency: cur } : undefined
}

/**
 * A schema 2 fee as a `Fee`. `amount` is null when the provider did not say it (`inRate` with
 * '0'), or when the currency is not an asset of the quote and not a fiat code. Schema 2 had no
 * `included`: the fees were part of the quote's input or rate, so `included` is true.
 */
export function migrateFee(f: FeeV2 | Fee, assets: Asset[]): Fee {
  if (!isFeeV2(f)) return f
  const unstated = !!f.inRate && (!isDecimal(f.amount) || !/[1-9]/.test(f.amount))
  const asset = unstated || !isDecimal(f.amount) ? undefined : feeAsset(f.currency, assets)
  const amount: Amount | null = asset ? { value: f.amount, asset } : null
  return { kind: f.kind, label: f.label, amount, included: true }
}

/** Typed fees, a guarantee (`estimate`: schema 2 had none) and an expiry (the session deadline) */
function migrateLegQuote(q: LegQuote, expiresAt: string): void {
  q.fees = (q.fees ?? []).map((f) => migrateFee(f, [q.input?.asset, q.output?.asset].filter((a): a is Asset => !!a)))
  q.guarantee ??= 'estimate'
  if (typeof q.expiresAt !== 'string') q.expiresAt = expiresAt
}

function migrateQuote(q: Quote, expiresAt: string): void {
  for (const l of q.legs ?? []) migrateLegQuote(l, expiresAt)
  q.fees = (q.fees ?? []).map((f) => migrateFee(f, [q.input?.asset, q.output?.asset].filter((a): a is Asset => !!a)))
  q.guarantee ??= 'estimate'
  if (typeof q.expiresAt !== 'string') q.expiresAt = expiresAt
}

/**
 * Schema 2 to 3. Quotes: typed fees (`Fee.amount` is an `Amount` or null, with `included`), a
 * `guarantee` and a required `expiresAt`.
 */
export function migrateToV3(rec: SessionRecord): void {
  const expiresAt = new Date(rec.expiresAt).toISOString()
  for (const s of Object.values(rec.quotes ?? {})) migrateQuote(s.quote, expiresAt)
  for (const p of [rec.active, ...(rec.attempts ?? [])]) for (const l of p?.legs ?? []) migrateLegQuote(l.quote, expiresAt)
  migrateStepsToV3(rec)
}

/** A schema 2 leg step: `state` next to `status`, loose surface fields, `sub`, and tx hash fields */
type LegStepV2 = {
  state?: string
  sub?: string
  providerStatus?: string
  surface?: Surface
  transitions?: Transition[]
  status: LegStatus
  error?: OpenRampError
  ref?: string
  output?: Amount
  txHash?: string
  sourceTxHash?: string
}

const PHASE: Record<string, 'auth' | 'kyc'> = { AUTH: 'auth', KYC: 'kyc' }
const PROVIDER_STATUS = /^[A-Za-z0-9_ .:-]{1,64}$/

/** A schema 2 `sub` and `providerStatus` as a `StepDetail` (none for a value that is not in the closed list) */
function detailOf(sub: unknown, providerStatus: unknown): StepDetail | undefined {
  if (!isStepDetailCode(sub)) return undefined
  return { code: sub, ...(typeof providerStatus === 'string' && PROVIDER_STATUS.test(providerStatus) ? { providerStatus } : {}) }
}

/**
 * A schema 2 leg step as a `LegStep`: an `action` from the state and the surface fields while the user
 * must act, a `phase` for a KYC or AUTH review, the AWAIT poll, `detail` from `sub`, and transactions
 * from `sourceTxHash` (role `source`) and `txHash` (role `destination` when it is another transaction,
 * or when the leg succeeded; else the transaction that the user sent, role `source`).
 */
export function migrateLegStep(v: LegStepV2 | LegStep): LegStep {
  const old = v as LegStepV2
  const isV2 = ['state', 'transitions', 'txHash', 'sourceTxHash', 'sub', 'surface', 'providerStatus'].some((k) => k in old)
  if (!isV2) return v as LegStep
  const out: LegStep = { status: old.status }
  const transitions = Array.isArray(old.transitions) ? old.transitions : []
  if (old.status === 'requires_action') {
    out.action = { kind: old.state === 'AUTH' ? 'auth' : old.state === 'KYC' ? 'kyc' : 'payment', ...(old.surface ? { surface: old.surface } : {}), transitions }
  } else if (!isLegTerminal(old.status)) {
    const phase = old.state ? PHASE[old.state] : undefined
    if (phase) out.phase = phase
    const poll = transitions.find((t): t is Extract<Transition, { kind: 'AWAIT' }> => t.kind === 'AWAIT')?.poll
    if (poll) out.poll = poll
  }
  const detail = detailOf(old.sub, old.providerStatus)
  if (detail) out.detail = detail
  if (old.error) out.error = old.error
  if (old.ref) out.ref = old.ref
  if (old.output) out.output = old.output
  const transactions: LegTransaction[] = []
  if (old.sourceTxHash) transactions.push({ role: 'source', hash: old.sourceTxHash })
  if (old.txHash && old.txHash !== old.sourceTxHash) transactions.push({ role: old.sourceTxHash || old.status === 'succeeded' ? 'destination' : 'source', hash: old.txHash })
  if (transactions.length) out.transactions = transactions
  return out
}

/** Schema 2 to 3: the leg steps of every payment, and the session step (`detail` from `sub`, no `progress`) */
export function migrateStepsToV3(rec: SessionRecord): void {
  for (const p of [rec.active, ...(rec.attempts ?? [])]) for (const l of p?.legs ?? []) if (l.step) l.step = migrateLegStep(l.step)
  const step = rec.step as Step & { sub?: string; progress?: unknown }
  const detail = detailOf(step.sub, undefined)
  delete step.sub
  delete step.progress
  if (detail && !step.detail) step.detail = detail
}
