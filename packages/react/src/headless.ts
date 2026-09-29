import { useSyncExternalStore } from 'react'
import type { DepositController, Snapshot } from '@openrampkit/client'

const noopSubscribe = () => () => {}
const none = () => undefined

/** Subscribe to a `DepositController` and return its snapshot. For fully custom UIs. */
export function useDepositController(controller: DepositController): Snapshot
export function useDepositController(controller: DepositController | undefined | null): Snapshot | undefined
export function useDepositController(controller: DepositController | undefined | null): Snapshot | undefined {
  return useSyncExternalStore(
    controller ? controller.subscribe : noopSubscribe,
    controller ? controller.getSnapshot : none,
    controller ? controller.getSnapshot : none,
  )
}
