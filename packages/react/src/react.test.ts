// @vitest-environment happy-dom
// React bindings with react-dom/client. The provider has no `fetch` option, so the global fetch is
// stubbed to call the real server handler (mock adapter) in-process.

import { act, createElement, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DepositController } from '@openrampkit/client'
import type { ClientEvent, PublicSession } from '@openrampkit/core'
import type { OpenRampModal } from '@openrampkit/web'
import { BASE, BASE_DEST, fakeClient, session, setupServer, sleep, waitFor } from '../../client/src/testctx.js'
import { DepositButton, OpenRampEmbedded, OpenRampProvider, darkTheme, lightTheme, useDepositController, useOpenRamp } from './index.js'
import type { OpenRampApi } from './index.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLElement
let server: ReturnType<typeof setupServer>

/** A new container and root, for tests that unmount or crash the current one */
function fresh() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
}

beforeEach(() => {
  server = setupServer()
  vi.stubGlobal('fetch', server.fetch)
  fresh()
})

afterEach(async () => {
  await act(async () => root.unmount())
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

async function render(node: ReactNode) {
  await act(async () => root.render(node))
}

async function newSecret(country = 'VN') {
  const s = await server.ramp.sessions.create({ userId: 'u', country, destination: country === 'VN' ? { type: 'merchant', currency: 'VND' } : BASE_DEST })
  return s.clientSecret
}

const modal = () => document.querySelector<OpenRampModal>('openramp-modal')

/** Wait until something is true, flushing React between checks */
async function until(fn: () => boolean, ms = 6000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('until: timeout')
    await act(async () => {
      await sleep(10)
    })
  }
}

/** Drive a started controller on a VND merchant session to COMPLETED */
async function payVietQr(c: DepositController) {
  await waitFor(() => c.getSnapshot().screen === 'methods')
  c.setTab('cash')
  await c.selectMethod('vietqr')
  c.setAmount('200000')
  await c.submitAmount()
  await c.confirm()
  await c.fire('simulate_payment')
}

function Capture(props: { onApi: (api: OpenRampApi) => void }) {
  const api = useOpenRamp()
  props.onApi(api)
  return createElement('span', { id: 'open' }, api.isOpen ? 'open' : 'closed')
}

describe('OpenRampProvider and useOpenRamp', () => {
  it('beginDeposit opens the modal on body; close() removes it and rejects', async () => {
    let api!: OpenRampApi
    const events: string[] = []
    const perCall: string[] = []
    await render(createElement(OpenRampProvider, { baseUrl: BASE, theme: lightTheme(), onEvent: (e: ClientEvent) => events.push(e.type) }, createElement(Capture, { onApi: (a) => (api = a) })))
    expect(container.textContent).toBe('closed')
    const secret = await newSecret()
    let p!: Promise<PublicSession>
    await act(async () => {
      p = api.beginDeposit({ clientSecret: secret, onEvent: (e) => perCall.push(e.type) })
      p.catch(() => {})
    })
    await until(() => !!modal())
    expect(modal()!.parentElement).toBe(document.body)
    expect(modal()!.theme?.mode).toBe('light')
    expect(container.textContent).toBe('open')
    await until(() => modal()!.controller?.getSnapshot().screen === 'methods')
    expect(events).toContain('modal.opened')
    expect(perCall).toContain('modal.opened')
    await act(async () => api.close())
    expect(modal()).toBeNull()
    expect(container.textContent).toBe('closed')
    await expect(p).rejects.toMatchObject({ code: 'CLOSED' })
  })

  it('beginDeposit resolves when the deposit completes', async () => {
    let api!: OpenRampApi
    await render(createElement(OpenRampProvider, { baseUrl: BASE }, createElement(Capture, { onApi: (a) => (api = a) })))
    let p!: Promise<PublicSession>
    const secret = await newSecret()
    await act(async () => {
      p = api.beginDeposit({ clientSecret: async () => secret })
    })
    await until(() => !!modal()?.controller)
    await payVietQr(modal()!.controller!)
    await expect(p).resolves.toMatchObject({ step: { state: 'COMPLETED' } })
  })

  it('a second beginDeposit replaces the first modal', async () => {
    let api!: OpenRampApi
    await render(createElement(OpenRampProvider, { baseUrl: BASE }, createElement(Capture, { onApi: (a) => (api = a) })))
    let first!: Promise<PublicSession>
    await act(async () => {
      first = api.beginDeposit({ clientSecret: await newSecret() })
      first.catch(() => {})
    })
    await until(() => !!modal())
    const el1 = modal()
    await act(async () => {
      void api.beginDeposit({ clientSecret: await newSecret() }).catch(() => {})
    })
    await until(() => document.querySelectorAll('openramp-modal').length === 1 && modal() !== el1)
    await expect(first).rejects.toBeDefined()
    expect(container.textContent).toBe('open')
  })

  it('keeps theme and appearance live while open, and closes the modal on unmount', async () => {
    let api!: OpenRampApi
    const tree = (theme: ReturnType<typeof lightTheme>) =>
      createElement(OpenRampProvider, { baseUrl: BASE, theme, appearance: { title: theme.mode } }, createElement(Capture, { onApi: (a) => (api = a) }))
    await render(tree(lightTheme()))
    await act(async () => {
      void api.beginDeposit({ clientSecret: await newSecret() }).catch(() => {})
    })
    await until(() => !!modal())
    await render(tree(darkTheme()))
    expect(modal()!.theme?.mode).toBe('dark')
    expect(modal()!.appearance?.title).toBe('dark')
    await act(async () => root.unmount())
    expect(modal()).toBeNull()
    fresh()
  })

  it('passes locale to the modal and keeps it live while open', async () => {
    let api!: OpenRampApi
    const tree = (locale: string) => createElement(OpenRampProvider, { baseUrl: BASE, locale }, createElement(Capture, { onApi: (a) => (api = a) }))
    await render(tree('vi'))
    await act(async () => {
      void api.beginDeposit({ clientSecret: await newSecret() }).catch(() => {})
    })
    await until(() => !!modal()?.controller && modal()!.controller!.getSnapshot().screen === 'methods')
    expect(modal()!.locale).toBe('vi')
    await modal()!.updateComplete
    expect(modal()!.shadowRoot!.querySelector('.title')!.textContent?.trim()).toBe('Nạp tiền')
    await render(tree('th'))
    expect(modal()!.locale).toBe('th')
    await modal()!.updateComplete
    expect(modal()!.shadowRoot!.querySelector('.title')!.textContent?.trim()).toBe('ฝากเงิน')
  })

  it('useOpenRamp outside a provider throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(render(createElement(Capture, { onApi: () => {} }))).rejects.toThrow('wrap your app in <OpenRampProvider>')
    spy.mockRestore()
    fresh()
  })
})

describe('DepositButton', () => {
  it('renders a Deposit button that opens the modal and is disabled while open', async () => {
    const secret = await newSecret()
    const onError = vi.fn()
    await render(createElement(OpenRampProvider, { baseUrl: BASE }, createElement(DepositButton, { getClientSecret: secret, className: 'btn', onError })))
    const btn = container.querySelector('button')!
    expect(btn.textContent).toBe('Deposit')
    expect(btn.className).toBe('btn')
    expect(btn.disabled).toBe(false)
    await act(async () => btn.click())
    await until(() => !!modal())
    expect(container.querySelector('button')!.disabled).toBe(true)
    await act(async () => modal()!.close())
    await until(() => onError.mock.calls.length === 1)
    expect(onError.mock.calls[0]![0]).toMatchObject({ code: 'CLOSED' })
    expect(container.querySelector('button')!.disabled).toBe(false)
  })

  it('calls onComplete and forwards onEvent', async () => {
    const secret = await newSecret()
    const onComplete = vi.fn()
    const onEvent = vi.fn()
    await render(createElement(OpenRampProvider, { baseUrl: BASE }, createElement(DepositButton, { getClientSecret: async () => secret, label: 'Top up', onComplete, onEvent })))
    const btn = container.querySelector('button')!
    expect(btn.textContent).toBe('Top up')
    await act(async () => btn.click())
    await until(() => !!modal()?.controller)
    await payVietQr(modal()!.controller!)
    await until(() => onComplete.mock.calls.length === 1)
    expect(onComplete.mock.calls[0]![0].step.state).toBe('COMPLETED')
    expect(onEvent).toHaveBeenCalled()
  })

  it('respects disabled', async () => {
    await render(createElement(OpenRampProvider, { baseUrl: BASE }, createElement(DepositButton, { getClientSecret: 'x', disabled: true })))
    expect(container.querySelector('button')!.disabled).toBe(true)
  })

  it('DepositButton.Custom renders children with open and isOpen', async () => {
    const secret = await newSecret()
    await render(
      createElement(
        OpenRampProvider,
        { baseUrl: BASE },
        createElement(DepositButton.Custom, {
          getClientSecret: secret,
          children: ({ open, isOpen }: { open: () => void; isOpen: boolean }) => createElement('a', { href: '#', onClick: open }, isOpen ? 'Opened' : 'Add funds'),
        }),
      ),
    )
    const a = container.querySelector('a')!
    expect(a.textContent).toBe('Add funds')
    await act(async () => a.click())
    await until(() => !!modal())
    expect(container.querySelector('a')!.textContent).toBe('Opened')
  })
})

describe('OpenRampEmbedded', () => {
  it('embedded takes locale from its prop, else from the provider', async () => {
    const secret = await newSecret()
    const tree = (locale?: string) =>
      createElement(OpenRampProvider, { baseUrl: BASE, locale: 'ms' }, createElement(OpenRampEmbedded, { clientSecret: secret, ...(locale ? { locale } : {}) }))
    await render(tree())
    const el = container.querySelector<OpenRampModal>('openramp-modal')!
    await until(() => !!el.controller)
    expect(el.locale).toBe('ms')
    await render(tree('fil'))
    expect(el.locale).toBe('fil')
  })

  it('mounts <openramp-modal embedded> with a controller and calls onComplete', async () => {
    const secret = await newSecret()
    const onComplete = vi.fn()
    const onController = vi.fn()
    const onEvent = vi.fn()
    const providerEvent = vi.fn()
    await render(
      createElement(
        OpenRampProvider,
        { baseUrl: BASE, theme: darkTheme(), onEvent: providerEvent },
        createElement(OpenRampEmbedded, { clientSecret: secret, onComplete, onController, onEvent, className: 'inline', style: { height: 500 } }),
      ),
    )
    const el = container.querySelector<OpenRampModal>('openramp-modal')!
    expect(el).not.toBeNull()
    expect(el.className).toBe('inline')
    await until(() => !!el.controller)
    expect(el.embedded).toBe(true)
    expect(el.hasAttribute('embedded')).toBe(true)
    expect(el.theme?.mode).toBe('dark')
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
    await render(createElement(OpenRampEmbedded, { baseUrl: BASE, clientSecret: async () => secret, onClose, messages: { title: 'Nạp' }, appearance: { title: 'A' } }))
    const el = container.querySelector<OpenRampModal>('openramp-modal')!
    await until(() => !!el.controller)
    expect(el.messages?.title).toBe('Nạp')
    expect(el.locale).toBeUndefined()
    el.dispatchEvent(new CustomEvent('openramp-close', { detail: { session: { id: 's' } } }))
    expect(onClose).toHaveBeenCalledWith({ id: 's' })
    el.dispatchEvent(new CustomEvent('openramp-close'))
    expect(onClose).toHaveBeenLastCalledWith(undefined)
  })

  it('shows the error when the client secret cannot load', async () => {
    await render(createElement(OpenRampEmbedded, { baseUrl: BASE, clientSecret: () => Promise.reject(new Error('No session')) }))
    const el = container.querySelector<OpenRampModal>('openramp-modal')!
    await until(() => !!el.error)
    expect(el.error).toMatchObject({ code: 'INTERNAL', message: 'No session' })
    await act(async () => root.unmount())
    fresh()
    await render(createElement(OpenRampEmbedded, { baseUrl: BASE, clientSecret: () => Promise.reject({ error: { code: 'UNAUTHORIZED', message: 'Bad', retryable: false } }) }))
    const el2 = container.querySelector<OpenRampModal>('openramp-modal')!
    await until(() => !!el2.error)
    expect(el2.error).toEqual({ code: 'UNAUTHORIZED', message: 'Bad', retryable: false })
  })

  it('a new clientSecret string creates a new controller and destroys the old one', async () => {
    const a = await newSecret()
    const b = await newSecret()
    const seen: DepositController[] = []
    await render(createElement(OpenRampEmbedded, { baseUrl: BASE, clientSecret: a, onController: (c) => seen.push(c) }))
    await until(() => seen.length === 1)
    const destroy = vi.spyOn(seen[0]!, 'destroy')
    await render(createElement(OpenRampEmbedded, { baseUrl: BASE, clientSecret: b, onController: (c) => seen.push(c) }))
    await until(() => seen.length === 2)
    expect(destroy).toHaveBeenCalled()
    expect(container.querySelector<OpenRampModal>('openramp-modal')!.controller).toBe(seen[1])
  })

  it('throws without baseUrl or provider', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(render(createElement(OpenRampEmbedded, { clientSecret: 'x' }))).rejects.toThrow('needs `baseUrl`')
    spy.mockRestore()
    fresh()
  })
})

describe('useDepositController', () => {
  it('re-renders on snapshot changes and handles no controller', async () => {
    const c = new DepositController({ client: fakeClient({ getSession: vi.fn(async () => session('SELECT_METHOD')) }), clientSecret: 'ors_1.sig' })
    const renders: string[] = []
    function View(props: { controller: DepositController | undefined }) {
      const snap = useDepositController(props.controller)
      renders.push(snap ? `${snap.screen}:${snap.tab}` : 'none')
      return createElement('i', null, snap?.screen ?? 'none')
    }
    await render(createElement(View, { controller: undefined }))
    expect(container.textContent).toBe('none')
    await render(createElement(View, { controller: c }))
    expect(container.textContent).toBe('loading')
    await act(async () => c.start())
    expect(container.textContent).toBe('methods')
    await act(async () => c.setTab('cash'))
    expect(renders.at(-1)).toBe('methods:cash')
  })

  it('stops updating after unmount', async () => {
    const c = new DepositController({ client: fakeClient(), clientSecret: 'ors_1.sig' })
    const unsub = vi.fn()
    const sub = c.subscribe
    c.subscribe = (fn) => {
      const off = sub(fn)
      return () => {
        unsub()
        return off()
      }
    }
    function View() {
      const [ctl] = useState(c)
      const snap = useDepositController(ctl)
      useEffect(() => {}, [snap])
      return createElement('i', null, snap.screen)
    }
    await render(createElement(View))
    await act(async () => root.unmount())
    expect(unsub).toHaveBeenCalled()
    fresh()
  })
})
