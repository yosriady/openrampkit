import { createOpenRampClient, DepositController } from '@openrampkit/client'
import { orkError } from '@openrampkit/core'
import type { OrkError, OrkEvent, PublicSession, SurfaceKind, WalletAdapter } from '@openrampkit/core'
import { defineOpenRampModal, OpenRampModal } from './element.js'
import type { Messages } from './messages.js'
import type { Appearance, Theme } from './theme.js'

/** Surfaces this UI can draw. The planner hides pathways that need anything else. */
export const SUPPORTED_SURFACES: SurfaceKind[] = ['REDIRECT', 'IFRAME', 'QR', 'DEEPLINK', 'BANK_FIELDS', 'DEPOSIT_ADDRESS', 'WALLET_TX', 'OTP', 'FORM']

/** Error code used when the user closes the modal before the deposit completes. */
export const CLOSED_CODE = 'CLOSED'

export type ClientSecretSource = string | (() => Promise<string>)

export type CreateControllerOptions = {
  baseUrl: string
  clientSecret: string
  wallet?: WalletAdapter
  onEvent?: (e: OrkEvent) => void
  /** Custom fetch, for tests and demos */
  fetch?: typeof fetch
  surfaces?: string[]
}

/** Create a `DepositController` for one session. Call `start()` on it to load the methods. */
export function createDepositController(opts: CreateControllerOptions): DepositController {
  const client = createOpenRampClient({ baseUrl: opts.baseUrl, ...(opts.fetch ? { fetch: opts.fetch } : {}) })
  return new DepositController({
    client,
    clientSecret: opts.clientSecret,
    surfaces: opts.surfaces ?? SUPPORTED_SURFACES,
    ...(opts.wallet ? { wallet: opts.wallet } : {}),
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
  })
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
  messages?: Partial<Messages>
  /** Where to mount the element. Default: `document.body` */
  container?: HTMLElement
  /** Render inline in `container`, without the overlay */
  embedded?: boolean
  onEvent?: (e: OrkEvent) => void
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
   * Rejects with an `OrkError` when the modal closes before completion.
   */
  done: Promise<PublicSession>
  close(): void
}

function toOrkError(e: unknown): OrkError {
  if (e && typeof e === 'object' && 'error' in e && e.error && typeof e.error === 'object' && 'code' in e.error) return e.error as OrkError
  return orkError('INTERNAL', { message: e instanceof Error ? e.message : String(e) })
}

/** Mount `<openramp-modal>`, start a deposit session and return a handle. Browser only. */
export function openDeposit(opts: OpenDepositOptions): DepositHandle {
  defineOpenRampModal()
  const el = document.createElement('openramp-modal') as OpenRampModal
  if (opts.theme) el.theme = opts.theme
  if (opts.appearance) el.appearance = opts.appearance
  if (opts.messages) el.messages = opts.messages
  el.embedded = !!opts.embedded
  el.open = true
  ;(opts.container ?? document.body).appendChild(el)

  let controller: DepositController | undefined
  let settled = false
  let finished = false
  let unsub: (() => void) | undefined
  let resolveDone!: (s: PublicSession) => void
  let rejectDone!: (e: OrkError) => void
  const done = new Promise<PublicSession>((res, rej) => {
    resolveDone = res
    rejectDone = rej
  })
  done.catch(() => {})

  const ready = (async () => {
    const secret = await resolveClientSecret(opts.clientSecret)
    if (finished) throw orkError(CLOSED_CODE, { message: 'The deposit was closed.' })
    const c = createDepositController({
      baseUrl: opts.baseUrl,
      clientSecret: secret,
      ...(opts.wallet ? { wallet: opts.wallet } : {}),
      ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
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
    if (!finished) el.error = toOrkError(e)
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
        snap?.session?.step.error ?? snap?.error ?? el.error ?? orkError(CLOSED_CODE, { message: 'The deposit was closed before it finished.' }),
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
