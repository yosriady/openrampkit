// The real server handler with the mock adapter, reached through an in-process fetch.
import { describe, expect, it } from 'vitest'
import { DepositController, createMockWallet } from './index.js'
import { BASE_DEST, setupServer, waitFor } from './testctx.js'

describe('DepositController + real server (mock adapter)', () => {
  it('transfer: deposit address for the chosen source, then completes', async () => {
    const { ramp, client } = setupServer()
    const s = await ramp.sessions.create({ userId: 'u1', country: 'US', destination: BASE_DEST })
    const c = new DepositController({ client, clientSecret: s.clientSecret })
    await c.start()
    await c.selectMethod('transfer')
    expect(c.getSnapshot().quotes.length).toBeGreaterThan(0)
    c.setSource({ chain: 'eip155:10', token: 'native', symbol: 'ETH', decimals: 18 })
    await waitFor(() => !c.getSnapshot().quotesLoading && c.getSnapshot().quotes[0]?.input.asset.kind === 'crypto' && (c.getSnapshot().quotes[0]!.input.asset as { chain: string }).chain === 'eip155:10')
    await c.confirm()
    const surface = c.getSnapshot().session!.step.surface!
    expect(surface).toMatchObject({ kind: 'DEPOSIT_ADDRESS', chain: 'eip155:10' })
    await c.fire('simulate_deposit')
    await waitFor(() => c.getSnapshot().screen === 'result')
    expect((await c.done).step.state).toBe('COMPLETED')
    c.destroy()
  })

  it('restart from PAYMENT goes back to methods with a fresh plan', async () => {
    const { ramp, client, requests } = setupServer()
    const s = await ramp.sessions.create({ userId: 'u2', country: 'VN', destination: { type: 'merchant', currency: 'VND' } })
    const c = new DepositController({ client, clientSecret: s.clientSecret, wallet: createMockWallet() })
    await c.start()
    await c.selectMethod('vietqr')
    c.setAmount('200000')
    await c.submitAmount()
    await c.confirm()
    expect(c.getSnapshot().session!.step).toMatchObject({ state: 'PAYMENT', surface: { kind: 'QR' } })
    c.back()
    await waitFor(() => c.getSnapshot().screen === 'methods')
    expect(c.getSnapshot().session!.step.state).toBe('SELECT_METHOD')
    const plans = requests.filter((r) => r.url.endsWith('/plan'))
    expect(plans).toHaveLength(2)
    expect(await plans[1]!.json()).toMatchObject({ walletConnected: true })
    const select = requests.find((r) => r.url.endsWith('/select'))!
    expect(select.headers.get('idempotency-key')).toMatch(/^[0-9a-f]{24}$/)
    c.close()
    await expect(c.done).rejects.toMatchObject({ message: 'Closed before completion.' })
  })
})
