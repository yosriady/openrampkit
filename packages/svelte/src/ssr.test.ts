// SSR safety (SvelteKit): import and use the package on the server (node, no window). Nothing may load Lit or @openrampkit/web.
import { describe, expect, it, vi } from 'vitest'

const loaded = vi.hoisted(() => ({ web: false, lit: false }))
vi.mock('@openrampkit/web', () => {
  loaded.web = true
  return {}
})
vi.mock('lit', () => {
  loaded.lit = true
  return {}
})

import { createOpenRamp, darkTheme, depositControllerStore } from './index.js'
import { loadWeb } from './load.js'

describe('server rendering', () => {
  it('creates a ramp and reads its stores without window or Lit', async () => {
    expect(typeof window).toBe('undefined')
    const ramp = createOpenRamp({ baseUrl: '/api/openramp', theme: darkTheme() })
    let open: boolean | undefined
    ramp.isOpen.subscribe((v) => (open = v))()
    expect(open).toBe(false)
    let snap: unknown = 'x'
    depositControllerStore(null).subscribe((v) => (snap = v))()
    expect(snap).toBeUndefined()
    await expect(ramp.beginDeposit({ clientSecret: 'x' })).rejects.toThrow('can only open in the browser')
    ramp.close()
    expect(loaded).toEqual({ web: false, lit: false })
  })

  it('loadWeb refuses to run on the server', async () => {
    await expect(loadWeb()).rejects.toThrow('can only open in the browser')
    expect(loaded.web).toBe(false)
  })
})
