// Provider SDK surfaces (`PROVIDER_SDK`). A renderer mounts a provider's own UI (for example Stripe's
// onramp element) into a container inside the modal. The server status stays the source of truth:
// renderer callbacks only trigger an immediate status check.

import type { Surface } from '@openrampkit/core'

export type ProviderSdkSurface = Extract<Surface, { kind: 'PROVIDER_SDK' }>

export type ProviderRendererContext = {
  surface: ProviderSdkSurface
  /** 'light' or 'dark', from the modal theme */
  mode: 'light' | 'dark'
  /** The provider says the user finished: the modal checks the status now */
  completed(detail?: unknown): void
  /** The provider says the payment failed or was closed */
  failed(detail?: unknown): void
}

/** Mount the provider UI into `container`. Return a cleanup function if the provider needs one. */
export type ProviderRenderer = (container: HTMLElement, ctx: ProviderRendererContext) => void | (() => void) | Promise<void | (() => void)>

const loading = new Map<string, Promise<void>>()

/** Load a script once per page (in the document head: provider SDKs do not load inside Shadow DOM). */
export function loadScript(src: string): Promise<void> {
  const existing = loading.get(src)
  if (existing) return existing
  const p = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = src
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => {
      loading.delete(src)
      reject(new Error(`Could not load ${src}`))
    }
    document.head.appendChild(s)
  })
  loading.set(src, p)
  return p
}

type StripeOnrampSession = {
  mount(el: HTMLElement): void
  addEventListener(type: string, cb: (e: { payload?: { session?: { status?: string } } }) => void): void
}
type StripeOnrampFactory = (publishableKey: string) => { createSession(o: { clientSecret: string; appearance?: { theme?: 'light' | 'dark' } }): StripeOnrampSession }

export const STRIPE_SCRIPTS = ['https://js.stripe.com/v3/', 'https://crypto-js.stripe.com/crypto-onramp-outer.js']

/**
 * Renderer for the Stripe Crypto Onramp element (`@openrampkit/adapter-stripe` with the default
 * PROVIDER_SDK surface). Loads Stripe's scripts, then mounts the onramp with the session's client secret.
 * Your CSP must allow scripts and frames from js.stripe.com and crypto-js.stripe.com.
 * TO VERIFY with a Stripe onramp account: event name and status values.
 */
export function stripeOnrampRenderer(opts: { load?: (src: string) => Promise<void> } = {}): ProviderRenderer {
  const load = opts.load ?? loadScript
  return async (container, ctx) => {
    const { clientSecret, publishableKey } = ctx.surface.params as { clientSecret?: string; publishableKey?: string }
    if (!clientSecret || !publishableKey) throw new Error('Stripe onramp needs clientSecret and publishableKey')
    for (const src of STRIPE_SCRIPTS) await load(src)
    const factory = (globalThis as unknown as { StripeOnramp?: StripeOnrampFactory }).StripeOnramp
    if (!factory) throw new Error('StripeOnramp did not load')
    const session = factory(publishableKey).createSession({ clientSecret, appearance: { theme: ctx.mode } })
    session.addEventListener('onramp_session_updated', (e) => {
      const status = e.payload?.session?.status
      if (status === 'fulfillment_complete' || status === 'fulfillment_processing') ctx.completed(status)
      else if (status === 'rejected') ctx.failed(status)
    })
    session.mount(container)
  }
}
