// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DepositController } from '@openrampkit/client'
import type { Surface } from '@openrampkit/core'
import { fakeClient, session, step, waitFor } from '../../client/src/testctx.js'
import { OpenRampModal, defineOpenRampModal, loadScript, stripeOnrampRenderer } from './index.js'
import type { ProviderRenderer } from './index.js'

defineOpenRampModal()

const SDK: Surface = { kind: 'PROVIDER_SDK', provider: 'stripe', params: { clientSecret: 'cos_1_secret', publishableKey: 'pk_test_1', redirectUrl: 'https://crypto.link.com/x' } }

async function mount(surface: Surface, renderers?: Record<string, ProviderRenderer>) {
  const client = fakeClient({
    getSession: vi.fn(async () => session(step({ state: 'PAYMENT', surface, transitions: [{ name: 'poll', kind: 'AWAIT', poll: { intervalMs: 60_000, backoff: 1, maxIntervalMs: 60_000, giveUpAfterMs: 600_000 } }] }))),
  })
  const controller = new DepositController({ client, clientSecret: 'ors_1.s' })
  const el = document.createElement('openramp-modal') as OpenRampModal
  if (renderers) el.providerRenderers = renderers
  el.embedded = true
  el.controller = controller
  document.body.appendChild(el)
  await controller.start()
  await el.updateComplete
  await el.updateComplete
  return { el, controller, client, root: el.shadowRoot! }
}

afterEach(() => {
  document.body.innerHTML = ''
  delete (globalThis as { StripeOnramp?: unknown }).StripeOnramp
})

describe('PROVIDER_SDK surfaces', () => {
  it('mounts the provider renderer once per step, with the surface and theme mode', async () => {
    const renderer = vi.fn<ProviderRenderer>((container, ctx) => {
      container.textContent = `mounted ${String(ctx.surface.params.clientSecret)} ${ctx.mode}`
    })
    const { el, root } = await mount(SDK, { stripe: renderer })
    await waitFor(() => renderer.mock.calls.length === 1)
    expect(root.querySelector('.provider-sdk')!.textContent).toBe('mounted cos_1_secret light')
    el.requestUpdate()
    await el.updateComplete
    expect(renderer).toHaveBeenCalledTimes(1)
  })

  it('renderer callbacks trigger an immediate status check; cleanup runs on unmount', async () => {
    const cleanup = vi.fn()
    let done!: (d?: unknown) => void
    const renderer: ProviderRenderer = (_c, ctx) => {
      done = ctx.completed
      return cleanup
    }
    const { el, client } = await mount(SDK, { stripe: renderer })
    await waitFor(() => typeof done === 'function')
    const before = client.step.mock.calls.length
    done('fulfillment_complete')
    await waitFor(() => client.step.mock.calls.length > before)
    await new Promise((r) => setTimeout(r, 0))
    el.remove()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('shows an error when the renderer fails', async () => {
    const { el, root } = await mount(SDK, { stripe: async () => { throw new Error('blocked by CSP') } })
    await waitFor(() => !!(el as unknown as { _sdkError?: string })._sdkError)
    await el.updateComplete
    expect(root.querySelector('.notice.error')!.textContent).toContain('Stripe could not load')
  })

  it('without a renderer: uses redirectUrl when given, else says the SDK is not supported', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const { root } = await mount(SDK)
    const btn = [...root.querySelectorAll('button')].find((b) => b.textContent?.includes('Continue to Stripe'))!
    btn.click()
    expect(open).toHaveBeenCalledWith('https://crypto.link.com/x', '_blank')
    document.body.innerHTML = ''
    const bare = await mount({ kind: 'PROVIDER_SDK', provider: 'other', params: {} })
    expect(bare.root.querySelector('.notice.info')!.textContent).toContain('Other SDK')
  })
})

describe('stripeOnrampRenderer', () => {
  it('loads the Stripe scripts, creates the session and maps status events', async () => {
    const loaded: string[] = []
    const listeners: Record<string, (e: unknown) => void> = {}
    const mountFn = vi.fn()
    const createSession = vi.fn(() => ({ mount: mountFn, addEventListener: (t: string, cb: (e: unknown) => void) => (listeners[t] = cb) }))
    ;(globalThis as { StripeOnramp?: unknown }).StripeOnramp = vi.fn(() => ({ createSession }))
    const completed = vi.fn()
    const failed = vi.fn()
    const container = document.createElement('div')
    await stripeOnrampRenderer({ load: async (src) => void loaded.push(src) })(container, { surface: SDK as never, mode: 'dark', completed, failed })
    expect(loaded).toEqual(['https://js.stripe.com/v3/', 'https://crypto-js.stripe.com/crypto-onramp-outer.js'])
    expect((globalThis as unknown as { StripeOnramp: ReturnType<typeof vi.fn> }).StripeOnramp).toHaveBeenCalledWith('pk_test_1')
    expect(createSession).toHaveBeenCalledWith({ clientSecret: 'cos_1_secret', appearance: { theme: 'dark' } })
    expect(mountFn).toHaveBeenCalledWith(container)
    listeners.onramp_session_updated!({ payload: { session: { status: 'fulfillment_complete' } } })
    listeners.onramp_session_updated!({ payload: { session: { status: 'rejected' } } })
    listeners.onramp_session_updated!({ payload: { session: { status: 'requires_payment' } } })
    expect(completed).toHaveBeenCalledTimes(1)
    expect(failed).toHaveBeenCalledTimes(1)
  })

  it('fails clearly without keys or when the SDK does not load', async () => {
    const ctx = { mode: 'light' as const, completed: vi.fn(), failed: vi.fn() }
    const r = stripeOnrampRenderer({ load: async () => {} })
    await expect(r(document.createElement('div'), { ...ctx, surface: { kind: 'PROVIDER_SDK', provider: 'stripe', params: {} } })).rejects.toThrow(/clientSecret/)
    await expect(r(document.createElement('div'), { ...ctx, surface: SDK as never })).rejects.toThrow(/did not load/)
  })

  it('loadScript adds each script once and rejects on error', async () => {
    // Keep the tags out of the document so happy-dom does not fetch them.
    const added: HTMLScriptElement[] = []
    const spy = vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(n: T) => (added.push(n as unknown as HTMLScriptElement), n))
    try {
      const p1 = loadScript('https://example.test/a.js')
      const p2 = loadScript('https://example.test/a.js')
      expect(p1).toBe(p2)
      expect(added).toHaveLength(1)
      expect(added[0]!.src).toBe('https://example.test/a.js')
      added[0]!.onload!(new Event('load'))
      await expect(p1).resolves.toBeUndefined()
      const p3 = loadScript('https://example.test/b.js')
      added[1]!.onerror!(new Event('error'))
      await expect(p3).rejects.toThrow(/Could not load/)
    } finally {
      spy.mockRestore()
    }
  })
})
