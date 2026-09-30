// SSR safety (SolidStart): render on the server (node conditions, so Solid's server build, no window).
// Nothing may load Lit or @openrampkit/web.
import { createComponent } from 'solid-js'
import type { JSX } from 'solid-js'
import { renderToString, ssr } from 'solid-js/web'
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

import { DepositButton, OpenRampEmbedded, OpenRampProvider, WithdrawButton, useDepositController } from './index.js'
import { loadWeb } from './load.js'

describe('server rendering', () => {
  it('renders the provider, buttons and the embedded element without window or Lit', () => {
    expect(typeof window).toBe('undefined')
    function Headless() {
      const snap = useDepositController(undefined)
      return ssr(['<p>', '</p>'], snap() ? 'x' : 'no controller') as unknown as JSX.Element
    }
    const html = renderToString(() =>
      createComponent(OpenRampProvider, {
        baseUrl: '/api/openramp',
        get children() {
          return [
            createComponent(DepositButton, { getClientSecret: 'x' }),
            createComponent(WithdrawButton, { getClientSecret: 'x', class: 'btn' }),
            createComponent(DepositButton.Custom, { getClientSecret: 'x', children: ({ isOpen }) => ssr(['<span>', '</span>'], String(isOpen())) as unknown as JSX.Element }),
            createComponent(OpenRampEmbedded, { clientSecret: 'x', class: 'inline' }),
            createComponent(Headless, {}),
          ]
        },
      }),
    )
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Deposit<\/button>/)
    expect(html).toMatch(/<button[^>]*class="btn[^>]*>Withdraw<\/button>/)
    expect(html).not.toContain('disabled')
    expect(html).toContain('<span>false</span>')
    expect(html).toMatch(/<openramp-modal[^>]*embedded/)
    expect(html).toMatch(/<openramp-modal[^>]*class="inline/)
    expect(html).toContain('no controller')
    expect(loaded).toEqual({ web: false, lit: false })
    expect(typeof window).toBe('undefined')
  })

  it('loadWeb refuses to run on the server', async () => {
    await expect(loadWeb()).rejects.toThrow('can only open in the browser')
    expect(loaded.web).toBe(false)
  })
})
