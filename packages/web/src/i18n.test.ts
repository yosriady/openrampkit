import { describe, expect, it } from 'vitest'
import { catalogFor, catalogs, en, mergeMessages, resolveLocale, resolveMessages } from './messages.js'
import type { Messages } from './messages.js'
import { STEP_SUBS } from '@openrampkit/core'
import type { Step } from '@openrampkit/core'
import { stepLabel } from './view.js'
import { formatAmount, formatEta, formatFees, formatFiat, formatLimit, formatToken } from './format.js'

/** Sample arguments for every function message, by arity. */
const ARGS: unknown[] = ['X1', 'Y2']

/** Every string a catalog can produce, with its key path. Functions are called with sample arguments. */
function strings(m: Messages): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const [k, v] of Object.entries(m)) {
    if (typeof v === 'string') out.push([k, v])
    else if (typeof v === 'function') {
      if (k === 'minMax') {
        const f = v as Messages['minMax']
        out.push([`${k}(min,max)`, f('1', '2')], [`${k}(min)`, f('1')], [`${k}(,max)`, f(undefined, '2')])
      } else if (/^eta|walletTxHint/.test(k)) {
        out.push([`${k}(1)`, (v as (...a: unknown[]) => string)(1, 'Base')], [`${k}(3)`, (v as (...a: unknown[]) => string)(3, 'Base')])
      } else out.push([k, (v as (...a: unknown[]) => string)(...ARGS)])
    } else for (const [k2, v2] of Object.entries(v as Record<string, string>)) out.push([`${k}.${k2}`, v2])
  }
  return out
}

const LOCALES = Object.keys(catalogs) as Array<keyof typeof catalogs>

describe('catalogs', () => {
  it('ships en, vi, id, th, ms and fil', () => {
    expect(LOCALES.sort()).toEqual(['en', 'fil', 'id', 'ms', 'th', 'vi'])
  })

  it.each(LOCALES)('%s has every key of English, of the same type, and nothing else', (loc) => {
    const m = catalogs[loc]
    expect(Object.keys(m).sort()).toEqual(Object.keys(en).sort())
    for (const k of Object.keys(en) as Array<keyof Messages>) {
      expect(typeof m[k], k).toBe(typeof en[k])
      if (typeof en[k] === 'object') expect(Object.keys(m[k] as object).sort(), k).toEqual(Object.keys(en[k] as object).sort())
      if (typeof en[k] === 'function') expect((m[k] as (...a: unknown[]) => string).length, k).toBe((en[k] as (...a: unknown[]) => string).length)
    }
    expect(m.locale).toBe(loc)
  })

  it.each(LOCALES)('%s has no empty strings, no em or en dashes, and keeps arguments', (loc) => {
    for (const [k, v] of strings(catalogs[loc])) {
      expect(v.trim(), `${loc}.${k}`).not.toBe('')
      expect(v, `${loc}.${k}`).not.toMatch(/[–—]/)
    }
    const m = catalogs[loc]
    expect(m.via('GCash, Maya')).toContain('GCash, Maya')
    expect(m.continueTo('Swapped')).toContain('Swapped')
    expect(m.depositWarning('USDC', 'Base')).toMatch(/USDC[\s\S]*Base/)
    expect(m.minMax()).toBe('')
  })

  it.each(LOCALES)('%s plural and ETA functions work for 1 and many', (loc) => {
    const m = catalogs[loc]
    for (const n of [1, 2, 5]) {
      expect(m.etaMinutes(n)).toContain(String(n))
      expect(m.etaHours(n)).toContain(String(n))
      expect(m.etaDays(n)).toContain(String(n))
      expect(m.walletTxHint(n, 'Base')).toContain(String(n))
    }
    expect(m.etaHoursRange(2, 4)).toMatch(/2[\s\S]*4/)
    expect(m.etaDaysRange(1, 3)).toMatch(/1[\s\S]*3/)
    expect(formatEta({ min: 3600, max: 3 * 3600 }, m)).toBe(m.etaHoursRange(1, 3))
    expect(formatEta({ min: 0, max: 30 }, m)).toBe(m.etaInstant)
  })

  it.each(LOCALES)('%s has a label for every Step.sub in STEP_SUBS, and stepLabel uses it', (loc) => {
    const m = catalogs[loc]
    expect(Object.keys(m.stepSub).sort()).toEqual([...STEP_SUBS].sort())
    const step = (sub?: string) => ({ sessionId: 's', state: 'PROCESSING' as const, transitions: [], ...(sub ? { sub } : {}) }) as Step
    for (const sub of STEP_SUBS) expect(stepLabel(m, step(sub))).toBe(m.stepSub[sub])
    // No sub, or a raw provider value from an older or newer server: the state title, never the raw value
    expect(stepLabel(m, step())).toBe(m.stepTitle.PROCESSING)
    expect(stepLabel(m, step('WAIT_DESTINATION_TRANSACTION'))).toBe(m.stepTitle.PROCESSING)
  })

  it('English plurals', () => {
    expect(en.etaHours(1)).toBe('~1 hour')
    expect(en.etaHours(2)).toBe('~2 hours')
    expect(en.walletTxHint(1, 'Base')).toBe('Approve 1 transaction on Base.')
    expect(en.walletTxHint(2, 'Base')).toBe('Approve 2 transactions on Base.')
  })

  it('uses common local payment words', () => {
    expect(catalogs.vi.title).toBe('Nạp tiền')
    expect(catalogs.id.title).toBe('Isi saldo')
    expect(catalogs.th.title).toBe('ฝากเงิน')
    expect(catalogs.ms.title).toBe('Tambah nilai')
    expect(catalogs.fil.title).toBe('Mag-deposit')
  })
})

describe('locale resolution', () => {
  it('catalogFor matches the language subtag and aliases', () => {
    expect(catalogFor('vi-VN')).toBe('vi')
    expect(catalogFor('TH')).toBe('th')
    expect(catalogFor('ms_MY')).toBe('ms')
    expect(catalogFor('tl-PH')).toBe('fil')
    expect(catalogFor('fil-PH')).toBe('fil')
    expect(catalogFor('in')).toBe('id')
    expect(catalogFor('de-DE')).toBeUndefined()
    expect(catalogFor(undefined)).toBeUndefined()
    expect(catalogFor('')).toBeUndefined()
  })

  it('explicit locale > session locale > en', () => {
    expect(resolveLocale({ locale: 'th', sessionLocale: 'vi' })).toEqual({ catalog: 'th', tag: 'th' })
    expect(resolveLocale({ sessionLocale: 'vi' })).toEqual({ catalog: 'vi', tag: 'vi' })
    expect(resolveLocale({})).toEqual({ catalog: 'en', tag: 'en' })
  })

  it('an explicit locale without a catalog keeps its tag for formatting and English strings', () => {
    expect(resolveLocale({ locale: 'fr-FR', sessionLocale: 'vi' })).toEqual({ catalog: 'en', tag: 'fr-FR' })
  })

  it('a session locale without a catalog gives English; a session "en" keeps its tag', () => {
    expect(resolveLocale({ sessionLocale: 'de' })).toEqual({ catalog: 'en', tag: 'en' })
    expect(resolveLocale({ sessionLocale: 'en-GB' })).toEqual({ catalog: 'en', tag: 'en-GB' })
  })

  it('ignores the browser language: English unless the app sets a locale', () => {
    const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    Object.defineProperty(globalThis, 'navigator', { value: { language: 'th-TH' }, configurable: true })
    try {
      expect(resolveLocale({})).toEqual({ catalog: 'en', tag: 'en' })
    } finally {
      if (nav) Object.defineProperty(globalThis, 'navigator', nav)
      else delete (globalThis as { navigator?: unknown }).navigator
    }
  })

  it('resolveMessages: explicit overrides > locale catalog', () => {
    const m = resolveMessages({ locale: 'vi-VN', messages: { title: 'Nạp USDC' } })
    expect(m.title).toBe('Nạp USDC')
    expect(m.tabCrypto).toBe('Dùng tiền mã hóa')
    expect(m.locale).toBe('vi-VN')
    expect(resolveMessages({})).toEqual(en)
    expect(mergeMessages({ close: 'X' }).close).toBe('X')
    expect(mergeMessages()).toBe(en)
  })
})

describe('locale number and currency formatting', () => {
  const sp = (s: string | undefined) => s?.replace(/\s/g, ' ')

  it('formats each SEA currency for its locale', () => {
    expect(sp(formatFiat('500000', 'VND', { locale: 'vi' }))).toBe('500.000 ₫')
    expect(sp(formatFiat('250000', 'IDR', { locale: 'id' }))).toBe('Rp 250.000')
    expect(sp(formatFiat('1000.5', 'THB', { locale: 'th' }))).toBe('฿1,000.50')
    expect(sp(formatFiat('1000.5', 'MYR', { locale: 'ms' }))).toBe('RM 1,000.50')
    expect(sp(formatFiat('1000.5', 'PHP', { locale: 'fil' }))).toBe('₱1,000.50')
  })

  it('VND has no decimals even for fractional amounts', () => {
    expect(sp(formatFiat('199999.6', 'VND', { locale: 'vi' }))).toBe('200.000 ₫')
    expect(sp(formatFiat('199999.6', 'VND', { locale: 'en' }))).toBe('₫200,000')
  })

  it('tokens, amounts, fees and limits follow the locale', () => {
    expect(formatToken('1234.5', 'USDC', 'vi')).toBe('1.234,5 USDC')
    expect(formatToken('1234.5', 'USDC', 'en')).toBe('1,234.5 USDC')
    expect(sp(formatAmount({ amount: '1234.5', asset: { kind: 'fiat', currency: 'USD' } }, 'vi'))).toBe('1.234,50 US$')
    expect(formatAmount({ amount: '1234.5', asset: { kind: 'crypto', chain: 'eip155:1', token: '0x', symbol: 'ETH' } }, 'id')).toBe('1.234,5 ETH')
    expect(sp(formatFees([{ kind: 'provider', label: 'Fee', amount: '15000', currency: 'IDR' }], 'id'))).toBe('Rp 15.000')
    expect(sp(formatLimit({ max: '50000000', currency: 'VND' }, resolveMessages({ locale: 'vi' })))).toBe('Hạn mức 50.000.000 ₫')
    // Non-ISO codes fall back to token formatting in the locale
    expect(formatFiat('1234.5', 'USDC', { locale: 'vi' })).toBe('1.234,5 USDC')
  })
})

describe('done screen text', () => {
  it('uses youDeposited when the destination ran contract calls, in every catalog', () => {
    expect(en.youDeposited('2 tUSDC')).toBe('2 tUSDC was deposited for you in the same transaction')
    for (const m of Object.values(catalogs)) expect(m.youDeposited('X')).toContain('X')
  })
})
