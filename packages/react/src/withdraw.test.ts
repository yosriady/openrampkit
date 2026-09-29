// @vitest-environment happy-dom
// beginWithdraw, <WithdrawButton> and <WithdrawButton.Custom> against the in-process server (mock adapter).
import { act, createElement } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockWallet } from '@openrampkit/client'
import type { OrkError, PublicSession } from '@openrampkit/core'
import type { OpenRampModal } from '@openrampkit/web'
import { BASE, BASE_DEST, BASE_SOURCE, setupServer, sleep } from '../../client/src/testctx.js'
import { OpenRampProvider, WithdrawButton, useOpenRamp } from './index.js'
import type { OpenRampApi } from './index.js'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ARB = '0x2222222222222222222222222222222222222222'
let root: Root
let container: HTMLElement
let server: ReturnType<typeof setupServer>

beforeEach(() => {
  server = setupServer()
  vi.stubGlobal('fetch', server.fetch)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

const render = (node: ReactNode) => act(async () => root.render(node))
const modal = () => document.querySelector<OpenRampModal>('openramp-modal')
const withdrawSecret = async () => (await server.ramp.sessions.create({ userId: 'u', direction: 'withdraw', source: BASE_SOURCE, country: 'PH' })).clientSecret

async function until(fn: () => boolean, ms = 8000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('until: timeout')
    await act(async () => {
      await sleep(10)
    })
  }
}

/** Drive the open modal's controller: to wallet on Arbitrum, 5 USDC, confirm in the mock wallet */
async function withdrawToArbitrum() {
  await until(() => modal()?.controller?.getSnapshot().screen === 'target')
  const c = modal()!.controller!
  c.setTargetChain('eip155:42161')
  c.setTargetAddress(ARB)
  await act(async () => c.submitTarget())
  c.setAmount('5')
  await act(async () => c.submitAmount())
  await act(async () => c.confirm())
  await act(async () => c.sendWalletTransactions())
}

describe('beginWithdraw', () => {
  it('opens the withdraw modal and resolves when the withdrawal completes', async () => {
    let api!: OpenRampApi
    function Capture() {
      api = useOpenRamp()
      return null
    }
    const wallet = createMockWallet({ delayMs: 0 })
    await render(createElement(OpenRampProvider, { baseUrl: BASE, wallet }, createElement(Capture)))
    let p!: Promise<PublicSession>
    const secret = await withdrawSecret()
    await act(async () => {
      p = api.beginWithdraw({ clientSecret: secret })
    })
    await until(() => !!modal())
    expect(api.isOpen).toBe(true)
    await withdrawToArbitrum()
    await expect(p).resolves.toMatchObject({ direction: 'withdraw', step: { state: 'COMPLETED' } })
  })

  it('refuses a deposit session', async () => {
    let api!: OpenRampApi
    function Capture() {
      api = useOpenRamp()
      return null
    }
    await render(createElement(OpenRampProvider, { baseUrl: BASE }, createElement(Capture)))
    const dep = await server.ramp.sessions.create({ userId: 'u', destination: BASE_DEST })
    let p!: Promise<PublicSession>
    await act(async () => {
      p = api.beginWithdraw({ clientSecret: dep.clientSecret })
      p.catch(() => {})
    })
    await until(() => modal()?.controller?.getSnapshot().screen === 'error')
    expect(modal()!.controller!.getSnapshot().error?.message).toBe('This is not a withdraw session.')
    await act(async () => api.close())
    await expect(p).rejects.toMatchObject({ message: 'This is not a withdraw session.' })
  })
})

describe('WithdrawButton', () => {
  it('renders "Withdraw", opens the modal, and calls onComplete', async () => {
    const onComplete = vi.fn()
    const secret = await withdrawSecret()
    await render(
      createElement(
        OpenRampProvider,
        { baseUrl: BASE, wallet: createMockWallet({ delayMs: 0 }) },
        createElement(WithdrawButton, { getClientSecret: async () => secret, className: 'w', onComplete }),
      ),
    )
    const btn = container.querySelector<HTMLButtonElement>('button.w')!
    expect(btn.textContent).toBe('Withdraw')
    await act(async () => btn.click())
    await until(() => !!modal())
    expect(btn.disabled).toBe(true)
    await withdrawToArbitrum()
    await until(() => onComplete.mock.calls.length === 1)
    expect(onComplete.mock.calls[0]![0]).toMatchObject({ direction: 'withdraw' })
  })

  it('WithdrawButton.Custom renders children with open and isOpen; onError when closed', async () => {
    const onError = vi.fn()
    const secret = await withdrawSecret()
    await render(
      createElement(
        OpenRampProvider,
        { baseUrl: BASE },
        createElement(WithdrawButton.Custom, {
          getClientSecret: secret,
          onError,
          children: ({ open, isOpen }) => createElement('a', { id: 'custom', onClick: open }, isOpen ? 'Open' : 'Cash out'),
        }),
      ),
    )
    const a = container.querySelector<HTMLAnchorElement>('#custom')!
    expect(a.textContent).toBe('Cash out')
    await act(async () => a.click())
    await until(() => modal()?.controller?.getSnapshot().screen === 'target')
    expect(a.textContent).toBe('Open')
    await act(async () => modal()!.close())
    await until(() => onError.mock.calls.length === 1)
    expect((onError.mock.calls[0]![0] as OrkError).code).toBe('CLOSED')
    expect(a.textContent).toBe('Cash out')
  })
})
