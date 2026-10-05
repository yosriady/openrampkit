// @vitest-environment happy-dom
// <openramp-modal> withdraw screens against the in-process server (mock adapter with the offramp leg),
// and `openWithdraw()`.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockWallet } from '@openrampkit/client'
import { USDC } from '@openrampkit/core'
import type { Snapshot } from '@openrampkit/client'
import type { CreateSessionInput } from '@openrampkit/server'
import { BASE, BASE_DEST, BASE_SOURCE, setupServer, sleep, waitFor } from '../../client/src/testctx.js'
import { CLOSED_CODE, TAG_NAME, createWithdrawController, openWithdraw } from './index.js'
import type { OpenRampModal, WithdrawHandle } from './index.js'
import { en } from './messages.js'
import { amountModel, quoteSubtitle, screenTitle } from './view.js'

const ARB = '0x2222222222222222222222222222222222222222'
const USER = '0x1111111111111111111111111111111111111111'

const mounted: OpenRampModal[] = []
const handles: WithdrawHandle[] = []
afterEach(() => {
  for (const el of mounted.splice(0)) {
    el.controller?.destroy()
    el.remove()
  }
  for (const h of handles.splice(0)) h.close()
  document.body.innerHTML = ''
})

async function settle(el: OpenRampModal) {
  for (let i = 0; i < 3; i++) {
    await el.updateComplete
    await sleep(0)
  }
}

async function mount(opts: { session?: Partial<CreateSessionInput>; config?: Parameters<typeof setupServer>[1]; wallet?: boolean; locale?: string } = {}) {
  const server = setupServer(undefined, opts.config)
  const s = await server.ramp.sessions.create({ userId: 'u', direction: 'withdraw', source: BASE_SOURCE, country: 'PH', ...opts.session } as CreateSessionInput)
  const wallet = opts.wallet === false ? undefined : createMockWallet({ address: USER, delayMs: 5 })
  const c = createWithdrawController({ baseUrl: BASE, clientSecret: s.clientSecret, fetch: server.fetch, ...(wallet ? { wallet } : {}) })
  const el = document.createElement(TAG_NAME) as OpenRampModal
  mounted.push(el)
  el.open = true
  if (opts.locale) el.locale = opts.locale
  el.controller = c
  document.body.appendChild(el)
  await c.start()
  await settle(el)
  const root = el.shadowRoot!
  const $ = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector<T>(sel)
  const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...root.querySelectorAll<T>(sel)]
  const text = () => (root.textContent ?? '').replace(/\s+/g, ' ')
  const button = (label: string | RegExp) => {
    const b = $$<HTMLButtonElement>('button').find((x) => (typeof label === 'string' ? x.textContent?.includes(label) : label.test(x.textContent ?? '')))
    if (!b) throw new Error(`No button "${label}" in: ${text()}`)
    return b
  }
  const click = async (b: HTMLElement) => {
    b.click()
    await settle(el)
  }
  const type = async (input: HTMLInputElement, value: string) => {
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    await settle(el)
  }
  const until = async (fn: () => boolean, ms = 8000) => {
    await waitFor(fn, ms)
    await settle(el)
  }
  const title = () => $('.title')?.textContent?.trim()
  return { el, c, s, server, wallet, $, $$, text, button, click, type, until, title }
}

describe('withdraw: to wallet screens', () => {
  it('title, tabs, the target form with validation, amount with balance, quote, wallet confirm and result', async () => {
    const h = await mount()
    expect(h.title()).toBe('Withdraw')
    const tabs = h.$$('[role="tab"]')
    expect(tabs.map((t) => [t.textContent?.trim(), t.getAttribute('aria-selected')])).toEqual([['To wallet', 'true'], ['To cash', 'false']])
    expect(h.$('[role="tablist"]')!.getAttribute('aria-label')).toBe('Withdraw to')
    const [chain, token] = h.$$<HTMLSelectElement>('select')
    expect(chain!.value).toBe('eip155:8453')
    expect(token!.selectedOptions[0]!.textContent).toBe('USDC')
    const addr = h.$<HTMLInputElement>('#ork-address')!
    expect(addr.value).toBe(USER)
    expect(h.text()).not.toContain('Use my wallet')

    chain!.value = 'eip155:42161'
    chain!.dispatchEvent(new Event('change'))
    await settle(h.el)
    expect(h.c.getSnapshot().target!.chain).toBe('eip155:42161')
    token!.value = 'native'
    token!.dispatchEvent(new Event('change'))
    await settle(h.el)
    expect(h.c.getSnapshot().target!.symbol).toBe('ETH')
    h.c.setTargetToken(h.c.targetTokens()[0]!.token)

    await h.type(addr, '0x123')
    expect(h.$('.field-error')!.textContent).toBe('Enter a valid address for this network.')
    expect(addr.getAttribute('aria-invalid')).toBe('true')
    expect(h.button('Continue').disabled).toBe(true)
    await h.click(h.button('Use my wallet'))
    expect(h.c.getSnapshot().target!.address).toBe(USER)
    await h.type(h.$<HTMLInputElement>('#ork-address')!, ARB)
    expect(h.$('.field-error')).toBeNull()
    h.$<HTMLInputElement>('#ork-address')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await h.until(() => h.c.getSnapshot().screen === 'amount')

    expect(h.title()).toBe('Amount to withdraw')
    expect(h.$('.amount-suffix')!.textContent).toBe('USDC')
    expect(h.text()).toContain('Available: 40 USDC')
    expect(h.$('.target-summary')!.textContent).toMatch(/^To 0x2222.*2222 on Arbitrum$/)
    expect(h.$$('.chip').map((c) => c.textContent?.trim())).toEqual(['25%', '50%', 'Max'])
    expect(h.$$('[role="radio"]')).toHaveLength(0) // no pay-with picker for withdrawals
    const amountInput = h.$<HTMLInputElement>('.amount-input')!
    expect(amountInput.getAttribute('aria-invalid')).toBe('false')
    expect(amountInput.getAttribute('aria-describedby')).toBe('ork-amount-balance')
    await h.type(amountInput, '41')
    expect(h.button(/Continue|Enter an amount/).disabled).toBe(true)
    // Over the balance: said in text, not only in color, and tied to the input
    expect(amountInput.getAttribute('aria-invalid')).toBe('true')
    expect(amountInput.getAttribute('aria-describedby')).toBe('ork-amount-balance ork-amount-error')
    expect(h.$('#ork-amount-error')!.textContent).toBe('This is more than your balance.')
    await h.click(h.$$('.chip')[2]!)
    expect(h.c.getSnapshot().amount).toBe('40')
    await h.type(h.$<HTMLInputElement>('.amount-input')!, '25')
    await h.click(h.button('Continue'))
    await h.until(() => !h.c.getSnapshot().quotesLoading)
    expect(h.text()).toContain('You send 25 USDC')
    await h.click(h.button('Confirm'))
    await h.until(() => h.c.getSnapshot().screen === 'step')
    expect(h.title()).toBe('Confirm withdrawal')
    expect(h.text()).toContain('Approve 1 transaction on Base.')
    await h.click(h.button('Confirm in wallet'))
    await h.until(() => h.c.getSnapshot().session?.step.state === 'PROCESSING')
    expect(h.title()).toBe('Sending')
    expect(h.text()).toContain('Your withdrawal is on its way.')
    await h.until(() => h.c.getSnapshot().screen === 'result')
    expect(h.text()).toContain('Withdrawal complete')
    expect(h.text()).toMatch(/You get about 24\.98\d* USDC/)
  })

  it('arrow keys switch the withdraw tabs; one allowed type hides the tabs', async () => {
    const h = await mount()
    h.$('[role="tablist"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await h.until(() => h.c.getSnapshot().screen === 'methods')
    expect(h.c.getSnapshot().tab).toBe('cash')
    h.$('[role="tablist"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    h.$('[role="tablist"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    await h.until(() => h.c.getSnapshot().screen === 'target')
    await h.click(h.$$('[role="tab"]')[0]!) // the active tab: no change
    expect(h.c.getSnapshot().screen).toBe('target')

    const one = await mount({ session: { allowedTargets: { crypto: { chains: ['eip155:42161'] } } } })
    expect(one.$$('[role="tab"]')).toHaveLength(0)
    expect(one.$('#ork-panel')!.getAttribute('role')).toBeNull()
    expect(one.$<HTMLSelectElement>('select')!.value).toBe('eip155:42161')
  })

  it('custody app: after confirm the step shows Sending, then the result', async () => {
    const h = await mount({ wallet: false, session: { source: { ...BASE_SOURCE, custody: 'app' } }, config: { treasury: { send: async () => ({ hash: `0x${'ab'.repeat(32)}` }) } } })
    expect(h.$<HTMLInputElement>('#ork-address')!.value).toBe('')
    await h.type(h.$<HTMLInputElement>('#ork-address')!, ARB)
    await h.click(h.button('Continue'))
    await h.until(() => h.c.getSnapshot().screen === 'amount')
    expect(h.text()).not.toContain('Available')
    expect(h.$$('.chip')).toHaveLength(0)
    await h.type(h.$<HTMLInputElement>('.amount-input')!, '10')
    await h.click(h.button('Continue'))
    await h.until(() => !h.c.getSnapshot().quotesLoading)
    await h.click(h.button('Confirm'))
    await h.until(() => h.c.getSnapshot().screen === 'step')
    expect(h.title()).toBe('Sending')
    await h.until(() => h.c.getSnapshot().screen === 'result')
    expect(h.text()).toContain('Withdrawal complete')
  })

  it('a failed withdrawal says so', async () => {
    const h = await mount({ wallet: false, session: { source: { ...BASE_SOURCE, custody: 'app' } }, config: { treasury: { send: async () => { throw new Error('no funds') } } } })
    await h.type(h.$<HTMLInputElement>('#ork-address')!, ARB)
    await h.click(h.button('Continue'))
    await h.until(() => h.c.getSnapshot().screen === 'amount')
    await h.type(h.$<HTMLInputElement>('.amount-input')!, '10')
    await h.click(h.button('Continue'))
    await h.until(() => !h.c.getSnapshot().quotesLoading)
    await h.click(h.button('Confirm'))
    await h.until(() => h.c.getSnapshot().screen === 'result')
    expect(h.text()).toContain('Withdrawal failed')
    expect(h.text()).toContain('The withdrawal could not be sent.')
  })
})

describe('withdraw: to cash screens', () => {
  it('GCash in PH: payout methods, amount, quote in PHP, payout form, wallet tx, result', async () => {
    const h = await mount()
    await h.click(h.button('To cash'))
    await h.until(() => h.c.getSnapshot().screen === 'methods')
    expect(h.text()).toContain('Paid out in PHP')
    expect(h.$$('[data-method]').map((b) => b.dataset.method)).toEqual(['gcash', 'bank_transfer'])
    await h.click(h.$('[data-method="gcash"]')!)
    expect(h.title()).toBe('GCash')
    expect(h.$('.target-summary')!.textContent).toBe('GCash · Paid out in PHP')
    await h.type(h.$<HTMLInputElement>('.amount-input')!, '20')
    await h.click(h.button('Continue'))
    await h.until(() => !h.c.getSnapshot().quotesLoading)
    expect(h.text()).toMatch(/₱1,131\.43/)
    await h.click(h.button('Confirm'))
    await h.until(() => h.c.getSnapshot().screen === 'step')
    expect(h.title()).toBe('Payout details')
    const fields = h.$$<HTMLInputElement>('form input')
    expect(fields.map((f) => f.id)).toEqual(['ork-f-account_name', 'ork-f-phone'])
    await h.type(fields[0]!, 'Juan Dela Cruz')
    await h.type(fields[1]!, '09171234567')
    h.$('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    // happy-dom limit: Lit cannot remove a rendered <form> (see the OTP test in element.test.ts).
    // Hide the element while the step changes, then show it again.
    h.el.open = false
    await h.until(() => h.c.getSnapshot().session?.step.surface?.kind === 'WALLET_TX')
    h.el.open = true
    await settle(h.el)
    expect(h.title()).toBe('Confirm withdrawal')
    await h.click(h.button('Confirm in wallet'))
    await h.until(() => h.c.getSnapshot().screen === 'result')
    expect(h.text()).toContain('Withdrawal complete')
    expect(h.text()).toContain('You get about ₱1,131.43')
  })

  it('shows a notice when no payout method serves the currency', async () => {
    const h = await mount({ session: { allowedTargets: { fiat: { currencies: ['CHF'] } } } })
    await h.until(() => h.c.getSnapshot().screen === 'methods')
    expect(h.text()).toContain('No payout methods are available for this withdrawal.')
    expect(h.text()).toContain('Paid out in CHF')
  })

  it('renders Vietnamese withdraw copy', async () => {
    const h = await mount({ locale: 'vi', session: { country: 'VN' } })
    expect(h.title()).toBe('Rút tiền')
    expect(h.$$('[role="tab"]').map((t) => t.textContent?.trim())).toEqual(['Về ví', 'Về tiền mặt'])
    expect(h.$('label[for="ork-address"]')!.textContent).toBe('Địa chỉ ví')
  })
})

describe('withdraw: view helpers', () => {
  const base: Snapshot = { screen: 'amount', direction: 'withdraw', tab: 'cash', amount: '', amountSide: 'source', quotes: [], quoteErrors: [], quotesLoading: false, busy: false, walletConnected: false, balances: [], surfaceClosed: false }

  it('titles per screen and step', () => {
    const step = (state: string, kind?: string) => ({ ...base, screen: 'step' as const, session: { step: { state, transitions: [], ...(kind ? { surface: { kind } } : {}) } } }) as unknown as Snapshot
    expect(screenTitle(base, en)).toBe('Withdraw') // cash amount without a method
    expect(screenTitle({ ...base, screen: 'target' }, en)).toBe('Withdraw')
    expect(screenTitle({ ...base, screen: 'target' }, en, { title: 'Cash out' })).toBe('Cash out')
    expect(screenTitle(step('PAYMENT', 'QR'), en)).toBe('Complete payment')
    expect(screenTitle(step('COMPLETED'), en)).toBe('Complete')
  })

  it('amount model: session bounds and no balance', () => {
    const m = amountModel({ ...base, session: { amountBounds: { min: '5', currency: 'USD' } } as never, amount: '3' }, en)
    expect(m).toMatchObject({ isWithdraw: true, isWallet: false, currency: 'USDC', prefix: '', overBalance: false, valid: true, chips: [] })
    expect(m.boundsText).toBe('Minimum $5')
  })

  it('quote subtitle says what the user sends', () => {
    const q = { fees: [], input: { amount: '10', asset: { kind: 'crypto', chain: 'eip155:8453', token: 'x', symbol: 'USDC' } } } as never
    expect(quoteSubtitle(q, en, 'withdraw')).toBe('You send 10 USDC · No fees')
    expect(quoteSubtitle(q, en)).toBe('You pay 10 USDC · No fees')
  })
})

describe('openWithdraw', () => {
  it('mounts the modal, resolves done when the withdrawal completes', async () => {
    const server = setupServer()
    const s = await server.ramp.sessions.create({ userId: 'u', direction: 'withdraw', source: BASE_SOURCE, country: 'PH' })
    const wallet = createMockWallet({ address: USER, delayMs: 0 })
    const h = openWithdraw({ baseUrl: BASE, clientSecret: async () => s.clientSecret, fetch: server.fetch, wallet })
    handles.push(h)
    const c = await h.ready
    await waitFor(() => c.getSnapshot().screen === 'target')
    c.setTargetAddress(ARB)
    await c.submitTarget()
    c.setAmount('5')
    await c.submitAmount()
    await c.confirm()
    await c.sendWalletTransactions()
    await expect(h.done).resolves.toMatchObject({ direction: 'withdraw', step: { state: 'COMPLETED' } })
  })

  it('rejects done with a withdrawal message on close; refuses a deposit session', async () => {
    const server = setupServer()
    const s = await server.ramp.sessions.create({ userId: 'u', direction: 'withdraw', source: BASE_SOURCE })
    const onClose = vi.fn()
    const h = openWithdraw({ baseUrl: BASE, clientSecret: s.clientSecret, fetch: server.fetch, onClose })
    handles.push(h)
    await h.ready
    h.close()
    await expect(h.done).rejects.toMatchObject({ code: CLOSED_CODE, message: 'The withdrawal was closed before it finished.' })
    expect(onClose).toHaveBeenCalledTimes(1)

    const dep = await server.ramp.sessions.create({ userId: 'u', destination: BASE_DEST })
    const d = openWithdraw({ baseUrl: BASE, clientSecret: dep.clientSecret, fetch: server.fetch })
    handles.push(d)
    const c = await d.ready
    await waitFor(() => c.getSnapshot().screen === 'error')
    await d.element.updateComplete
    expect(d.element.shadowRoot!.textContent).toContain('This is not a withdraw session.')
  })
})

describe('withdraw: locked target screens', () => {
  it('no tabs and no target form; the locked address shows read only', async () => {
    const target = { type: 'crypto' as const, chain: 'eip155:42161', token: USDC['eip155:42161']!, address: ARB }
    const h = await mount({ session: { target, lockTarget: true } })
    // One usable method: straight to the amount screen, which names the locked address.
    expect(h.c.getSnapshot().screen).toBe('amount')
    expect(h.$$('[role="tab"]')).toHaveLength(0)
    expect(h.$('#ork-address')).toBeNull()
    expect(h.$('.target-summary')!.textContent).toBe('To 0x2222...2222 on Arbitrum')
    // Back shows the payout methods with the locked address, not the form.
    await h.click(h.$('.header .icon-btn[aria-label="Back"]')!)
    expect(h.c.getSnapshot().screen).toBe('methods')
    expect(h.$('#ork-address')).toBeNull()
    expect(h.$('.locked-target')!.textContent).toBe('To 0x2222...2222 on Arbitrum')
    expect(h.server.requests.some((r) => r.url.endsWith('/target'))).toBe(false)
  })

  it('a locked cash target shows its payout methods with no tabs', async () => {
    const h = await mount({ session: { target: { type: 'fiat', currency: 'PHP' }, lockTarget: true } })
    expect(h.c.getSnapshot().screen).toBe('methods')
    expect(h.$$('[role="tab"]')).toHaveLength(0)
    expect(h.text()).toContain('Paid out in PHP')
    expect(h.$$('[data-method]').map((b) => b.dataset.method)).toEqual(['gcash', 'bank_transfer'])
  })
})
