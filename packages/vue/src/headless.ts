import { shallowRef, toValue, watch } from 'vue'
import type { MaybeRefOrGetter, ShallowRef } from 'vue'
import type { DepositController, Snapshot } from '@openrampkit/client'

/**
 * Subscribe to a `DepositController` and return its snapshot as a shallow ref. For fully custom UIs.
 * `controller` can be a value, a ref or a getter. The value is `undefined` while there is no controller.
 */
export function useDepositController(controller: MaybeRefOrGetter<DepositController | undefined | null>): Readonly<ShallowRef<Snapshot | undefined>> {
  const snap = shallowRef<Snapshot | undefined>(toValue(controller)?.getSnapshot())
  watch(
    () => toValue(controller),
    (c, _old, onCleanup) => {
      snap.value = c?.getSnapshot()
      // Do not subscribe during server rendering: nothing would unsubscribe.
      if (!c || typeof window === 'undefined') return
      onCleanup(c.subscribe(() => (snap.value = c.getSnapshot())))
    },
    { immediate: true },
  )
  return snap
}
