// @vitest-environment happy-dom
// Svelte stores, actions and context helpers. Actions are plain functions, so they run on DOM nodes without the compiler.
// The global fetch is stubbed to call the real server handler (mock adapter) in-process.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DepositController } from '@openrampkit/client'
import type { ClientEvent } from '@openrampkit/core'
import type { OpenRampModal } from '@openrampkit/web'
import { BASE, BASE_SOURCE, fakeClient, session, setupServer, sleep } from '../../client/src/testctx.js'

// A component-free stand-in for Svelte's context API.
const svelte = vi.hoisted(() => ({ ctx: new Map<unknown, unknown>(), destroy: [] as (() => void)[] }))
vi.mock('svelte', () => ({
  setContext: (k: unknown, v: unknown) => svelte.ctx.set(k, v),
  getContext: (k: unknown) => svelte.ctx.get(k),
  hasContext: (k: unknown) => svelte.ctx.has(k),
  onDestroy: (fn: () => void) => svelte.destroy.push(fn),
}))

import { createOpenRamp, darkTheme, depositButton, depositControllerStore, getOpenRamp, lightTheme, openRampEmbedded, setOpenRamp, withdrawButton } from './index.js'

let server: ReturnType<typeof setupServer>

beforeEach(() => {
  server = setupServer()
  vi.stubGlobal('fetch', server.fetch)
})

afterEach(() => {
  document.body.innerHTML = ''
  svelte.ctx.clear()
  svelte.destroy.length = 0
  vi.unstubAllGlobals()
})

const newSecret = async () => (await server.ramp.sessions.create({ userId: 'u', country: 'VN', destination: { type: 'merchant', currency: 'VND' } })).clientSecret
const withdrawSecret = async () => (await server.ramp.sessions.create({ userId: 'u', direction: 'withdraw', source: BASE_SOURCE, country: 'PH' })).clientSecret
const modal = () => document.querySelector<OpenRampModal>('openramp-modal')

async function until(fn: () => boolean, ms = 6000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('until: timeout')
    await sleep(10)
  }
}

async function payVietQr(c: DepositController) {
  await until(() => c.getSnapshot().screen === 'methods')
  c.setTab('cash')
  await c.selectMethod('vietqr')
  c.setAmount('200000')
  await c.submitAmount()
  await c.confirm()
  await c.fire('simulate_payment')
}

function button() {
  const b = document.createElement('button')
  document.body.appendChild(b)
  return b
}

describe('createOpenRamp', () => {
  it('beginDeposit opens the modal on body; isOpen follows; close() removes it and rejects', async () => {
    const events: string[] = []
    const perCall: string[] = []
    const ramp = createOpenRamp({ baseUrl: BASE, theme: lightTheme(), onEvent: (e: ClientEvent) => events.push(e.type) })
    const seen: boolean[] = []
    const off = ramp.isOpen.subscribe((v) => seen.push(v))
    expect(seen).toEqual([false])
    const p = ramp.beginDeposit({ clientSecret: await newSecret(), onEvent: (e) => perCall.push(e.type) })
    p.catch(() => {})
    await until(() => !!modal())
    expect(modal()!.parentElement).toBe(document.body)
    expect(modal()!.theme?.mode).toBe('light')
    expect(seen).toEqual([false, true])
    await until(() => modal()!.controller?.getSnapshot().screen === 'methods')
    expect(events).toContain('modal.opened')
    expect(perCall).toContain('modal.opened')
    ramp.close()
    expect(modal()).toBeNull()
    expect(seen).toEqual([false, true, false])
    await expect(p).rejects.toMatchObject({ code: 'CLOSED' })
    off()
  })

  it('beginDeposit resolves when the deposit completes', async () => {
    const ramp = createOpenRamp({ baseUrl: BASE })
    const secret = await newSecret()
    const p = ramp.beginDeposit({ clientSecret: async () => secret })
    await until(() => !!modal()?.controller)
    await payVietQr(modal()!.controller!)
    await expect(p).resolves.toMatchObject({ step: { state: 'COMPLETED' } })
  })

  it('beginWithdraw opens a withdraw session; a second call replaces the first modal', async () => {
    const ramp = createOpenRamp({ baseUrl: BASE })
    const first = ramp.beginWithdraw({ clientSecret: await withdrawSecret() })
    first.catch(() => {})
    await until(() => !!modal()?.controller?.getSnapshot().session)
    expect(modal()!.controller!.getSnapshot().session?.direction).toBe('withdraw')
    const el1 = modal()
    void ramp.beginDeposit({ clientSecret: await newSecret() }).catch(() => {})
    await until(() => document.querySelectorAll('openramp-modal').length === 1 && modal() !== el1)
    await expect(first).rejects.toBeDefined()
    let open = false
    ramp.isOpen.subscribe((v) => (open = v))()
    expect(open).toBe(true)
  })

  it('update() merges config and keeps theme, appearance and locale live while open', async () => {
    const ramp = createOpenRamp({ baseUrl: BASE, theme: lightTheme(), locale: 'vi' })
    void ramp.beginDeposit({ clientSecret: await newSecret() }).catch(() => {})
    await until(() => !!modal())
    expect(modal()!.locale).toBe('vi')
    ramp.update({ theme: darkTheme(), appearance: { title: 'dark' }, locale: 'th' })
    expect(modal()!.theme?.mode).toBe('dark')
    expect(modal()!.appearance?.title).toBe('dark')
    expect(modal()!.locale).toBe('th')
    let baseUrl = ''
    ramp.config.subscribe((c) => (baseUrl = c.baseUrl))()
    expect(baseUrl).toBe(BASE)
  })
})

describe('setOpenRamp and getOpenRamp', () => {
  it('shares a ramp through context and closes it on destroy', async () => {
    const ramp = setOpenRamp({ baseUrl: BASE })
    expect(getOpenRamp()).toBe(ramp)
    void ramp.beginDeposit({ clientSecret: await newSecret() }).catch(() => {})
    await until(() => !!modal())
    for (const fn of svelte.destroy) fn()
    expect(modal()).toBeNull()
  })

  it('accepts an existing ramp and does not close it on destroy', () => {
    const ramp = createOpenRamp({ baseUrl: BASE })
    expect(setOpenRamp(ramp)).toBe(ramp)
    expect(svelte.destroy).toHaveLength(0)
  })

  it('getOpenRamp throws without setOpenRamp', () => {
    expect(() => getOpenRamp()).toThrow('call setOpenRamp()')
  })
})

describe('depositButton and withdrawButton actions', () => {
  it('opens the modal on click, disables the button while open, and reports close as an error', async () => {
    const ramp = createOpenRamp({ baseUrl: BASE })
    const onError = vi.fn()
    const b = button()
    const action = depositButton(b, { ramp, getClientSecret: await newSecret(), onError })
    expect(b.disabled).toBe(false)
    b.click()
    await until(() => !!modal())
    expect(b.disabled).toBe(true)
    modal()!.close()
    await until(() => onError.mock.calls.length === 1)
    expect(onError.mock.calls[0]![0]).toMatchObject({ code: 'CLOSED' })
    expect(b.disabled).toBe(false)
    action.update({ ramp, getClientSecret: 'x', disabled: true })
    expect(b.disabled).toBe(true)
    action.destroy()
    b.click()
    await sleep(20)
    expect(modal()).toBeNull()
  })

  it('calls onComplete and forwards onEvent', async () => {
    const ramp = createOpenRamp({ baseUrl: BASE })
    const secret = await newSecret()
    const onComplete = vi.fn()
    const onEvent = vi.fn()
    const b = button()
    depositButton(b, { ramp, getClientSecret: async () => secret, onComplete, onEvent })
    b.click()
    await until(() => !!modal()?.controller)
    await payVietQr(modal()!.controller!)
    await until(() => onComplete.mock.calls.length === 1)
    expect(onComplete.mock.calls[0]![0].step.state).toBe('COMPLETED')
    expect(onEvent).toHaveBeenCalled()
  })

  it('withdrawButton opens a withdraw session and follows a new ramp on update', async () => {
    const a = createOpenRamp({ baseUrl: BASE })
    const b2 = createOpenRamp({ baseUrl: BASE })
    const secret = await withdrawSecret()
    const b = button()
    const action = withdrawButton(b, { ramp: a, getClientSecret: secret })
    action.update({ ramp: b2, getClientSecret: secret })
    b.click()
    await until(() => !!modal()?.controller?.getSnapshot().session)
    expect(modal()!.controller!.getSnapshot().session?.direction).toBe('withdraw')
    expect(b.disabled).toBe(true)
    a.close()
    expect(b.disabled).toBe(true)
  })

  it('works on elements without a disabled property', async () => {
    const ramp = createOpenRamp({ baseUrl: BASE })
    const a = document.createElement('a')
    document.body.appendChild(a)
    depositButton(a, { ramp, getClientSecret: await newSecret() })
    a.click()
    await until(() => !!modal())
    expect('disabled' in a).toBe(false)
  })
})

describe('openRampEmbedded action', () => {
  it('adds <openramp-modal embedded> to a container, takes ramp values, and calls onComplete', async () => {
    const secret = await newSecret()
    const providerEvent = vi.fn()
    const ramp = createOpenRamp({ baseUrl: BASE, theme: darkTheme(), locale: 'ms', onEvent: providerEvent })
    const onComplete = vi.fn()
    const onController = vi.fn()
    const onEvent = vi.fn()
    const div = document.createElement('div')
    document.body.appendChild(div)
    const action = openRampEmbedded(div, { ramp, clientSecret: secret, onComplete, onController, onEvent })
    const el = div.querySelector<OpenRampModal>('openramp-modal')!
    expect(el.hasAttribute('embedded')).toBe(true)
    await until(() => !!el.controller)
    expect(el.embedded).toBe(true)
    expect(el.theme?.mode).toBe('dark')
    expect(el.locale).toBe('ms')
    expect(onController).toHaveBeenCalledWith(el.controller)
    ramp.update({ locale: 'th' })
    expect(el.locale).toBe('th')
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('.overlay')).toBeNull()
    await payVietQr(el.controller!)
    await until(() => onComplete.mock.calls.length === 1)
    expect(onComplete.mock.calls[0]![0].step.state).toBe('COMPLETED')
    expect(onEvent).toHaveBeenCalled()
    expect(providerEvent).toHaveBeenCalled()
    action.destroy()
    expect(div.querySelector('openramp-modal')).toBeNull()
  })

  it('works on <openramp-modal> with baseUrl, and reports close', async () => {
    const secret = await newSecret()
    const onClose = vi.fn()
    const el = document.createElement('openramp-modal') as OpenRampModal
    document.body.appendChild(el)
    const action = openRampEmbedded(el, { baseUrl: BASE, clientSecret: async () => secret, onClose, messages: { title: 'Nạp' }, locale: 'fil' })
    await until(() => !!el.controller)
    expect(el.messages?.title).toBe('Nạp')
    expect(el.locale).toBe('fil')
    el.dispatchEvent(new CustomEvent('openramp-close', { detail: { session: { id: 's' } } }))
    expect(onClose).toHaveBeenCalledWith({ id: 's' })
    el.dispatchEvent(new CustomEvent('openramp-close'))
    expect(onClose).toHaveBeenLastCalledWith(undefined)
    action.destroy()
    expect(el.isConnected).toBe(true)
  })

  it('shows the error when the client secret cannot load', async () => {
    const el = document.createElement('openramp-modal') as OpenRampModal
    document.body.appendChild(el)
    openRampEmbedded(el, { baseUrl: BASE, clientSecret: () => Promise.reject(new Error('No session')) })
    await until(() => !!el.error)
    expect(el.error).toMatchObject({ code: 'INTERNAL', message: 'No session' })
  })

  it('a new clientSecret string creates a new controller; other updates do not; destroy destroys it', async () => {
    const a = await newSecret()
    const b = await newSecret()
    const seen: DepositController[] = []
    const onController = (c: DepositController) => seen.push(c)
    const el = document.createElement('openramp-modal') as OpenRampModal
    document.body.appendChild(el)
    const action = openRampEmbedded(el, { baseUrl: BASE, clientSecret: a, onController })
    await until(() => seen.length === 1)
    action.update({ baseUrl: BASE, clientSecret: a, onController, locale: 'vi' })
    expect(el.locale).toBe('vi')
    await sleep(30)
    expect(seen).toHaveLength(1)
    const destroy = vi.spyOn(seen[0]!, 'destroy')
    action.update({ baseUrl: BASE, clientSecret: b, onController })
    await until(() => seen.length === 2)
    expect(destroy).toHaveBeenCalled()
    expect(el.controller).toBe(seen[1])
    const destroy2 = vi.spyOn(seen[1]!, 'destroy')
    action.destroy()
    expect(destroy2).toHaveBeenCalled()
  })

  it('throws without baseUrl or ramp', () => {
    const el = document.createElement('openramp-modal')
    expect(() => openRampEmbedded(el, { clientSecret: 'x' })).toThrow('needs `baseUrl` or `ramp`')
  })
})

describe('depositControllerStore', () => {
  it('emits snapshots, stops after unsubscribe, and handles no controller', async () => {
    let none: unknown = 'x'
    depositControllerStore(undefined).subscribe((v) => (none = v))()
    expect(none).toBeUndefined()
    const c = new DepositController({ client: fakeClient({ getSession: vi.fn(async () => session('SELECT_METHOD')) }), clientSecret: 'ors_1.sig' })
    const seen: string[] = []
    const off = depositControllerStore(c).subscribe((s) => seen.push(`${s!.screen}:${s!.tab}`))
    expect(seen[0]).toMatch(/^loading/)
    await c.start()
    c.setTab('cash')
    expect(seen.at(-1)).toBe('methods:cash')
    off()
    const n = seen.length
    c.setTab('crypto')
    expect(seen).toHaveLength(n)
  })
})
