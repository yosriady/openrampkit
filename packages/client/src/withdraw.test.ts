// Withdraw flow of the controller, against the real server handler with the mock adapter (offramp on).
import { describe, expect, it, vi } from 'vitest'
import { USDC } from '@openrampkit/core'
import type { OrkEvent, WithdrawSource } from '@openrampkit/core'
import type { CreateSessionInput } from '@openrampkit/server'
import { RampController, WithdrawController, createMockWallet, isValidTargetAddress, withdrawTokens } from './index.js'
import type { ControllerOptions } from './index.js'
import { BASE_DEST, BASE_SOURCE, setupServer, waitFor } from './testctx.js'

const USER = '0x1111111111111111111111111111111111111111'
const ARB = '0x2222222222222222222222222222222222222222'

async function make(opts: {
  session?: Partial<CreateSessionInput>
  wallet?: boolean
  config?: Parameters<typeof setupServer>[1]
  ctl?: Partial<ControllerOptions>
} = {}) {
  const srv = setupServer(undefined, opts.config)
  const s = await srv.ramp.sessions.create({ userId: 'u1', direction: 'withdraw', source: BASE_SOURCE, country: 'PH', ...opts.session } as CreateSessionInput)
  const events: OrkEvent[] = []
  const wallet = opts.wallet === false ? undefined : createMockWallet({ address: USER, delayMs: 0 })
  const c = new WithdrawController({ client: srv.client, clientSecret: s.clientSecret, ...(wallet ? { wallet } : {}), onEvent: (e) => events.push(e), ...opts.ctl })
  return { ...srv, s, c, events, wallet }
}

const bodyOf = async (reqs: Request[], suffix: string) => Promise.all(reqs.filter((r) => r.url.endsWith(suffix)).map((r) => r.clone().json()))

describe('withdraw: helpers', () => {
  it('address format and token choices', () => {
    expect(isValidTargetAddress('eip155:1', ARB)).toBe(true)
    expect(isValidTargetAddress('eip155:1', ` ${ARB} `)).toBe(true)
    expect(isValidTargetAddress('eip155:1', '0x123')).toBe(false)
    expect(isValidTargetAddress('eip155:1', `0x${'0'.repeat(40)}`)).toBe(false)
    expect(isValidTargetAddress('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')).toBe(true)
    expect(isValidTargetAddress('bip122:0', 'bc1qar0srrr7x')).toBe(true)
    expect(isValidTargetAddress('bip122:0', 'short')).toBe(false)
    expect(withdrawTokens('eip155:42161').map((t) => t.symbol)).toEqual(['USDC', 'ETH'])
    expect(withdrawTokens('eip155:143').map((t) => t.symbol)).toEqual(['MON'])
    expect(withdrawTokens('cosmos:x').map((t) => t.symbol)).toEqual(['ETH'])
    expect(WithdrawController).toBe(RampController)
  })
})

describe('withdraw: to wallet', () => {
  it('prefills the form, validates the address, and runs target, amount, quote, wallet tx and result', async () => {
    const { c, events, requests, wallet } = await make()
    await c.start()
    let snap = c.getSnapshot()
    expect(snap).toMatchObject({ screen: 'target', direction: 'withdraw', tab: 'crypto', cashCurrency: 'PHP' })
    expect(snap.target).toEqual({ chain: 'eip155:8453', token: USDC['eip155:8453'], symbol: 'USDC', decimals: 6, address: USER })
    expect(c.withdrawTabs()).toEqual(['crypto', 'cash'])
    expect(c.withdrawChains()).toEqual(Object.keys(USDC))
    expect(c.sourceBalance()).toMatchObject({ amount: '40', symbol: 'USDC' })

    c.setTargetChain('eip155:42161')
    expect(c.getSnapshot().target).toMatchObject({ chain: 'eip155:42161', token: USDC['eip155:42161'], symbol: 'USDC', address: USER })
    c.setTargetToken('native')
    expect(c.getSnapshot().target).toMatchObject({ token: 'native', symbol: 'ETH', decimals: 18 })
    c.setTargetChain('eip155:10') // keeps "native"
    expect(c.getSnapshot().target).toMatchObject({ chain: 'eip155:10', token: 'native' })
    c.setTargetToken('0xnot-a-choice')
    expect(c.getSnapshot().target!.token).toBe('native')
    c.setTargetChain('eip155:42161')
    c.setTargetToken(USDC['eip155:42161']!)

    c.setTargetAddress('0x1234')
    await c.submitTarget()
    expect(c.getSnapshot().error?.message).toBe('Enter a valid address for this network.')
    expect(requests.some((r) => r.url.endsWith('/target'))).toBe(false)
    c.setTargetAddress(` ${ARB} `)
    expect(c.getSnapshot().error).toBeUndefined()
    await c.submitTarget()
    snap = c.getSnapshot()
    expect(snap.screen).toBe('amount')
    expect(snap.method?.method).toBe('wallet')
    expect(await bodyOf(requests, '/target')).toEqual([expect.objectContaining({ type: 'crypto', chain: 'eip155:42161', address: ARB, symbol: 'USDC', decimals: 6, walletConnected: true, walletAddress: USER })])
    expect(events.map((e) => e.type)).toContain('target.selected')

    c.setAmount('25')
    await c.submitAmount()
    expect(c.getSnapshot().quotes[0]).toMatchObject({ input: { amount: '25' }, output: { asset: { chain: 'eip155:42161' } } })
    // Withdraw quotes never send a pay-with source: the session fixes it.
    expect((await bodyOf(requests, '/quotes'))[0]).toEqual({ method: 'wallet', amount: '25', amountSide: 'source' })
    await c.confirm()
    expect(c.getSnapshot().session!.step.surface).toMatchObject({ kind: 'WALLET_TX', chain: 'eip155:8453', txs: [{ to: ARB }] })
    await c.sendWalletTransactions()
    expect(wallet!.sent).toHaveLength(1)
    await waitFor(() => c.getSnapshot().screen === 'result', 8000)
    expect((await c.done).step.state).toBe('COMPLETED')
    c.destroy()
  })

  it('back goes from amount to the form; restart from PAYMENT returns to the form', async () => {
    const { c } = await make()
    await c.start()
    c.setTargetAddress(ARB)
    await c.submitTarget()
    c.back()
    expect(c.getSnapshot().screen).toBe('target')
    await c.submitTarget()
    c.setAmount('5')
    await c.submitAmount()
    await c.confirm()
    expect(c.getSnapshot().screen).toBe('step')
    c.back() // PAYMENT: restart
    await waitFor(() => c.getSnapshot().screen === 'target')
    expect(c.getSnapshot().session!.step.state).toBe('SELECT_METHOD')
    c.destroy()
  })

  it('a refused address keeps the user on the form with the server error', async () => {
    const { c } = await make({ config: { screenAddress: async (a) => a !== ARB } })
    await c.start()
    c.setTargetAddress(ARB)
    await c.submitTarget()
    expect(c.getSnapshot()).toMatchObject({ screen: 'target', busy: false, error: { code: 'ADDRESS_REJECTED' } })
  })

  it('without a wallet the method is unavailable: the plan shows on the methods screen', async () => {
    const { c } = await make({ wallet: false })
    await c.start()
    expect(c.getSnapshot().target!.address).toBe('')
    c.setTargetAddress(ARB)
    await c.submitTarget()
    expect(c.getSnapshot().screen).toBe('methods')
    expect(c.getSnapshot().plan!.methods[0]).toMatchObject({ group: 'unavailable' })
  })

  it('custody app with a treasury: after confirm the step is already PROCESSING (no wallet)', async () => {
    const send = vi.fn(async () => ({ hash: `0x${'ab'.repeat(32)}` }))
    const source: WithdrawSource = { ...BASE_SOURCE, custody: 'app' }
    const { c } = await make({ wallet: false, session: { source }, config: { treasury: { send } } })
    await c.start()
    c.setTargetAddress(ARB)
    await c.submitTarget()
    expect(c.getSnapshot().screen).toBe('amount')
    expect(c.sourceBalance()).toBeUndefined()
    c.setAmount('12')
    await c.submitAmount()
    await c.confirm()
    expect(c.getSnapshot().session!.step.state).toBe('PROCESSING')
    expect(send).toHaveBeenCalledTimes(1)
    await waitFor(() => c.getSnapshot().screen === 'result', 8000)
    c.destroy()
  })
})

describe('withdraw: to cash', () => {
  it('GCash in PH: payout methods, amount, quote in PHP, form, wallet tx, result', async () => {
    const { c, requests } = await make()
    await c.start()
    c.setTab('cash')
    expect(c.getSnapshot().screen).toBe('loading')
    await waitFor(() => c.getSnapshot().screen === 'methods')
    expect(c.getSnapshot().plan!.currency).toBe('PHP')
    expect(c.getSnapshot().plan!.methods.map((m) => m.method)).toEqual(['gcash', 'bank_transfer'])
    expect(await bodyOf(requests, '/target')).toEqual([expect.objectContaining({ type: 'fiat', currency: 'PHP' })])
    await c.selectMethod('gcash')
    c.back()
    expect(c.getSnapshot().screen).toBe('methods')
    await c.selectMethod('gcash')
    c.setAmount('20')
    await c.submitAmount()
    expect(c.getSnapshot().quotes[0]!.output).toMatchObject({ amount: '1131.43', asset: { kind: 'fiat', currency: 'PHP' } })
    await c.confirm()
    expect(c.getSnapshot().session!.step.surface?.kind).toBe('FORM')
    await c.fire('submit_details', { account_name: 'Juan', phone: '09171234567' })
    expect(c.getSnapshot().session!.step.surface?.kind).toBe('WALLET_TX')
    await c.sendWalletTransactions()
    await waitFor(() => c.getSnapshot().screen === 'result', 8000)
    expect(c.getSnapshot().session!.step.state).toBe('COMPLETED')
    c.destroy()
  })

  it('switching tabs quickly drops the stale cash plan', async () => {
    const { c } = await make()
    await c.start()
    c.setTab('cash')
    c.setTab('crypto')
    await new Promise((r) => setTimeout(r, 30))
    expect(c.getSnapshot().screen).toBe('target')
  })

  it('allowedTargets: cash only starts on the methods, in an allowed currency', async () => {
    const { c } = await make({ session: { country: 'SG', allowedTargets: { fiat: { currencies: ['PHP'] } } } })
    await c.start()
    await waitFor(() => c.getSnapshot().screen === 'methods')
    expect(c.withdrawTabs()).toEqual(['cash'])
    expect(c.getSnapshot()).toMatchObject({ tab: 'cash', cashCurrency: 'PHP' })
  })

  it('allowedTargets: listed chains only, and the source token shows on its chain', async () => {
    const token = `0x${'7'.repeat(40)}`
    const { c } = await make({ session: { source: { chain: 'eip155:8453', token, symbol: 'XYZ', decimals: 8, custody: 'user_wallet' }, allowedTargets: { crypto: { chains: ['eip155:10', 'eip155:8453'] } } } })
    await c.start()
    expect(c.withdrawTabs()).toEqual(['crypto'])
    expect(c.withdrawChains()).toEqual(['eip155:10', 'eip155:8453'])
    expect(c.getSnapshot().target).toMatchObject({ chain: 'eip155:8453', token, symbol: 'XYZ', decimals: 8 })
    expect(c.targetTokens().map((t) => t.symbol)).toEqual(['XYZ', 'USDC', 'ETH'])
    expect(c.targetTokens('eip155:10').map((t) => t.symbol)).toEqual(['USDC', 'ETH'])
  })

  it('no allowed target type is an error; a deposit session is refused when a withdraw is expected', async () => {
    const none = await make({ session: { allowedTargets: {} } })
    await none.c.start()
    expect(none.c.getSnapshot()).toMatchObject({ screen: 'error', error: { code: 'TARGET_NOT_ALLOWED' } })

    const srv = setupServer()
    const dep = await srv.ramp.sessions.create({ userId: 'u', destination: BASE_DEST })
    const c = new RampController({ client: srv.client, clientSecret: dep.clientSecret, expect: 'withdraw' })
    await c.start()
    expect(c.getSnapshot()).toMatchObject({ screen: 'error', error: { message: 'This is not a withdraw session.' } })
    // Deposit sessions ignore the withdraw helpers.
    const d = new RampController({ client: srv.client, clientSecret: dep.clientSecret })
    await d.start()
    expect(d.getSnapshot().direction).toBe('deposit')
    expect(d.sourceBalance()).toBeUndefined()
    await d.submitTarget()
    d.setTargetAddress(ARB)
    d.setTargetToken('native')
    expect(d.getSnapshot().target).toBeUndefined()
  })

  it('a failing cash target shows the error screen', async () => {
    const { c } = await make({ session: { allowedTargets: { fiat: {}, crypto: {} } }, config: {} })
    await c.start()
    // Force a server error: the session has an active payment after a crypto confirm.
    c.setTargetAddress(ARB)
    await c.submitTarget()
    c.setAmount('5')
    await c.submitAmount()
    await c.confirm()
    c.setTab('cash')
    await waitFor(() => c.getSnapshot().screen === 'error')
    expect(c.getSnapshot().error?.message).toMatch(/already in progress/)
  })
})
