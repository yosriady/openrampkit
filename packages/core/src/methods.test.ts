import { describe, expect, it } from 'vitest'
import { DEFAULT_METHOD_PRIORITY, METHODS, METHOD_COUNTRIES, USDC, currencyForCountry, methodAvailableIn, methodName, minorUnits, planPathways } from './index.js'
import type { LegSpec } from './index.js'

const GLOBAL = [
  'sepa_instant', 'faster_payments', 'open_banking', 'ideal', 'bancontact', 'sofort', 'blik', 'payid', 'spei', 'pse',
  'bancolombia', 'khipu', 'imps', 'mpesa', 'mobile_money', 'astropay', 'alipay',
]

/** One leg that offers every method, in any currency */
const everything: LegSpec = {
  id: 'all', kind: 'fiat_onramp', methods: ['card', 'apple_pay', 'google_pay', 'sepa', 'bank_transfer', ...GLOBAL],
  from: { asset: { kind: 'fiat', currencies: '*' }, location: ['user_account'] },
  to: { asset: { kind: 'crypto', chains: { 'eip155:8453': [USDC['eip155:8453']!] } }, location: ['address'] },
  regions: { allow: ['*'], deny: [] }, eta: { min: 60, max: 300 }, surfaces: ['REDIRECT'],
}

function plan(country: string) {
  return planPathways({
    direction: 'deposit',
    destination: { type: 'crypto', chain: 'eip155:8453', token: USDC['eip155:8453']!, address: '0xabc' },
    user: { country },
    legs: [{ adapterId: 'p', provider: 'P', spec: everything }],
  })
}

describe('global and regional methods', () => {
  it('have names and kinds; existing codes are unchanged', () => {
    for (const id of GLOBAL) expect(METHODS[id]?.id).toBe(id)
    expect(methodName('sepa_instant')).toBe('SEPA Instant')
    expect(methodName('open_banking')).toBe('Pay by bank')
    expect(methodName('ideal')).toBe('iDEAL')
    expect(methodName('mpesa')).toBe('M-Pesa')
    expect(METHODS.blik!.kind).toBe('bank')
    expect(METHODS.mobile_money!.kind).toBe('ewallet')
    // stable codes
    for (const id of ['card', 'apple_pay', 'google_pay', 'sepa', 'ach', 'pix', 'upi', 'interac', 'venmo', 'paypal', 'revolut_pay', 'mercadopago']) expect(METHODS[id]).toBeDefined()
  })

  it('are offered only in their countries', () => {
    expect(methodAvailableIn('ideal', 'NL')).toBe(true)
    expect(methodAvailableIn('ideal', 'DE')).toBe(false)
    expect(methodAvailableIn('faster_payments', 'GB')).toBe(true)
    expect(methodAvailableIn('faster_payments', 'FR')).toBe(false)
    expect(methodAvailableIn('open_banking', 'GB')).toBe(true)
    expect(methodAvailableIn('open_banking', 'PL')).toBe(true)
    expect(methodAvailableIn('open_banking', 'US')).toBe(false)
    expect(methodAvailableIn('blik', 'PL')).toBe(true)
    expect(methodAvailableIn('payid', 'AU')).toBe(true)
    expect(methodAvailableIn('spei', 'MX')).toBe(true)
    expect(methodAvailableIn('pse', 'CO')).toBe(true)
    expect(methodAvailableIn('pse', 'MX')).toBe(false)
    expect(methodAvailableIn('mpesa', 'KE')).toBe(true)
    expect(methodAvailableIn('mobile_money', 'GH')).toBe(true)
    expect(methodAvailableIn('mobile_money', 'DE')).toBe(false)
    // not gated: wallets that work across borders
    expect(METHOD_COUNTRIES.astropay).toBeUndefined()
    expect(METHOD_COUNTRIES.alipay).toBeUndefined()
  })

  it('map local currencies for the new markets', () => {
    expect(currencyForCountry('PL')).toBe('PLN')
    expect(currencyForCountry('CO')).toBe('COP')
    expect(currencyForCountry('CL')).toBe('CLP')
    expect(currencyForCountry('GR')).toBe('EUR')
    expect(currencyForCountry('GH')).toBe('GHS')
    expect(minorUnits('CLP')).toBe(0)
    expect(minorUnits('UGX')).toBe(0)
  })

  it('every method in a priority list is a known method', () => {
    for (const list of Object.values(DEFAULT_METHOD_PRIORITY)) for (const m of list) expect(METHODS[m], m).toBeDefined()
  })

  it('planner: the local method is recommended and other countries methods are dropped', () => {
    const cases: Array<[string, string, string[]]> = [
      ['NL', 'ideal', ['sepa_instant', 'open_banking', 'sepa']],
      ['BE', 'bancontact', ['sepa_instant']],
      ['PL', 'blik', ['open_banking']],
      ['MX', 'spei', ['astropay']],
      ['CO', 'pse', ['bancolombia']],
      ['CL', 'khipu', []],
      ['IN', 'imps', []],
      ['AU', 'payid', []],
      ['KE', 'mpesa', ['mobile_money']],
      ['GH', 'mobile_money', []],
    ]
    for (const [country, first, also] of cases) {
      const r = plan(country)
      const ids = r.methods.map((m) => m.method)
      // IN: UPI is not offered by this leg, so IMPS (next in the list) is recommended
      expect(r.methods[0]).toMatchObject({ method: first, group: 'recommended' })
      for (const m of also) expect(ids).toContain(m)
      for (const m of GLOBAL) if (METHOD_COUNTRIES[m] && !METHOD_COUNTRIES[m]!.includes(country)) expect(ids).not.toContain(m)
    }
    // GB: cards first, then Faster Payments before pay by bank
    const gb = plan('GB').methods.map((m) => m.method)
    expect(gb.slice(0, 3)).toEqual(['apple_pay', 'card', 'google_pay'])
    expect(gb.indexOf('faster_payments')).toBeLessThan(gb.indexOf('open_banking'))
    expect(gb).not.toContain('sepa')
  })
})
