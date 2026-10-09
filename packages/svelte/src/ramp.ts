// Framework-agnostic modal state: one open modal at a time, opened with `openDeposit` or `openWithdraw`.
import type { ClientEvent, PublicSession, WalletAdapter } from '@openrampkit/core'
import type { Appearance, Theme } from '@openrampkit/web/theme'
import type { DepositHandle, Messages, ProviderRenderer } from '@openrampkit/web'
import { loadWeb } from './load.js'

export type OpenRampConfig = {
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
  onEvent?: (e: ClientEvent) => void
}

export type BeginDepositOptions = {
  clientSecret: string | (() => Promise<string>)
  onEvent?: (e: ClientEvent) => void
}

export type BeginWithdrawOptions = BeginDepositOptions

export type RampCore = {
  beginDeposit(opts: BeginDepositOptions): Promise<PublicSession>
  beginWithdraw(opts: BeginWithdrawOptions): Promise<PublicSession>
  close(): void
  /** Push theme, appearance and locale to the open modal */
  sync(): void
}

export function createRampCore(getConfig: () => OpenRampConfig, setOpen: (open: boolean) => void): RampCore {
  let handle: DepositHandle | null = null

  const begin = async (kind: 'deposit' | 'withdraw', opts: BeginDepositOptions): Promise<PublicSession> => {
    const web = await loadWeb()
    handle?.close()
    const c = getConfig()
    const onEvent = (e: ClientEvent) => {
      getConfig().onEvent?.(e)
      opts.onEvent?.(e)
    }
    const h: DepositHandle = (kind === 'withdraw' ? web.openWithdraw : web.openDeposit)({
      baseUrl: c.baseUrl,
      clientSecret: opts.clientSecret,
      onEvent,
      onClose: () => {
        if (handle === h) {
          handle = null
          setOpen(false)
        }
      },
      ...(c.wallet ? { wallet: c.wallet } : {}),
      ...(c.theme ? { theme: c.theme } : {}),
      ...(c.appearance ? { appearance: c.appearance } : {}),
      ...(c.messages ? { messages: c.messages } : {}),
      ...(c.locale ? { locale: c.locale } : {}),
      ...(c.providerRenderers ? { providerRenderers: c.providerRenderers } : {}),
    })
    handle = h
    setOpen(true)
    return h.done
  }

  return {
    beginDeposit: (opts) => begin('deposit', opts),
    beginWithdraw: (opts) => begin('withdraw', opts),
    close() {
      const h = handle
      handle = null
      h?.close()
      setOpen(false)
    },
    sync() {
      const el = handle?.element
      if (!el) return
      const c = getConfig()
      el.theme = c.theme
      el.appearance = c.appearance
      el.locale = c.locale
    },
  }
}
