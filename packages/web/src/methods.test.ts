// @vitest-environment happy-dom
// Method rows for markets outside Southeast Asia: the plan comes from the real planner with the
// static legs of the provider adapters, and the modal renders labels and generic icons for it.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { DepositController } from '@openrampkit/client'
import { meld } from '@openrampkit/adapter-meld'
import { moonpay } from '@openrampkit/adapter-moonpay'
import { onramper } from '@openrampkit/adapter-onramper'
import { transak } from '@openrampkit/adapter-transak'
import { USDC, planPathways } from '@openrampkit/core'
import { fakeClient } from '../../client/src/testctx.js'
import { icons, methodIcon } from './icons.js'
import { OpenRampModal, TAG_NAME } from './index.js'

const ADAPTERS = [
  moonpay({ publishableKey: 'pk_test_x', secretKey: 'sk_test_x', env: 'sandbox' }),
  transak({ apiKey: 'k', apiSecret: 's', referrerDomain: 'app.test', env: 'staging' }),
  meld({ apiKey: 'k', env: 'sandbox' }),
  onramper({ apiKey: 'pk_test_x', secretKey: 'x', env: 'sandbox' }),
]

function planFor(country: string) {
  return planPathways({
    direction: 'deposit',
    destination: { type: 'crypto', chain: 'eip155:8453', token: USDC['eip155:8453']!, address: '0x000000000000000000000000000000000000beef' },
    user: { country },
    legs: ADAPTERS.flatMap((a) => a.legs.map((spec) => ({ adapterId: a.id, provider: a.name, spec }))),
  })
}

const mounted: OpenRampModal[] = []
afterEach(() => {
  for (const el of mounted.splice(0)) {
    el.controller?.destroy()
    el.remove()
  }
})

async function render(country: string) {
  const client = fakeClient({ plan: vi.fn(async () => planFor(country)) })
  const c = new DepositController({ client, clientSecret: 'ors_1.sig' })
  const el = document.createElement(TAG_NAME) as OpenRampModal
  mounted.push(el)
  el.open = true
  el.controller = c
  document.body.appendChild(el)
  await c.start()
  for (let i = 0; i < 3; i++) {
    await el.updateComplete
    await new Promise((r) => setTimeout(r, 0))
  }
  const rows = [...el.shadowRoot!.querySelectorAll<HTMLElement>('[data-method]')]
  return Object.fromEntries(rows.map((r) => [r.dataset.method!, (r.textContent ?? '').replace(/\s+/g, ' ').trim()]))
}

describe('method rows outside Southeast Asia', () => {
  it('Netherlands: iDEAL, SEPA Instant and pay by bank with their names and providers', async () => {
    const rows = await render('NL')
    expect(Object.keys(rows)[0]).toBe('ideal')
    expect(rows.ideal).toContain('iDEAL')
    expect(rows.ideal).toContain('via Meld, Onramper')
    expect(rows.sepa_instant).toContain('SEPA Instant')
    expect(rows.open_banking).toContain('Pay by bank')
    expect(rows.faster_payments).toBeUndefined()
  })

  it('United Kingdom, Poland, Mexico, Kenya: the local method row is rendered', async () => {
    expect((await render('GB')).faster_payments).toContain('Faster Payments')
    expect((await render('PL')).blik).toContain('BLIK')
    expect((await render('MX')).spei).toContain('SPEI')
    expect((await render('KE')).mpesa).toContain('M-Pesa')
  })

  it('uses generic glyphs: instant bank rails and mobile money have their own icon', () => {
    for (const m of ['sepa_instant', 'faster_payments', 'open_banking', 'ideal', 'blik', 'payid', 'spei', 'pse', 'khipu', 'imps', 'interac']) {
      expect(methodIcon('bank', m)).toBe(icons.bankInstant)
    }
    expect(methodIcon('ewallet', 'mpesa')).toBe(icons.mobileMoney)
    expect(methodIcon('ewallet', 'mobile_money')).toBe(icons.mobileMoney)
    expect(methodIcon('bank', 'sepa')).toBe(icons.bank)
    expect(methodIcon('card', 'bancontact')).toBe(icons.card)
  })
})
