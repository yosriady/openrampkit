import type { ProviderRenderer } from './provider-sdk.js'
import { createOpenRampClient, DepositController, toOpenRampError } from '@openrampkit/client'
import { openRampError } from '@openrampkit/core'
import type { Direction, OpenRampError, ClientEvent, PublicSession, SurfaceKind, WalletAdapter } from '@openrampkit/core'
import { defineOpenRampModal, OpenRampModal } from './element.js'
import type { Messages } from './messages.js'
import type { Appearance, Theme } from './theme.js'

/** Surfaces this UI can draw. The planner hides pathways that need anything else. */
export const SUPPORTED_SURFACES: SurfaceKind[] = ['REDIRECT', 'IFRAME', 'QR', 'DEEPLINK', 'BANK_FIELDS', 'DEPOSIT_ADDRESS', 'WALLET_TX', 'OTP', 'FORM']

/** Error code used when the user closes the modal before the deposit or withdrawal completes. */
export const CLOSED_CODE = 'CLOSED' as const

export type ClientSecretSource = string | (() => Promise<string>)

export type CreateControllerOptions = {
  baseUrl: string
  clientSecret: string
  wallet?: WalletAdapter
  onEvent?: (e: ClientEvent) => void
  /** Custom fetch, for tests and demos */
  fetch?: typeof fetch
  surfaces?: string[]
  /** Refuse a session of the other direction. Default: follow the session. */
  expect?: Direction
}

/**
 * Create a controller for one session. Call `start()` on it to load the methods.
 * The session's direction picks the flow, so this works for deposit and withdraw sessions.
 */
export function createDepositController(opts: CreateControllerOptions): DepositController {
  const client = createOpenRampClient({ baseUrl: opts.baseUrl, ...(opts.fetch ? { fetch: opts.fetch } : {}) })
  return new DepositController({
    client,
    clientSecret: opts.clientSecret,
    surfaces: opts.surfaces ?? SUPPORTED_SURFACES,
    ...(opts.wallet ? { wallet: opts.wallet } : {}),
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
    ...(opts.expect ? { expect: opts.expect } : {}),
  })
}

/** Create a controller for one withdraw session. It refuses a deposit session. */
export function createWithdrawController(opts: Omit<CreateControllerOptions, 'expect'>): DepositController {
  return createDepositController({ ...opts, expect: 'withdraw' })
}

export async function resolveClientSecret(src: ClientSecretSource): Promise<string> {
  return typeof src === 'function' ? await src() : src
}

export type OpenDepositOptions = {
  baseUrl: string
  clientSecret: ClientSecretSource
  wallet?: WalletAdapter
  theme?: Theme
  appearance?: Appearance
  /** Partial message catalog. Overrides the locale catalog key by key. */
  messages?: Partial<Messages>
  /**
   * BCP 47 locale, e.g. `vi`, `id`, `th`, `ms`, `fil` or `en`. Picks the built-in catalog and the number format.
   * Default: the session locale from the server, then English.
   */
  locale?: string
  /** Where to mount the element. Default: `document.body` */
  container?: HTMLElement
  /** Render inline in `container`, without the overlay */
  embedded?: boolean
  /** Renderers for PROVIDER_SDK surfaces, e.g. `{ stripe: stripeOnrampRenderer() }` */
  providerRenderers?: Record<string, ProviderRenderer>
  onEvent?: (e: ClientEvent) => void
  /** Called once when the modal closes, with the last session state */
  onClose?: (session: PublicSession | undefined) => void
  fetch?: typeof fetch
}

export type DepositHandle = {
  element: OpenRampModal
  /** Resolves with the controller once the client secret is known */
  ready: Promise<DepositController>
  /** The controller, or undefined while the client secret is loading */
  readonly controller: DepositController | undefined
  /**
   * Resolves with the session when the deposit completes (the modal can stay open on the success screen).
   * Rejects with an `OpenRampError` when the modal closes before completion.
   */
  done: Promise<PublicSession>
  close(): void
}

export type OpenWithdrawOptions = OpenDepositOptions
export type WithdrawHandle = DepositHandle

/** Mount `<openramp-modal>`, start a deposit session and return a handle. Browser only. */
export function openDeposit(opts: OpenDepositOptions): DepositHandle {
  return openSession(opts, 'deposit')
}

/**
 * Mount `<openramp-modal>` for a withdraw session (create it on your server with
 * `direction: 'withdraw'` and a `source`) and return a handle. Browser only.
 * `done` resolves when the withdrawal completes and rejects when the modal closes first.
 */
export function openWithdraw(opts: OpenWithdrawOptions): WithdrawHandle {
  return openSession(opts, 'withdraw')
}

function openSession(opts: OpenDepositOptions, kind: Direction): DepositHandle {
  defineOpenRampModal()
  const el = document.createElement('openramp-modal') as OpenRampModal
  if (opts.theme) el.theme = opts.theme
  if (opts.appearance) el.appearance = opts.appearance
  if (opts.messages) el.messages = opts.messages
  if (opts.locale) el.locale = opts.locale
  if (opts.providerRenderers) el.providerRenderers = opts.providerRenderers
  el.embedded = !!opts.embedded
  el.open = true
  ;(opts.container ?? document.body).appendChild(el)

  let controller: DepositController | undefined
  let settled = false
  let finished = false
  let unsub: (() => void) | undefined
  let resolveDone!: (s: PublicSession) => void
  let rejectDone!: (e: OpenRampError) => void
  const done = new Promise<PublicSession>((res, rej) => {
    resolveDone = res
    rejectDone = rej
  })
  done.catch(() => {})

  const ready = (async () => {
    const secret = await resolveClientSecret(opts.clientSecret)
    if (finished) throw openRampError(CLOSED_CODE, { message: `The ${kind} was closed.` })
    const c = createDepositController({
      baseUrl: opts.baseUrl,
      clientSecret: secret,
      ...(opts.wallet ? { wallet: opts.wallet } : {}),
      ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      // Offer PROVIDER_SDK methods (e.g. Stripe's onramp element) only when the app gave a renderer.
      ...(opts.providerRenderers && Object.keys(opts.providerRenderers).length ? { surfaces: [...SUPPORTED_SURFACES, 'PROVIDER_SDK' as const] } : {}),
      expect: kind,
    })
    controller = c
    unsub = c.subscribe(() => {
      const s = c.getSnapshot().session
      if (!settled && s?.step.state === 'COMPLETED') {
        settled = true
        resolveDone(s)
      }
    })
    el.controller = c
    void c.start()
    return c
  })()
  ready.catch((e) => {
    if (!finished) el.error = toOpenRampError(e)
  })

  const finish = () => {
    if (finished) return
    finished = true
    el.removeEventListener('openramp-close', finish)
    unsub?.()
    el.remove()
    const snap = controller?.getSnapshot()
    if (!settled) {
      settled = true
      rejectDone(
        snap?.session?.step.error ?? snap?.error ?? el.error ?? openRampError(CLOSED_CODE, { message: `The ${kind === 'withdraw' ? 'withdrawal' : 'deposit'} was closed before it finished.` }),
      )
    }
    opts.onClose?.(snap?.session)
  }
  el.addEventListener('openramp-close', finish)

  return {
    element: el,
    ready,
    get controller() {
      return controller
    },
    done,
    close() {
      if (finished) return
      el.close()
      finish()
    },
  }
}
