import { computed, defineComponent, h, onBeforeUnmount, onMounted, shallowRef, watch, watchEffect } from 'vue'
import type { DefineComponent, PropType } from 'vue'
import type { OrkEvent, PublicSession, WalletAdapter } from '@openrampkit/core'
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
  onEvent?: (e: OrkEvent) => void
  onComplete?: (session: PublicSession) => void
  /** Called when the user presses Close on a result or error screen */
  onClose?: (session: PublicSession | undefined) => void
  /** Receives the controller once it exists, for headless add-ons */
  onController?: (controller: DepositController) => void
}

/**
 * Renders `<openramp-modal embedded>` inline (no overlay). `class` and `style` go to the element.
 * Listen with `@complete`, `@close`, `@event` and `@controller`.
 */
export const OpenRampEmbedded: DefineComponent<OpenRampEmbeddedProps> = defineComponent({
  name: 'OpenRampEmbedded',
  props: {
    clientSecret: { type: [String, Function] as PropType<string | (() => Promise<string>)>, required: true },
    baseUrl: String,
    wallet: Object as PropType<WalletAdapter>,
    theme: Object as PropType<Theme>,
    appearance: Object as PropType<Appearance>,
    messages: Object as PropType<Partial<Messages>>,
    locale: String,
    onEvent: Function as PropType<(e: OrkEvent) => void>,
    onComplete: Function as PropType<(session: PublicSession) => void>,
    onClose: Function as PropType<(session: PublicSession | undefined) => void>,
    onController: Function as PropType<(controller: DepositController) => void>,
  },
  setup(props) {
    const config = useOpenRampConfig()
    const ctx = () => config?.()
    const baseUrl = computed(() => props.baseUrl ?? ctx()?.baseUrl)
    const wallet = computed(() => props.wallet ?? ctx()?.wallet)
    if (!baseUrl.value) throw new Error('@openrampkit/vue: <OpenRampEmbedded> needs `baseUrl` or an <OpenRampProvider>.')
    const el = shallowRef<OpenRampModal | null>(null)
    let offClose: (() => void) | undefined

    // Browser only: onMounted never runs during server rendering.
    onMounted(() => {
      const node = el.value
      if (!node) return
      // One controller per client secret. A new function identity does not restart the session; a new string does.
      watch(
        [baseUrl, wallet, () => (typeof props.clientSecret === 'string' ? props.clientSecret : null)],
        (_n, _o, onCleanup) => {
          const url = baseUrl.value
          if (!url) return
          const w = wallet.value
          const renderers = ctx()?.providerRenderers
          const stop = startEmbedded(node, {
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
          onCleanup(stop)
        },
        { immediate: true },
      )
      watchEffect(() => {
        const c = ctx()
        applyView(node, {
          theme: props.theme ?? c?.theme,
          appearance: props.appearance ?? c?.appearance,
          messages: props.messages ?? c?.messages,
          locale: props.locale ?? c?.locale,
          providerRenderers: c?.providerRenderers,
        })
      })
      offClose = onModalClose(node, (s) => props.onClose?.(s))
    })
    onBeforeUnmount(() => offClose?.())

    return () => h('openramp-modal', { ref: el, '^embedded': '' })
  },
})
