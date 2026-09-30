import type { PublicSession } from '@openrampkit/core'
import type { DepositController, Snapshot } from '@openrampkit/client'
import { createRampCore } from './ramp.js'
import type { BeginDepositOptions, BeginWithdrawOptions, OpenRampConfig } from './ramp.js'
import { writable } from './store.js'
import type { Readable } from './store.js'

export type OpenRamp = {
  /** Opens the modal. Resolves with the session when the deposit completes; rejects if the modal closes first. */
  beginDeposit(opts: BeginDepositOptions): Promise<PublicSession>
  /**
   * Opens the modal for a withdraw session (created on your server with `direction: 'withdraw'`).
   * Resolves with the session when the withdrawal completes; rejects if the modal closes first.
   */
  beginWithdraw(opts: BeginWithdrawOptions): Promise<PublicSession>
  close(): void
  /** Store: whether the modal is open. Use `$isOpen` in a component. */
  isOpen: Readable<boolean>
  /** Store: the current config */
  config: Readable<OpenRampConfig>
  /** Merge new config values. Theme, appearance and locale changes reach an open modal. */
  update(config: Partial<OpenRampConfig>): void
}

/**
 * Create the modal state for your app. Works without a component: call it in a module, a load function or a component.
 * Nothing loads in the browser until `beginDeposit` or `beginWithdraw` runs.
 */
export function createOpenRamp(config: OpenRampConfig): OpenRamp {
  const isOpen = writable(false)
  const cfg = writable<OpenRampConfig>({ ...config })
  const core = createRampCore(cfg.get, isOpen.set)
  return {
    beginDeposit: core.beginDeposit,
    beginWithdraw: core.beginWithdraw,
    close: core.close,
    isOpen: { subscribe: isOpen.subscribe },
    config: { subscribe: cfg.subscribe },
    update(next) {
      cfg.set({ ...cfg.get(), ...next })
      core.sync()
    },
  }
}

/**
 * A store with the snapshot of a `DepositController`, for fully custom UIs. `undefined` while there is no controller.
 * Use `$snapshot` in a component.
 */
export function depositControllerStore(controller: DepositController | undefined | null): Readable<Snapshot | undefined> {
  return {
    subscribe(run) {
      if (!controller) {
        run(undefined)
        return () => {}
      }
      run(controller.getSnapshot())
      return controller.subscribe(() => run(controller.getSnapshot()))
    },
  }
}
