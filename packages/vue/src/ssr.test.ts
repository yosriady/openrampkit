// SSR safety (Nuxt): render on the server (node, no window). Nothing may load Lit or @openrampkit/web.
import { createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
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
  it('renders the provider, buttons and the embedded element without window or Lit', async () => {
    expect(typeof window).toBe('undefined')
    const Headless = defineComponent({
      setup() {
        const snap = useDepositController(undefined)
        return () => h('p', null, snap.value ? 'x' : 'no controller')
      },
    })
    const app = createSSRApp({
      render: () =>
        h(OpenRampProvider, { baseUrl: '/api/openramp' }, () => [
          h(DepositButton, { getClientSecret: 'x' }),
          h(WithdrawButton, { getClientSecret: 'x' }),
          h(DepositButton.Custom, { getClientSecret: 'x' }, { default: ({ isOpen }: { isOpen: boolean }) => h('span', null, String(isOpen)) }),
          h(OpenRampEmbedded, { clientSecret: 'x', class: 'inline' }),
          h(Headless),
        ]),
    })
    const html = await renderToString(app)
    expect(html).toContain('<button type="button">Deposit</button>')
    expect(html).toContain('<button type="button">Withdraw</button>')
    expect(html).toContain('<span>false</span>')
    expect(html).toMatch(/<openramp-modal[^>]*embedded/)
    expect(html).toContain('class="inline"')
    expect(html).toContain('no controller')
    expect(loaded).toEqual({ web: false, lit: false })
    expect(typeof window).toBe('undefined')
  })

  it('loadWeb refuses to run on the server', async () => {
    await expect(loadWeb()).rejects.toThrow('can only open in the browser')
    expect(loaded.web).toBe(false)
  })
})
