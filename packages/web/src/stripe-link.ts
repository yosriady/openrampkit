// Renderer for the Stripe Link headless flow (`@openrampkit/adapter-stripe-link`), on Stripe's
// Embedded Components SDK (`@stripe/crypto`, `loadCryptoOnrampAndInitialize`).
//
// A separate entry (`@openrampkit/web/stripe-link`): the main entry never imports it, and the Stripe
// SDK is an optional peer dependency that loads with a dynamic import only when a step mounts.
//
// Security rules (see docs/adapters/stripe-link.md, Security):
// - The client key binds the Link sign-in to this page. It is random (crypto.getRandomValues), lives in
//   this closure only (never in storage, the DOM or a log), and goes only to our server, with every
//   transition. A new Link sign-in makes a new key.
// - KYC data and the phone number go from the form straight to the Stripe SDK. They never go to
//   `ctx.submit`, a log, or a callback detail, and the form is emptied after the call.
// - Card and bank data stay inside Stripe's Payment Element. Only the payment token (`cpt_...`) goes
//   to our server.

import type { Step } from '@openrampkit/core'
import type { ProviderRenderer, ProviderRendererContext } from './provider-sdk.js'

/** The parts of Stripe's `OnrampCoordinator` that the renderer uses (from `@stripe/crypto` 1.1.3 types). */
export type StripeLinkOnramp = {
  registerLinkUser(email: string, phone: string, country: string, fullName?: string): Promise<{ created: boolean }>
  authenticate(linkAuthIntentId: string, onCompletion: (r: { result: 'success' | 'abandoned' | 'declined'; crypto_customer_id?: string }) => void): Promise<HTMLElement | null | undefined>
  submitKycInfo(info: StripeLinkKycInfo): Promise<void>
  verifyDocuments(): Promise<{ result: 'success' | 'abandoned' }>
  registerWalletAddress(walletAddress: string, network: string): Promise<unknown>
  collectPaymentMethod(
    options: { payment_method_types: string[]; wallets: { applePay: string; googlePay: string } },
    onCompletion: (r: { cryptoPaymentToken: string }) => void,
  ): Promise<HTMLElement>
  performCheckout(onrampSessionId: string, checkout: (onrampSessionId: string) => Promise<string>): Promise<{ successful: boolean }>
}

/** Stripe's `KycInfo` (US fields) */
export type StripeLinkKycInfo = {
  given_name?: string
  surname?: string
  id_number?: { type: 'us_ssn'; value: string }
  date_of_birth?: { day: number; month: number; year: number }
  address?: { country: string; line1?: string; line2?: string; city?: string; state?: string; postal_code?: string }
}

/** Loads and creates the SDK. Default: `loadCryptoOnrampAndInitialize` from `@stripe/crypto`. */
export type StripeLinkLoader = (publishableKey: string, options: { theme: 'stripe' | 'night' | 'flat' } & Record<string, unknown>) => Promise<StripeLinkOnramp | null>

export type StripeLinkRendererOptions = {
  /** Replace the SDK loader (tests, or an app that loads `@stripe/crypto` itself) */
  load?: StripeLinkLoader
  /** Extra `CryptoOnrampInitOptions` (variables, rules, ...). Default theme: `night` in dark mode, else `stripe`. */
  appearance?: Record<string, unknown>
  /** Replace the default KYC form. Resolve with the data for `submitKycInfo`. It goes to Stripe only. */
  collectKyc?: (container: HTMLElement) => Promise<StripeLinkKycInfo>
  /** Replace the default Link sign-up form (phone in E.164 and full name). It goes to Stripe only. */
  collectRegistration?: (container: HTMLElement, defaults: { email: string; country: string }) => Promise<{ phone: string; fullName?: string }>
  /** Override the English UI text */
  text?: Partial<typeof TEXT>
}

/** The adapter's transition names (`STRIPE_LINK_TRANSITIONS`) */
export const STRIPE_LINK_TRANSITION_NAMES = {
  registered: 'link_registered',
  authenticated: 'link_authenticated',
  kyc: 'kyc_submitted',
  documents: 'documents_verified',
  wallet: 'wallet_registered',
  paymentMethod: 'payment_method_collected',
  checkout: 'checkout',
} as const

const TEXT = {
  signUpHint: 'Create a Link account to continue.',
  phone: 'Phone number',
  fullName: 'Full name',
  createAccount: 'Create account',
  badPhone: 'Enter a phone number with the country code, for example +12125551234.',
  signInAbandoned: 'The Link sign-in was closed.',
  signInDeclined: 'You must allow this app in Link to continue.',
  signIn: 'Sign in to Link',
  kycHint: 'Stripe needs these details to verify your identity. They go to Stripe only.',
  givenName: 'First name',
  surname: 'Last name',
  ssn: 'Social Security number',
  dob: 'Date of birth',
  line1: 'Address',
  line2: 'Apartment, suite (optional)',
  city: 'City',
  state: 'State (2 letters)',
  postalCode: 'ZIP code',
  submit: 'Continue',
  verifyHint: 'Stripe needs a photo of your ID and a selfie.',
  verify: 'Verify your identity',
  verifyAbandoned: 'The identity check was closed.',
  pay: 'Pay',
  payFailed: 'The payment did not finish. Try again or choose another method.',
  tryAgain: 'Try again',
  failed: 'Something went wrong with Stripe. Try again.',
}

/** A client key: 32 random bytes in base64url (43 characters). The adapter accepts 32 to 128 URL-safe characters. */
export function makeClientKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A phone number in E.164. A US number without a country code gets +1. */
export function toE164(raw: string): string | undefined {
  const digits = raw.replace(/[\s().-]/g, '')
  const p = /^\d{10}$/.test(digits) ? `+1${digits}` : /^1\d{10}$/.test(digits) ? `+${digits}` : digits
  return /^\+[1-9]\d{6,14}$/.test(p) ? p : undefined
}

/** Thrown inside the checkout callback when the server answers without a client secret (the purchase moved on). */
class CheckoutMovedOn extends Error {}

const defaultLoad: StripeLinkLoader = async (pk, options) => {
  const m = await import('@stripe/crypto')
  return (await m.loadCryptoOnrampAndInitialize(pk, options as Parameters<typeof m.loadCryptoOnrampAndInitialize>[1])) as unknown as StripeLinkOnramp | null
}

type El = HTMLElement
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string> = {}, ...kids: Array<Node | string>): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) e.setAttribute(k, v)
  e.append(...kids)
  return e
}

/**
 * Renderer for `provider: 'stripe-link'` PROVIDER_SDK steps. Use one renderer per modal: it keeps the
 * Stripe SDK instance and the client key across the steps of one purchase.
 *
 * ```ts
 * import { stripeLinkRenderer } from '@openrampkit/web/stripe-link'
 * openDeposit({ ..., providerRenderers: { 'stripe-link': stripeLinkRenderer() } })
 * ```
 */
export function stripeLinkRenderer(opts: StripeLinkRendererOptions = {}): ProviderRenderer {
  const load = opts.load ?? defaultLoad
  const t = { ...TEXT, ...opts.text }
  const T = STRIPE_LINK_TRANSITION_NAMES
  let onramp: Promise<StripeLinkOnramp> | undefined
  let onrampKey = ''
  // The client key: in memory only. A page reload loses it, and the adapter then asks for a new Link
  // sign-in (the Stripe SDK's sign-in is in memory too, so storage would not help).
  let clientKey: string | undefined

  function sdk(publishableKey: string, mode: 'light' | 'dark'): Promise<StripeLinkOnramp> {
    if (!onramp || onrampKey !== publishableKey) {
      onrampKey = publishableKey
      const p = load(publishableKey, { theme: mode === 'dark' ? 'night' : 'stripe', ...opts.appearance }).then((o) => {
        if (!o) throw new Error('The Stripe Link SDK did not load')
        return o
      })
      p.catch(() => {
        if (onramp === p) onramp = undefined
      })
      onramp = p
    }
    return onramp
  }

  // Async, so that a bad step rejects (the modal then shows an error) instead of throwing.
  return async (container, ctx) => {
    let alive = true
    const send = (name: string, inputs: Record<string, unknown> = {}): Promise<Step> => {
      clientKey ??= makeClientKey()
      return ctx.submit(name, { ...inputs, clientKey })
    }

    /** Show a message with a retry button. */
    const notice = (msg: string, retry?: () => void, kind = 'error') => {
      const box = el('div', { class: 'stack' }, el('div', { class: `notice ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, msg))
      if (retry) {
        const b = el('button', { class: 'btn', type: 'button' }, t.tryAgain)
        b.onclick = retry
        box.append(b)
      }
      if (alive) container.replaceChildren(box)
    }
    const sdkFailed = (retry: () => void) => (e: unknown) => {
      if (!alive || e instanceof CheckoutMovedOn) return
      // An SDK error message is shown as is (Stripe writes it for users). Never log it: it may echo user input.
      notice(e instanceof Error && e.message ? e.message : t.failed, retry)
    }
    /** After a transition: the modal shows the next step. The same sub-step again (a new sign-in, documents again) runs here. */
    const next = (step: Step) => {
      const s = step.surface
      if (alive && s?.kind === 'PROVIDER_SDK' && s.provider === 'stripe-link' && s.params.step === ctx.surface.params.step) run({ ...ctx, surface: s })
    }
    /** A button that runs `fn` once per click and is disabled while it runs. */
    const button = (label: string, fn: () => Promise<unknown>) => {
      const b = el('button', { class: 'btn', type: 'button' }, label)
      b.onclick = () => {
        b.disabled = true
        fn().finally(() => (b.disabled = false))
      }
      return b
    }
    const field = (id: string, label: string, attrs: Record<string, string> = {}) => {
      const input = el('input', { class: 'input', id: `ork-sl-${id}`, name: id, autocomplete: 'off', ...attrs })
      return [el('div', {}, el('label', { class: 'field-label', for: `ork-sl-${id}` }, label), input), input] as const
    }

    function run(c: ProviderRendererContext) {
      const p = c.surface.params as Record<string, unknown>
      const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '')
      const pk = str('publishableKey')
      if (!pk) throw new Error('Stripe Link needs a publishableKey')
      const again = () => run(c)
      const fail = sdkFailed(again)
      switch (p.step) {
        case 'register_link_user': {
          const email = str('email')
          const country = str('country') || 'US'
          const register = async (phone: string, fullName?: string) => {
            const o = await sdk(pk, c.mode)
            await o.registerLinkUser(email, phone, country, fullName)
            if (alive) next(await send(T.registered))
          }
          if (opts.collectRegistration) {
            opts.collectRegistration(container, { email, country }).then((r) => register(r.phone, r.fullName)).catch(fail)
            return
          }
          const [phoneRow, phone] = field('phone', t.phone, { type: 'tel', autocomplete: 'tel', required: '' })
          const [nameRow, name] = field('name', t.fullName, { autocomplete: 'name' })
          const err = el('div', { class: 'notice error', role: 'alert', hidden: '' })
          const form = el('form', { class: 'form' }, el('p', { class: 'hint' }, t.signUpHint), phoneRow, nameRow, err, el('button', { class: 'btn', type: 'submit' }, t.createAccount))
          form.onsubmit = (e) => {
            e.preventDefault()
            const e164 = toE164(phone.value)
            if (!e164) {
              err.textContent = t.badPhone
              err.hidden = false
              return
            }
            const fullName = name.value.trim() || undefined
            form.reset()
            register(e164, fullName).catch(fail)
          }
          container.replaceChildren(form)
          return
        }
        case 'authenticate': {
          const id = str('linkAuthIntentId')
          sdk(pk, c.mode)
            .then((o) =>
              o.authenticate(id, (r) => {
                if (!alive) return
                if (r.result === 'success' && r.crypto_customer_id) {
                  // A new sign-in binds a new key.
                  clientKey = makeClientKey()
                  send(T.authenticated, { cryptoCustomerId: r.crypto_customer_id }).then(next, () => notice(t.failed, again))
                } else notice(r.result === 'declined' ? t.signInDeclined : t.signInAbandoned, again)
              }),
            )
            .then((ui) => {
              // No element: the user needs no sign-in UI, and the callback runs at once.
              if (alive && ui) container.replaceChildren(ui)
            })
            .catch(fail)
          return
        }
        case 'submit_kyc_info': {
          const submit = async (info: StripeLinkKycInfo) => {
            const o = await sdk(pk, c.mode)
            await o.submitKycInfo(info)
            if (alive) next(await send(T.kyc))
          }
          if (opts.collectKyc) {
            opts.collectKyc(container).then(submit).catch(fail)
            return
          }
          const rows: Array<readonly [El, HTMLInputElement]> = [
            field('given', t.givenName, { required: '', autocomplete: 'given-name' }),
            field('surname', t.surname, { required: '', autocomplete: 'family-name' }),
            field('ssn', t.ssn, { required: '', inputmode: 'numeric', pattern: '\\d{3}-?\\d{2}-?\\d{4}' }),
            field('dob', t.dob, { required: '', type: 'date', autocomplete: 'bday' }),
            field('line1', t.line1, { required: '', autocomplete: 'address-line1' }),
            field('line2', t.line2, { autocomplete: 'address-line2' }),
            field('city', t.city, { required: '', autocomplete: 'address-level2' }),
            field('state', t.state, { required: '', maxlength: '2', autocomplete: 'address-level1' }),
            field('zip', t.postalCode, { required: '', autocomplete: 'postal-code' }),
          ]
          const form = el('form', { class: 'form' }, el('p', { class: 'hint' }, t.kycHint), ...rows.map((r) => r[0]), el('button', { class: 'btn', type: 'submit' }, t.submit))
          form.onsubmit = (e) => {
            e.preventDefault()
            const v = (i: number) => rows[i]![1].value.trim()
            const [year, month, day] = v(3).split('-').map(Number)
            const info: StripeLinkKycInfo = {
              given_name: v(0),
              surname: v(1),
              id_number: { type: 'us_ssn', value: v(2).replace(/\D/g, '') },
              date_of_birth: { day: day!, month: month!, year: year! },
              address: { country: 'US', line1: v(4), ...(v(5) ? { line2: v(5) } : {}), city: v(6), state: v(7).toUpperCase(), postal_code: v(8) },
            }
            // Empty the form at once: the data now lives only in this call to Stripe.
            form.reset()
            submit(info).catch(fail)
          }
          container.replaceChildren(form)
          return
        }
        case 'verify_documents': {
          // A button: Stripe's document check opens its own window, which needs a user gesture.
          container.replaceChildren(
            el('p', { class: 'hint' }, t.verifyHint),
            button(t.verify, async () => {
              try {
                const o = await sdk(pk, c.mode)
                const r = await o.verifyDocuments()
                if (!alive) return
                if (r.result === 'success') next(await send(T.documents))
                else notice(t.verifyAbandoned, again)
              } catch (e) {
                fail(e)
              }
            }),
          )
          return
        }
        case 'register_wallet_address': {
          // The address and network come from the server (the leg's own address).
          sdk(pk, c.mode)
            .then((o) => o.registerWalletAddress(str('walletAddress'), str('network')))
            .then(() => (alive ? send(T.wallet).then(next) : undefined))
            .catch(fail)
          return
        }
        case 'collect_payment_method': {
          const wallets = (p.wallets ?? { applePay: 'never', googlePay: 'never' }) as { applePay: string; googlePay: string }
          const types = Array.isArray(p.paymentMethodTypes) ? (p.paymentMethodTypes as string[]) : ['card']
          let sent = false
          sdk(pk, c.mode)
            .then((o) =>
              o.collectPaymentMethod({ payment_method_types: types, wallets }, (r) => {
                // Read only the payment token. The card and bank numbers stay inside Stripe's element, and the
                // display details in `r` (brand, last 4) are not read or sent. One transition per mount.
                if (!alive || sent || !r?.cryptoPaymentToken) return
                sent = true
                send(T.paymentMethod, { paymentToken: r.cryptoPaymentToken }).then(next, () => notice(t.failed, again))
              }),
            )
            .then((ui) => {
              if (alive) container.replaceChildren(ui)
            })
            .catch(fail)
          return
        }
        case 'perform_checkout': {
          const sessionId = str('onrampSessionId')
          const pay = async () => {
            try {
              const o = await sdk(pk, c.mode)
              // Stripe calls this for each checkout attempt (again after 3DS). Each call is a transition,
              // with the client key; the server answers with the client secret for the SDK.
              const r = await o.performCheckout(sessionId, async () => {
                const step = await send(T.checkout, typeof navigator !== 'undefined' ? { userAgent: navigator.userAgent } : {})
                const s = step.surface
                const secret = s?.kind === 'PROVIDER_SDK' && typeof s.params.clientSecret === 'string' ? s.params.clientSecret : ''
                // No secret: the purchase is past the checkout (processing, done or failed). The server status decides.
                if (!secret) throw new CheckoutMovedOn()
                return secret
              })
              if (r.successful) c.completed('checkout')
              else {
                c.failed('checkout')
                notice(t.payFailed, again)
              }
            } catch (e) {
              if (e instanceof CheckoutMovedOn) c.completed('checkout')
              else fail(e)
            }
          }
          container.replaceChildren(button(t.pay, pay))
          return
        }
        default:
          throw new Error(`Unknown Stripe Link step ${String(p.step)}`)
      }
    }

    run(ctx)
    return () => {
      alive = false
      container.replaceChildren()
    }
  }
}
