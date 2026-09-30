import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { OrkEvent, PublicSession, WalletAdapter } from '@openrampkit/core'
import type { Appearance, Theme } from '@openrampkit/web/theme'
import type { DepositHandle, Messages, ProviderRenderer } from '@openrampkit/web'
import { loadWeb } from './load.js'

export type OpenRampProviderProps = {
  /** Base URL of your OpenRampKit server handler, e.g. `/api/openramp` */
  baseUrl: string
  wallet?: WalletAdapter
  theme?: Theme
  appearance?: Appearance
  /** Partial message catalog. Overrides the locale catalog key by key. */
  messages?: Partial<Messages>
  /** BCP 47 locale (`en`, `vi`, `id`, `th`, `ms`, `fil`, ...). Default: session locale, then English (the browser language is not used). */
  locale?: string
  /** Renderers for PROVIDER_SDK surfaces, e.g. `{ stripe: stripeOnrampRenderer() }` from `@openrampkit/web` */
  providerRenderers?: Record<string, ProviderRenderer>
  onEvent?: (e: OrkEvent) => void
  children?: ReactNode
}

export type BeginDepositOptions = {
  clientSecret: string | (() => Promise<string>)
  onEvent?: (e: OrkEvent) => void
}

export type BeginWithdrawOptions = BeginDepositOptions

export type OpenRampApi = {
  /** Opens the modal. Resolves with the session when the deposit completes; rejects if the modal closes first. */
  beginDeposit(opts: BeginDepositOptions): Promise<PublicSession>
  /**
   * Opens the modal for a withdraw session (created on your server with `direction: 'withdraw'`).
   * Resolves with the session when the withdrawal completes; rejects if the modal closes first.
   */
  beginWithdraw(opts: BeginWithdrawOptions): Promise<PublicSession>
  close(): void
  isOpen: boolean
}

type Ctx = OpenRampApi & Omit<OpenRampProviderProps, 'children'>

const OpenRampContext = createContext<Ctx | null>(null)

export function OpenRampProvider(props: OpenRampProviderProps) {
  const { children, ...config } = props
  const configRef = useRef(config)
  configRef.current = config
  const handleRef = useRef<DepositHandle | null>(null)
  const [isOpen, setOpen] = useState(false)

  const close = useCallback(() => {
    handleRef.current?.close()
    handleRef.current = null
  }, [])

  const begin = useCallback(async (kind: 'deposit' | 'withdraw', opts: BeginDepositOptions): Promise<PublicSession> => {
    const web = await loadWeb()
    handleRef.current?.close()
    const c = configRef.current
    const onEvent = (e: OrkEvent) => {
      c.onEvent?.(e)
      opts.onEvent?.(e)
    }
    const handle = (kind === 'withdraw' ? web.openWithdraw : web.openDeposit)({
      baseUrl: c.baseUrl,
      clientSecret: opts.clientSecret,
      onEvent,
      onClose: () => {
        if (handleRef.current === handle) handleRef.current = null
        setOpen(false)
      },
      ...(c.wallet ? { wallet: c.wallet } : {}),
      ...(c.theme ? { theme: c.theme } : {}),
      ...(c.appearance ? { appearance: c.appearance } : {}),
      ...(c.messages ? { messages: c.messages } : {}),
      ...(c.locale ? { locale: c.locale } : {}),
      ...(c.providerRenderers ? { providerRenderers: c.providerRenderers } : {}),
    })
    handleRef.current = handle
    setOpen(true)
    return handle.done
  }, [])
  const beginDeposit = useCallback((opts: BeginDepositOptions) => begin('deposit', opts), [begin])
  const beginWithdraw = useCallback((opts: BeginWithdrawOptions) => begin('withdraw', opts), [begin])

  // Close the modal when the provider unmounts.
  useEffect(() => () => handleRef.current?.close(), [])

  // Keep theme changes live while the modal is open.
  useEffect(() => {
    const el = handleRef.current?.element
    if (!el) return
    el.theme = config.theme
    el.appearance = config.appearance
    el.locale = config.locale
  }, [config.theme, config.appearance, config.locale, isOpen])

  const value = useMemo<Ctx>(() => ({ ...config, beginDeposit, beginWithdraw, close, isOpen }), [config.baseUrl, config.wallet, config.theme, config.appearance, config.messages, config.locale, config.onEvent, beginDeposit, beginWithdraw, close, isOpen])
  return createElement(OpenRampContext.Provider, { value }, children)
}

function useCtx(): Ctx {
  const ctx = useContext(OpenRampContext)
  if (!ctx) throw new Error('@openrampkit/react: wrap your app in <OpenRampProvider>.')
  return ctx
}

/** `{ beginDeposit, beginWithdraw, close, isOpen }` */
export function useOpenRamp(): OpenRampApi {
  const { beginDeposit, beginWithdraw, close, isOpen } = useCtx()
  return { beginDeposit, beginWithdraw, close, isOpen }
}

/** Provider config, or null outside a provider. Internal. */
export function useOpenRampConfig(): Ctx | null {
  return useContext(OpenRampContext)
}
