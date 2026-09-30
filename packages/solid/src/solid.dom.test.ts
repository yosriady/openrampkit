// Solid bindings with @solidjs/testing-library, on Solid's browser build (see the `solid-dom` project in vitest.config.ts).
// The global fetch is stubbed to call the real server handler (mock adapter) in-process.

import { cleanup, render } from '@solidjs/testing-library'
import { createComponent, createRenderEffect, createSignal } from 'solid-js'
import type { JSX } from 'solid-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DepositController } from '@openrampkit/client'
import type { OrkEvent } from '@openrampkit/core'
import type { OpenRampModal } from '@openrampkit/web'
import { BASE, BASE_SOURCE, fakeClient, session, setupServer, sleep } from '../../client/src/testctx.js'
import { DepositButton, OpenRampEmbedded, OpenRampProvider, WithdrawButton, darkTheme, lightTheme, useDepositController, useOpenRamp } from './index.js'
import type { OpenRampApi, OpenRampProviderProps, Theme } from './index.js'

let server: ReturnType<typeof setupServer>

beforeEach(() => {
  server = setupServer()
  vi.stubGlobal('fetch', server.fetch)
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
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

function Capture(props: { onApi: (api: OpenRampApi) => void }): JSX.Element {
  const api = useOpenRamp()
  props.onApi(api)
  const span = document.createElement('span')
  span.id = 'open'
  createRenderEffect(() => (span.textContent = api.isOpen() ? 'open' : 'closed'))
  return span
}

function withProvider(p: OpenRampProviderProps, child: () => JSX.Element) {
  return () =>
    createComponent(OpenRampProvider, {
      ...p,
      get children() {
        return child()
      },
    })
}

describe('OpenRampProvider and useOpenRamp', () => {
  it('beginDeposit opens the modal on body; close() removes it and rejects', async () => {
    let api!: OpenRampApi
    const events: string[] = []
    const perCall: string[] = []
    render(withProvider({ baseUrl: BASE, theme: lightTheme(), onEvent: (e: OrkEvent) => events.push(e.type) }, () => createComponent(Capture, { onApi: (a) => (api = a) })))
    const r = document.getElementById('open')!
    expect(r.textContent).toBe('closed')
    const p = api.beginDeposit({ clientSecret: await newSecret(), onEvent: (e) => perCall.push(e.type) })
    p.catch(() => {})
    await until(() => !!modal())
    expect(modal()!.parentElement).toBe(document.body)
    expect(modal()!.theme?.mode).toBe('light')
    expect(r.textContent).toBe('open')
    await until(() => modal()!.controller?.getSnapshot().screen === 'methods')
    expect(events).toContain('modal.opened')
    expect(perCall).toContain('modal.opened')
    api.close()
    expect(modal()).toBeNull()
    expect(r.textContent).toBe('closed')
    await expect(p).rejects.toMatchObject({ code: 'CLOSED' })
  })

  it('beginDeposit resolves when the deposit completes', async () => {
    let api!: OpenRampApi
    render(withProvider({ baseUrl: BASE }, () => createComponent(Capture, { onApi: (a) => (api = a) })))
    const secret = await newSecret()
    const p = api.beginDeposit({ clientSecret: async () => secret })
    await until(() => !!modal()?.controller)
    await payVietQr(modal()!.controller!)
    await expect(p).resolves.toMatchObject({ step: { state: 'COMPLETED' } })
  })

  it('beginWithdraw opens a withdraw session; a second call replaces the first modal', async () => {
    let api!: OpenRampApi
    render(withProvider({ baseUrl: BASE }, () => createComponent(Capture, { onApi: (a) => (api = a) })))
    const first = api.beginWithdraw({ clientSecret: await withdrawSecret() })
    first.catch(() => {})
    await until(() => !!modal()?.controller?.getSnapshot().session)
    expect(modal()!.controller!.getSnapshot().session?.direction).toBe('withdraw')
    const el1 = modal()
    void api.beginDeposit({ clientSecret: await newSecret() }).catch(() => {})
    await until(() => document.querySelectorAll('openramp-modal').length === 1 && modal() !== el1)
    await expect(first).rejects.toBeDefined()
    expect(api.isOpen()).toBe(true)
  })

  it('keeps theme, appearance and locale live while open, and closes the modal on unmount', async () => {
    let api!: OpenRampApi
    const [theme, setTheme] = createSignal<Theme>(lightTheme())
    const [locale, setLocale] = createSignal('vi')
    const r = render(() =>
      createComponent(OpenRampProvider, {
        baseUrl: BASE,
        get theme() {
          return theme()
        },
        get appearance() {
          return { title: theme().mode }
        },
        get locale() {
          return locale()
        },
        get children() {
          return createComponent(Capture, { onApi: (a) => (api = a) })
        },
      }),
    )
    void api.beginDeposit({ clientSecret: await newSecret() }).catch(() => {})
    await until(() => !!modal())
    expect(modal()!.locale).toBe('vi')
    setTheme(darkTheme())
    setLocale('th')
    expect(modal()!.theme?.mode).toBe('dark')
    expect(modal()!.appearance?.title).toBe('dark')
    expect(modal()!.locale).toBe('th')
    r.unmount()
    expect(modal()).toBeNull()
  })

  it('useOpenRamp outside a provider throws', () => {
    expect(() => render(() => createComponent(Capture, { onApi: () => {} }))).toThrow('wrap your app in <OpenRampProvider>')
  })
})

describe('DepositButton and WithdrawButton', () => {
  it('renders a Deposit button that opens the modal, is disabled while open, and calls onError on close', async () => {
    const secret = await newSecret()
    const onError = vi.fn()
    const r = render(withProvider({ baseUrl: BASE }, () => createComponent(DepositButton, { getClientSecret: secret, class: 'btn', onError })))
    const btn = r.container.querySelector('button')!
    expect(btn.textContent).toBe('Deposit')
    expect(btn.className).toBe('btn')
    expect(btn.disabled).toBe(false)
    btn.click()
    await until(() => !!modal())
    expect(btn.disabled).toBe(true)
    modal()!.close()
    await until(() => onError.mock.calls.length === 1)
    expect(onError.mock.calls[0]![0]).toMatchObject({ code: 'CLOSED' })
    expect(btn.disabled).toBe(false)
  })

  it('calls onComplete and forwards onEvent', async () => {
    const secret = await newSecret()
    const onComplete = vi.fn()
    const onEvent = vi.fn()
    const r = render(withProvider({ baseUrl: BASE }, () => createComponent(DepositButton, { getClientSecret: async () => secret, label: 'Top up', onComplete, onEvent })))
    const btn = r.container.querySelector('button')!
    expect(btn.textContent).toBe('Top up')
    btn.click()
    await until(() => !!modal()?.controller)
    await payVietQr(modal()!.controller!)
    await until(() => onComplete.mock.calls.length === 1)
    expect(onComplete.mock.calls[0]![0].step.state).toBe('COMPLETED')
    expect(onEvent).toHaveBeenCalled()
  })

  it('respects disabled', () => {
    const r = render(withProvider({ baseUrl: BASE }, () => createComponent(WithdrawButton, { getClientSecret: 'x', disabled: true })))
    const btn = r.container.querySelector('button')!
    expect(btn.disabled).toBe(true)
    expect(btn.textContent).toBe('Withdraw')
  })

  it('WithdrawButton opens a withdraw session', async () => {
    const secret = await withdrawSecret()
    const r = render(withProvider({ baseUrl: BASE }, () => createComponent(WithdrawButton, { getClientSecret: secret })))
    r.container.querySelector('button')!.click()
    await until(() => !!modal()?.controller?.getSnapshot().session)
    expect(modal()!.controller!.getSnapshot().session?.direction).toBe('withdraw')
  })

  it('DepositButton.Custom renders children with open and isOpen', async () => {
    const secret = await newSecret()
    let isOpen!: () => boolean
    const r = render(
      withProvider({ baseUrl: BASE }, () =>
        createComponent(DepositButton.Custom, {
          getClientSecret: secret,
          children: (p) => {
            isOpen = p.isOpen
            const a = document.createElement('a')
            a.textContent = 'Add funds'
            a.addEventListener('click', p.open)
            return a
          },
        }),
      ),
    )
    const a = r.container.querySelector('a')!
    expect(a.textContent).toBe('Add funds')
    expect(isOpen()).toBe(false)
    a.click()
    await until(() => !!modal())
    expect(isOpen()).toBe(true)
  })
})

describe('OpenRampEmbedded', () => {
  it('mounts <openramp-modal embedded> with a controller, takes provider values, and calls onComplete', async () => {
    const secret = await newSecret()
    const onComplete = vi.fn()
    const onController = vi.fn()
    const onEvent = vi.fn()
    const providerEvent = vi.fn()
    const r = render(
      withProvider({ baseUrl: BASE, theme: darkTheme(), locale: 'ms', onEvent: providerEvent }, () =>
        createComponent(OpenRampEmbedded, { clientSecret: secret, class: 'inline', style: { height: '500px' }, onComplete, onController, onEvent }),
      ),
    )
    const el = r.container.querySelector<OpenRampModal>('openramp-modal')!
    expect(el.className).toBe('inline')
    expect(el.style.height).toBe('500px')
    expect(el.hasAttribute('embedded')).toBe(true)
    await until(() => !!el.controller)
    expect(el.embedded).toBe(true)
    expect(el.theme?.mode).toBe('dark')
    expect(el.locale).toBe('ms')
    expect(onController).toHaveBeenCalledWith(el.controller)
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('.overlay')).toBeNull()
    await payVietQr(el.controller!)
    await until(() => onComplete.mock.calls.length === 1)
    expect(onComplete.mock.calls[0]![0].step.state).toBe('COMPLETED')
    expect(onEvent).toHaveBeenCalled()
    expect(providerEvent).toHaveBeenCalled()
  })

  it('works without a provider when baseUrl is given, and reports close', async () => {
    const secret = await newSecret()
    const onClose = vi.fn()
    const r = render(() => createComponent(OpenRampEmbedded, { baseUrl: BASE, clientSecret: async () => secret, onClose, messages: { title: 'Nạp' }, locale: 'fil' }))
    const el = r.container.querySelector<OpenRampModal>('openramp-modal')!
    await until(() => !!el.controller)
    expect(el.messages?.title).toBe('Nạp')
    expect(el.locale).toBe('fil')
    el.dispatchEvent(new CustomEvent('openramp-close', { detail: { session: { id: 's' } } }))
    expect(onClose).toHaveBeenCalledWith({ id: 's' })
    el.dispatchEvent(new CustomEvent('openramp-close'))
    expect(onClose).toHaveBeenLastCalledWith(undefined)
  })

  it('shows the error when the client secret cannot load', async () => {
    const r = render(() => createComponent(OpenRampEmbedded, { baseUrl: BASE, clientSecret: () => Promise.reject(new Error('No session')) }))
    const el = r.container.querySelector<OpenRampModal>('openramp-modal')!
    await until(() => !!el.error)
    expect(el.error).toMatchObject({ code: 'INTERNAL', message: 'No session' })
  })

  it('a new clientSecret string creates a new controller and destroys the old one; unmount destroys it too', async () => {
    const [secret, setSecret] = createSignal(await newSecret())
    const b = await newSecret()
    const seen: DepositController[] = []
    const r = render(() =>
      createComponent(OpenRampEmbedded, {
        baseUrl: BASE,
        get clientSecret() {
          return secret()
        },
        onController: (c) => seen.push(c),
      }),
    )
    await until(() => seen.length === 1)
    const destroy = vi.spyOn(seen[0]!, 'destroy')
    setSecret(b)
    await until(() => seen.length === 2)
    expect(destroy).toHaveBeenCalled()
    expect(r.container.querySelector<OpenRampModal>('openramp-modal')!.controller).toBe(seen[1])
    const destroy2 = vi.spyOn(seen[1]!, 'destroy')
    r.unmount()
    expect(destroy2).toHaveBeenCalled()
  })

  it('throws without baseUrl or provider', () => {
    expect(() => render(() => createComponent(OpenRampEmbedded, { clientSecret: 'x' }))).toThrow('needs `baseUrl`')
  })
})

describe('useDepositController', () => {
  it('updates on snapshot changes, follows an accessor, and handles no controller', async () => {
    const c = new DepositController({ client: fakeClient({ getSession: vi.fn(async () => session('SELECT_METHOD')) }), clientSecret: 'ors_1.sig' })
    const [ctl, setCtl] = createSignal<DepositController | undefined>(undefined)
    let snap!: ReturnType<typeof useDepositController>
    render(() => {
      snap = useDepositController(ctl)
      return document.createElement('i')
    })
    expect(snap()).toBeUndefined()
    setCtl(c)
    expect(snap()?.screen).toBe('loading')
    await c.start()
    expect(snap()?.screen).toBe('methods')
    c.setTab('cash')
    expect(snap()?.tab).toBe('cash')
    setCtl(undefined)
    expect(snap()).toBeUndefined()
  })

  it('stops updating after unmount', async () => {
    const c = new DepositController({ client: fakeClient(), clientSecret: 'ors_1.sig' })
    const unsub = vi.fn()
    const sub = c.subscribe
    c.subscribe = (fn) => {
      const off = sub(fn)
      return () => {
        unsub()
        off()
      }
    }
    let snap!: ReturnType<typeof useDepositController>
    const r = render(() => {
      snap = useDepositController(c)
      return document.createElement('i')
    })
    expect(snap()?.screen).toBe('loading')
    r.unmount()
    expect(unsub).toHaveBeenCalled()
  })
})
