// Svelte actions (`use:`). They run only in the browser, so server rendering never loads Lit.
import type { OrkError, OrkEvent, PublicSession, WalletAdapter } from '@openrampkit/core'
import type { DepositController } from '@openrampkit/client'
import type { Messages, OpenRampModal } from '@openrampkit/web'
import type { Appearance, Theme } from '@openrampkit/web/theme'
import { applyView, onModalClose, startEmbedded } from './embed.js'
import type { OpenRamp } from './openramp.js'
import type { OpenRampConfig } from './ramp.js'

/** The return value of an action, as Svelte expects it */
export type ActionReturn<P> = {
  update(params: P): void
  destroy(): void
}

export type ButtonActionParams = {
  /** From `createOpenRamp()`, `setOpenRamp()` or `getOpenRamp()` */
  ramp: OpenRamp
  /** A client secret, or a function that fetches one from your server */
  getClientSecret: string | (() => Promise<string>)
  onComplete?: (session: PublicSession) => void
  /** Called when the modal closes before the session completes */
  onError?: (error: OrkError) => void
  onEvent?: (e: OrkEvent) => void
  /** Keep the element disabled. The action also disables it while the modal is open. */
  disabled?: boolean
}

function buttonAction(kind: 'deposit' | 'withdraw') {
  return (node: HTMLElement, params: ButtonActionParams): ActionReturn<ButtonActionParams> => {
    let p = params
    let open = false
    let unsubscribe: () => void = () => {}
    const render = () => {
      if ('disabled' in node) (node as HTMLButtonElement).disabled = !!p.disabled || open
    }
    const subscribe = () => {
      unsubscribe()
      unsubscribe = p.ramp.isOpen.subscribe((v) => {
        open = v
        render()
      })
    }
    const onClick = () => {
      const begin = kind === 'withdraw' ? p.ramp.beginWithdraw : p.ramp.beginDeposit
      begin({ clientSecret: p.getClientSecret, ...(p.onEvent ? { onEvent: p.onEvent } : {}) }).then(
        (s) => p.onComplete?.(s),
        (e: OrkError) => p.onError?.(e),
      )
    }
    node.addEventListener('click', onClick)
    subscribe()
    return {
      update(next) {
        const rampChanged = next.ramp !== p.ramp
        p = next
        if (rampChanged) subscribe()
        else render()
      },
      destroy() {
        node.removeEventListener('click', onClick)
        unsubscribe()
      },
    }
  }
}

/** `<button use:depositButton={{ ramp, getClientSecret }}>`: opens a deposit on click; disabled while the modal is open. */
export const depositButton = buttonAction('deposit')

/** `<button use:withdrawButton={{ ramp, getClientSecret }}>`: the same for a withdraw session. */
export const withdrawButton = buttonAction('withdraw')

export type EmbeddedActionParams = {
  clientSecret: string | (() => Promise<string>)
  /** Default values for `baseUrl`, `wallet`, `theme`, `appearance`, `messages`, `locale` and `onEvent`. Follows `ramp.update()`. */
  ramp?: OpenRamp
  /** Required when there is no `ramp` */
  baseUrl?: string
  wallet?: WalletAdapter
  theme?: Theme
  appearance?: Appearance
  messages?: Partial<Messages>
  /** BCP 47 locale */
  locale?: string
  /** Called after the ramp's `onEvent` */
  onEvent?: (e: OrkEvent) => void
  onComplete?: (session: PublicSession) => void
  /** Called when the user presses Close on a result or error screen */
  onClose?: (session: PublicSession | undefined) => void
  /** Receives the controller once it exists, for headless add-ons */
  onController?: (controller: DepositController) => void
}

/**
 * Renders the modal inline, without an overlay. Use it on `<openramp-modal>` (the element is rendered on the server
 * too), or on any container: the action then adds an `<openramp-modal>` inside it.
 * A new string `clientSecret`, `baseUrl` or `wallet` starts a new session. A new function does not.
 */
export function openRampEmbedded(node: HTMLElement, params: EmbeddedActionParams): ActionReturn<EmbeddedActionParams> {
  const own = node.localName !== 'openramp-modal'
  const el = (own ? node.appendChild(document.createElement('openramp-modal')) : node) as OpenRampModal
  el.setAttribute('embedded', '')
  let p = params
  let rampConfig: OpenRampConfig | undefined
  let stop: (() => void) | undefined
  let key: unknown[] = []

  const baseUrl = () => p.baseUrl ?? rampConfig?.baseUrl
  const wallet = () => p.wallet ?? rampConfig?.wallet
  const view = () =>
    applyView(el, {
      theme: p.theme ?? rampConfig?.theme,
      appearance: p.appearance ?? rampConfig?.appearance,
      messages: p.messages ?? rampConfig?.messages,
      locale: p.locale ?? rampConfig?.locale,
      providerRenderers: rampConfig?.providerRenderers,
    })
  const start = () => {
    const url = baseUrl()
    if (!url) throw new Error('@openrampkit/svelte: openRampEmbedded needs `baseUrl` or `ramp`.')
    const next = [url, wallet(), typeof p.clientSecret === 'string' ? p.clientSecret : null]
    if (stop && next.every((v, i) => v === key[i])) return
    key = next
    stop?.()
    const w = wallet()
    const renderers = rampConfig?.providerRenderers
    stop = startEmbedded(el, {
      baseUrl: url,
      clientSecret: p.clientSecret,
      ...(w ? { wallet: w } : {}),
      ...(renderers ? { providerRenderers: renderers } : {}),
      onEvent: (e) => {
        rampConfig?.onEvent?.(e)
        p.onEvent?.(e)
      },
      onComplete: (s) => p.onComplete?.(s),
      onController: (c) => p.onController?.(c),
    })
  }

  let unsubscribe: () => void = () => {}
  let subscribedTo: OpenRamp | undefined
  const follow = () => {
    if (p.ramp === subscribedTo) return
    unsubscribe()
    subscribedTo = p.ramp
    rampConfig = undefined
    unsubscribe =
      p.ramp?.config.subscribe((c) => {
        const first = !rampConfig
        rampConfig = c
        if (!first) {
          view()
          start()
        }
      }) ?? (() => {})
  }

  follow()
  view()
  start()
  const offClose = onModalClose(el, (s) => p.onClose?.(s))

  return {
    update(next) {
      p = next
      follow()
      view()
      start()
    },
    destroy() {
      offClose()
      unsubscribe()
      stop?.()
      if (own) el.remove()
    },
  }
}
