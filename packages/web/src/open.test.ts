// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BASE, BASE_DEST, setupServer, sleep, waitFor } from '../../client/src/testctx.js'
import { CLOSED_CODE, OpenRampModal, SUPPORTED_SURFACES, createDepositController, darkTheme, openDeposit, resolveClientSecret } from './index.js'
import type { DepositHandle } from './index.js'

const handles: DepositHandle[] = []
afterEach(() => {
  for (const h of handles.splice(0)) h.close()
  document.body.innerHTML = ''
})

async function session(country = 'VN', destination: Parameters<ReturnType<typeof setupServer>['ramp']['sessions']['create']>[0]['destination'] = { type: 'merchant', currency: 'VND' }) {
  const server = setupServer()
  const s = await server.ramp.sessions.create({ userId: 'u', country, destination })
  return { ...server, secret: s.clientSecret }
}

function open(opts: Parameters<typeof openDeposit>[0]) {
  const h = openDeposit(opts)
  handles.push(h)
  return h
}

describe('resolveClientSecret and createDepositController', () => {
  it('resolves strings and functions', async () => {
    expect(await resolveClientSecret('a.b')).toBe('a.b')
    expect(await resolveClientSecret(async () => 'c.d')).toBe('c.d')
  })

  it('plans with the supported surfaces by default, or the given ones', async () => {
    const { fetch, secret, requests } = await session()
    const c = createDepositController({ baseUrl: BASE, clientSecret: secret, fetch })
    await c.start()
    const plan = requests.find((r) => r.url.endsWith('/plan'))!
    expect((await plan.json()).surfaces).toEqual(SUPPORTED_SURFACES)
    const c2 = createDepositController({ baseUrl: BASE, clientSecret: secret, fetch, surfaces: ['QR'] })
    await c2.start()
    const plan2 = requests.filter((r) => r.url.endsWith('/plan'))[1]!
    expect((await plan2.json()).surfaces).toEqual(['QR'])
    c.destroy()
    c2.destroy()
  })
})

describe('openDeposit', () => {
  it('passes the locale option to the element', async () => {
    const { fetch, secret } = await session()
    const h = open({ baseUrl: BASE, clientSecret: secret, fetch, locale: 'vi' })
    expect(h.element.locale).toBe('vi')
    const c = await h.ready
    await waitFor(() => c.getSnapshot().screen === 'methods')
    await h.element.updateComplete
    expect(h.element.shadowRoot!.querySelector('.title')!.textContent?.trim()).toBe('Nạp tiền')
    const h2 = open({ baseUrl: BASE, clientSecret: secret, fetch })
    expect(h2.element.locale).toBeUndefined()
  })

  it('mounts on body with options, then resolves done when the deposit completes', async () => {
    const { fetch, secret } = await session()
    const events: string[] = []
    const onClose = vi.fn()
    const h = open({
      baseUrl: BASE,
      clientSecret: secret,
      fetch,
      theme: darkTheme(),
      appearance: { title: 'Pay' },
      messages: { done: 'Finish' },
      onEvent: (e) => events.push(e.type),
      onClose,
    })
    expect(h.element).toBeInstanceOf(OpenRampModal)
    expect(h.element.parentElement).toBe(document.body)
    expect(h.element.open).toBe(true)
    expect(h.element.embedded).toBe(false)
    expect(h.element.theme?.mode).toBe('dark')
    expect(h.element.appearance?.title).toBe('Pay')
    const c = await h.ready
    expect(h.controller).toBe(c)
    expect(h.element.controller).toBe(c)
    await waitFor(() => c.getSnapshot().screen === 'methods')
    c.setTab('cash')
    await c.selectMethod('vietqr')
    c.setAmount('200000')
    await c.submitAmount()
    await c.confirm()
    await c.fire('simulate_payment')
    const done = await h.done
    expect(done.step.state).toBe('COMPLETED')
    expect(events).toContain('modal.opened')
    // The modal stays on the success screen until the user closes it
    expect(h.element.isConnected).toBe(true)
    await h.element.updateComplete
    const btn = [...h.element.shadowRoot!.querySelectorAll('button')].find((b) => b.textContent?.includes('Finish'))!
    btn.click()
    expect(h.element.isConnected).toBe(false)
    expect(onClose).toHaveBeenCalledOnce()
    expect(onClose.mock.calls[0]![0].step.state).toBe('COMPLETED')
    await expect(h.done).resolves.toBeDefined()
  })

  it('close() removes the element and rejects done with CLOSED; a second close is a no-op', async () => {
    const { fetch, secret } = await session()
    const onClose = vi.fn()
    const h = open({ baseUrl: BASE, clientSecret: secret, fetch, onClose })
    const c = await h.ready
    await waitFor(() => c.getSnapshot().screen === 'methods')
    h.close()
    expect(h.element.isConnected).toBe(false)
    await expect(h.done).rejects.toMatchObject({ code: CLOSED_CODE })
    h.close()
    expect(onClose).toHaveBeenCalledOnce()
    expect(onClose.mock.calls[0]![0].step.state).toBe('SELECT_METHOD')
  })

  it('closing without any error rejects with the CLOSED code', async () => {
    const h = open({ baseUrl: BASE, clientSecret: () => new Promise<string>(() => {}) })
    h.close()
    await expect(h.done).rejects.toMatchObject({ code: CLOSED_CODE, message: 'The deposit was closed before it finished.' })
    expect(h.controller).toBeUndefined()
  })

  it('closing while the secret loads rejects ready with CLOSED and never creates a controller', async () => {
    const { fetch, secret } = await session()
    let release!: (s: string) => void
    const h = open({ baseUrl: BASE, clientSecret: () => new Promise<string>((r) => (release = r)), fetch })
    expect(h.controller).toBeUndefined()
    h.close()
    release(secret)
    await expect(h.ready).rejects.toMatchObject({ code: CLOSED_CODE })
    expect(h.controller).toBeUndefined()
    expect(h.element.error).toBeUndefined()
  })

  it('async clientSecret: shows loading, then the methods', async () => {
    const { fetch, secret } = await session('US', BASE_DEST)
    const h = open({ baseUrl: BASE, clientSecret: async () => (await sleep(5), secret), fetch })
    await h.element.updateComplete
    expect(h.element.shadowRoot!.querySelector('.skeleton')).not.toBeNull()
    const c = await h.ready
    await waitFor(() => c.getSnapshot().screen === 'methods')
    await h.element.updateComplete
    expect(h.element.shadowRoot!.querySelector('[data-method]')).not.toBeNull()
  })

  it('a failing clientSecret shows the error, and done rejects with it on close', async () => {
    const h = open({ baseUrl: BASE, clientSecret: async () => Promise.reject(new Error('Session endpoint down')) })
    await expect(h.ready).rejects.toThrow('Session endpoint down')
    await sleep(0)
    expect(h.element.error).toMatchObject({ code: 'INTERNAL', message: 'Session endpoint down' })
    await h.element.updateComplete
    expect(h.element.shadowRoot!.textContent).toContain('Session endpoint down')
    h.close()
    await expect(h.done).rejects.toMatchObject({ message: 'Session endpoint down' })
  })

  it('embedded in a container, with a wallet', async () => {
    const { fetch, secret } = await session('US', BASE_DEST)
    const { createMockWallet } = await import('@openrampkit/client')
    const box = document.createElement('div')
    document.body.appendChild(box)
    const h = open({ baseUrl: BASE, clientSecret: secret, fetch, container: box, embedded: true, wallet: createMockWallet() })
    expect(h.element.parentElement).toBe(box)
    expect(h.element.embedded).toBe(true)
    const c = await h.ready
    await waitFor(() => c.getSnapshot().screen === 'methods')
    expect(c.getSnapshot().walletConnected).toBe(true)
    await h.element.updateComplete
    expect(h.element.shadowRoot!.querySelector('.overlay')).toBeNull()
  })

  it('Escape in the element finishes the handle like close()', async () => {
    const { fetch, secret } = await session()
    const onClose = vi.fn()
    const h = open({ baseUrl: BASE, clientSecret: secret, fetch, onClose })
    const c = await h.ready
    await waitFor(() => c.getSnapshot().screen === 'methods')
    await h.element.updateComplete
    h.element.shadowRoot!.querySelector('.card')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }))
    expect(h.element.isConnected).toBe(false)
    expect(onClose).toHaveBeenCalledOnce()
    await expect(h.done).rejects.toBeDefined()
  })

  it('done rejects with the step error when the user closes after a failure', async () => {
    const { fetch, secret } = await session()
    const h = open({ baseUrl: BASE, clientSecret: secret, fetch })
    const c = await h.ready
    await waitFor(() => c.getSnapshot().screen === 'methods')
    // A server error on an action is kept in the snapshot and becomes the close reason
    await c.fire('no_such_transition')
    expect(c.getSnapshot().error).toBeDefined()
    h.close()
    await expect(h.done).rejects.toEqual(c.getSnapshot().error)
  })
})
