import { createEffect, createSignal, onCleanup, untrack } from 'solid-js'
import type { Accessor } from 'solid-js'
import type { DepositController, Snapshot } from '@openrampkit/client'

type MaybeAccessor<T> = T | Accessor<T>

/**
 * Subscribe to a `DepositController` and return its snapshot as an accessor. For fully custom UIs.
 * `controller` can be a value or an accessor. The snapshot is `undefined` while there is no controller.
 */
export function useDepositController(controller: MaybeAccessor<DepositController | undefined | null>): Accessor<Snapshot | undefined> {
  const get = typeof controller === 'function' ? controller : () => controller
  const [snap, setSnap] = createSignal<Snapshot | undefined>(untrack(get)?.getSnapshot())
  // Effects do not run during server rendering, so nothing subscribes there.
  createEffect(() => {
    const c = get()
    setSnap(() => c?.getSnapshot())
    if (c) onCleanup(c.subscribe(() => setSnap(() => c.getSnapshot())))
  })
  return snap
}
