// Exact decimal math on strings, built on bigint. No floats anywhere.

const DECIMAL = /^-?\d+(\.\d+)?$/

export function isDecimal(value: string): boolean {
  return DECIMAL.test(value)
}

/** Parse a decimal string into a scaled bigint with `scale` fractional digits (truncates extra digits). */
export function toScaled(value: string, scale: number): bigint {
  if (!isDecimal(value)) throw new Error(`Invalid decimal: ${value}`)
  const negative = value.startsWith('-')
  const [intPart = '0', fracPart = ''] = (negative ? value.slice(1) : value).split('.')
  const frac = (fracPart + '0'.repeat(scale)).slice(0, scale)
  const scaled = BigInt(intPart + frac)
  return negative ? -scaled : scaled
}

/** Format a scaled bigint back to a decimal string, trimming trailing zeros. */
export function fromScaled(value: bigint, scale: number, opts: { minFraction?: number } = {}): string {
  const negative = value < 0n
  const abs = negative ? -value : value
  const s = abs.toString().padStart(scale + 1, '0')
  const int = scale === 0 ? s : s.slice(0, -scale)
  let frac = scale === 0 ? '' : s.slice(-scale)
  frac = frac.replace(/0+$/, '')
  const min = opts.minFraction ?? 0
  if (frac.length < min) frac = frac.padEnd(min, '0')
  const out = frac ? `${int}.${frac}` : int
  return negative && out !== '0' ? `-${out}` : out
}

/** Decimal string to base units, e.g. ('12.5', 6) -> '12500000' */
export function toBaseUnits(value: string, decimals: number): string {
  return toScaled(value, decimals).toString()
}

/** Base units to decimal string, e.g. ('12500000', 6) -> '12.5' */
export function fromBaseUnits(value: string, decimals: number): string {
  return fromScaled(BigInt(value), decimals)
}

const WORK_SCALE = 18

export function add(a: string, b: string): string {
  return fromScaled(toScaled(a, WORK_SCALE) + toScaled(b, WORK_SCALE), WORK_SCALE)
}

export function sub(a: string, b: string): string {
  return fromScaled(toScaled(a, WORK_SCALE) - toScaled(b, WORK_SCALE), WORK_SCALE)
}

export function cmp(a: string, b: string): -1 | 0 | 1 {
  const x = toScaled(a, WORK_SCALE)
  const y = toScaled(b, WORK_SCALE)
  return x < y ? -1 : x > y ? 1 : 0
}

export function mulRatio(value: string, ratio: string): string {
  const v = toScaled(value, WORK_SCALE)
  const r = toScaled(ratio, WORK_SCALE)
  return fromScaled((v * r) / 10n ** BigInt(WORK_SCALE), WORK_SCALE)
}

/** Apply basis points: bps(100, '12') -> '0.12' */
export function bps(value: string, points: number): string {
  const v = toScaled(value, WORK_SCALE)
  return fromScaled((v * BigInt(Math.round(points))) / 10_000n, WORK_SCALE)
}

/** Round to a currency's minor units (half up) for display and provider APIs. */
export function roundTo(value: string, fractionDigits: number): string {
  const extra = toScaled(value, fractionDigits + 1)
  const sign = extra < 0n ? -1n : 1n
  const abs = extra * sign
  const rounded = (abs + 5n) / 10n
  return fromScaled(rounded * sign, fractionDigits, { minFraction: fractionDigits })
}
