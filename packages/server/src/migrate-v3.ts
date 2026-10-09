// Stored-record schema 2 to 3: the adapter contract v2 shapes (see `migrateRecord` in store.ts).

import { isDecimal } from '@openrampkit/core'
import type { Amount, Asset, Fee, LegQuote, Quote } from '@openrampkit/core'
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
}
