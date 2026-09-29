import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { OrkEvent, PublicSession, WalletAdapter } from '@openrampkit/core'
import type { Appearance, Theme } from '@openrampkit/web/theme'
import type { DepositHandle, Messages } from '@openrampkit/web'
import { loadWeb } from './load.js'

export type OpenRampProviderProps = {
  /** Base URL of your OpenRampKit server handler, e.g. `/api/openramp` */
  baseUrl: string
  wallet?: WalletAdapter
  theme?: Theme
  appearance?: Appearance
  messages?: Partial<Messages>
  onEvent?: (e: OrkEvent) => void
  children?: ReactNode
}

export type BeginDepositOptions = {
  clientSecret: string | (() => Promise<string>)
  onEvent?: (e: OrkEvent) => void
}

export type OpenRampApi = {
  /** Opens the modal. Resolves with the session when the deposit completes; rejects if the modal closes first. */
  beginDeposit(opts: BeginDepositOptions): Promise<PublicSession>
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

  const beginDeposit = useCallback(async (opts: BeginDepositOptions): Promise<PublicSession> => {
    const web = await loadWeb()
    handleRef.current?.close()
    const c = configRef.current
    const onEvent = (e: OrkEvent) => {
      c.onEvent?.(e)
      opts.onEvent?.(e)
    }
    const handle = web.openDeposit({
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
    })
    handleRef.current = handle
    setOpen(true)
    return handle.done
  }, [])

  // Close the modal when the provider unmounts.
  useEffect(() => () => handleRef.current?.close(), [])

  // Keep theme changes live while the modal is open.
  useEffect(() => {
    const el = handleRef.current?.element
    if (!el) return
    el.theme = config.theme
    el.appearance = config.appearance
  }, [config.theme, config.appearance, isOpen])

  const value = useMemo<Ctx>(() => ({ ...config, beginDeposit, close, isOpen }), [config.baseUrl, config.wallet, config.theme, config.appearance, config.messages, config.onEvent, beginDeposit, close, isOpen])
  return createElement(OpenRampContext.Provider, { value }, children)
}

function useCtx(): Ctx {
  const ctx = useContext(OpenRampContext)
  if (!ctx) throw new Error('@openrampkit/react: wrap your app in <OpenRampProvider>.')
  return ctx
}

/** `{ beginDeposit, close, isOpen }` */
export function useOpenRamp(): OpenRampApi {
  const { beginDeposit, close, isOpen } = useCtx()
  return { beginDeposit, close, isOpen }
}

/** Provider config, or null outside a provider. Internal. */
export function useOpenRampConfig(): Ctx | null {
  return useContext(OpenRampContext)
}
