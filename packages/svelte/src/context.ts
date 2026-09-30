import { getContext, hasContext, onDestroy, setContext } from 'svelte'
import { createOpenRamp } from './openramp.js'
import type { OpenRamp } from './openramp.js'
import type { OpenRampConfig } from './ramp.js'

const KEY = Symbol.for('@openrampkit/svelte')

/**
 * Share an `OpenRamp` with child components. Call it during component initialization, for example in your root layout.
 * Pass a config (a new `OpenRamp` is created and closes when the component is destroyed) or an existing `OpenRamp`.
 */
export function setOpenRamp(configOrRamp: OpenRampConfig | OpenRamp): OpenRamp {
  const created = !('beginDeposit' in configOrRamp)
  const ramp = created ? createOpenRamp(configOrRamp) : configOrRamp
  setContext(KEY, ramp)
  if (created) onDestroy(() => ramp.close())
  return ramp
}

/** The `OpenRamp` from `setOpenRamp()`. Call it during component initialization. Throws when there is none. */
export function getOpenRamp(): OpenRamp {
  if (!hasContext(KEY)) throw new Error('@openrampkit/svelte: call setOpenRamp() in a parent component first.')
  return getContext<OpenRamp>(KEY)
}
