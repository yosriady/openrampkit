import { createElement, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { OrkEvent, PublicSession, WalletAdapter } from '@openrampkit/core'
import { toOrkError } from '@openrampkit/client'
import type { DepositController } from '@openrampkit/client'
import type { Messages, OpenRampModal } from '@openrampkit/web'
import type { Appearance, Theme } from '@openrampkit/web/theme'
import { loadWeb } from './load.js'
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
  className?: string
  style?: CSSProperties
}

/** Renders `<openramp-modal embedded>` inline (no overlay), like D0's embedded mode. */
export function OpenRampEmbedded(props: OpenRampEmbeddedProps) {
  const ctx = useOpenRampConfig()
  const ref = useRef<OpenRampModal | null>(null)
  const latest = useRef(props)
  latest.current = props
  const [controller, setController] = useState<DepositController>()
  const baseUrl = props.baseUrl ?? ctx?.baseUrl
  const wallet = props.wallet ?? ctx?.wallet
  const theme = props.theme ?? ctx?.theme
  const appearance = props.appearance ?? ctx?.appearance
  const messages = props.messages ?? ctx?.messages
  const locale = props.locale ?? ctx?.locale

  // Create one controller per client secret.
  useEffect(() => {
    if (!baseUrl) throw new Error('@openrampkit/react: <OpenRampEmbedded> needs `baseUrl` or an <OpenRampProvider>.')
    let cancelled = false
    let ctl: DepositController | undefined
    ;(async () => {
      const web = await loadWeb()
      const secret = await web.resolveClientSecret(props.clientSecret)
      if (cancelled) return
      ctl = web.createDepositController({
        baseUrl,
        clientSecret: secret,
        ...(wallet ? { wallet } : {}),
        ...(ctx?.providerRenderers && Object.keys(ctx.providerRenderers).length ? { surfaces: [...web.SUPPORTED_SURFACES, 'PROVIDER_SDK' as const] } : {}),
        onEvent: (e) => {
          ctx?.onEvent?.(e)
          latest.current.onEvent?.(e)
        },
      })
      ctl.done.then((s) => latest.current.onComplete?.(s)).catch(() => {})
      setController(ctl)
      latest.current.onController?.(ctl)
      void ctl.start()
    })().catch((e: unknown) => {
      if (cancelled || !ref.current) return
      ref.current.error = toOrkError(e)
    })
    return () => {
      cancelled = true
      ctl?.destroy()
      setController(undefined)
    }
    // A new function identity for clientSecret should not restart the session; only a new string does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, wallet, typeof props.clientSecret === 'string' ? props.clientSecret : null])

  // Push props to the element.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.controller = controller
    el.theme = theme
    el.appearance = appearance
    el.messages = messages
    el.locale = locale
    el.providerRenderers = ctx?.providerRenderers
    el.embedded = true
  }, [controller, theme, appearance, messages, locale, ctx?.providerRenderers])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onClose = (e: Event) => latest.current.onClose?.((e as CustomEvent<{ session?: PublicSession }>).detail?.session)
    el.addEventListener('openramp-close', onClose)
    return () => el.removeEventListener('openramp-close', onClose)
  }, [])

  return createElement('openramp-modal', {
    ref,
    embedded: true,
    className: props.className,
    style: props.style,
  })
}
