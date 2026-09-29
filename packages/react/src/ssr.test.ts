// SSR safety: render on the server (node, no window). Nothing may load Lit or @openrampkit/web.
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
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

import { DepositButton, OpenRampEmbedded, OpenRampProvider, useDepositController } from './index.js'
import { loadWeb } from './load.js'

describe('server rendering', () => {
  it('renders the provider, buttons and the embedded element without window or Lit', () => {
    expect(typeof window).toBe('undefined')
    function Headless() {
      const snap = useDepositController(undefined)
      return createElement('p', null, snap ? 'x' : 'no controller')
    }
    const html = renderToString(
      createElement(
        OpenRampProvider,
        { baseUrl: '/api/openramp' },
        createElement(DepositButton, { getClientSecret: 'x' }),
        createElement(DepositButton.Custom, { getClientSecret: 'x', children: ({ isOpen }: { isOpen: boolean }) => createElement('span', null, String(isOpen)) }),
        createElement(OpenRampEmbedded, { clientSecret: 'x', className: 'inline' }),
        createElement(Headless),
      ),
    )
    expect(html).toContain('<button type="button">Deposit</button>')
    expect(html).toContain('<span>false</span>')
    expect(html).toContain('<openramp-modal')
    expect(html).toContain('no controller')
    expect(loaded).toEqual({ web: false, lit: false })
    expect(typeof window).toBe('undefined')
  })

  it('loadWeb refuses to run on the server', async () => {
    await expect(loadWeb()).rejects.toThrow('can only open in the browser')
    expect(loaded.web).toBe(false)
  })
})
