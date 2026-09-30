// @vitest-environment happy-dom
// <openramp-modal> driven by a real DepositController against the in-process server and the mock adapter.
// Surfaces that the mock adapter never returns (IFRAME, FORM, OTP, ...) use a fake client.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DepositController, createMockWallet } from '@openrampkit/client'
import type { Destination, PublicSession, Surface, Transition, WalletAdapter } from '@openrampkit/core'
import { USDC, orkError } from '@openrampkit/core'
import { BASE, BASE_DEST, fakeClient, quote, session, setupServer, sleep, step, waitFor } from '../../client/src/testctx.js'
import { OpenRampModal, TAG_NAME, createDepositController, darkColors, defineOpenRampModal, lightColors } from './index.js'

type Mounted = Awaited<ReturnType<typeof mount>>

const mounted: OpenRampModal[] = []
afterEach(() => {
  for (const el of mounted.splice(0)) {
    el.controller?.destroy()
    el.remove()
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function settle(el: OpenRampModal) {
  for (let i = 0; i < 3; i++) {
    await el.updateComplete
    await sleep(0)
  }
}

function helpers(el: OpenRampModal) {
  const root = el.shadowRoot!
  const $ = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T & HTMLElement>(sel)
  const $$ = <T extends Element = HTMLElement>(sel: string) => [...root.querySelectorAll<T & HTMLElement>(sel)]
  const text = () => (root.textContent ?? '').replace(/\s+/g, ' ')
  const button = (label: string | RegExp) => {
    const b = $$<HTMLButtonElement>('button').find((x) => (typeof label === 'string' ? x.textContent?.includes(label) : label.test(x.textContent ?? '')))
    if (!b) throw new Error(`No button "${label}" in: ${text()}`)
    return b
  }
  const title = () => $('.title')?.textContent?.trim()
  const click = async (b: HTMLElement) => {
    b.click()
    await settle(el)
  }
  const key = async (target: Element, k: string, init: KeyboardEventInit = {}) => {
    const e = new KeyboardEvent('keydown', { key: k, bubbles: true, composed: true, cancelable: true, ...init })
    target.dispatchEvent(e)
    await settle(el)
    return e
  }
  const cashTab = async () => {
    el.controller!.setTab('cash')
    await settle(el)
  }
  const until = async (fn: () => boolean, ms = 6000) => {
    await waitFor(fn, ms)
    await settle(el)
  }
  return { root, $, $$, text, button, title, click, key, until, cashTab }
}

async function mount(opts: { country?: string; destination?: Destination; wallet?: WalletAdapter; embedded?: boolean; start?: boolean } = {}) {
  const server = setupServer()
  const s = await server.ramp.sessions.create({ userId: 'u', country: opts.country ?? 'US', destination: opts.destination ?? BASE_DEST })
  const events: string[] = []
  const c = createDepositController({
    baseUrl: BASE,
    clientSecret: s.clientSecret,
    fetch: server.fetch,
    onEvent: (e) => events.push(e.type),
    ...(opts.wallet ? { wallet: opts.wallet } : {}),
  })
  const el = document.createElement(TAG_NAME) as OpenRampModal
  mounted.push(el)
  el.open = true
  el.embedded = !!opts.embedded
  el.controller = c
  document.body.appendChild(el)
  if (opts.start !== false) await c.start()
  await settle(el)
  return { el, c, events, server, ...helpers(el) }
}

/** An element on a fake controller whose `select` returns the given step. */
async function mountStep(surface: Surface | undefined, transitions: Transition[] = [], extra: Partial<PublicSession['step']> = {}) {
  const client = fakeClient({ select: vi.fn(async () => session(step({ state: 'PAYMENT', transitions, ...(surface ? { surface } : {}), ...extra }))) })
  const c = new DepositController({ client, clientSecret: 'ors_1.sig' })
  const el = document.createElement(TAG_NAME) as OpenRampModal
  mounted.push(el)
  el.open = true
  el.controller = c
  document.body.appendChild(el)
  await c.start()
  await c.selectMethod('card')
  c.setAmount('100')
  await c.submitAmount()
  await c.confirm()
  await settle(el)
  return { el, c, client, ...helpers(el) }
}

describe('registration', () => {
  it('defines the element once', () => {
    defineOpenRampModal()
    defineOpenRampModal()
    expect(customElements.get(TAG_NAME)).toBe(OpenRampModal)
  })

  it('renders nothing while closed and not embedded', async () => {
    const el = document.createElement(TAG_NAME) as OpenRampModal
    mounted.push(el)
    document.body.appendChild(el)
    await settle(el)
    expect(el.shadowRoot!.querySelector('.card')).toBeNull()
  })

  it('shows loading without a controller, and the error when one is set', async () => {
    const el = document.createElement(TAG_NAME) as OpenRampModal
    mounted.push(el)
    el.open = true
    document.body.appendChild(el)
    await settle(el)
    const h = helpers(el)
    expect(h.$('.skeleton')).not.toBeNull()
    expect(h.$('.card')!.getAttribute('aria-busy')).toBe('true')
    expect(h.$('[aria-live]')!.textContent).toBe('Loading')
    el.error = orkError('UNAUTHORIZED')
    await settle(el)
    expect(h.text()).toContain('Something went wrong')
    expect(h.text()).toContain('This session is not valid.')
    // No controller: no "Try again", only Close
    expect(() => h.button('Try again')).toThrow()
    await h.click(h.button('Close'))
    expect(el.open).toBe(false)
  })
})

describe('methods screen', () => {
  it('shows tabs, groups and rows; switches tabs by click and arrow keys', async () => {
    const h = await mount({ wallet: createMockWallet() })
    expect(h.title()).toBe('Deposit')
    const tabs = h.$$('.tab')
    expect(tabs.map((t) => t.textContent?.trim())).toEqual(['Use Crypto', 'Use Cash'])
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true')
    expect(h.$$('.group-label').map((g) => g.textContent)).toEqual(['Connected', 'Other options'])
    expect(h.$$('[data-method]').map((b) => b.dataset.method)).toEqual(['wallet', 'transfer'])
    // Wallet row shows the short address, providers and an ETA
    const wallet = h.$('[data-method="wallet"]')!
    expect(wallet.textContent).toContain('0x1111...1111')
    expect(wallet.textContent).toContain('via Test provider')
    expect(wallet.querySelector('.row-end')?.textContent).toBe('Instant')

    await h.click(tabs[1]!)
    expect(h.c.getSnapshot().tab).toBe('cash')
    expect(h.$$('[data-method]').map((b) => b.dataset.method)).toEqual(['apple_pay', 'card', 'google_pay'])
    expect(h.$('#ork-methods')!.getAttribute('aria-labelledby')).toBe('ork-tab-cash')

    await h.key(h.$('.tablist, .tabs')!, 'ArrowLeft')
    expect(h.c.getSnapshot().tab).toBe('crypto')
    await h.key(h.$('.tabs')!, 'ArrowRight')
    expect(h.c.getSnapshot().tab).toBe('cash')
    // Other keys do nothing
    await h.key(h.$('.tabs')!, 'a')
    expect(h.c.getSnapshot().tab).toBe('cash')
    expect(h.events[0]).toBe('modal.opened')
  })

  it('unavailable rows are disabled and show the reason', async () => {
    const h = await mount({ country: 'VN' })
    const wallet = h.$<HTMLButtonElement>('[data-method="wallet"]')!
    expect(wallet.disabled).toBe(true)
    expect(wallet.querySelector('.row-sub.reason')?.textContent).toBe('Connect a wallet to use this method.')
    expect(wallet.querySelector('.row-end')).toBeNull()
    expect(h.$$('.group-label').map((g) => g.textContent)).toContain('Not available')
  })

  it('merchant destination: no tabs, cash methods only', async () => {
    const h = await mount({ country: 'ID', destination: { type: 'merchant', currency: 'IDR' } })
    expect(h.$('.tabs')).toBeNull()
    expect(h.$('#ork-methods')!.getAttribute('role')).toBeNull()
    expect(h.$$('[data-method]').map((b) => b.dataset.method)).toEqual(['qris', 'card'])
  })

  it('shows a notice when there are no methods', async () => {
    const client = fakeClient({ plan: vi.fn(async () => ({ pathways: [], methods: [], currency: 'USD' })) })
    const c = new DepositController({ client, clientSecret: 'ors_1.sig' })
    const el = document.createElement(TAG_NAME) as OpenRampModal
    mounted.push(el)
    el.open = true
    el.controller = c
    document.body.appendChild(el)
    await c.start()
    await settle(el)
    expect(helpers(el).text()).toContain('No payment methods are available for this deposit.')
  })

  it('shows the logo on the first screen', async () => {
    const h = await mount()
    h.el.appearance = { logoUrl: 'https://x.test/logo.png', merchantName: 'Acme', title: 'Top up', hideFooter: true }
    await settle(h.el)
    expect(h.$<HTMLImageElement>('img.logo')!.getAttribute('src')).toBe('https://x.test/logo.png')
    expect(h.$('img.logo')!.getAttribute('alt')).toBe('Acme')
    expect(h.title()).toBe('Top up')
    expect(h.$('.footer')).toBeNull()
  })
})

describe('amount and quotes', () => {
  it('amount screen: chips, input, validation, back', async () => {
    const h = await mount({ country: 'VN' })
    await h.cashTab()
    await h.click(h.$('[data-method="vietqr"]')!)
    expect(h.title()).toBe('VietQR')
    const btn = h.button('Enter an amount') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    const chips = h.$$('.chip')
    expect(chips.map((c) => c.textContent?.trim())).toEqual(['₫200,000', '₫500,000', '₫1,000,000', '₫2,000,000'])
    expect(h.$('.amount-prefix')!.textContent).toBe('₫')
    await h.click(chips[1]!)
    expect(h.c.getSnapshot().amount).toBe('500000')
    expect(h.$$('.chip')[1]!.getAttribute('aria-pressed')).toBe('true')
    expect(h.$<HTMLInputElement>('.amount-input')!.value).toBe('500000')

    const input = h.$<HTMLInputElement>('.amount-input')!
    input.value = '1,234,567'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle(h.el)
    expect(h.c.getSnapshot().amount).toBe('1234567')
    expect((h.button('Continue') as HTMLButtonElement).disabled).toBe(false)

    await h.click(h.$('.icon-btn[aria-label="Back"]')!)
    expect(h.c.getSnapshot().screen).toBe('methods')
  })

  it('Enter submits a valid amount, then quotes can be picked with click and arrows', async () => {
    const h = await mount({ country: 'SG' })
    await h.cashTab()
    await h.click(h.$('[data-method="card"]')!)
    const input = h.$<HTMLInputElement>('.amount-input')!
    await h.key(input, 'Enter')
    expect(h.c.getSnapshot().screen).toBe('amount')
    h.c.setAmount('100')
    await settle(h.el)
    await h.key(h.$('.amount-input')!, 'Enter')
    await h.until(() => h.c.getSnapshot().screen === 'quotes' && !h.c.getSnapshot().quotesLoading)
    expect(h.title()).toBe('Choose a quote')
    const rows = h.$$('[data-quote]')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]!.getAttribute('aria-checked')).toBe('true')
    expect(rows[0]!.textContent).toContain('You pay')
    expect(rows[0]!.textContent).toContain('Fees')
    expect((h.button('Confirm') as HTMLButtonElement).disabled).toBe(false)
    await h.key(h.$('[role="radiogroup"]')!, 'ArrowDown')
    await h.key(h.$('[role="radiogroup"]')!, 'ArrowUp')
    await h.key(h.$('[role="radiogroup"]')!, 'x')
    expect(h.c.getSnapshot().selectedQuoteId).toBe(rows[0]!.dataset.quote)
    await h.click(h.$('.icon-btn[aria-label="Back"]')!)
    expect(h.c.getSnapshot().screen).toBe('amount')
  })

  it('quote list with several quotes, badges, selection and partial errors', async () => {
    const q = (id: string, badges: Array<'best_price' | 'fastest'>) => quote({ id, provider: id, badges })
    const client = fakeClient({
      quotes: vi.fn(async () => ({ quotes: [q('alpha', ['best_price']), q('beta', ['fastest'])], errors: [orkError('PROVIDER_UNAVAILABLE'), orkError('PROVIDER_UNAVAILABLE')] })),
    })
    const c = new DepositController({ client, clientSecret: 'ors_1.sig' })
    const el = document.createElement(TAG_NAME) as OpenRampModal
    mounted.push(el)
    el.open = true
    el.controller = c
    document.body.appendChild(el)
    await c.start()
    await c.selectMethod('card')
    c.setAmount('100')
    await c.submitAmount()
    await settle(el)
    const h = helpers(el)
    expect(h.$('.badge.success')!.textContent).toBe('Best price')
    expect(h.$$('.badge').map((b) => b.textContent)).toEqual(['Best price', 'Fastest'])
    // Errors are de-duplicated
    expect(h.$('.hint[style]')!.textContent).toBe('The provider is not available right now.')
    await h.click(h.$('[data-quote="beta"]')!)
    expect(c.getSnapshot().selectedQuoteId).toBe('beta')
    expect(h.$('[data-quote="alpha"]')!.getAttribute('tabindex')).toBe('-1')
    await h.key(h.$('[role="radiogroup"]')!, 'ArrowDown')
    expect(c.getSnapshot().selectedQuoteId).toBe('alpha')
    await h.click(h.button('Confirm'))
    expect(client.select).toHaveBeenCalledWith('ors_1.sig', { quoteId: 'alpha' })
  })

  it('no quotes: notice, errors and Refresh', async () => {
    const client = fakeClient({ quotes: vi.fn(async () => ({ quotes: [], errors: [orkError('AMOUNT_TOO_LOW')] })) })
    const c = new DepositController({ client, clientSecret: 'ors_1.sig' })
    const el = document.createElement(TAG_NAME) as OpenRampModal
    mounted.push(el)
    el.open = true
    el.controller = c
    document.body.appendChild(el)
    await c.start()
    await c.selectMethod('card')
    c.setAmount('1')
    await c.submitAmount()
    await settle(el)
    const h = helpers(el)
    expect(h.text()).toContain('No quotes are available for this amount.')
    expect(h.text()).toContain('The amount is below the minimum for this method.')
    expect(() => h.button('Confirm')).toThrow()
    await h.click(h.button('Refresh'))
    expect(client.quotes).toHaveBeenCalledTimes(2)
  })

  it('shows the loading state while quotes load', async () => {
    let release!: () => void
    const client = fakeClient({ quotes: vi.fn(() => new Promise((r) => (release = () => r({ quotes: [quote({ id: 'a' })], errors: [] })))) as never })
    const c = new DepositController({ client, clientSecret: 'ors_1.sig' })
    const el = document.createElement(TAG_NAME) as OpenRampModal
    mounted.push(el)
    el.open = true
    el.controller = c
    document.body.appendChild(el)
    await c.start()
    await c.selectMethod('card')
    c.setAmount('1')
    void c.submitAmount()
    await settle(el)
    const h = helpers(el)
    expect(h.text()).toContain('Getting quotes')
    expect(h.$('[aria-live]')!.textContent).toBe('Getting quotes')
    release()
    await settle(el)
    expect(h.$('[data-quote="a"]')).not.toBeNull()
  })
})

describe('payment steps (real server)', () => {
  it('QR step: amount, code, reference, countdown, Simulate payment, then success', async () => {
    const h = await mount({ country: 'VN', destination: { type: 'merchant', currency: 'VND' } })
    await h.click(h.$('[data-method="vietqr"]')!)
    h.c.setAmount('200000')
    await settle(h.el)
    await h.click(h.button('Continue'))
    await h.until(() => !h.c.getSnapshot().quotesLoading)
    await h.click(h.button('Confirm'))
    await h.until(() => h.c.getSnapshot().screen === 'step')
    expect(h.title()).toBe('Complete payment')
    expect(h.$('.big-amount')!.textContent).toBe('₫200,000')
    const path = h.$('.qr path')!.getAttribute('d')!
    expect(path).toMatch(/^M0 0h7v1h-7z/)
    expect(h.$('[role="timer"]')!.textContent).toMatch(/^Expires in 1[45]:\d\d$/)
    expect(h.$('.kv-label')!.textContent).toBe('Reference')

    // Copy the reference
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await h.click(h.$('.copy-btn')!)
    expect(writeText).toHaveBeenCalledWith(h.c.getSnapshot().session!.step.surface!.kind === 'QR' ? (h.c.getSnapshot().session!.step.surface as { reference: string }).reference : '')
    expect(h.$('.copy-btn')!.textContent?.trim()).toBe('Copied')

    // Overlay click does not close during a payment step
    await h.click(h.$('.overlay')!)
    expect(h.el.open).toBe(true)

    expect(h.text()).toContain('Checking status')
    await h.click(h.button('Simulate payment'))
    await h.until(() => h.c.getSnapshot().screen === 'result')
    expect(h.$('.result-title')!.textContent).toBe('Deposit complete')
    expect(h.text()).toContain('You get about ₫198,600')
    const closed = vi.fn()
    h.el.addEventListener('openramp-close', closed)
    await h.click(h.button('Done'))
    expect(closed).toHaveBeenCalledOnce()
    expect((closed.mock.calls[0]![0] as CustomEvent).detail.session.step.state).toBe('COMPLETED')
    expect(h.el.open).toBe(false)
    await expect(h.c.done).resolves.toBeDefined()
  })

  it('Choose another method on a payment step restarts', async () => {
    const h = await mount({ country: 'VN', destination: { type: 'merchant', currency: 'VND' } })
    await h.click(h.$('[data-method="vietqr"]')!)
    h.c.setAmount('200000')
    await settle(h.el)
    await h.click(h.button('Continue'))
    await h.until(() => !h.c.getSnapshot().quotesLoading)
    await h.click(h.button('Confirm'))
    await h.until(() => h.c.getSnapshot().screen === 'step')
    await h.click(h.button('Choose another method'))
    await h.until(() => h.c.getSnapshot().screen === 'methods')
    expect(h.$('[data-method="vietqr"]')).not.toBeNull()
  })

  // happy-dom limit: the transfer quotes screen has two sibling <select>s, which the happy-dom 18 parser
  // cannot handle (Lit reports "duplicate attribute bindings"). The element stays hidden on that screen;
  // view.test.ts covers the picker logic.
  it('DEPOSIT_ADDRESS step: address, network, token, warning, copy, simulate deposit', async () => {
    const h = await mount({ country: 'US' })
    h.el.open = false
    await settle(h.el)
    await h.c.selectMethod('transfer')
    h.c.setSource({ chain: 'eip155:10', token: USDC['eip155:10']!, symbol: 'USDC', decimals: 6 })
    await h.until(() => !h.c.getSnapshot().quotesLoading && (h.c.getSnapshot().quotes[0]?.input.asset as { chain?: string })?.chain === 'eip155:10')
    await h.c.confirm()
    h.el.open = true
    await settle(h.el)
    expect(h.text()).toContain('Send USDC on Optimism to this address')
    const address = (h.c.getSnapshot().session!.step.surface as { address: string }).address
    expect(h.$$('.kv-value').map((v) => v.textContent)).toEqual([address, 'Optimism', 'USDC'])
    expect(h.$$('.copy-btn')).toHaveLength(1) // network and token rows have no copy button
    expect(h.text()).toContain('Minimum deposit: 1 USDC')
    expect(h.$('.notice.warning')!.textContent).toContain('This is a test address.')
    expect(h.$('.qr svg')!.getAttribute('aria-label')).toBe('Address')

    // Clipboard failure falls back without throwing
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) }, configurable: true })
    await h.click(h.$('.copy-btn')!)
    expect(h.$('.copy-btn')!.getAttribute('aria-label')).toBe('Copied')

    await h.click(h.button('Simulate deposit'))
    await h.until(() => h.c.getSnapshot().screen === 'result')
    expect(h.$('.result-title')!.textContent).toBe('Deposit complete')
  })

  it('WALLET_TX step with createMockWallet: balance picker, chips, confirm in wallet, success', async () => {
    const wallet = createMockWallet({ delayMs: 5 })
    const h = await mount({ country: 'US', wallet })
    await h.click(h.$('[data-method="wallet"]')!)
    expect(h.$('.amount-suffix')!.textContent).toBe('USDC')
    expect(h.$$('.chip').map((c) => c.textContent?.trim())).toEqual(['25%', '50%', 'Max'])
    expect(h.text()).toContain('Balance: 250 USDC')
    const radios = h.$$('[role="radio"]')
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false'])
    await h.click(radios[1]!)
    expect(h.c.getSnapshot().source?.chain).toBe('eip155:8453')
    expect(h.text()).toContain('Balance: 40 USDC')
    await h.click(h.$$('.chip')[0]!)
    expect(h.c.getSnapshot().amount).toBe('10')
    await h.click(h.button('Continue'))
    await h.until(() => !h.c.getSnapshot().quotesLoading)
    await h.click(h.button('Confirm'))
    await h.until(() => h.c.getSnapshot().screen === 'step')
    expect(h.text()).toContain('Approve 1 transaction on Base.')
    await h.click(h.button('Confirm in wallet'))
    await h.until(() => wallet.sent.length === 1)
    await h.until(() => h.c.getSnapshot().screen === 'result')
    expect(h.text()).toContain('Deposit complete')
  })

  it('REDIRECT step: opens the provider in a new tab and waits', async () => {
    const open = vi.fn(() => ({ opener: {} }))
    vi.spyOn(window, 'open').mockImplementation(open as never)
    const h = await mount({ country: 'SG' })
    await h.cashTab()
    await h.click(h.$('[data-method="card"]')!)
    h.c.setAmount('100')
    await settle(h.el)
    await h.click(h.button('Continue'))
    await h.until(() => !h.c.getSnapshot().quotesLoading)
    await h.click(h.button('Confirm'))
    await h.until(() => h.c.getSnapshot().screen === 'step')
    expect(h.text()).toContain('You will finish this step on Test provider.')
    await h.click(h.button('Continue to Test provider'))
    expect(open).toHaveBeenCalledWith(expect.stringContaining(`${BASE}/start/`), '_blank')
    expect(h.text()).toContain('Waiting for Test provider. Keep this window open.')
    expect(h.button('Open again').className).toContain('secondary')
    expect(h.events).toContain('surface.opened')
  })
})

describe('other surfaces (fake client)', () => {
  it('REDIRECT with a completed transition shows Continue after opening', async () => {
    vi.spyOn(window, 'open').mockImplementation((() => null) as never)
    const h = await mountStep({ kind: 'REDIRECT', url: 'https://p.example/', popup: true }, [{ name: 'done', kind: 'SURFACE_RESULT', expects: 'completed' }])
    expect(() => h.button(/^\s*Continue\s*$/)).toThrow()
    // Provider name falls back to the selected quote
    await h.click(h.button('Continue to Test provider'))
    await h.click(h.button(/^\s*Continue\s*$/))
    expect(h.client.transition).toHaveBeenCalledWith('ors_1.sig', 'done', undefined)
  })

  it('IFRAME renders a sandboxed frame with the default height', async () => {
    const h = await mountStep({ kind: 'IFRAME', url: 'about:blank', origin: 'https://p.example', provider: 'Prov' })
    const f = h.$('iframe.provider')!
    expect(f.getAttribute('src')).toBe('about:blank')
    expect(f.getAttribute('title')).toBe('Prov checkout')
    expect(f.getAttribute('sandbox')).toContain('allow-scripts')
    expect(f.getAttribute('allow')).toBe('payment; camera; microphone; clipboard-write')
    expect(f.getAttribute('style')).toBe('height:560px')
  })

  it('IFRAME and PROVIDER_SDK never render a javascript: or data: URL', async () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>']) {
      const h = await mountStep({ kind: 'IFRAME', url, origin: 'https://p.example', provider: 'Prov' })
      expect(h.$('iframe')).toBeNull()
      expect(h.text()).toContain('Prov could not load.')
    }
    const open = vi.spyOn(window, 'open').mockImplementation((() => null) as never)
    const sdk = await mountStep({ kind: 'PROVIDER_SDK', provider: 'coinbase_pay', params: { redirectUrl: 'javascript:alert(1)' } })
    expect(sdk.text()).toContain('This step needs the Coinbase Pay SDK.')
    expect(open).not.toHaveBeenCalled()
  })

  it('PROVIDER_SDK shows that it is not supported', async () => {
    const h = await mountStep({ kind: 'PROVIDER_SDK', provider: 'coinbase_pay', params: {} })
    expect(h.text()).toContain('This step needs the Coinbase Pay SDK.')
  })

  it('BANK_FIELDS shows copy rows only where allowed', async () => {
    const h = await mountStep({ kind: 'BANK_FIELDS', fields: [{ label: 'IBAN', value: 'DE00', copy: true }, { label: 'Bank', value: 'Acme', copy: false }] })
    expect(h.$$('.kv-label').map((l) => l.textContent)).toEqual(['IBAN', 'Bank'])
    expect(h.$$('.copy-btn').map((b) => b.getAttribute('aria-label'))).toEqual(['Copy IBAN'])
  })

  it('DEEPLINK opens the app', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation((() => ({ opener: null })) as never)
    const h = await mountStep({ kind: 'DEEPLINK', url: 'gcash://pay', appName: 'GCash' })
    await h.click(h.button('Open GCash'))
    expect(open).toHaveBeenCalledWith('gcash://pay', '_blank')
  })

  it('OTP uses the first SUBMIT transition input id and submits the code', async () => {
    const h = await mountStep({ kind: 'OTP', channel: 'email', to: 'a@b.c' }, [
      { name: 'verify', kind: 'SUBMIT', label: 'Verify', inputs: [{ id: 'otp', label: 'x', type: 'text' }] },
      { name: 'resend', kind: 'SUBMIT', label: 'Resend code' },
    ])
    expect(h.text()).toContain('Enter the code we sent to a@b.c')
    // happy-dom limit: HTMLFormElement.nextSibling is always undefined, so Lit cannot remove a rendered <form>.
    // Keep the transition pending so the form stays on screen.
    h.client.transition.mockImplementation(() => new Promise(() => {}))
    const input = h.$<HTMLInputElement>('#ork-f-otp')!
    expect(input.getAttribute('autocomplete')).toBe('one-time-code')
    expect(input.getAttribute('inputmode')).toBe('numeric')
    input.value = '123456'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const form = h.$<HTMLFormElement>('form')!
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle(h.el)
    expect(h.client.transition).toHaveBeenCalledWith('ors_1.sig', 'verify', { otp: '123456' })
  })

  it('FORM renders text, number, select and checkbox fields; extra SUBMITs render as buttons or forms', async () => {
    const h = await mountStep(
      {
        kind: 'FORM',
        fields: [
          { id: 'email', label: 'Email', type: 'email', required: true },
          { id: 'age', label: 'Age', type: 'number' },
          { id: 'tel', label: 'Phone', type: 'tel' },
          { id: 'country', label: 'Country', type: 'select', options: [{ value: 'VN', label: 'Vietnam' }] },
          { id: 'tos', label: 'I agree', type: 'checkbox', required: true },
        ],
      },
      [
        { name: 'send', kind: 'SUBMIT', label: '' },
        { name: 'skip', kind: 'SUBMIT', label: 'Skip' },
        { name: 'extra', kind: 'SUBMIT', label: 'Extra', inputs: [{ id: 'note', label: 'Note', type: 'text' }] },
      ],
    )
    h.client.transition.mockImplementation(() => new Promise(() => {})) // see the OTP test
    expect(h.$('#ork-f-email')!.getAttribute('autocomplete')).toBe('email')
    expect(h.$('#ork-f-tel')!.getAttribute('autocomplete')).toBe('tel')
    expect(h.$('#ork-f-age')!.getAttribute('type')).toBe('text')
    expect(h.$('#ork-f-age')!.getAttribute('inputmode')).toBe('numeric')
    expect(h.$$('button[type="submit"]').map((b) => b.textContent?.trim())).toEqual(['Submit', 'Extra'])
    const set = (sel: string, prop: 'value' | 'checked', v: string | boolean, ev: string) => {
      const x = h.$<HTMLInputElement>(sel)!
      ;(x as unknown as Record<string, unknown>)[prop] = v
      x.dispatchEvent(new Event(ev, { bubbles: true }))
    }
    set('#ork-f-email', 'value', 'a@b.c', 'input')
    set('#ork-f-country', 'value', 'VN', 'change')
    set('#ork-f-tos', 'checked', true, 'change')
    h.$$<HTMLFormElement>('form')[0]!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle(h.el)
    expect(h.client.transition).toHaveBeenCalledWith('ors_1.sig', 'send', { email: 'a@b.c', country: 'VN', tos: true })
  })

  it('a step without a surface shows processing, progress and extra buttons', async () => {
    const h = await mountStep(undefined, [{ name: 'cancel', kind: 'SUBMIT', label: 'Cancel order' }], {
      sub: 'KYC_REVIEW',
      progress: {
        legs: [
          { adapterId: 'mock', legId: 'a', provider: 'Mock', status: 'succeeded', txHash: '0x1234567890abcdef1234567890abcdef' },
          { adapterId: 'relay_bridge', legId: 'b', status: 'processing' },
        ],
      },
      error: orkError('PAYMENT_FAILED'),
    })
    expect(h.text()).toContain('Kyc Review')
    expect(h.$$('.progress li')).toHaveLength(2)
    expect(h.$$('.leg-status').map((l) => l.textContent)).toEqual(['done', 'in progress'])
    expect(h.text()).toContain('0x1234...cdef')
    expect(h.text()).toContain('Relay Bridge')
    expect(h.$('.notice.error')!.textContent).toContain('The payment did not go through.')
    const cancel = h.button('Cancel order')
    expect(cancel.className).not.toContain('secondary')
    await h.click(cancel)
    expect(h.client.transition).toHaveBeenCalledWith('ors_1.sig', 'cancel', undefined)
  })

  it('a PROCESSING step without a surface uses the state title', async () => {
    const client = fakeClient({ select: vi.fn(async () => session(step({ state: 'PROCESSING' }))) })
    const c = new DepositController({ client, clientSecret: 'ors_1.sig' })
    const el = document.createElement(TAG_NAME) as OpenRampModal
    mounted.push(el)
    el.open = true
    el.controller = c
    document.body.appendChild(el)
    await c.start()
    await c.selectMethod('card')
    c.setAmount('1')
    await c.submitAmount()
    await c.confirm()
    await settle(el)
    expect(helpers(el).$('.secondary-text')!.textContent).toBe('Processing')
    expect(helpers(el).$('[aria-live]')!.textContent).toBe('Processing')
  })
})

describe('result and error screens', () => {
  async function mountResult(state: 'FAILED' | 'EXPIRED' | 'COMPLETED', err = orkError('PAYMENT_FAILED')) {
    const client = fakeClient({
      getSession: vi.fn(async () =>
        session(step({ state, ...(state === 'COMPLETED' ? {} : { error: err }), progress: { legs: [{ adapterId: 'a', legId: 'a', status: 'succeeded' }, { adapterId: 'b', legId: 'b', status: 'succeeded' }] } })),
      ),
    })
    client.transition.mockResolvedValue(session('SELECT_METHOD'))
    const c = new DepositController({ client, clientSecret: 'ors_1.sig' })
    const el = document.createElement(TAG_NAME) as OpenRampModal
    mounted.push(el)
    el.open = true
    el.controller = c
    document.body.appendChild(el)
    await c.start()
    await settle(el)
    return { c, client, el, ...helpers(el) }
  }

  it('FAILED: title, message, Try again restarts', async () => {
    const h = await mountResult('FAILED')
    expect(h.$('.result-title')!.textContent).toBe('Payment failed')
    expect(h.text()).toContain('The payment did not go through. You can try again.')
    await h.click(h.button('Try again'))
    expect(h.client.transition).toHaveBeenCalledWith('ors_1.sig', 'restart', undefined)
  })

  it('EXPIRED: no retry, only Close', async () => {
    const h = await mountResult('EXPIRED', orkError('SESSION_EXPIRED'))
    expect(h.$('.result-title')!.textContent).toBe('Session expired')
    expect(() => h.button('Try again')).toThrow()
    expect(h.button('Close').className).not.toContain('secondary')
  })

  it('COMPLETED without a quote shows the generic body and the progress of both legs', async () => {
    const h = await mountResult('COMPLETED')
    expect(h.text()).toContain('Your funds are on the way to your account.')
    expect(h.$$('.progress li')).toHaveLength(2)
  })

  it('error screen: Try again calls start()', async () => {
    const client = fakeClient({ getSession: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(session('SELECT_METHOD')) })
    const c = new DepositController({ client, clientSecret: 'ors_1.sig' })
    const el = document.createElement(TAG_NAME) as OpenRampModal
    mounted.push(el)
    el.open = true
    el.controller = c
    document.body.appendChild(el)
    await c.start()
    await settle(el)
    const h = helpers(el)
    expect(h.text()).toContain('offline')
    await h.click(h.button('Try again'))
    await h.until(() => c.getSnapshot().screen === 'methods')
    expect(h.$('[data-method]')).not.toBeNull()
  })
})

describe('keyboard, focus and closing', () => {
  it('Escape closes, dispatches openramp-close and closes the controller', async () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const h = await mount({ start: false })
    await h.c.start()
    await settle(h.el)
    const events: CustomEvent[] = []
    document.addEventListener('openramp-close', (e) => events.push(e as CustomEvent), { once: true })
    const e = await h.key(h.$('.card')!, 'Escape')
    expect(e.defaultPrevented).toBe(true)
    expect(events).toHaveLength(1)
    expect(h.el.open).toBe(false)
    expect(h.el.hasAttribute('open')).toBe(false)
    expect(h.$('.card')).toBeNull()
    await expect(h.c.done).rejects.toMatchObject({ message: 'Closed before completion.' })
    expect(h.events).toContain('modal.closed')
    // Focus returns to the element that opened it
    expect(document.activeElement).toBe(opener)
    // A second close() does not close the controller again
    h.el.close()
    expect(h.events.filter((x) => x === 'modal.closed')).toHaveLength(1)
    opener.remove()
  })

  it('focus moves to the title and Tab wraps inside the card', async () => {
    const h = await mount()
    const root = h.root
    expect(root.activeElement?.classList.contains('title')).toBe(true)
    const focusables = h.$$('button:not([disabled])')
    const first = focusables[0]!
    const last = focusables[focusables.length - 1]!
    last.focus()
    const e1 = await h.key(h.$('.card')!, 'Tab')
    expect(e1.defaultPrevented).toBe(true)
    expect(root.activeElement).toBe(first)
    first.focus()
    const e2 = await h.key(h.$('.card')!, 'Tab', { shiftKey: true })
    expect(e2.defaultPrevented).toBe(true)
    expect(root.activeElement).toBe(last)
    // In the middle, Tab is left to the browser
    focusables[1]!.focus()
    const e3 = await h.key(h.$('.card')!, 'Tab')
    expect(e3.defaultPrevented).toBe(false)
    // Other keys are ignored
    const e4 = await h.key(h.$('.card')!, 'a')
    expect(e4.defaultPrevented).toBe(false)
  })

  it('overlay click closes on the methods screen, but a click inside the card does not', async () => {
    const h = await mount()
    await h.click(h.$('.card')!)
    expect(h.el.open).toBe(true)
    await h.click(h.$('.overlay')!)
    expect(h.el.open).toBe(false)
  })

  it('the close button closes', async () => {
    const h = await mount()
    await h.click(h.$('.icon-btn[aria-label="Close"]')!)
    expect(h.el.open).toBe(false)
  })

  it('embedded: no overlay, region role, no close button, Escape ignored, no focus steal', async () => {
    const outside = document.createElement('input')
    document.body.appendChild(outside)
    outside.focus()
    const h = await mount({ embedded: true })
    expect(h.$('.overlay')).toBeNull()
    expect(h.$('.card')!.getAttribute('role')).toBe('region')
    expect(h.$('.card')!.hasAttribute('aria-modal')).toBe(false)
    expect(h.$('.icon-btn[aria-label="Close"]')).toBeNull()
    expect(h.root.activeElement).toBeNull()
    expect(document.activeElement).toBe(outside)
    const e = await h.key(h.$('.card')!, 'Escape')
    expect(e.defaultPrevented).toBe(false)
    expect(h.el.hasAttribute('embedded')).toBe(true)
    // After the user works inside, screen changes move focus to the title
    h.$('.card')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }))
    await h.cashTab()
    await h.click(h.$('[data-method="card"]')!)
    expect(h.root.activeElement?.classList.contains('title')).toBe(true)
    outside.remove()
  })

  it('embedded error screen has no Close button', async () => {
    const el = document.createElement(TAG_NAME) as OpenRampModal
    mounted.push(el)
    el.embedded = true
    el.error = orkError('INTERNAL')
    document.body.appendChild(el)
    await settle(el)
    expect(() => helpers(el).button('Close')).toThrow()
  })
})

describe('controller swaps, theme and messages', () => {
  it('follows a new controller and unsubscribes on disconnect', async () => {
    const a = await mount()
    const other = new DepositController({ client: fakeClient({ getSession: vi.fn(async () => session('COMPLETED')) }), clientSecret: 'ors_1.sig' })
    a.el.controller = other
    await other.start()
    await settle(a.el)
    expect(a.text()).toContain('Deposit complete')
    a.el.remove()
    // Updates after disconnect do not throw
    other.setTab('cash')
    document.body.appendChild(a.el)
    await settle(a.el)
    expect(a.$('.result-title')).not.toBeNull()
  })

  it('applies theme variables and data-mode; auto follows the system setting', async () => {
    let listener: ((e: { matches: boolean }) => void) | undefined
    const mql = { matches: true, addEventListener: (_: string, fn: typeof listener) => (listener = fn), removeEventListener: vi.fn() }
    vi.spyOn(window, 'matchMedia').mockImplementation((() => mql) as never)
    const h = await mount()
    expect(h.el.getAttribute('data-mode')).toBe('light')
    expect(h.el.style.getPropertyValue('--ork-color-background')).toBe(lightColors.background)
    h.el.theme = { mode: 'dark', accent: '#ff0000' }
    await settle(h.el)
    expect(h.el.getAttribute('data-mode')).toBe('dark')
    expect(h.el.style.getPropertyValue('--ork-color-accent')).toBe('#ff0000')
    h.el.theme = { mode: 'auto' }
    await settle(h.el)
    expect(h.el.getAttribute('data-mode')).toBe('dark')
    expect(h.el.style.getPropertyValue('--ork-color-background')).toBe(darkColors.background)
    listener!({ matches: false })
    await settle(h.el)
    expect(h.el.getAttribute('data-mode')).toBe('light')
    h.el.remove()
    expect(mql.removeEventListener).toHaveBeenCalled()
  })

  it('uses partial messages for translations', async () => {
    const h = await mount()
    h.el.messages = { title: 'Nạp tiền', tabCrypto: 'Tiền mã hoá' }
    await settle(h.el)
    expect(h.title()).toBe('Nạp tiền')
    expect(h.$('.tab')!.textContent?.trim()).toBe('Tiền mã hoá')
    expect(h.$('.footer')!.textContent).toBe('Powered by OpenRampKit')
  })

  it('shows the controller error notice on the methods screen', async () => {
    const h = await mount()
    await h.c.selectMethod('card')
    await h.c.submitAmount() // validation error
    h.c.back()
    await settle(h.el)
    expect(h.$('.notice.error')).toBeNull()
    await h.c.selectMethod('card')
    await h.c.submitAmount()
    await settle(h.el)
    expect(h.$('.notice.error')!.textContent).toContain('Enter an amount.')
    expect(h.$('[aria-live]')!.textContent).toBe('Enter an amount.')
  })
})

describe('provider iframe messages', () => {
  const ORIGIN = 'https://p.example'
  const iframe = (extra: Partial<Extract<Surface, { kind: 'IFRAME' }>> = {}): Surface => ({
    kind: 'IFRAME',
    url: 'about:blank',
    origin: ORIGIN,
    provider: 'Prov',
    messages: { completed: ['ORDER_DONE'], failed: ['ORDER_FAILED'], closed: ['CLOSED'] },
    ...extra,
  })

  /** An element on an IFRAME step. `step()` returns the same PAYMENT step unless `stepFn` says otherwise. */
  async function mountIframe(surface: Surface, stepFn?: ReturnType<typeof vi.fn>) {
    const pay = session(step({ state: 'PAYMENT', surface }))
    const client = fakeClient({ select: vi.fn(async () => pay), step: stepFn ?? vi.fn(async () => pay) })
    const events: string[] = []
    const c = new DepositController({ client, clientSecret: 'ors_1.sig', onEvent: (e) => events.push(e.type) })
    const el = document.createElement(TAG_NAME) as OpenRampModal
    mounted.push(el)
    el.open = true
    el.controller = c
    document.body.appendChild(el)
    await c.start()
    await c.selectMethod('card')
    c.setAmount('100')
    await c.submitAmount()
    await c.confirm()
    await settle(el)
    const h = helpers(el)
    const frame = () => h.$<HTMLIFrameElement>('iframe.provider')
    const post = async (data: unknown, init: { origin?: string; source?: MessageEventSource | null } = {}) => {
      const source = 'source' in init ? init.source : frame()!.contentWindow
      window.dispatchEvent(new MessageEvent('message', { data, origin: init.origin ?? ORIGIN, source }))
      await settle(el)
    }
    return { el, c, client, events, frame, post, ...h }
  }

  it('ignores a wrong origin, a wrong source window and unknown types', async () => {
    const h = await mountIframe(iframe())
    await h.post({ type: 'ORDER_DONE' }, { origin: 'https://evil.example' })
    await h.post({ type: 'ORDER_DONE' }, { origin: 'https://p.example:8443' })
    await h.post({ type: 'ORDER_DONE' }, { origin: 'http://p.example' })
    await h.post({ type: 'ORDER_DONE' }, { source: window })
    await h.post({ type: 'ORDER_DONE' }, { source: null })
    const other = document.createElement('iframe')
    document.body.appendChild(other)
    await h.post({ type: 'ORDER_DONE' }, { source: other.contentWindow })
    other.remove()
    await h.post({ type: 'SOMETHING_ELSE' })
    await h.post('not json')
    await h.post('{broken')
    await h.post(null)
    expect(h.client.step).not.toHaveBeenCalled()
    expect(h.events).not.toContain('surface.message')
  })

  it('a completed message polls the step at once; the server status sets the result', async () => {
    const stepFn = vi.fn(async () => session(step({ state: 'COMPLETED' })))
    const h = await mountIframe(iframe(), stepFn)
    await h.post({ type: 'ORDER_DONE', data: { orderId: 'o1' } })
    await h.until(() => h.$('.result-icon.success') !== null)
    expect(stepFn).toHaveBeenCalledTimes(1)
    expect(h.events).toContain('surface.message')
    expect(h.text()).toContain('Deposit complete')
  })

  it('a completed message does not complete the deposit when the server still says PAYMENT', async () => {
    const h = await mountIframe(iframe())
    await h.post({ type: 'ORDER_DONE' })
    await h.until(() => h.client.step.mock.calls.length === 1)
    expect(h.c.getSnapshot().screen).toBe('step')
    expect(h.frame()).not.toBeNull()
  })

  it('uses messages.origin, a custom typeField and JSON string payloads', async () => {
    const h = await mountIframe(iframe({ messages: { origin: 'https://widget.p.example/', typeField: 'event', failed: ['x.failed'] } }))
    await h.post({ event: 'x.failed' }) // surface.origin is not allowed any more
    expect(h.client.step).not.toHaveBeenCalled()
    await h.post(JSON.stringify({ event: 'x.failed' }), { origin: 'https://widget.p.example' })
    await h.until(() => h.client.step.mock.calls.length === 1)
  })

  it('accepts the generic openramp-embed protocol from the allowed origin', async () => {
    const h = await mountIframe(iframe({ messages: undefined }))
    await h.post({ source: 'openramp-embed', type: 'payment.completed' }, { origin: 'https://evil.example' })
    await h.post({ source: 'other', type: 'payment.completed' })
    expect(h.client.step).not.toHaveBeenCalled()
    await h.post({ source: 'openramp-embed', type: 'payment.failed' })
    await h.until(() => h.client.step.mock.calls.length === 1)
    await h.post({ source: 'openramp-embed', type: 'closed' })
    expect(h.text()).toContain('Payment window closed')
  })

  it('closed shows a notice with Try again and Choose another method, and stops listening', async () => {
    const h = await mountIframe(iframe())
    await h.post({ type: 'CLOSED' })
    expect(h.frame()).toBeNull()
    expect(h.text()).toContain('Payment window closed')
    expect(h.text()).toContain('Open it again to finish paying, or choose another method.')
    expect(h.$$('button').filter((b) => b.textContent?.includes('Choose another method'))).toHaveLength(1)
    await h.until(() => h.client.step.mock.calls.length === 1)
    // While the notice shows there is no frame, so messages are not read.
    await h.post({ type: 'ORDER_DONE' }, { source: window })
    expect(h.client.step).toHaveBeenCalledTimes(1)
    // Try again brings back a new frame and listens again.
    await h.click(h.button('Try again'))
    expect(h.frame()).not.toBeNull()
    await h.post({ type: 'ORDER_DONE' })
    await h.until(() => h.client.step.mock.calls.length === 2)
    await h.post({ type: 'CLOSED' })
    await h.click(h.button('Choose another method'))
    expect(h.client.transition).toHaveBeenCalledWith('ors_1.sig', 'restart', undefined)
  })

  it('adds the window listener only while the frame shows, and removes it on disconnect', async () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const h = await mountIframe(iframe())
    expect(add.mock.calls.filter(([t]) => t === 'message')).toHaveLength(1)
    h.el.remove()
    expect(remove.mock.calls.filter(([t]) => t === 'message')).toHaveLength(1)
  })

  it('a non-IFRAME step does not listen', async () => {
    const add = vi.spyOn(window, 'addEventListener')
    await mountStep({ kind: 'BANK_FIELDS', fields: [] })
    expect(add.mock.calls.filter(([t]) => t === 'message')).toHaveLength(0)
  })
})

describe('locale', () => {
  const VN_DEST: Destination = { type: 'merchant', currency: 'VND' }

  it('renders Vietnamese tab labels, title and amounts with locale "vi"', async () => {
    const h = await mount({ start: false })
    h.el.locale = 'vi'
    await h.c.start()
    await settle(h.el)
    expect(h.title()).toBe('Nạp tiền')
    expect(h.$$('.tab').map((t) => t.textContent?.trim())).toEqual(['Dùng tiền mã hóa', 'Dùng tiền mặt'])
    expect(h.$('.footer')!.textContent).toBe('Cung cấp bởi OpenRampKit')
  })

  it('formats VND amount chips for Vietnamese without decimals', async () => {
    const h = await mount({ country: 'VN', destination: VN_DEST })
    h.el.locale = 'vi-VN'
    await settle(h.el)
    await h.click(h.$('[data-method="vietqr"]')!)
    const chips = h.$$('.chip').map((c) => c.textContent?.trim().replace(/\s/g, ' '))
    expect(chips[0]).toBe('200.000 ₫')
    expect(h.button('Nhập số tiền')).toBeTruthy()
  })

  it('explicit messages override the locale catalog', async () => {
    const h = await mount()
    h.el.locale = 'th'
    h.el.messages = { title: 'เติมเงิน' }
    await settle(h.el)
    expect(h.title()).toBe('เติมเงิน')
    expect(h.$('.tab')!.textContent?.trim()).toBe('ใช้คริปโต')
  })

  it('uses the session locale from the server when no locale is set', async () => {
    const client = fakeClient({ getSession: vi.fn(async () => session('SELECT_METHOD', { locale: 'id-ID' })) })
    const c = new DepositController({ client, clientSecret: 'ors_1.sig' })
    const el = document.createElement(TAG_NAME) as OpenRampModal
    mounted.push(el)
    el.open = true
    el.controller = c
    document.body.appendChild(el)
    await c.start()
    await settle(el)
    const h = helpers(el)
    expect(h.title()).toBe('Isi saldo')
    expect(h.$$('.tab').map((t) => t.textContent?.trim())).toEqual(['Pakai kripto', 'Pakai uang tunai'])
    // The explicit property wins over the session locale
    el.locale = 'fil'
    await settle(el)
    expect(h.title()).toBe('Mag-deposit')
  })
})
