// Payment method coverage per region: the real provider adapters, configured together, planned for
// users in each country. Catalog calls fail here (no network), so every adapter uses its static legs.
import { describe, expect, it } from 'vitest'
import type { Adapter } from '@openrampkit/adapter'
import { coinbase } from '@openrampkit/adapter-coinbase'
import { meld } from '@openrampkit/adapter-meld'
import { moonpay } from '@openrampkit/adapter-moonpay'
import { onramper } from '@openrampkit/adapter-onramper'
import { stripe } from '@openrampkit/adapter-stripe'
import { swapped } from '@openrampkit/adapter-swapped'
import { transak } from '@openrampkit/adapter-transak'
import { USDC } from '@openrampkit/core'
import type { PlanResult } from '@openrampkit/core'
import { createOpenRamp } from './index.js'

const BASE = 'https://app.test/api/openramp'
const SECRET = 's'.repeat(40)
const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const DEST = { type: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']!, address: '0x000000000000000000000000000000000000beef' }

const ADAPTERS: Record<string, () => Adapter> = {
  moonpay: () => moonpay({ publishableKey: 'pk_test_x', secretKey: 'sk_test_x', env: 'sandbox' }),
  transak: () => transak({ apiKey: 'k', apiSecret: 's', referrerDomain: 'app.test', env: 'sandbox' }),
  coinbase: () => coinbase({ apiKeyId: 'id', apiKeySecret: 'secret' }),
  stripe: () => stripe({ secretKey: 'sk_test_x', publishableKey: 'pk_test_x', webhookSecret: 'whsec_x' }),
  meld: () => meld({ apiKey: 'k', env: 'sandbox' }),
  onramper: () => onramper({ apiKey: 'pk_test_x', secretKey: 'x', env: 'sandbox' }),
  swapped: () => swapped({ publicKey: 'pk_sandbox_x', secretKey: 'sk_sandbox_x', env: 'sandbox' }),
}

/** Plan a deposit for a user in `country` with the named adapters configured */
async function planFor(country: string, names: string[] = Object.keys(ADAPTERS)): Promise<PlanResult> {
  const ramp = createOpenRamp({
    secret: SECRET,
    baseUrl: BASE,
    adapters: names.map((n) => ADAPTERS[n]!()),
    logger: quiet,
    // No network: catalogs fail and the static legs are used
    fetch: async () => {
      throw new Error('offline')
    },
  })
  const s = await ramp.sessions.create({ userId: 'u', country, destination: DEST })
  const res = await ramp.handle(
    new Request(`${BASE}/sessions/${s.id}/plan`, { method: 'POST', headers: { authorization: `Bearer ${s.clientSecret}`, 'content-type': 'application/json' }, body: '{}' }),
  )
  expect(res.status).toBe(200)
  return (await res.json()) as PlanResult
}

/** Available methods in display order, with their providers */
function available(plan: PlanResult): Record<string, string[]> {
  return Object.fromEntries(plan.methods.filter((m) => m.group !== 'unavailable').map((m) => [m.method, m.providers]))
}

describe('payment methods per region (all adapters configured)', () => {
  it('Netherlands: iDEAL first, then SEPA Instant and pay by bank, in EUR', async () => {
    const plan = await planFor('NL')
    expect(plan.currency).toBe('EUR')
    const m = available(plan)
    expect(plan.methods[0]!.method).toBe('ideal')
    expect(m.ideal).toEqual(['Meld', 'Onramper'])
    expect(m.sepa_instant).toEqual(['Meld', 'Onramper'])
    expect(m.open_banking).toEqual(expect.arrayContaining(['Transak', 'Meld', 'Onramper']))
    expect(m.sepa).toEqual(expect.arrayContaining(['MoonPay', 'Meld', 'Onramper']))
    // Methods of other countries stay out
    expect(m.bancontact).toBeUndefined()
    expect(m.faster_payments).toBeUndefined()
    expect(m.blik).toBeUndefined()
  })

  it('Belgium: Bancontact first', async () => {
    const plan = await planFor('BE')
    expect(plan.methods[0]!.method).toBe('bancontact')
    expect(available(plan).bancontact).toEqual(['Meld', 'Onramper'])
    expect(available(plan).ideal).toBeUndefined()
  })

  it('Germany: cards first, then SEPA Instant, SEPA and pay by bank', async () => {
    const plan = await planFor('DE')
    const order = plan.methods.filter((x) => x.group !== 'unavailable').map((x) => x.method)
    expect(order.slice(0, 2)).toEqual(['apple_pay', 'card'])
    expect(order.indexOf('sepa_instant')).toBeLessThan(order.indexOf('sepa'))
    expect(order).toContain('open_banking')
  })

  it('United Kingdom: Faster Payments and pay by bank, in GBP', async () => {
    const plan = await planFor('GB')
    expect(plan.currency).toBe('GBP')
    const m = available(plan)
    expect(m.faster_payments).toEqual(expect.arrayContaining(['MoonPay', 'Transak', 'Meld', 'Onramper']))
    expect(m.open_banking).toEqual(expect.arrayContaining(['MoonPay', 'Transak', 'Meld', 'Onramper']))
    expect(m.bank_transfer).toBeUndefined()
    expect(m.sepa).toBeUndefined()
  })

  it('Poland: BLIK first, in PLN', async () => {
    const plan = await planFor('PL')
    expect(plan.currency).toBe('PLN')
    expect(plan.methods[0]!.method).toBe('blik')
    expect(available(plan).blik).toEqual(['Meld'])
  })

  it('Mexico: SPEI first, in MXN', async () => {
    const plan = await planFor('MX')
    expect(plan.currency).toBe('MXN')
    expect(plan.methods[0]!.method).toBe('spei')
    expect(available(plan).spei).toEqual(['Meld', 'Onramper'])
  })

  it('Colombia: PSE first, then Bancolombia, in COP', async () => {
    const plan = await planFor('CO')
    expect(plan.currency).toBe('COP')
    expect(plan.methods[0]!.method).toBe('pse')
    expect(available(plan).pse).toEqual(['Transak', 'Meld'])
    expect(available(plan).bancolombia).toEqual(['Onramper'])
  })

  it('Chile: Khipu first, in CLP', async () => {
    const plan = await planFor('CL')
    expect(plan.currency).toBe('CLP')
    expect(plan.methods[0]!.method).toBe('khipu')
    expect(available(plan).khipu).toEqual(['Meld', 'Onramper'])
  })

  it('Brazil: Pix first', async () => {
    const plan = await planFor('BR')
    expect(plan.methods[0]!.method).toBe('pix')
    expect(available(plan).pix).toEqual(expect.arrayContaining(['MoonPay', 'Meld', 'Onramper']))
  })

  it('India: UPI first, then IMPS', async () => {
    const plan = await planFor('IN')
    const order = plan.methods.map((m) => m.method)
    expect(order[0]).toBe('upi')
    expect(order.indexOf('imps')).toBe(1)
    expect(available(plan).imps).toEqual(['Meld', 'Onramper'])
  })

  it('Canada: Interac first, from MoonPay, Meld and Onramper', async () => {
    const plan = await planFor('CA')
    expect(plan.methods[0]!.method).toBe('interac')
    expect(available(plan).interac).toEqual(expect.arrayContaining(['MoonPay', 'Meld', 'Onramper']))
  })

  it('Australia: PayID first', async () => {
    const plan = await planFor('AU')
    expect(plan.methods[0]!.method).toBe('payid')
    expect(available(plan).payid).toEqual(['Meld'])
  })

  it('Kenya: M-Pesa first, then mobile money, in KES', async () => {
    const plan = await planFor('KE')
    expect(plan.currency).toBe('KES')
    expect(plan.methods.slice(0, 2).map((m) => m.method)).toEqual(['mpesa', 'mobile_money'])
    expect(available(plan).mpesa).toEqual(['Meld'])
  })

  it('Ghana: mobile money first, in GHS', async () => {
    const plan = await planFor('GH')
    expect(plan.currency).toBe('GHS')
    expect(plan.methods[0]!.method).toBe('mobile_money')
  })

  it('United States: ACH from Coinbase, MoonPay, Meld and Onramper', async () => {
    const plan = await planFor('US')
    // Stripe needs the PROVIDER_SDK surface, which this plan request does not list
    expect(available(plan).ach).toEqual(expect.arrayContaining(['Coinbase', 'MoonPay', 'Meld', 'Onramper']))
    expect(available(plan).faster_payments).toBeUndefined()
  })

  it('one adapter alone: Onramper gives iDEAL in NL and SPEI in MX', async () => {
    expect(available(await planFor('NL', ['onramper'])).ideal).toEqual(['Onramper'])
    expect(available(await planFor('MX', ['onramper'])).spei).toEqual(['Onramper'])
    expect(available(await planFor('PL', ['onramper'])).blik).toBeUndefined()
  })
})
