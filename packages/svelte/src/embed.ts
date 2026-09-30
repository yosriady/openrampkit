// Framework-agnostic embedded mode: create one controller for one `<openramp-modal embedded>` element.
import type { OrkEvent, PublicSession, WalletAdapter } from '@openrampkit/core'
import { toOrkError } from '@openrampkit/client'
import type { DepositController } from '@openrampkit/client'
import type { Messages, OpenRampModal, ProviderRenderer } from '@openrampkit/web'
import type { Appearance, Theme } from '@openrampkit/web/theme'
import { loadWeb } from './load.js'

export type EmbedSession = {
  baseUrl: string
  clientSecret: string | (() => Promise<string>)
  wallet?: WalletAdapter
  providerRenderers?: Record<string, ProviderRenderer>
  onEvent: (e: OrkEvent) => void
  onComplete: (session: PublicSession) => void
  onController: (controller: DepositController) => void
}

export type EmbedView = {
  theme?: Theme
  appearance?: Appearance
  messages?: Partial<Messages>
  locale?: string
  providerRenderers?: Record<string, ProviderRenderer>
}

/** Start a session on `el`. Returns a function that stops it and destroys the controller. Browser only. */
export function startEmbedded(el: OpenRampModal, o: EmbedSession): () => void {
  let cancelled = false
  let ctl: DepositController | undefined
  ;(async () => {
    const web = await loadWeb()
    const secret = await web.resolveClientSecret(o.clientSecret)
    if (cancelled) return
    ctl = web.createDepositController({
      baseUrl: o.baseUrl,
      clientSecret: secret,
      ...(o.wallet ? { wallet: o.wallet } : {}),
      ...(o.providerRenderers && Object.keys(o.providerRenderers).length ? { surfaces: [...web.SUPPORTED_SURFACES, 'PROVIDER_SDK' as const] } : {}),
      onEvent: o.onEvent,
    })
    ctl.done.then(o.onComplete).catch(() => {})
    el.controller = ctl
    o.onController(ctl)
    void ctl.start()
  })().catch((e: unknown) => {
    if (!cancelled) el.error = toOrkError(e)
  })
  return () => {
    cancelled = true
    ctl?.destroy()
    if (ctl && el.controller === ctl) el.controller = undefined
  }
}

/** Push view props to the element */
export function applyView(el: OpenRampModal, v: EmbedView): void {
  el.theme = v.theme
  el.appearance = v.appearance
  el.messages = v.messages
  el.locale = v.locale
  el.providerRenderers = v.providerRenderers
  el.embedded = true
}

/** Listen for the close event. Returns the unsubscribe function. */
export function onModalClose(el: HTMLElement, fn: (session: PublicSession | undefined) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<{ session?: PublicSession }>).detail?.session)
  el.addEventListener('openramp-close', h)
  return () => el.removeEventListener('openramp-close', h)
}
