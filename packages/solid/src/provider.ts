import { createComponent, createContext, createEffect, createSignal, on, onCleanup, useContext } from 'solid-js'
import type { Accessor, JSX } from 'solid-js'
import type { PublicSession } from '@openrampkit/core'
import { createRampCore } from './ramp.js'
import type { BeginDepositOptions, BeginWithdrawOptions, OpenRampConfig } from './ramp.js'

export type OpenRampProviderProps = OpenRampConfig & { children?: JSX.Element }

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
  isOpen: Accessor<boolean>
}

type Ctx = { api: OpenRampApi; config: () => OpenRampConfig }

const OpenRampContext = createContext<Ctx>()

/** Holds the shared config and opens the modal. Theme, appearance and locale changes reach an open modal. */
export function OpenRampProvider(props: OpenRampProviderProps): JSX.Element {
  const [isOpen, setOpen] = createSignal(false)
  const config = (): OpenRampConfig => {
    const c: OpenRampConfig = { baseUrl: props.baseUrl }
    if (props.wallet) c.wallet = props.wallet
    if (props.theme) c.theme = props.theme
    if (props.appearance) c.appearance = props.appearance
    if (props.messages) c.messages = props.messages
    if (props.locale) c.locale = props.locale
    if (props.providerRenderers) c.providerRenderers = props.providerRenderers
    if (props.onEvent) c.onEvent = props.onEvent
    return c
  }
  const core = createRampCore(config, (v) => setOpen(v))
  createEffect(on(() => [props.theme, props.appearance, props.locale], () => core.sync(), { defer: true }))
  // Close the modal when the provider unmounts.
  onCleanup(() => core.close())
  const api: OpenRampApi = { beginDeposit: core.beginDeposit, beginWithdraw: core.beginWithdraw, close: core.close, isOpen }
  return createComponent(OpenRampContext.Provider, {
    value: { api, config },
    get children() {
      return props.children
    },
  })
}

/** `{ beginDeposit, beginWithdraw, close, isOpen }`. Throws outside `<OpenRampProvider>`. */
export function useOpenRamp(): OpenRampApi {
  const ctx = useContext(OpenRampContext)
  if (!ctx) throw new Error('@openrampkit/solid: wrap your app in <OpenRampProvider>.')
  return ctx.api
}

/** Provider config, or undefined outside a provider. Internal. */
export function useOpenRampConfig(): (() => OpenRampConfig) | undefined {
  return useContext(OpenRampContext)?.config
}
