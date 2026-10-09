import { describe, expect, it } from 'vitest'
import {
  currencySymbol,
  displayChain,
  formatAmount,
  formatCountdown,
  formatEta,
  formatFees,
  formatFiat,
  formatLimit,
  formatToken,
  isFiatCurrency,
  presetAmounts,
  shortAddress,
  titleCase,
} from './format.js'
import { en, mergeMessages } from './messages.js'
import { qrPath } from './qr.js'

const L = 'en-US'

describe('amounts', () => {
  it('formatFiat uses the currency minor units', () => {
    expect(formatFiat('1234.5', 'usd', { locale: L })).toBe('$1,234.50')
    expect(formatFiat('500000', 'VND', { locale: L })).toBe('₫500,000')
    expect(formatFiat('1000', 'JPY', { locale: L })).toBe('¥1,000')
  })

  it('formatFiat compact drops decimals for whole amounts only', () => {
    expect(formatFiat('100', 'USD', { compact: true, locale: L })).toBe('$100')
    expect(formatFiat('100.5', 'USD', { compact: true, locale: L })).toBe('$100.50')
  })

  it('formatFiat falls back to token formatting for non-ISO codes and bad numbers', () => {
    expect(formatFiat('1.5', 'USDC', { locale: L })).toBe('1.5 USDC')
    expect(formatFiat('abc', 'USD')).toBe('abc USD')
    expect(formatFiat('2', 'u$d', { locale: L })).toBe('2 u$d')
  })

  it('formatToken shows more digits for small amounts', () => {
    expect(formatToken('1.123456789', 'ETH', L)).toBe('1.1235 ETH')
    expect(formatToken('0.000123456', 'ETH', L)).toBe('0.000123 ETH')
    expect(formatToken('0', undefined, L)).toBe('0')
    expect(formatToken('xyz', 'T', L)).toBe('xyz T')
  })

  it('formatAmount handles fiat and crypto assets', () => {
    expect(formatAmount({ value: '10', asset: { kind: 'fiat', currency: 'USD' } })).toBe('$10.00')
    expect(formatAmount({ value: '10', asset: { kind: 'crypto', chain: 'eip155:1', token: '0x', symbol: 'USDC' } })).toBe('10 USDC')
    expect(formatAmount({ value: '10', asset: { kind: 'crypto', chain: 'eip155:1', token: '0x' } })).toBe('10')
  })

  it('crypto tickers with 3 letters are not fiat (regression: "ETH 0.00")', () => {
    expect(isFiatCurrency('usd')).toBe(true)
    expect(isFiatCurrency('ETH')).toBe(false)
    expect(isFiatCurrency('USDC')).toBe(false)
    expect(formatFiat('0.0001', 'ETH', { locale: L })).toBe('0.0001 ETH')
    expect(formatFiat('1.5', 'SOL', { locale: L })).toBe('1.5 SOL')
    expect(currencySymbol('BTC', L)).toBe('BTC')
  })

  it('isFiatCurrency works without Intl.supportedValuesOf', () => {
    const I = Intl as { supportedValuesOf?: unknown }
    const orig = I.supportedValuesOf
    I.supportedValuesOf = undefined
    try {
      expect(isFiatCurrency('EUR')).toBe(true)
      expect(isFiatCurrency('ETH')).toBe(false)
    } finally {
      I.supportedValuesOf = orig
    }
  })

  it('currencySymbol', () => {
    expect(currencySymbol('usd', L)).toBe('$')
    expect(currencySymbol('PHP', L)).toBe('₱')
    expect(currencySymbol('USDC', L)).toBe('USDC')
  })
})

describe('fees', () => {
  it('sums per currency and skips zero fees', () => {
    expect(
      formatFees([
        { kind: 'provider', label: 'a', amount: '1.2', currency: 'USD' },
        { kind: 'network', label: 'b', amount: '0.3', currency: 'USD' },
        { kind: 'network', label: 'c', amount: '0.0001', currency: 'ETH' },
        { kind: 'app', label: 'd', amount: '0', currency: 'EUR' },
      ]),
    ).toBe('$1.50 + 0.0001 ETH')
  })

  it('returns undefined when there are no fees', () => {
    expect(formatFees([])).toBeUndefined()
    expect(formatFees([{ kind: 'app', label: 'x', amount: '0.00', currency: 'USD' }])).toBeUndefined()
  })
})

describe('ETA and limits', () => {
  it('formatEta picks the right unit', () => {
    expect(formatEta({ min: 0, max: 60 }, en)).toBe('Instant')
    expect(formatEta({ min: 10, max: 61 }, en)).toBe('~2 min')
    expect(formatEta({ min: 60, max: 300 }, en)).toBe('~5 min')
    expect(formatEta({ min: 60, max: 3600 }, en)).toBe('~1 hour')
    expect(formatEta({ min: 3600, max: 3 * 3600 }, en)).toBe('1 to 3 hours')
    expect(formatEta({ min: 1800, max: 3 * 3600 }, en)).toBe('~3 hours')
    expect(formatEta({ min: 86400, max: 86400 }, en)).toBe('~1 day')
    expect(formatEta({ min: 86400, max: 3 * 86400 }, en)).toBe('1 to 3 days')
    expect(formatEta({ min: -5, max: 2 * 86400 }, en)).toBe('1 to 2 days')
    expect(formatEta({ min: 5 * 86400, max: 5 * 86400 }, en)).toBe('~5 days')
  })

  it('formatLimit', () => {
    expect(formatLimit(undefined, en)).toBeUndefined()
    expect(formatLimit({ currency: 'USD' }, en)).toBeUndefined()
    expect(formatLimit({ max: '20000', currency: 'USD' }, en)).toBe('$20,000 limit')
  })
})

describe('small helpers', () => {
  it('shortAddress keeps short strings', () => {
    expect(shortAddress('0x1111111111111111111111111111111111111111')).toBe('0x1111...1111')
    expect(shortAddress('0xabc')).toBe('0xabc')
    expect(shortAddress('12345678901234')).toBe('12345678901234')
  })

  it('displayChain and titleCase', () => {
    expect(displayChain('eip155:8453')).toBe('Base')
    expect(displayChain('eip155:777')).toBe('eip155:777')
    expect(titleCase('coinbase_onramp')).toBe('Coinbase Onramp')
    expect(titleCase('apple-pay')).toBe('Apple Pay')
  })

  it('formatCountdown', () => {
    expect(formatCountdown(0)).toBe('0:00')
    expect(formatCountdown(-10)).toBe('0:00')
    expect(formatCountdown(65_900)).toBe('1:05')
    expect(formatCountdown(15 * 60_000)).toBe('15:00')
  })

  it('presetAmounts per currency with a default', () => {
    expect(presetAmounts('vnd')).toEqual([200000, 500000, 1000000, 2000000])
    expect(presetAmounts('EUR')).toEqual([25, 50, 100, 250])
  })
})

describe('messages', () => {
  it('mergeMessages returns the English catalog or merges overrides', () => {
    expect(mergeMessages()).toBe(en)
    const m = mergeMessages({ title: 'Nạp tiền', etaMinutes: (n: number) => `${n} phút` })
    expect(m.title).toBe('Nạp tiền')
    expect(m.etaMinutes(3)).toBe('3 phút')
    expect(m.close).toBe('Close')
  })

  it('message functions', () => {
    expect(en.minMax('$1', '$2')).toBe('Min $1, max $2')
    expect(en.minMax('$1')).toBe('Minimum $1')
    expect(en.minMax(undefined, '$2')).toBe('Maximum $2')
    expect(en.minMax()).toBe('')
    expect(en.etaHours(1)).toBe('~1 hour')
    expect(en.etaDays(2)).toBe('~2 days')
    expect(en.walletTxHint(1, 'Base')).toBe('Approve 1 transaction on Base.')
    expect(en.walletTxHint(2, 'Base')).toBe('Approve 2 transactions on Base.')
  })

  it('has no em or en dashes in any string', () => {
    const texts: string[] = []
    const walk = (v: unknown) => {
      if (typeof v === 'string') texts.push(v)
      else if (typeof v === 'function') texts.push(String(v(1, 2)))
      else if (v && typeof v === 'object') Object.values(v).forEach(walk)
    }
    walk(en)
    for (const t of texts) expect(t).not.toMatch(/[–—]/)
  })
})

describe('qrPath', () => {
  it('encodes text as a square grid of merged dark runs', () => {
    const { size, path } = qrPath('hello')
    expect(size).toBe(21) // version 1
    expect(path).toMatch(/^(M\d+ \d+h\d+v1h-\d+z)+$/)
    // The finder pattern at the top-left starts with a 7-module run in row 0
    expect(path.startsWith('M0 0h7v1h-7z')).toBe(true)
  })

  it('is deterministic and grows with the data', () => {
    expect(qrPath('abc')).toEqual(qrPath('abc'))
    expect(qrPath('x'.repeat(200)).size).toBeGreaterThan(21)
  })
})
