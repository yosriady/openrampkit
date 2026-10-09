import { createComponent, createEffect, on, onCleanup, onMount, untrack } from 'solid-js'
import type { JSX } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import type { OpenRampEvent, PublicSession, WalletAdapter } from '@openrampkit/core'
import type { DepositController } from '@openrampkit/client'
import type { Messages, OpenRampModal } from '@openrampkit/web'
import type { Appearance, Theme } from '@openrampkit/web/theme'
import { applyView, onModalClose, startEmbedded } from './embed.js'
import { useOpenRampConfig } from './provider.js'

export type OpenRampEmbeddedProps = {
  clientSecret: string | (() => Promise<string>)
  /** Defaults to the provider's `baseUrl` */
  baseUrl?: string
  wallet?: WalletAdapter
  theme?: Theme
  appearance?: Appearance
  messages?: Partial<Messages>
  /** BCP 47 locale. Defaults to the provider's `locale` */
  locale?: string
  onEvent?: (e: OpenRampEvent) => void
  onComplete?: (session: PublicSession) => void
  /** Called when the user presses Close on a result or error screen */
  onClose?: (session: PublicSession | undefined) => void
  /** Receives the controller once it exists, for headless add-ons */
  onController?: (controller: DepositController) => void
  class?: string
  style?: JSX.CSSProperties | string
}

/** Renders `<openramp-modal embedded>` inline (no overlay). */
export function OpenRampEmbedded(props: OpenRampEmbeddedProps): JSX.Element {
  const config = useOpenRampConfig()
  const ctx = () => config?.()
  const baseUrl = () => props.baseUrl ?? ctx()?.baseUrl
  const wallet = () => props.wallet ?? ctx()?.wallet
  if (!untrack(baseUrl)) throw new Error('@openrampkit/solid: <OpenRampEmbedded> needs `baseUrl` or an <OpenRampProvider>.')
  let el: OpenRampModal | undefined

  // Browser only: onMount never runs during server rendering.
  onMount(() => {
    const node = el
    if (!node) return
    // One controller per client secret. A new function identity does not restart the session; a new string does.
    createEffect(
      on([baseUrl, wallet, () => (typeof props.clientSecret === 'string' ? props.clientSecret : null)], ([url, w]) => {
        if (!url) return
        const stop = untrack(() => {
          const renderers = ctx()?.providerRenderers
          return startEmbedded(node, {
            baseUrl: url,
            clientSecret: props.clientSecret,
            ...(w ? { wallet: w } : {}),
            ...(renderers ? { providerRenderers: renderers } : {}),
            onEvent: (e) => {
              ctx()?.onEvent?.(e)
              props.onEvent?.(e)
            },
            onComplete: (s) => props.onComplete?.(s),
            onController: (c) => props.onController?.(c),
          })
        })
        onCleanup(stop)
      }),
    )
    createEffect(() => {
      const c = ctx()
      applyView(node, {
        theme: props.theme ?? c?.theme,
        appearance: props.appearance ?? c?.appearance,
        messages: props.messages ?? c?.messages,
        locale: props.locale ?? c?.locale,
        providerRenderers: c?.providerRenderers,
      })
    })
    onCleanup(onModalClose(node, (s) => props.onClose?.(s)))
  })

  return createComponent(Dynamic<'openramp-modal'>, {
    component: 'openramp-modal',
    ref: (e: HTMLElement) => (el = e as OpenRampModal),
    'attr:embedded': '',
    get class() {
      return props.class
    },
    get style() {
      return props.style
    },
  } as never)
}
