import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockAdapter } from '@openrampkit/adapter-mock'
import { createOpenRamp } from './index.js'
import type { OpenRampConfig } from './index.js'

const BASE = 'https://ramp.test/api/openramp'
const SECRET = 'test-secret-test-secret-test-secret-123'
const DEST = { type: 'crypto' as const, chain: 'eip155:8453', token: '0x833589fcd6e9b75e5c02b1c46e2bf6e1d6d6e0aa', address: '0x000000000000000000000000000000000000beef' }

function setup(extra: Partial<OpenRampConfig> = {}) {
  return createOpenRamp({ secret: SECRET, baseUrl: BASE, adapters: [mockAdapter({ settleMs: 0 })], logger: { debug() {}, info() {}, warn() {}, error() {} }, ...extra })
}
const get = (ramp: ReturnType<typeof setup>, url: string, auth?: string) =>
  ramp.handle(new Request(url, auth ? { headers: { authorization: `Bearer ${auth}` } } : {}))
const credentialOf = (url: string) => url.slice(`${BASE}/pay/`.length)

afterEach(() => vi.useRealTimers())

describe('pay links', () => {
  it('renders a page that mounts the web component with a signed credential', async () => {
    const ramp = setup()
    const s = await ramp.sessions.create({ userId: 'u', country: 'VN', destination: DEST, locale: 'vi' })
    const link = (await ramp.sessions.payLink(s.id))!
    expect(link.url.startsWith(`${BASE}/pay/${s.id}.pay_`)).toBe(true)
    expect(Date.parse(link.expiresAt)).toBeGreaterThan(Date.parse(s.expiresAt))

    const res = await get(ramp, link.url)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    const csp = res.headers.get('content-security-policy')!
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toMatch(/script-src 'nonce-[0-9a-f]{32}' 'self' https:\/\/esm\.sh/)
    const html = await res.text()
    expect(html).toContain('openDeposit')
    expect(html).toContain(`"clientSecret":"${credentialOf(link.url)}"`)
    expect(html).toContain('lang="vi"')
    expect(html).not.toContain(SECRET)
  })

  it('the credential works as a client secret for that session only', async () => {
    const ramp = setup()
    const a = await ramp.sessions.create({ userId: 'u', country: 'VN', destination: DEST })
    const b = await ramp.sessions.create({ userId: 'u', country: 'VN', destination: DEST })
    const cred = credentialOf((await ramp.sessions.payLink(a.id))!.url)
    expect((await get(ramp, `${BASE}/sessions/${a.id}`, cred)).status).toBe(200)
    // Same signature, other session id: refused
    expect((await get(ramp, `${BASE}/sessions/${b.id}`, cred.replace(a.id, b.id))).status).toBe(401)
    // Tampered signature: refused, on the page and on the API
    const bad = cred.slice(0, -1) + (cred.endsWith('0') ? '1' : '0')
    expect((await get(ramp, `${BASE}/sessions/${a.id}`, bad)).status).toBe(401)
    expect((await get(ramp, `${BASE}/pay/${bad}`)).status).toBe(401)
    expect((await get(ramp, `${BASE}/pay/garbage`)).status).toBe(401)
    // A start URL signature does not pass as a pay credential
    expect((await get(ramp, `${BASE}/pay/${a.id}.pay_zz_${'0'.repeat(32)}`)).status).toBe(401)
  })

  it('expires, and a pay credential cannot mint new links', async () => {
    const ramp = setup()
    const s = await ramp.sessions.create({ userId: 'u', country: 'VN', destination: DEST })
    const mint = await ramp.handle(
      new Request(`${BASE}/sessions/${s.id}/pay-link`, { method: 'POST', headers: { authorization: `Bearer ${s.clientSecret}` }, body: JSON.stringify({ ttlMinutes: 5 }) }),
    )
    expect(mint.status).toBe(201)
    const link = (await mint.json()) as { url: string; expiresAt: string }
    expect(Date.parse(link.expiresAt) - Date.now()).toBeLessThanOrEqual(5 * 60_000 + 1000)
    const cred = credentialOf(link.url)

    const again = await ramp.handle(new Request(`${BASE}/sessions/${s.id}/pay-link`, { method: 'POST', headers: { authorization: `Bearer ${cred}` } }))
    expect(again.status).toBe(403)

    vi.useFakeTimers({ now: Date.now() + 6 * 60_000 })
    expect((await get(ramp, link.url)).status).toBe(410)
    const api = await get(ramp, `${BASE}/sessions/${s.id}`, cred)
    expect(api.status).toBe(401)
    expect(((await api.json()) as { error: { message: string } }).error.message).toBe('This pay link expired.')
  })

  it('withdraw pages open the withdraw flow; a same-origin script URL; can be turned off', async () => {
    const ramp = setup({ payPage: { scriptUrl: '/static/openramp-web.js', title: '<Pay>' } })
    const s = await ramp.sessions.create({
      userId: 'u',
      direction: 'withdraw',
      source: { chain: 'eip155:8453', token: '0x833589fcd6e9b75e5c02b1c46e2bf6e1d6d6e0aa', symbol: 'USDC', decimals: 6, custody: 'app' },
    })
    const res = await get(ramp, (await ramp.sessions.payLink(s.id))!.url)
    const html = await res.text()
    expect(html).toContain('"direction":"withdraw"')
    expect(html).toContain('https://ramp.test/static/openramp-web.js')
    expect(html).toContain('&#60;Pay&#62;')
    expect(res.headers.get('content-security-policy')).toMatch(/script-src 'nonce-[0-9a-f]+' 'self';/)

    const off = setup({ payPage: false })
    const t = await off.sessions.create({ userId: 'u', destination: DEST })
    await expect(off.sessions.payLink(t.id)).rejects.toThrow()
    expect((await get(off, `${BASE}/pay/${t.id}.pay_zz_x`)).status).toBe(404)
    expect(await ramp.sessions.payLink('ors_missing')).toBeNull()
  })
})
