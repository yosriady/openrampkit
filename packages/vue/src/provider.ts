import { defineComponent, getCurrentScope, inject, onScopeDispose, provide, readonly, ref, toValue, watch } from 'vue'
import type { DefineComponent, InjectionKey, MaybeRefOrGetter, PropType, Ref } from 'vue'
import type { OpenRampEvent, PublicSession, WalletAdapter } from '@openrampkit/core'
import type { Appearance, Theme } from '@openrampkit/web/theme'
import type { Messages, ProviderRenderer } from '@openrampkit/web'
import { createRampCore } from './ramp.js'
import type { BeginDepositOptions, BeginWithdrawOptions, OpenRampConfig } from './ramp.js'

export type OpenRampApi = {
  /** Opens the modal. Resolves with the session when the deposit completes; rejects if the modal closes first. */
  beginDeposit(opts: BeginDepositOptions): Promise<PublicSession>
  /**
   * Opens the modal for a withdraw session (created on your server with `direction: 'withdraw'`).
   * Resolves with the session when the withdrawal completes; rejects if the modal closes first.
   */
  beginWithdraw(opts: BeginWithdrawOptions): Promise<PublicSession>
  close(): void
  /** Whether the modal is open */
  isOpen: Readonly<Ref<boolean>>
}

type Ctx = { api: OpenRampApi; config: () => OpenRampConfig }

const OpenRampKey: InjectionKey<Ctx> = Symbol('openramp')

/**
 * Provide the OpenRampKit config to child components. Call it in `setup()` (for example in `App.vue`).
 * `config` can be a plain object, a ref or a getter. Theme, appearance and locale changes reach an open modal.
 * The modal closes when the calling scope is disposed.
 */
export function provideOpenRamp(config: MaybeRefOrGetter<OpenRampConfig>): OpenRampApi {
  const isOpen = ref(false)
  const getConfig = () => toValue(config)
  const core = createRampCore(getConfig, (v) => (isOpen.value = v))
  watch(
    () => {
      const c = getConfig()
      return [c.theme, c.appearance, c.locale]
    },
    () => core.sync(),
  )
  if (getCurrentScope()) onScopeDispose(() => core.close())
  const api: OpenRampApi = {
    beginDeposit: core.beginDeposit,
    beginWithdraw: core.beginWithdraw,
    close: core.close,
    isOpen: readonly(isOpen),
  }
  provide(OpenRampKey, { api, config: getConfig })
  return api
}

/** `{ beginDeposit, beginWithdraw, close, isOpen }`. Throws outside `provideOpenRamp()` or `<OpenRampProvider>`. */
export function useOpenRamp(): OpenRampApi {
  const ctx = inject(OpenRampKey, null)
  if (!ctx) throw new Error('@openrampkit/vue: wrap your app in <OpenRampProvider> or call provideOpenRamp().')
  return ctx.api
}

/** Provider config, or null outside a provider. Internal. */
export function useOpenRampConfig(): (() => OpenRampConfig) | null {
  return inject(OpenRampKey, null)?.config ?? null
}

export type OpenRampProviderProps = OpenRampConfig

/** Holds the shared config and opens the modal. Same as calling `provideOpenRamp(props)`. */
export const OpenRampProvider: DefineComponent<OpenRampProviderProps> = defineComponent({
  name: 'OpenRampProvider',
  props: {
    baseUrl: { type: String, required: true },
    wallet: Object as PropType<WalletAdapter>,
    theme: Object as PropType<Theme>,
    appearance: Object as PropType<Appearance>,
    messages: Object as PropType<Partial<Messages>>,
    locale: String,
    providerRenderers: Object as PropType<Record<string, ProviderRenderer>>,
    onEvent: Function as PropType<(e: OpenRampEvent) => void>,
  },
  setup(props, { slots }) {
    provideOpenRamp(() => {
      const c: OpenRampConfig = { baseUrl: props.baseUrl }
      if (props.wallet) c.wallet = props.wallet
      if (props.theme) c.theme = props.theme
      if (props.appearance) c.appearance = props.appearance
      if (props.messages) c.messages = props.messages
      if (props.locale) c.locale = props.locale
      if (props.providerRenderers) c.providerRenderers = props.providerRenderers
      if (props.onEvent) c.onEvent = props.onEvent
      return c
    })
    return () => slots.default?.()
  },
})
