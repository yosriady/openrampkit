// @vitest-environment happy-dom
// Vue bindings with @testing-library/vue. The global fetch is stubbed to call the real server handler (mock adapter) in-process.

import { cleanup, render } from '@testing-library/vue'
import { defineComponent, h, nextTick, ref, shallowRef } from 'vue'
import type { Component } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DepositController } from '@openrampkit/client'
import type { OpenRampEvent } from '@openrampkit/core'
import type { OpenRampModal } from '@openrampkit/web'
import { BASE, BASE_SOURCE, fakeClient, session, setupServer, sleep } from '../../client/src/testctx.js'
import {
  DepositButton,
  OpenRampEmbedded,
  OpenRampProvider,
  WithdrawButton,
  darkTheme,
  lightTheme,
  provideOpenRamp,
  useDepositController,
  useOpenRamp,
} from './index.js'
import type { OpenRampApi, Theme } from './index.js'

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
    await nextTick()
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

/** Renders `useOpenRamp()` state and hands the API to the test */
const Capture = defineComponent({
  props: { onApi: { type: Function, required: true } },
  setup(props) {
    const api = useOpenRamp()
    props.onApi(api)
    return () => h('span', { id: 'open' }, api.isOpen.value ? 'open' : 'closed')
  },
})

function withProvider(providerProps: Record<string, unknown>, child: () => ReturnType<typeof h>): Component {
  return defineComponent({ setup: () => () => h(OpenRampProvider, providerProps as { baseUrl: string }, { default: child }) })
}

describe('OpenRampProvider and useOpenRamp', () => {
  it('beginDeposit opens the modal on body; close() removes it and rejects', async () => {
    let api!: OpenRampApi
    const events: string[] = []
    const perCall: string[] = []
    const r = render(withProvider({ baseUrl: BASE, theme: lightTheme(), onEvent: (e: OpenRampEvent) => events.push(e.type) }, () => h(Capture, { onApi: (a: OpenRampApi) => (api = a) })))
    expect(r.container.textContent).toBe('closed')
    const p = api.beginDeposit({ clientSecret: await newSecret(), onEvent: (e) => perCall.push(e.type) })
    p.catch(() => {})
    await until(() => !!modal())
    expect(modal()!.parentElement).toBe(document.body)
    expect(modal()!.theme?.mode).toBe('light')
    await nextTick()
    expect(r.container.textContent).toBe('open')
    await until(() => modal()!.controller?.getSnapshot().screen === 'methods')
    expect(events).toContain('modal.opened')
    expect(perCall).toContain('modal.opened')
    api.close()
    await nextTick()
    expect(modal()).toBeNull()
    expect(r.container.textContent).toBe('closed')
    await expect(p).rejects.toMatchObject({ code: 'CLOSED' })
  })

  it('beginDeposit resolves when the deposit completes', async () => {
    let api!: OpenRampApi
    render(withProvider({ baseUrl: BASE }, () => h(Capture, { onApi: (a: OpenRampApi) => (api = a) })))
    const secret = await newSecret()
    const p = api.beginDeposit({ clientSecret: async () => secret })
    await until(() => !!modal()?.controller)
    await payVietQr(modal()!.controller!)
    await expect(p).resolves.toMatchObject({ step: { state: 'COMPLETED' } })
  })

  it('beginWithdraw opens a withdraw session; a second call replaces the first modal', async () => {
    let api!: OpenRampApi
    const r = render(withProvider({ baseUrl: BASE }, () => h(Capture, { onApi: (a: OpenRampApi) => (api = a) })))
    const first = api.beginWithdraw({ clientSecret: await withdrawSecret() })
    first.catch(() => {})
    await until(() => !!modal()?.controller?.getSnapshot().session)
    expect(modal()!.controller!.getSnapshot().session?.direction).toBe('withdraw')
    const el1 = modal()
    void api.beginDeposit({ clientSecret: await newSecret() }).catch(() => {})
    await until(() => document.querySelectorAll('openramp-modal').length === 1 && modal() !== el1)
    await expect(first).rejects.toBeDefined()
    await nextTick()
    expect(r.container.textContent).toBe('open')
  })

  it('keeps theme, appearance and locale live while open, and closes the modal on unmount', async () => {
    let api!: OpenRampApi
    const theme = shallowRef<Theme>(lightTheme())
    const locale = ref('vi')
    const App = defineComponent({
      setup() {
        provideOpenRamp(() => ({ baseUrl: BASE, theme: theme.value, appearance: { title: theme.value.mode }, locale: locale.value }))
        return () => h(Capture, { onApi: (a: OpenRampApi) => (api = a) })
      },
    })
    const r = render(App)
    void api.beginDeposit({ clientSecret: await newSecret() }).catch(() => {})
    await until(() => !!modal())
    expect(modal()!.locale).toBe('vi')
    theme.value = darkTheme()
    locale.value = 'th'
    await nextTick()
    expect(modal()!.theme?.mode).toBe('dark')
    expect(modal()!.appearance?.title).toBe('dark')
    expect(modal()!.locale).toBe('th')
    r.unmount()
    expect(modal()).toBeNull()
  })

  it('useOpenRamp outside a provider throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => render(defineComponent({ setup: () => (useOpenRamp(), () => null) }))).toThrow('wrap your app in <OpenRampProvider>')
    warn.mockRestore()
  })
})

describe('DepositButton and WithdrawButton', () => {
  it('renders a Deposit button that opens the modal, is disabled while open, and emits error on close', async () => {
    const secret = await newSecret()
    const onError = vi.fn()
    const r = render(withProvider({ baseUrl: BASE }, () => h(DepositButton, { getClientSecret: secret, class: 'btn', onError })))
    const btn = r.container.querySelector('button')!
    expect(btn.textContent).toBe('Deposit')
    expect(btn.className).toBe('btn')
    expect(btn.disabled).toBe(false)
    btn.click()
    await until(() => !!modal())
    await nextTick()
    expect(btn.disabled).toBe(true)
    modal()!.close()
    await until(() => onError.mock.calls.length === 1)
    expect(onError.mock.calls[0]![0]).toMatchObject({ code: 'CLOSED' })
    await nextTick()
    expect(btn.disabled).toBe(false)
  })

  it('emits complete and forwards events; the default slot sets the label', async () => {
    const secret = await newSecret()
    const onComplete = vi.fn()
    const onEvent = vi.fn()
    const r = render(withProvider({ baseUrl: BASE }, () => h(DepositButton, { getClientSecret: async () => secret, onComplete, onEvent }, { default: () => 'Top up' })))
    const btn = r.container.querySelector('button')!
    expect(btn.textContent).toBe('Top up')
    btn.click()
    await until(() => !!modal()?.controller)
    await payVietQr(modal()!.controller!)
    await until(() => onComplete.mock.calls.length === 1)
    expect(onComplete.mock.calls[0]![0].step.state).toBe('COMPLETED')
    expect(onEvent).toHaveBeenCalled()
  })

  it('respects disabled and label', () => {
    const r = render(withProvider({ baseUrl: BASE }, () => h(WithdrawButton, { getClientSecret: 'x', disabled: true, label: 'Cash out' })))
    const btn = r.container.querySelector('button')!
    expect(btn.disabled).toBe(true)
    expect(btn.textContent).toBe('Cash out')
  })

  it('WithdrawButton opens a withdraw session', async () => {
    const secret = await withdrawSecret()
    const r = render(withProvider({ baseUrl: BASE }, () => h(WithdrawButton, { getClientSecret: secret })))
    const btn = r.container.querySelector('button')!
    expect(btn.textContent).toBe('Withdraw')
    btn.click()
    await until(() => !!modal()?.controller?.getSnapshot().session)
    expect(modal()!.controller!.getSnapshot().session?.direction).toBe('withdraw')
  })

  it('DepositButton.Custom renders the slot with open and isOpen', async () => {
    const secret = await newSecret()
    const r = render(
      withProvider({ baseUrl: BASE }, () =>
        h(DepositButton.Custom, { getClientSecret: secret }, { default: ({ open, isOpen }: { open: () => void; isOpen: boolean }) => h('a', { href: '#', onClick: open }, isOpen ? 'Opened' : 'Add funds') }),
      ),
    )
    const a = r.container.querySelector('a')!
    expect(a.textContent).toBe('Add funds')
    a.click()
    await until(() => !!modal())
    await nextTick()
    expect(r.container.querySelector('a')!.textContent).toBe('Opened')
  })
})

describe('OpenRampEmbedded', () => {
  it('mounts <openramp-modal embedded> with a controller, takes provider values, and emits complete', async () => {
    const secret = await newSecret()
    const onComplete = vi.fn()
    const onController = vi.fn()
    const onEvent = vi.fn()
    const providerEvent = vi.fn()
    const r = render(withProvider({ baseUrl: BASE, theme: darkTheme(), locale: 'ms', onEvent: providerEvent }, () => h(OpenRampEmbedded, { clientSecret: secret, class: 'inline', onComplete, onController, onEvent })))
    const el = r.container.querySelector<OpenRampModal>('openramp-modal')!
    expect(el.className).toBe('inline')
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

  it('works without a provider when baseUrl is given, and emits close', async () => {
    const secret = await newSecret()
    const onClose = vi.fn()
    const r = render(OpenRampEmbedded, { props: { baseUrl: BASE, clientSecret: async () => secret, onClose, messages: { title: 'Nạp' }, locale: 'fil' } })
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
    const r = render(OpenRampEmbedded, { props: { baseUrl: BASE, clientSecret: () => Promise.reject(new Error('No session')) } })
    const el = r.container.querySelector<OpenRampModal>('openramp-modal')!
    await until(() => !!el.error)
    expect(el.error).toMatchObject({ code: 'INTERNAL', message: 'No session' })
  })

  it('a new clientSecret string creates a new controller and destroys the old one; unmount destroys it too', async () => {
    const a = await newSecret()
    const b = await newSecret()
    const seen: DepositController[] = []
    const r = render(OpenRampEmbedded, { props: { baseUrl: BASE, clientSecret: a, onController: (c: DepositController) => seen.push(c) } })
    await until(() => seen.length === 1)
    const destroy = vi.spyOn(seen[0]!, 'destroy')
    await r.rerender({ clientSecret: b })
    await until(() => seen.length === 2)
    expect(destroy).toHaveBeenCalled()
    expect(r.container.querySelector<OpenRampModal>('openramp-modal')!.controller).toBe(seen[1])
    const destroy2 = vi.spyOn(seen[1]!, 'destroy')
    r.unmount()
    expect(destroy2).toHaveBeenCalled()
  })

  it('throws without baseUrl or provider', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => render(OpenRampEmbedded, { props: { clientSecret: 'x' } })).toThrow('needs `baseUrl`')
    warn.mockRestore()
  })
})

describe('useDepositController', () => {
  it('updates on snapshot changes, follows a ref, and handles no controller', async () => {
    const c = new DepositController({ client: fakeClient({ getSession: vi.fn(async () => session('SELECT_METHOD')) }), clientSecret: 'ors_1.sig' })
    const ctl = shallowRef<DepositController | undefined>(undefined)
    const View = defineComponent({
      setup() {
        const snap = useDepositController(ctl)
        return () => h('i', null, snap.value ? `${snap.value.screen}:${snap.value.tab}` : 'none')
      },
    })
    const r = render(View)
    expect(r.container.textContent).toBe('none')
    ctl.value = c
    await nextTick()
    expect(r.container.textContent).toMatch(/^loading/)
    await c.start()
    await nextTick()
    expect(r.container.textContent).toMatch(/^methods/)
    c.setTab('cash')
    await nextTick()
    expect(r.container.textContent).toBe('methods:cash')
    ctl.value = undefined
    await nextTick()
    expect(r.container.textContent).toBe('none')
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
    const View = defineComponent({
      setup() {
        const snap = useDepositController(c)
        return () => h('i', null, snap.value?.screen)
      },
    })
    const r = render(View)
    r.unmount()
    expect(unsub).toHaveBeenCalled()
  })
})

