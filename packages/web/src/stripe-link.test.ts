// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Step } from '@openrampkit/core'
import { STRIPE_LINK_CLIENT_KEY, STRIPE_LINK_TRANSITIONS } from '../../adapters/stripe-link/src/index.js'
import { STRIPE_LINK_TRANSITION_NAMES, makeClientKey, stripeLinkRenderer, toE164 } from './stripe-link.js'
import type { StripeLinkOnramp } from './stripe-link.js'
import type { ProviderRendererContext, ProviderSdkSurface } from './provider-sdk.js'

const PK = 'pk_test_1'
const KEY = /^[A-Za-z0-9_-]{43}$/

function surface(step: string, params: Record<string, unknown> = {}): ProviderSdkSurface {
  return { kind: 'PROVIDER_SDK', provider: 'stripe-link', params: { publishableKey: PK, step, ...params } }
}
function sdkStep(step: string, params: Record<string, unknown> = {}): Step {
  return { sessionId: 'ors_1', state: 'PAYMENT', transitions: [], surface: surface(step, params) }
}
const PROCESSING: Step = { sessionId: 'ors_1', state: 'PROCESSING', transitions: [] }

/** A fake Stripe SDK: each method records its call; callbacks are kept for the test to fire. */
function fakeOnramp() {
  const cb: { auth?: (r: Parameters<Parameters<StripeLinkOnramp['authenticate']>[1]>[0]) => void; pm?: (r: { cryptoPaymentToken: string; paymentMethodDetails?: unknown }) => void } = {}
  const authEl = document.createElement('div')
  authEl.className = 'stripe-auth'
  const pmEl = document.createElement('div')
  pmEl.className = 'stripe-pe'
  const o = {
    registerLinkUser: vi.fn(async () => ({ created: true })),
    authenticate: vi.fn(async (_id: string, f: NonNullable<typeof cb.auth>) => ((cb.auth = f), authEl as HTMLElement | null)),
    submitKycInfo: vi.fn(async () => {}),
    verifyDocuments: vi.fn(async () => ({ result: 'success' as 'success' | 'abandoned' })),
    registerWalletAddress: vi.fn(async () => ({})),
    collectPaymentMethod: vi.fn(async (_o: unknown, f: NonNullable<typeof cb.pm>) => ((cb.pm = f), pmEl)),
    performCheckout: vi.fn(async (id: string, checkout: (id: string) => Promise<string>) => {
      await checkout(id)
      return { successful: true }
    }),
  }
  return { o, cb, authEl, pmEl }
}

function setup(over: { load?: ReturnType<typeof vi.fn> } & Parameters<typeof stripeLinkRenderer>[0] = {}) {
  const sdk = fakeOnramp()
  const load = over.load ?? vi.fn(async () => sdk.o as unknown as StripeLinkOnramp)
  const renderer = stripeLinkRenderer({ ...over, load })
  const submit = vi.fn<ProviderRendererContext['submit']>(async () => PROCESSING)
  const completed = vi.fn()
  const failed = vi.fn()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const mount = async (s: ProviderSdkSurface, mode: 'light' | 'dark' = 'light') => {
    const cleanup = await renderer(container, { surface: s, mode, completed, failed, submit })
    await flush()
    return cleanup as () => void
  }
  return { sdk, load, renderer, submit, completed, failed, container, mount }
}

const flush = () => new Promise((r) => setTimeout(r, 0))
const input = (c: HTMLElement, name: string) => c.querySelector<HTMLInputElement>(`input[name="${name}"]`)!
function type(c: HTMLElement, name: string, value: string) {
  input(c, name).value = value
}
const submitForm = (c: HTMLElement) => c.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
const click = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('button')!.click()

afterEach(() => {
  document.body.innerHTML = ''
})

describe('stripeLinkRenderer', () => {
  it('uses the adapter transition names and client key input', () => {
    const { email: _email, ...rest } = STRIPE_LINK_TRANSITIONS
    expect(STRIPE_LINK_TRANSITION_NAMES).toEqual(rest)
    expect(STRIPE_LINK_CLIENT_KEY).toBe('clientKey')
  })

  it('register_link_user: checks the phone, registers with Stripe, then calls link_registered', async () => {
    const t = setup()
    await t.mount(surface('register_link_user', { email: 'a@b.co', country: 'US' }))
    type(t.container, 'phone', '12')
    submitForm(t.container)
    expect(t.container.querySelector('.notice.error')!.textContent).toContain('country code')
    expect(t.sdk.o.registerLinkUser).not.toHaveBeenCalled()
    type(t.container, 'phone', '(212) 555-1234')
    type(t.container, 'name', 'Jane Doe')
    submitForm(t.container)
    // The form is emptied at once
    expect(input(t.container, 'phone').value).toBe('')
    await flush()
    expect(t.sdk.o.registerLinkUser).toHaveBeenCalledWith('a@b.co', '+12125551234', 'US', 'Jane Doe')
    expect(t.submit).toHaveBeenCalledWith('link_registered', { clientKey: expect.stringMatching(KEY) })
    // The phone number goes to Stripe only
    expect(JSON.stringify(t.submit.mock.calls)).not.toContain('5551234')
  })

  it('authenticate: mounts the Link UI; success sends the customer id and a new client key', async () => {
    const t = setup()
    await t.mount(surface('authenticate', { linkAuthIntentId: 'lai_1' }), 'dark')
    expect(t.load).toHaveBeenCalledWith(PK, { theme: 'night' })
    expect(t.sdk.o.authenticate).toHaveBeenCalledWith('lai_1', expect.any(Function))
    expect(t.container.firstChild).toBe(t.sdk.authEl)
    t.sdk.cb.auth!({ result: 'success', crypto_customer_id: 'crc_1' })
    await flush()
    expect(t.submit).toHaveBeenCalledWith('link_authenticated', { cryptoCustomerId: 'crc_1', clientKey: expect.stringMatching(KEY) })
  })

  it('authenticate: abandoned and declined show a message with a retry; no element keeps the container', async () => {
    const t = setup()
    await t.mount(surface('authenticate', { linkAuthIntentId: 'lai_1' }))
    t.sdk.cb.auth!({ result: 'abandoned' })
    expect(t.container.querySelector('.notice.error')!.textContent).toContain('closed')
    click(t.container)
    await flush()
    expect(t.sdk.o.authenticate).toHaveBeenCalledTimes(2)
    t.sdk.cb.auth!({ result: 'declined' })
    expect(t.container.textContent).toContain('allow this app')
    expect(t.submit).not.toHaveBeenCalled()
    // When Stripe needs no sign-in UI it returns null and calls back at once
    t.sdk.o.authenticate.mockImplementationOnce(async (_id, f) => (f({ result: 'success', crypto_customer_id: 'crc_2' }), null))
    click(t.container)
    await flush()
    expect(t.submit).toHaveBeenCalledWith('link_authenticated', { cryptoCustomerId: 'crc_2', clientKey: expect.stringMatching(KEY) })
  })

  it('sends the same client key with every transition after the sign-in; a new sign-in makes a new key', async () => {
    const t = setup()
    t.submit.mockResolvedValue(PROCESSING)
    await t.mount(surface('authenticate', { linkAuthIntentId: 'lai_1' }))
    t.sdk.cb.auth!({ result: 'success', crypto_customer_id: 'crc_1' })
    await flush()
    const key = t.submit.mock.calls[0]![1]!.clientKey as string
    expect(key).toMatch(KEY)

    await t.mount(surface('submit_kyc_info'))
    for (const [n, v] of [['given', 'J'], ['surname', 'S'], ['ssn', '000-00-0000'], ['dob', '1990-01-02'], ['line1', '1 Main'], ['city', 'SF'], ['state', 'ca'], ['zip', '94111']]) type(t.container, n!, v!)
    submitForm(t.container)
    await flush()
    await t.mount(surface('verify_documents'))
    click(t.container)
    await flush()
    await t.mount(surface('register_wallet_address', { walletAddress: '0xabc', network: 'base' }))
    await t.mount(surface('collect_payment_method', { paymentMethodTypes: ['card'], wallets: { applePay: 'auto', googlePay: 'never' } }))
    t.sdk.cb.pm!({ cryptoPaymentToken: 'cpt_1' })
    await flush()
    t.submit.mockResolvedValueOnce(sdkStep('perform_checkout', { onrampSessionId: 'cos_1', clientSecret: 'cs_1' }))
    await t.mount(surface('perform_checkout', { onrampSessionId: 'cos_1' }))
    click(t.container)
    await flush()

    const calls = t.submit.mock.calls.map(([n, i]) => [n, i?.clientKey])
    expect(calls.map((c) => c[0])).toEqual(['link_authenticated', 'kyc_submitted', 'documents_verified', 'wallet_registered', 'payment_method_collected', 'checkout'])
    for (const c of calls) expect(c[1]).toBe(key)
    // One SDK instance for the whole purchase
    expect(t.load).toHaveBeenCalledTimes(1)

    await t.mount(surface('authenticate', { linkAuthIntentId: 'lai_2' }))
    t.sdk.cb.auth!({ result: 'success', crypto_customer_id: 'crc_1' })
    await flush()
    const key2 = t.submit.mock.calls.at(-1)![1]!.clientKey
    expect(key2).toMatch(KEY)
    expect(key2).not.toBe(key)
  })

  it('submit_kyc_info: the KYC data goes to Stripe only, and the form is emptied', async () => {
    const t = setup()
    await t.mount(surface('submit_kyc_info'))
    for (const [n, v] of [['given', 'John'], ['surname', 'Smith'], ['ssn', '123-45-6789'], ['dob', '1990-01-02'], ['line1', '123 Main St'], ['line2', 'Apt 4B'], ['city', 'San Francisco'], ['state', 'ca'], ['zip', '94111']]) type(t.container, n!, v!)
    submitForm(t.container)
    expect(input(t.container, 'ssn').value).toBe('')
    await flush()
    expect(t.sdk.o.submitKycInfo).toHaveBeenCalledWith({
      given_name: 'John',
      surname: 'Smith',
      id_number: { type: 'us_ssn', value: '123456789' },
      date_of_birth: { day: 2, month: 1, year: 1990 },
      address: { country: 'US', line1: '123 Main St', line2: 'Apt 4B', city: 'San Francisco', state: 'CA', postal_code: '94111' },
    })
    expect(t.submit).toHaveBeenCalledWith('kyc_submitted', { clientKey: expect.stringMatching(KEY) })
    expect(JSON.stringify(t.submit.mock.calls)).not.toMatch(/123456789|Smith|Main/)
  })

  it('submit_kyc_info: an app form can replace the default form', async () => {
    const collectKyc = vi.fn(async () => ({ given_name: 'A' }))
    const t = setup({ collectKyc })
    await t.mount(surface('submit_kyc_info'))
    expect(collectKyc).toHaveBeenCalledWith(t.container)
    expect(t.sdk.o.submitKycInfo).toHaveBeenCalledWith({ given_name: 'A' })
    expect(t.submit).toHaveBeenCalledWith('kyc_submitted', { clientKey: expect.stringMatching(KEY) })
  })

  it('submit_kyc_info: a Stripe error shows its message and the form again, and calls no transition', async () => {
    const t = setup()
    t.sdk.o.submitKycInfo.mockRejectedValueOnce(new Error('Invalid SSN'))
    await t.mount(surface('submit_kyc_info'))
    for (const n of ['given', 'surname', 'ssn', 'dob', 'line1', 'city', 'state', 'zip']) type(t.container, n, n === 'dob' ? '1990-01-02' : 'x')
    submitForm(t.container)
    await flush()
    expect(t.container.querySelector('.notice.error')!.textContent).toBe('Invalid SSN')
    expect(t.submit).not.toHaveBeenCalled()
    click(t.container)
    expect(t.container.querySelector('form')).not.toBeNull()
  })

  it('verify_documents: runs on a click; abandoned asks again; the same step again shows the button again', async () => {
    const t = setup()
    await t.mount(surface('verify_documents'))
    expect(t.sdk.o.verifyDocuments).not.toHaveBeenCalled()
    t.sdk.o.verifyDocuments.mockResolvedValueOnce({ result: 'abandoned' })
    click(t.container)
    await flush()
    expect(t.container.textContent).toContain('identity check was closed')
    expect(t.submit).not.toHaveBeenCalled()
    click(t.container) // try again: the button screen
    t.submit.mockResolvedValueOnce(sdkStep('verify_documents'))
    click(t.container)
    await flush()
    expect(t.submit).toHaveBeenCalledWith('documents_verified', { clientKey: expect.stringMatching(KEY) })
    expect(t.container.querySelector('button')!.textContent).toBe('Verify your identity')
  })

  it('register_wallet_address: registers the server address and network at once', async () => {
    const t = setup()
    await t.mount(surface('register_wallet_address', { walletAddress: '0xabc', network: 'base' }))
    expect(t.sdk.o.registerWalletAddress).toHaveBeenCalledWith('0xabc', 'base')
    expect(t.submit).toHaveBeenCalledWith('wallet_registered', { clientKey: expect.stringMatching(KEY) })
  })

  it('collect_payment_method: mounts the Payment Element and sends only the payment token', async () => {
    const t = setup()
    await t.mount(surface('collect_payment_method', { paymentMethodTypes: ['us_bank_account'], wallets: { applePay: 'never', googlePay: 'never' } }))
    expect(t.sdk.o.collectPaymentMethod).toHaveBeenCalledWith({ payment_method_types: ['us_bank_account'], wallets: { applePay: 'never', googlePay: 'never' } }, expect.any(Function))
    expect(t.container.firstChild).toBe(t.sdk.pmEl)
    t.sdk.cb.pm!({ cryptoPaymentToken: 'cpt_1', paymentMethodDetails: { type: 'us_bank_account', us_bank_account: { last4: '6789', bank_name: 'B' } } })
    await flush()
    expect(t.submit).toHaveBeenCalledWith('payment_method_collected', { paymentToken: 'cpt_1', clientKey: expect.stringMatching(KEY) })
    // The display details are not sent; a second callback calls no second transition
    expect(JSON.stringify(t.submit.mock.calls)).not.toContain('6789')
    t.sdk.cb.pm!({ cryptoPaymentToken: 'cpt_2' })
    await flush()
    expect(t.submit).toHaveBeenCalledTimes(1)
  })

  it('perform_checkout: each Stripe checkout call (again after 3DS) is a transition, and returns its client secret', async () => {
    const t = setup()
    const secrets: string[] = []
    t.sdk.o.performCheckout.mockImplementationOnce(async (id, checkout) => {
      secrets.push(await checkout(id)) // first attempt: 3DS needed
      secrets.push(await checkout(id)) // after 3DS
      return { successful: true }
    })
    t.submit
      .mockResolvedValueOnce(sdkStep('perform_checkout', { onrampSessionId: 'cos_1', clientSecret: 'cos_1_secret_a' }))
      .mockResolvedValueOnce(sdkStep('perform_checkout', { onrampSessionId: 'cos_1', clientSecret: 'cos_1_secret_b' }))
    await t.mount(surface('perform_checkout', { onrampSessionId: 'cos_1' }))
    expect(t.sdk.o.performCheckout).not.toHaveBeenCalled()
    click(t.container)
    await flush()
    expect(t.sdk.o.performCheckout).toHaveBeenCalledWith('cos_1', expect.any(Function))
    expect(secrets).toEqual(['cos_1_secret_a', 'cos_1_secret_b'])
    expect(t.submit).toHaveBeenCalledTimes(2)
    for (const [n, i] of t.submit.mock.calls) {
      expect(n).toBe('checkout')
      expect(i).toEqual({ clientKey: expect.stringMatching(KEY), userAgent: navigator.userAgent })
    }
    expect(t.completed).toHaveBeenCalledWith('checkout')
    // The client secret never goes into the DOM
    expect(t.container.innerHTML).not.toContain('secret')
  })

  it('perform_checkout: an unsuccessful checkout asks for a status check and offers a retry', async () => {
    const t = setup()
    t.submit.mockResolvedValue(sdkStep('perform_checkout', { onrampSessionId: 'cos_1', clientSecret: 'cs' }))
    t.sdk.o.performCheckout.mockResolvedValueOnce({ successful: false })
    await t.mount(surface('perform_checkout', { onrampSessionId: 'cos_1' }))
    click(t.container)
    await flush()
    expect(t.failed).toHaveBeenCalledWith('checkout')
    expect(t.container.textContent).toContain('did not finish')
    click(t.container)
    expect(t.container.querySelector('button')!.textContent).toBe('Pay')
  })

  it('perform_checkout: a server answer past the checkout (no client secret) ends in a status check', async () => {
    const t = setup()
    t.submit.mockResolvedValueOnce(PROCESSING)
    t.sdk.o.performCheckout.mockImplementationOnce(async (id, checkout) => {
      await checkout(id)
      return { successful: true }
    })
    await t.mount(surface('perform_checkout', { onrampSessionId: 'cos_1' }))
    click(t.container)
    await flush()
    expect(t.completed).toHaveBeenCalledWith('checkout')
    expect(t.container.querySelector('.notice.error')).toBeNull()
  })

  it('a refused transition shows a retry and keeps the key', async () => {
    const t = setup()
    await t.mount(surface('authenticate', { linkAuthIntentId: 'lai_1' }))
    t.submit.mockRejectedValueOnce({ code: 'BAD_REQUEST', message: 'refused' })
    t.sdk.cb.auth!({ result: 'success', crypto_customer_id: 'crc_1' })
    await flush()
    expect(t.container.querySelector('.notice.error')).not.toBeNull()
    // The server message is shown by the modal, not here
    expect(t.container.textContent).not.toContain('refused')
  })

  it('the same sub-step again with new params runs again (a new Link sign-in)', async () => {
    const t = setup()
    t.submit.mockResolvedValueOnce(sdkStep('authenticate', { linkAuthIntentId: 'lai_2' }))
    await t.mount(surface('authenticate', { linkAuthIntentId: 'lai_1' }))
    t.sdk.cb.auth!({ result: 'success', crypto_customer_id: 'crc_x' })
    await flush()
    expect(t.sdk.o.authenticate).toHaveBeenLastCalledWith('lai_2', expect.any(Function))
  })

  it('errors: no publishable key, an unknown step, and an SDK that does not load', async () => {
    const t = setup()
    await expect(t.renderer(t.container, { surface: { kind: 'PROVIDER_SDK', provider: 'stripe-link', params: { step: 'authenticate' } }, mode: 'light', completed: t.completed, failed: t.failed, submit: t.submit })).rejects.toThrow(/publishableKey/)
    await expect(t.mount(surface('nope'))).rejects.toThrow(/Unknown Stripe Link step/)
    const bad = setup({ load: vi.fn(async () => null) })
    await bad.mount(surface('register_wallet_address', { walletAddress: '0xabc', network: 'base' }))
    expect(bad.container.querySelector('.notice.error')!.textContent).toContain('did not load')
    expect(bad.submit).not.toHaveBeenCalled()
    // A failed load is not cached: the retry loads again
    bad.load.mockResolvedValueOnce(bad.sdk.o)
    click(bad.container)
    await flush()
    expect(bad.load).toHaveBeenCalledTimes(2)
    expect(bad.submit).toHaveBeenCalledWith('wallet_registered', { clientKey: expect.stringMatching(KEY) })
  })

  it('cleanup empties the container, and a late Stripe callback calls no transition', async () => {
    const t = setup()
    const cleanup = await t.mount(surface('authenticate', { linkAuthIntentId: 'lai_1' }))
    cleanup()
    expect(t.container.childNodes.length).toBe(0)
    t.sdk.cb.auth!({ result: 'success', crypto_customer_id: 'crc_1' })
    await flush()
    expect(t.submit).not.toHaveBeenCalled()
  })

  it('never logs and never stores the client key', async () => {
    const log = vi.spyOn(console, 'log')
    const warn = vi.spyOn(console, 'warn')
    const err = vi.spyOn(console, 'error')
    const t = setup()
    await t.mount(surface('register_wallet_address', { walletAddress: '0xabc', network: 'base' }))
    const key = t.submit.mock.calls[0]![1]!.clientKey as string
    expect(log).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(err).not.toHaveBeenCalled()
    expect(JSON.stringify({ ...localStorage })).not.toContain(key)
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(key)
    expect(document.documentElement.outerHTML).not.toContain(key)
  })
})

describe('helpers', () => {
  it('makeClientKey: 32 random bytes in base64url, different each time', () => {
    const a = makeClientKey()
    expect(a).toMatch(KEY)
    expect(makeClientKey()).not.toBe(a)
  })

  it('toE164', () => {
    expect(toE164('212 555 1234')).toBe('+12125551234')
    expect(toE164('1-212-555-1234')).toBe('+12125551234')
    expect(toE164('+44 20 7946 0958')).toBe('+442079460958')
    expect(toE164('555')).toBeUndefined()
    expect(toE164('+0123456789')).toBeUndefined()
  })
})
