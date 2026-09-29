// Display helpers. Money values are decimal strings; we only convert to numbers for display.

import { add, chainName, minorUnits } from '@openrampkit/core'
import type { Amount, Fee } from '@openrampkit/core'
import type { Messages } from './messages.js'

const ISO_CURRENCY = /^[A-Z]{3}$/
/** Common 3-letter crypto tickers, for runtimes without `Intl.supportedValuesOf` */
const CRYPTO_TICKERS = new Set(['ETH', 'BTC', 'SOL', 'BNB', 'POL', 'MON', 'ARB', 'DAI', 'OKB', 'TRX', 'XRP', 'ADA', 'TON', 'APT', 'SUI', 'AVAX'])
let supported: Set<string> | undefined

/**
 * True for a real ISO 4217 currency code. `Intl.NumberFormat` accepts any well-formed 3-letter code,
 * so without this check "ETH" would format as a fiat amount with 2 decimals ("ETH 0.00").
 */
export function isFiatCurrency(code: string): boolean {
  const cur = code.toUpperCase()
  if (!ISO_CURRENCY.test(cur)) return false
  const list = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf
  if (list) {
    supported ??= new Set(list('currency'))
    return supported.has(cur)
  }
  return !CRYPTO_TICKERS.has(cur)
}

/** Fiat amount with the currency's minor units (VND and IDR have none), formatted for `opts.locale`. */
export function formatFiat(amount: string, currency: string, opts: { compact?: boolean; locale?: string | undefined } = {}): string {
  const n = Number(amount)
  if (!Number.isFinite(n)) return `${amount} ${currency}`
  const cur = currency.toUpperCase()
  if (isFiatCurrency(cur)) {
    try {
      const digits = opts.compact && Number.isInteger(n) ? 0 : minorUnits(cur)
      return new Intl.NumberFormat(opts.locale, {
        style: 'currency',
        currency: cur,
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(n)
    } catch {
      // Unknown currency code: fall through
    }
  }
  return formatToken(amount, currency, opts.locale)
}

export function formatToken(amount: string, symbol?: string, locale?: string): string {
  const n = Number(amount)
  const digits = n !== 0 && Math.abs(n) < 1 ? 6 : 4
  const s = Number.isFinite(n) ? new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(n) : amount
  return symbol ? `${s} ${symbol}` : s
}

/** `locale` is a BCP 47 tag (for example `m.locale`). Undefined uses the runtime default. */
export function formatAmount(a: Amount, locale?: string): string {
  if (a.asset.kind === 'fiat') return formatFiat(a.amount, a.asset.currency, locale ? { locale } : {})
  return formatToken(a.amount, a.asset.symbol ?? '', locale)
}

/** Currency symbol for an ISO code, e.g. USD -> $, PHP -> ₱. Falls back to the code. */
export function currencySymbol(currency: string, locale?: string): string {
  const cur = currency.toUpperCase()
  if (!isFiatCurrency(cur)) return cur
  try {
    const parts = new Intl.NumberFormat(locale, { style: 'currency', currency: cur, currencyDisplay: 'narrowSymbol' }).formatToParts(0)
    return parts.find((p) => p.type === 'currency')?.value ?? cur
  } catch {
    return cur
  }
}

/** Sum fees per currency, e.g. "$1.20 + 0.0001 ETH". */
export function formatFees(fees: Fee[], locale?: string): string | undefined {
  const byCur = new Map<string, string>()
  for (const f of fees) {
    if (!f.amount || Number(f.amount) === 0) continue
    byCur.set(f.currency, add(byCur.get(f.currency) ?? '0', f.amount))
  }
  if (!byCur.size) return undefined
  return [...byCur].map(([cur, amt]) => formatFiat(amt, cur, locale ? { locale } : {})).join(' + ')
}

export function formatEta(eta: { min: number; max: number }, m: Messages): string {
  const max = eta.max
  const min = Math.max(0, eta.min)
  if (max <= 60) return m.etaInstant
  if (max < 3600) return m.etaMinutes(Math.max(1, Math.ceil(max / 60)))
  if (max < 86400) {
    const a = Math.max(1, Math.round(min / 3600))
    const b = Math.max(1, Math.ceil(max / 3600))
    return a < b && min >= 3600 ? m.etaHoursRange(a, b) : m.etaHours(b)
  }
  const a = Math.max(1, Math.round(min / 86400))
  const b = Math.max(1, Math.ceil(max / 86400))
  return a < b ? m.etaDaysRange(a, b) : m.etaDays(b)
}

export function formatLimit(limits: { max?: string; currency: string } | undefined, m: Messages): string | undefined {
  if (!limits?.max) return undefined
  return m.limit(formatFiat(limits.max, limits.currency, { compact: true, locale: m.locale }))
}

export function shortAddress(addr: string): string {
  return addr.length > 14 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr
}

export function displayChain(chain: string): string {
  return chainName(chain)
}

/** "swapped" -> "Swapped", "coinbase_onramp" -> "Coinbase Onramp" */
export function titleCase(id: string): string {
  return id.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const mm = Math.floor(s / 60)
  const ss = s % 60
  return `${mm}:${ss.toString().padStart(2, '0')}`
}

/** Preset amount chips per currency, in whole units. */
const PRESETS: Record<string, number[]> = {
  PHP: [500, 1000, 2500, 5000],
  THB: [300, 1000, 2000, 5000],
  MYR: [50, 100, 250, 500],
  IDR: [100000, 250000, 500000, 1000000],
  VND: [200000, 500000, 1000000, 2000000],
  INR: [1000, 2500, 5000, 10000],
  JPY: [3000, 5000, 10000, 30000],
  KRW: [30000, 50000, 100000, 300000],
  BRL: [100, 250, 500, 1000],
  TWD: [1000, 3000, 5000, 10000],
  HKD: [200, 500, 1000, 2000],
  MXN: [500, 1000, 2500, 5000],
  NGN: [20000, 50000, 100000, 250000],
  KES: [2500, 5000, 10000, 25000],
  TRY: [1000, 2500, 5000, 10000],
}

export function presetAmounts(currency: string): number[] {
  return PRESETS[currency.toUpperCase()] ?? [25, 50, 100, 250]
}
