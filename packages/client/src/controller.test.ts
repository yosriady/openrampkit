import { afterEach, describe, expect, it, vi } from 'vitest'
import { USDC, orkError } from '@openrampkit/core'
import type { OrkEvent, PublicSession, WalletAdapter } from '@openrampkit/core'
import { DepositController, OrkClientError, createMockWallet } from './index.js'
import type { ControllerOptions } from './index.js'
import { BEEF, POLL, fakeClient, method, plan, quote, session, step } from './testctx.js'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function make(over: Partial<ControllerOptions> = {}, client = fakeClient()) {
  const events: OrkEvent[] = []
  const c = new DepositController({ client, clientSecret: 'ors_1.sig', onEvent: (e) => events.push(e), ...over })
  const types = () => events.map((e) => e.type)
  return { c, client, events, types }
}

const paymentStep = (surface: NonNullable<PublicSession['step']['surface']>, transitions: PublicSession['step']['transitions'] = []) =>
  session(step({ state: 'PAYMENT', surface, transitions }))

/** Controller on the quotes screen for `card`, amount 100 */
async function atQuotes(over: Partial<ControllerOptions> = {}, client = fakeClient()) {
  const h = make(over, client)
  await h.c.start()
  await h.c.selectMethod('card')
  h.c.setAmount('100')
  await h.c.submitAmount()
  return h
}

describe('start', () => {
  it('loads session and plan without a wallet and picks the crypto tab', async () => {
    const { c, client, types } = make()
    const seen: string[] = []
    c.subscribe(() => seen.push(c.getSnapshot().screen))
    await c.start()
    const s = c.getSnapshot()
    expect(s.screen).toBe('methods')
    expect(s.tab).toBe('crypto')
    expect(s.walletConnected).toBe(false)
    expect(s.walletAddress).toBeUndefined()
    expect(s.balances).toEqual([])
    expect(seen[0]).toBe('loading')
    expect(client.plan).toHaveBeenCalledWith('ors_1.sig', { walletConnected: false })
    // No balances: USDC on a chain other than the destination (Base)
    expect(s.source).toEqual({ chain: 'eip155:42161', token: USDC['eip155:42161'], symbol: 'USDC', decimals: 6 })
    expect(types()).toEqual(['modal.opened'])
  })

  it('default source falls back to Arbitrum when the destination is not Base or Arbitrum', async () => {
    const client = fakeClient({ getSession: vi.fn(async () => session('SELECT_METHOD', { destination: { type: 'crypto', chain: 'eip155:42161', token: '0x1', address: BEEF } })) })
    const { c } = make({}, client)
    await c.start()
    expect(c.getSnapshot().source?.chain).toBe('eip155:8453')
  })

  it('with a wallet: address, positive balances and the largest balance as source', async () => {
    const wallet = createMockWallet({
      address: '0xabc0000000000000000000000000000000000001',
      balances: [
        { chain: 'eip155:10', token: USDC['eip155:10']!, symbol: 'USDC', decimals: 6, amount: '5', usd: '5' },
        { chain: 'eip155:1', token: 'native', symbol: 'ETH', decimals: 18, amount: '0.1', usd: '300' },
        { chain: 'eip155:8453', token: '0xdead', symbol: 'DUST', decimals: 18, amount: '0' },
      ],
    })
    const getAccounts = vi.spyOn(wallet, 'getAccounts')
    const { c, client } = make({ wallet, surfaces: ['QR'] })
    await c.start()
    const s = c.getSnapshot()
    expect(s.walletConnected).toBe(true)
    expect(s.walletAddress).toBe('0xabc0000000000000000000000000000000000001')
    expect(s.balances.map((b) => b.symbol)).toEqual(['USDC', 'ETH'])
    expect(s.source).toEqual({ chain: 'eip155:1', token: 'native', symbol: 'ETH', decimals: 18 })
    expect(client.plan).toHaveBeenCalledWith('ors_1.sig', { walletConnected: true, walletAddress: '0xabc0000000000000000000000000000000000001', surfaces: ['QR'] })
    expect(getAccounts).toHaveBeenCalledTimes(1)
  })

  it('a wallet that fails getAccounts or getBalances counts as not connected / empty', async () => {
    const broken: WalletAdapter = {
      id: 'x',
      getAccounts: async () => {
        throw new Error('locked')
      },
      sendTransactions: async () => ({ hash: '0x' }),
    }
    const { c } = make({ wallet: broken })
    await c.start()
    expect(c.getSnapshot().walletConnected).toBe(false)

    const noBalances: WalletAdapter = {
      id: 'y',
      getAccounts: async () => [{ chain: 'eip155:1', address: '0x1' }],
      getBalances: async () => {
        throw new Error('rpc down')
      },
      sendTransactions: async () => ({ hash: '0x' }),
    }
    const h = make({ wallet: noBalances })
    await h.c.start()
    expect(h.c.getSnapshot()).toMatchObject({ walletConnected: true, balances: [], screen: 'methods' })
  })

  it('picks the cash tab for a merchant destination or when no crypto method is available', async () => {
    const merchant = make({}, fakeClient({ getSession: vi.fn(async () => session('SELECT_METHOD', { destination: { type: 'merchant', currency: 'IDR' } })) }))
    await merchant.c.start()
    expect(merchant.c.getSnapshot().tab).toBe('cash')
    expect(merchant.c.getSnapshot().source).toMatchObject({ chain: 'eip155:42161' })

    const onlyUnavailableCrypto = plan([method({ method: 'wallet', kind: 'crypto', group: 'unavailable' }), method({ method: 'card' })])
    const noCrypto = make({}, fakeClient({ plan: vi.fn(async () => onlyUnavailableCrypto) }))
    await noCrypto.c.start()
    expect(noCrypto.c.getSnapshot().tab).toBe('cash')
  })

  it('resumes a session that is past SELECT_METHOD without planning', async () => {
    const client = fakeClient({ getSession: vi.fn(async () => session('COMPLETED')) })
    const { c } = make({}, client)
    await c.start()
    expect(c.getSnapshot().screen).toBe('result')
    expect(client.plan).not.toHaveBeenCalled()
    await expect(c.done).resolves.toMatchObject({ step: { state: 'COMPLETED' } })
  })

  it('shows the error screen when loading fails, and retry emits modal.opened once', async () => {
    const client = fakeClient({ getSession: vi.fn().mockRejectedValueOnce(new OrkClientError(orkError('UNAUTHORIZED'), 401)).mockResolvedValue(session('SELECT_METHOD')) })
    const { c, types } = make({}, client)
    await c.start()
    expect(c.getSnapshot()).toMatchObject({ screen: 'error', busy: false, error: { code: 'UNAUTHORIZED' } })
    await c.start()
    expect(c.getSnapshot()).toMatchObject({ screen: 'methods', error: undefined })
    expect(types().filter((t) => t === 'modal.opened')).toHaveLength(1)
  })

  it('maps a generic error to INTERNAL with its message', async () => {
    const { c } = make({}, fakeClient({ plan: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) }))
    await c.start()
    expect(c.getSnapshot().error).toMatchObject({ code: 'INTERNAL', message: 'Failed to fetch' })
    const h = make({}, fakeClient({ plan: vi.fn().mockRejectedValue('weird') }))
    await h.c.start()
    expect(h.c.getSnapshot().error).toMatchObject({ code: 'INTERNAL', message: 'weird' })
  })
})

describe('tabs and methods', () => {
  it('methodsForTab splits crypto and exchange from cash kinds', async () => {
    const methods = [...plan().methods, method({ method: 'coinbase', kind: 'exchange' })]
    const { c } = make({}, fakeClient({ plan: vi.fn(async () => plan(methods)) }))
    expect(c.methodsForTab()).toEqual([])
    await c.start()
    expect(c.methodsForTab('crypto').map((m) => m.method)).toEqual(['wallet', 'transfer', 'coinbase'])
    expect(c.methodsForTab('cash').map((m) => m.method)).toEqual(['card', 'pix'])
    expect(c.methodsForTab().map((m) => m.method)).toEqual(['wallet', 'transfer', 'coinbase'])
    c.setTab('cash')
    expect(c.getSnapshot().tab).toBe('cash')
    expect(c.methodsForTab().map((m) => m.method)).toEqual(['card', 'pix'])
  })

  it('selectMethod ignores unknown and unavailable methods', async () => {
    const { c, types } = make()
    await c.start()
    await c.selectMethod('nope')
    await c.selectMethod('pix')
    expect(c.getSnapshot().screen).toBe('methods')
    expect(types()).not.toContain('method.selected')
  })

  it('selectMethod for fiat and wallet goes to the amount screen', async () => {
    const { c, client, events } = make()
    await c.start()
    await c.selectMethod('card')
    expect(c.getSnapshot()).toMatchObject({ screen: 'amount', amountSide: 'source', method: { method: 'card' }, quotes: [] })
    expect(events.at(-1)).toMatchObject({ type: 'method.selected', data: { object: { method: 'card' } }, sessionId: 'ors_1', livemode: false })
    await c.selectMethod('wallet')
    expect(c.getSnapshot().screen).toBe('amount')
    expect(client.quotes).not.toHaveBeenCalled()
  })

  it('selectMethod for transfer quotes at once with the source token and no amount', async () => {
    const { c, client } = make()
    await c.start()
    c.setAmount('55')
    await c.selectMethod('transfer')
    expect(c.getSnapshot()).toMatchObject({ screen: 'quotes', amount: '', selectedQuoteId: 'q1' })
    expect(client.quotes).toHaveBeenCalledWith('ors_1.sig', {
      method: 'transfer',
      amount: '0',
      amountSide: 'source',
      source: { chain: 'eip155:42161', token: USDC['eip155:42161'] },
    })
  })

  it('setSource re-quotes only on the transfer quotes screen', async () => {
    const { c, client } = make()
    await c.start()
    await c.selectMethod('card')
    c.setSource({ chain: 'eip155:10', token: 'native' })
    expect(client.quotes).not.toHaveBeenCalled()
    await c.selectMethod('transfer')
    client.quotes.mockClear()
    c.setSource({ chain: 'eip155:10', token: 'native', symbol: 'ETH', decimals: 18 })
    await vi.waitFor(() => expect(client.quotes).toHaveBeenCalledOnce())
    expect(client.quotes.mock.calls[0]![1]).toMatchObject({ source: { chain: 'eip155:10', token: 'native' } })
  })
})

describe('amount', () => {
  it('setAmount keeps digits and the first decimal point', () => {
    const { c } = make()
    c.setAmount('1,000.50')
    expect(c.getSnapshot().amount).toBe('1000.50')
    c.setAmount('$12a.3.4')
    expect(c.getSnapshot().amount).toBe('12.34')
    c.setAmount('')
    expect(c.getSnapshot().amount).toBe('')
  })

  it('submitAmount rejects empty, zero and non-numbers', async () => {
    const { c, client } = make()
    await c.start()
    await c.selectMethod('card')
    for (const v of ['', '0', '0.00', '.']) {
      c.setAmount(v)
      await c.submitAmount()
      expect(c.getSnapshot()).toMatchObject({ screen: 'amount', error: { code: 'BAD_REQUEST', message: 'Enter an amount.' } })
    }
    expect(client.quotes).not.toHaveBeenCalled()
    c.setAmount('25')
    await c.submitAmount()
    expect(c.getSnapshot()).toMatchObject({ screen: 'quotes', error: undefined, amount: '25' })
    expect(client.quotes).toHaveBeenCalledWith('ors_1.sig', { method: 'card', amount: '25', amountSide: 'source' })
  })

  it('wallet quotes carry the source token', async () => {
    const { c, client } = make()
    await c.start()
    await c.selectMethod('wallet')
    c.setAmount('10')
    await c.submitAmount()
    expect(client.quotes.mock.calls[0]![1]).toMatchObject({ method: 'wallet', source: { chain: 'eip155:42161' } })
  })
})

describe('refreshQuotes', () => {
  it('is a no-op without a method', async () => {
    const { c, client } = make()
    await c.refreshQuotes()
    expect(client.quotes).not.toHaveBeenCalled()
  })

  it('stores quotes, selects the first and emits quotes.shown', async () => {
    const { c, events } = await atQuotes()
    expect(c.getSnapshot()).toMatchObject({ quotesLoading: false, selectedQuoteId: 'q1', quoteErrors: [] })
    expect(c.getSnapshot().quotes.map((q) => q.id)).toEqual(['q1', 'q2'])
    expect(events.find((e) => e.type === 'quotes.shown')?.data.object).toEqual({ method: 'card', count: 2 })
    c.selectQuote('q2')
    expect(c.getSnapshot().selectedQuoteId).toBe('q2')
  })

  it('keeps partial errors next to the quotes that worked', async () => {
    const errors = [orkError('PROVIDER_UNAVAILABLE'), orkError('AMOUNT_TOO_LOW')]
    const client = fakeClient({ quotes: vi.fn(async () => ({ quotes: [quote({ id: 'only' })], errors })) })
    const { c } = await atQuotes({}, client)
    expect(c.getSnapshot()).toMatchObject({ selectedQuoteId: 'only', quoteErrors: errors })
  })

  it('no quotes: nothing is selected', async () => {
    const client = fakeClient({ quotes: vi.fn(async () => ({ quotes: [], errors: [orkError('NO_QUOTES')] })) })
    const { c } = await atQuotes({}, client)
    expect(c.getSnapshot().selectedQuoteId).toBeUndefined()
    expect(c.getSnapshot().quoteErrors[0]!.code).toBe('NO_QUOTES')
  })

  it('a failed request sets the error and clears the loading flag', async () => {
    const client = fakeClient({ quotes: vi.fn().mockRejectedValue(new OrkClientError(orkError('RATE_LIMITED'), 429)) })
    const { c } = await atQuotes({}, client)
    expect(c.getSnapshot()).toMatchObject({ quotesLoading: false, busy: false, error: { code: 'RATE_LIMITED' } })
  })

  it('re-quotes 10 s before the earliest expiry while the quotes screen is open', async () => {
    vi.useFakeTimers()
    const exp = (s: number) => new Date(Date.now() + s * 1000).toISOString()
    const client = fakeClient({
      quotes: vi.fn(async () => ({ quotes: [quote({ id: 'a', expiresAt: exp(120) }), quote({ id: 'b', expiresAt: exp(60) })], errors: [] })),
    })
    const { c } = await atQuotes({}, client)
    expect(client.quotes).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(49_000)
    expect(client.quotes).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(client.quotes).toHaveBeenCalledTimes(2)
    // Leaving the screen stops the timer
    c.back()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(client.quotes).toHaveBeenCalledTimes(2)
  })

  it('re-quotes after at least 5 s when a quote is about to expire, and not while busy', async () => {
    vi.useFakeTimers()
    let busyHold: (() => void) | undefined
    const client = fakeClient({
      quotes: vi.fn(async () => ({ quotes: [quote({ id: 'a', expiresAt: new Date(Date.now() + 1000).toISOString() })], errors: [] })),
      select: vi.fn(() => new Promise<PublicSession>((r) => (busyHold = () => r(session('PROCESSING'))))),
    })
    const { c } = await atQuotes({}, client)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(client.quotes).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(client.quotes).toHaveBeenCalledTimes(2)
    // confirm() clears the timer
    const p = c.confirm()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(client.quotes).toHaveBeenCalledTimes(2)
    busyHold!()
    await p
    c.destroy()
  })

  it('quotes without expiry set no timer', async () => {
    vi.useFakeTimers()
    const { c, client } = await atQuotes()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(client.quotes).toHaveBeenCalledTimes(1)
    c.destroy()
  })

  it('drops a stale response when the user picked another method meanwhile', async () => {
    let release!: () => void
    const client = fakeClient({
      quotes: vi.fn(
        () => new Promise<{ quotes: ReturnType<typeof quote>[]; errors: [] }>((r) => (release = () => r({ quotes: [quote({ id: 'late' })], errors: [] }))),
      ),
    })
    const { c } = make({}, client)
    await c.start()
    await c.selectMethod('card')
    c.setAmount('10')
    const p = c.submitAmount()
    c.back()
    c.back()
    await c.selectMethod('wallet')
    release()
    await p
    expect(c.getSnapshot()).toMatchObject({ method: { method: 'wallet' }, quotes: [], screen: 'amount' })
  })

  it('drops an older response when a newer request finished first', async () => {
    const releases: Array<() => void> = []
    let n = 0
    const client = fakeClient({
      quotes: vi.fn(() => {
        const id = `q${++n}`
        return new Promise((r) => releases.push(() => r({ quotes: [quote({ id })], errors: [] })))
      }) as never,
    })
    const { c } = make({}, client)
    await c.start()
    await c.selectMethod('card')
    c.setAmount('10')
    const first = c.submitAmount()
    const second = c.refreshQuotes()
    releases[1]!()
    await second
    releases[0]!()
    await first
    expect(c.getSnapshot().quotes.map((q) => q.id)).toEqual(['q2'])
  })
})

describe('confirm, fire and wallet', () => {
  it('confirm without a selected quote does nothing', async () => {
    const { c, client } = make()
    await c.confirm()
    expect(client.select).not.toHaveBeenCalled()
  })

  it('confirm selects the quote and shows the step', async () => {
    const wallet = createMockWallet({ address: '0x2222222222222222222222222222222222222222' })
    const { c, client, types } = await atQuotes({ wallet })
    c.selectQuote('q2')
    await c.confirm()
    expect(client.select).toHaveBeenCalledWith('ors_1.sig', { quoteId: 'q2', walletAddress: '0x2222222222222222222222222222222222222222' })
    expect(c.getSnapshot()).toMatchObject({ screen: 'step', busy: false })
    expect(types()).toEqual(expect.arrayContaining(['quote.selected', 'step.changed']))
  })

  it('confirm failure keeps the quotes screen and shows the error', async () => {
    const client = fakeClient({ select: vi.fn().mockRejectedValue(new OrkClientError(orkError('QUOTE_EXPIRED'), 409)) })
    const { c } = await atQuotes({}, client)
    await c.confirm()
    expect(client.select).toHaveBeenCalledWith('ors_1.sig', { quoteId: 'q1' })
    expect(c.getSnapshot()).toMatchObject({ screen: 'quotes', busy: false, error: { code: 'QUOTE_EXPIRED' } })
  })

  it('fire sends the transition and applies the session; errors are shown', async () => {
    const client = fakeClient()
    const { c } = await atQuotes({}, client)
    await c.confirm()
    await c.fire('simulate_payment', { a: 1 })
    expect(client.transition).toHaveBeenCalledWith('ors_1.sig', 'simulate_payment', { a: 1 })
    expect(c.getSnapshot().session?.step.state).toBe('PROCESSING')
    client.transition.mockRejectedValueOnce(new Error('network'))
    await c.fire('x')
    expect(c.getSnapshot()).toMatchObject({ busy: false, error: { code: 'INTERNAL', message: 'network' } })
    c.destroy()
  })

  it('sendWalletTransactions does nothing unless the surface is WALLET_TX', async () => {
    const wallet = createMockWallet({ delayMs: 0 })
    const { c } = await atQuotes({ wallet })
    await c.sendWalletTransactions()
    expect(wallet.sent).toHaveLength(0)
  })

  const walletSurface = paymentStep(
    { kind: 'WALLET_TX', chain: 'eip155:8453', txs: [{ to: BEEF, chainId: 8453 }] },
    [{ name: 'submit_tx', kind: 'SURFACE_RESULT', expects: 'tx_hash' }],
  )

  it('sendWalletTransactions without a wallet shows an error', async () => {
    const client = fakeClient({ select: vi.fn(async () => walletSurface) })
    const { c } = await atQuotes({}, client)
    await c.confirm()
    await c.sendWalletTransactions()
    expect(c.getSnapshot().error).toMatchObject({ code: 'BAD_REQUEST', message: 'No wallet is connected.' })
    expect(client.transition).not.toHaveBeenCalled()
  })

  it('sendWalletTransactions sends with the wallet and reports the tx hash', async () => {
    const wallet = createMockWallet({ delayMs: 0 })
    const client = fakeClient({ select: vi.fn(async () => walletSurface) })
    const { c } = await atQuotes({ wallet }, client)
    await c.confirm()
    await c.sendWalletTransactions()
    expect(wallet.sent).toHaveLength(1)
    expect(wallet.sent[0]!.chain).toBe('eip155:8453')
    expect(client.transition).toHaveBeenCalledWith('ors_1.sig', 'submit_tx', { txHash: wallet.sent[0]!.hash })
    c.destroy()
  })

  it('sendWalletTransactions without a tx_hash transition only sends', async () => {
    const wallet = createMockWallet({ delayMs: 0 })
    const client = fakeClient({ select: vi.fn(async () => paymentStep({ kind: 'WALLET_TX', chain: 'eip155:1', txs: [] })) })
    const { c } = await atQuotes({ wallet }, client)
    await c.confirm()
    await c.sendWalletTransactions()
    expect(wallet.sent).toHaveLength(1)
    expect(client.transition).not.toHaveBeenCalled()
    expect(c.getSnapshot().busy).toBe(false)
  })

  it('a rejected wallet request shows the wallet error', async () => {
    const wallet: WalletAdapter = {
      id: 'w',
      getAccounts: async () => [{ chain: 'eip155:1', address: '0x1' }],
      sendTransactions: async () => {
        throw new Error('User rejected the request.')
      },
    }
    const client = fakeClient({ select: vi.fn(async () => walletSurface) })
    const { c } = await atQuotes({ wallet }, client)
    await c.confirm()
    await c.sendWalletTransactions()
    expect(c.getSnapshot()).toMatchObject({ busy: false, error: { message: 'User rejected the request.' } })
  })
})

describe('openSurface', () => {
  async function withSurface(surface: NonNullable<PublicSession['step']['surface']> | undefined) {
    const client = fakeClient({ select: vi.fn(async () => session(step({ state: 'PAYMENT', ...(surface ? { surface } : {}) }))) })
    const h = await atQuotes({}, client)
    await h.c.confirm()
    return h
  }

  it('REDIRECT opens a new tab, drops the opener and never navigates the host page', async () => {
    const tab = { opener: {} as unknown }
    const win = { open: vi.fn(() => tab), location: { href: 'https://app.example/' } }
    vi.stubGlobal('window', win)
    const { c, events } = await withSurface({ kind: 'REDIRECT', url: 'https://pay.example/x', popup: true })
    c.openSurface()
    expect(win.open).toHaveBeenCalledWith('https://pay.example/x', '_blank')
    expect(tab.opener).toBeNull()
    expect(win.location.href).toBe('https://app.example/')
    expect(events.at(-1)).toMatchObject({ type: 'surface.opened', data: { object: { kind: 'REDIRECT' } } })

    // Popup blocked: still no host navigation
    win.open.mockReturnValueOnce(null as never)
    c.openSurface()
    expect(win.location.href).toBe('https://app.example/')
  })

  it('REDIRECT tolerates a tab whose opener cannot be set', async () => {
    const tab = {}
    Object.defineProperty(tab, 'opener', {
      set() {
        throw new Error('cross-origin')
      },
    })
    vi.stubGlobal('window', { open: vi.fn(() => tab), location: { href: 'x' } })
    const { c } = await withSurface({ kind: 'REDIRECT', url: 'https://pay.example/x', popup: true })
    expect(() => c.openSurface()).not.toThrow()
  })

  it('DEEPLINK falls back to location when the popup is blocked', async () => {
    const win = { open: vi.fn(() => null), location: { href: 'https://app.example/' } }
    vi.stubGlobal('window', win)
    const { c } = await withSurface({ kind: 'DEEPLINK', url: 'gcash://pay?x=1', appName: 'GCash' })
    c.openSurface()
    expect(win.location.href).toBe('gcash://pay?x=1')
  })

  it('other surfaces only emit the event, and no surface does nothing', async () => {
    const win = { open: vi.fn(), location: { href: 'a' } }
    vi.stubGlobal('window', win)
    const { c, events } = await withSurface({ kind: 'QR', payload: 'x', amount: '1', currency: 'USD' })
    c.openSurface()
    expect(win.open).not.toHaveBeenCalled()
    expect(events.at(-1)?.type).toBe('surface.opened')
    const h = await withSurface(undefined)
    const n = h.events.length
    h.c.openSurface()
    expect(h.events).toHaveLength(n)
  })

  it('works without a window (server side)', async () => {
    const { c } = await withSurface({ kind: 'DEEPLINK', url: 'x://y', appName: 'X' })
    expect(() => c.openSurface()).not.toThrow()
  })
})

describe('back and restart', () => {
  it('quotes -> amount -> methods, and transfer quotes -> methods', async () => {
    const { c } = await atQuotes()
    c.back()
    expect(c.getSnapshot().screen).toBe('amount')
    c.back()
    expect(c.getSnapshot().screen).toBe('methods')
    c.back()
    expect(c.getSnapshot().screen).toBe('methods')
    await c.selectMethod('transfer')
    c.back()
    expect(c.getSnapshot().screen).toBe('methods')
  })

  it('back clears a validation error', async () => {
    const { c } = make()
    await c.start()
    await c.selectMethod('card')
    await c.submitAmount()
    expect(c.getSnapshot().error).toBeDefined()
    c.back()
    expect(c.getSnapshot().error).toBeUndefined()
  })

  it('back from a PAYMENT step fires restart, which re-plans', async () => {
    const client = fakeClient()
    client.transition.mockResolvedValue(session('SELECT_METHOD'))
    const { c } = await atQuotes({}, client)
    await c.confirm()
    expect(c.getSnapshot().screen).toBe('step')
    client.plan.mockClear()
    c.back()
    await vi.waitFor(() => expect(c.getSnapshot().screen).toBe('methods'))
    expect(client.transition).toHaveBeenCalledWith('ors_1.sig', 'restart', undefined)
    expect(client.plan).toHaveBeenCalledOnce()
    expect(c.getSnapshot()).toMatchObject({ method: undefined, quotes: [], amount: '', selectedQuoteId: undefined })
  })

  it('back on a PROCESSING step or on the result does nothing', async () => {
    const client = fakeClient({ select: vi.fn(async () => session('PROCESSING')) })
    const { c } = await atQuotes({}, client)
    await c.confirm()
    c.back()
    expect(client.transition).not.toHaveBeenCalled()
    c.destroy()
  })

  it('restart re-plan failure shows the error screen', async () => {
    const client = fakeClient()
    client.transition.mockResolvedValue(session('SELECT_METHOD'))
    const { c } = await atQuotes({}, client)
    client.plan.mockRejectedValueOnce(new OrkClientError(orkError('SESSION_EXPIRED'), 410))
    await c.restart()
    await vi.waitFor(() => expect(c.getSnapshot().screen).toBe('error'))
    expect(c.getSnapshot().error?.code).toBe('SESSION_EXPIRED')
  })

  it('restart keeps wallet address and surfaces for the new plan', async () => {
    const wallet = createMockWallet({ address: '0x3333333333333333333333333333333333333333' })
    const client = fakeClient()
    client.transition.mockResolvedValue(session('SELECT_METHOD'))
    const { c } = await atQuotes({ wallet, surfaces: ['QR'] }, client)
    client.plan.mockClear()
    await c.restart()
    await vi.waitFor(() => expect(client.plan).toHaveBeenCalled())
    expect(client.plan).toHaveBeenCalledWith('ors_1.sig', { walletConnected: true, walletAddress: '0x3333333333333333333333333333333333333333', surfaces: ['QR'] })
  })
})

describe('polling', () => {
  const awaiting = (sub?: string) => session(step({ state: 'PROCESSING', ...(sub ? { sub } : {}), transitions: [{ name: 'poll', kind: 'AWAIT', poll: POLL }] }))

  it('polls with backoff up to the max interval, then gives up', async () => {
    vi.useFakeTimers()
    const client = fakeClient({ select: vi.fn(async () => awaiting()), step: vi.fn(async () => awaiting()) })
    const { c } = await atQuotes({}, client)
    await c.confirm()
    const at = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms)
      return client.step.mock.calls.length
    }
    expect(await at(999)).toBe(0)
    expect(await at(1)).toBe(1) // t=1000
    expect(await at(1999)).toBe(1)
    expect(await at(1)).toBe(2) // t=3000 (2000 later)
    expect(await at(4000)).toBe(3) // t=7000 (4000 later, max)
    expect(await at(4000)).toBe(4) // t=11000 (capped at 4000)
    // giveUpAfterMs = 20s: polls at 15000, 19000, 23000, then stop
    expect(await at(100_000)).toBe(7)
  })

  it('keeps polling after a failed poll request', async () => {
    vi.useFakeTimers()
    const client = fakeClient({ select: vi.fn(async () => awaiting()), step: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(awaiting()) })
    const { c } = await atQuotes({}, client)
    await c.confirm()
    await vi.advanceTimersByTimeAsync(3000)
    expect(client.step).toHaveBeenCalledTimes(2)
    expect(c.getSnapshot().error).toBeUndefined()
    c.destroy()
  })

  it('applies a changed step (sub or progress) and restarts the backoff', async () => {
    vi.useFakeTimers()
    const progressed = session(step({ state: 'PROCESSING', transitions: [{ name: 'poll', kind: 'AWAIT', poll: POLL }], progress: { legs: [{ adapterId: 'mock', legId: 'a', status: 'succeeded' }] } }))
    const client = fakeClient({ select: vi.fn(async () => awaiting()), step: vi.fn().mockResolvedValueOnce(awaiting('BRIDGING')).mockResolvedValueOnce(progressed).mockResolvedValue(progressed) })
    const { c, types } = await atQuotes({}, client)
    await c.confirm()
    await vi.advanceTimersByTimeAsync(1000)
    expect(c.getSnapshot().session?.step.sub).toBe('BRIDGING')
    expect(types().filter((t) => t === 'step.changed')).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1000) // backoff restarted at 1000
    expect(c.getSnapshot().session?.step.progress?.legs[0]!.status).toBe('succeeded')
    c.destroy()
  })

  it('does not poll without an AWAIT transition', async () => {
    vi.useFakeTimers()
    const { c, client } = await atQuotes()
    await c.confirm()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(client.step).not.toHaveBeenCalled()
  })

  it('ignores a poll response that raced with a transition', async () => {
    vi.useFakeTimers()
    let releasePoll!: () => void
    const client = fakeClient({
      select: vi.fn(async () => awaiting()),
      step: vi.fn(() => new Promise<PublicSession>((r) => (releasePoll = () => r(awaiting('STALE'))))),
      transition: vi.fn(async () => session('COMPLETED')),
    })
    const { c } = await atQuotes({}, client)
    await c.confirm()
    await vi.advanceTimersByTimeAsync(1000)
    expect(client.step).toHaveBeenCalledOnce()
    await c.fire('finish')
    releasePoll()
    await vi.advanceTimersByTimeAsync(0)
    expect(c.getSnapshot()).toMatchObject({ screen: 'result', session: { step: { state: 'COMPLETED' } } })
  })

  it('destroy stops polling and quote timers, and drops in-flight results', async () => {
    vi.useFakeTimers()
    let releasePoll!: () => void
    const client = fakeClient({
      select: vi.fn(async () => awaiting()),
      step: vi.fn(() => new Promise<PublicSession>((r) => (releasePoll = () => r(session('COMPLETED'))))),
    })
    const { c } = await atQuotes({}, client)
    const listener = vi.fn()
    c.subscribe(listener)
    await c.confirm()
    await vi.advanceTimersByTimeAsync(1000)
    c.destroy()
    listener.mockClear()
    releasePoll()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(client.step).toHaveBeenCalledOnce()
    expect(listener).not.toHaveBeenCalled()
    expect(c.getSnapshot().screen).toBe('step')
  })

  it('destroy during a quote request sets no re-quote timer', async () => {
    vi.useFakeTimers()
    let release!: () => void
    const client = fakeClient({
      quotes: vi.fn(() => new Promise((r) => (release = () => r({ quotes: [quote({ id: 'a', expiresAt: new Date(Date.now() + 1000).toISOString() })], errors: [] })))) as never,
    })
    const { c } = make({}, client)
    await c.start()
    await c.selectMethod('card')
    c.setAmount('5')
    const p = c.submitAmount()
    c.destroy()
    release()
    await p
    await vi.advanceTimersByTimeAsync(60_000)
    expect(client.quotes).toHaveBeenCalledOnce()
  })
})

describe('terminal states and done', () => {
  it('done resolves on COMPLETED and close() then does not reject', async () => {
    const client = fakeClient({ select: vi.fn(async () => session('COMPLETED')) })
    const { c, events } = await atQuotes({}, client)
    await c.confirm()
    expect(c.getSnapshot().screen).toBe('result')
    await expect(c.done).resolves.toMatchObject({ step: { state: 'COMPLETED' } })
    c.close()
    expect(events.at(-1)).toMatchObject({ type: 'modal.closed', data: { object: { screen: 'result', state: 'COMPLETED' } } })
    await expect(c.done).resolves.toBeDefined()
  })

  it('FAILED shows the result but keeps done pending; restart and success resolve it', async () => {
    const failed = session(step({ state: 'FAILED', error: orkError('PAYMENT_FAILED') }))
    const client = fakeClient({ select: vi.fn().mockResolvedValueOnce(failed).mockResolvedValue(session('COMPLETED')) })
    client.transition.mockResolvedValue(session('SELECT_METHOD'))
    const { c } = await atQuotes({}, client)
    await c.confirm()
    expect(c.getSnapshot()).toMatchObject({ screen: 'result', error: { code: 'PAYMENT_FAILED' } })
    const state = await Promise.race([c.done.then(() => 'settled'), new Promise((r) => setTimeout(() => r('pending'), 10))])
    expect(state).toBe('pending')
    await c.fire('restart')
    await vi.waitFor(() => expect(c.getSnapshot().screen).toBe('methods'))
    await c.selectMethod('card')
    c.setAmount('5')
    await c.submitAmount()
    await c.confirm()
    await expect(c.done).resolves.toMatchObject({ step: { state: 'COMPLETED' } })
  })

  it('close before completion rejects done and stops listeners', async () => {
    const { c, types } = await atQuotes()
    const l = vi.fn()
    c.subscribe(l)
    c.close()
    await expect(c.done).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Closed before completion.', recovery: 'choose_other' })
    expect(types().at(-1)).toBe('modal.closed')
    l.mockClear()
    c.setAmount('1')
    expect(l).not.toHaveBeenCalled()
  })

  it('unsubscribe removes one listener', () => {
    const { c } = make()
    const a = vi.fn()
    const b = vi.fn()
    const off = c.subscribe(a)
    c.subscribe(b)
    off()
    c.setTab('cash')
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledOnce()
  })

  it('events carry id, created and livemode; no sessionId before the session loads', () => {
    const events: OrkEvent[] = []
    const c = new DepositController({ client: fakeClient(), clientSecret: 'ors_1.sig', onEvent: (e) => events.push(e) })
    void c.start()
    expect(events[0]).toMatchObject({ type: 'modal.opened', livemode: false, data: { object: {} } })
    expect(events[0]!.id).toMatch(/^evt_/)
    expect(events[0]!.sessionId).toBeUndefined()
    expect(typeof events[0]!.created).toBe('number')
  })

  it('works without onEvent', async () => {
    const c = new DepositController({ client: fakeClient(), clientSecret: 'ors_1.sig' })
    await c.start()
    expect(c.getSnapshot().screen).toBe('methods')
  })
})

describe('notifySurface (provider iframe messages)', () => {
  const iframe = { kind: 'IFRAME' as const, url: 'https://p.example/w', origin: 'https://p.example' }
  const payment = (sub?: string) =>
    session(step({ state: 'PAYMENT', surface: iframe, transitions: [{ name: 'poll', kind: 'AWAIT', poll: POLL }], ...(sub ? { sub } : {}) }))

  async function atIframe(stepFn = vi.fn(async () => payment())) {
    const client = fakeClient({ select: vi.fn(async () => payment()), step: stepFn })
    const h = await atQuotes({}, client)
    await h.c.confirm()
    return h
  }

  it('completed polls at once, skipping the backoff wait, and emits surface.message', async () => {
    vi.useFakeTimers()
    const done = session(step({ state: 'COMPLETED' }))
    const { c, client, events } = await atIframe(vi.fn(async () => done))
    expect(client.step).not.toHaveBeenCalled()
    c.notifySurface('completed', { origin: 'https://p.example' })
    await vi.advanceTimersByTimeAsync(0)
    expect(client.step).toHaveBeenCalledTimes(1)
    expect(c.getSnapshot().screen).toBe('result')
    expect(c.getSnapshot().session?.step.state).toBe('COMPLETED')
    const ev = events.find((e) => e.type === 'surface.message')!
    expect(ev.data.object).toEqual({ kind: 'completed', detail: { origin: 'https://p.example' } })
    c.destroy()
  })

  it('never takes the outcome from the message: the server status decides', async () => {
    vi.useFakeTimers()
    const { c, client } = await atIframe()
    c.notifySurface('completed')
    await vi.advanceTimersByTimeAsync(0)
    expect(client.step).toHaveBeenCalledTimes(1)
    // The server still says PAYMENT, so the step stays and polling goes on from the first interval.
    expect(c.getSnapshot().screen).toBe('step')
    expect(c.getSnapshot().session?.step.state).toBe('PAYMENT')
    await vi.advanceTimersByTimeAsync(999)
    expect(client.step).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(client.step).toHaveBeenCalledTimes(2)
    c.destroy()
  })

  it('failed also only polls; a burst of messages sends one request', async () => {
    vi.useFakeTimers()
    let release!: () => void
    const stepFn = vi.fn(() => new Promise<PublicSession>((r) => (release = () => r(payment()))))
    const { c, client, types } = await atIframe(stepFn)
    c.notifySurface('failed')
    c.notifySurface('failed')
    c.notifySurface('completed')
    expect(client.step).toHaveBeenCalledTimes(1)
    expect(types().filter((t) => t === 'surface.message')).toHaveLength(3)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(c.getSnapshot().error).toBeUndefined()
    expect(c.getSnapshot().surfaceClosed).toBe(false)
    c.destroy()
  })

  it('closed sets surfaceClosed and polls; reopenSurface clears it; a new step clears it', async () => {
    vi.useFakeTimers()
    const stepFn = vi.fn(async () => payment())
    const { c, client } = await atIframe(stepFn)
    c.notifySurface('closed')
    expect(c.getSnapshot().surfaceClosed).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(client.step).toHaveBeenCalledTimes(1)
    expect(c.getSnapshot().surfaceClosed).toBe(true)
    c.reopenSurface()
    expect(c.getSnapshot().surfaceClosed).toBe(false)
    c.reopenSurface() // no-op
    c.notifySurface('closed')
    await vi.advanceTimersByTimeAsync(0)
    stepFn.mockResolvedValue(payment('RETRY'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(c.getSnapshot().session?.step.sub).toBe('RETRY')
    expect(c.getSnapshot().surfaceClosed).toBe(false)
    c.destroy()
  })

  it('a failed immediate poll keeps polling with backoff', async () => {
    vi.useFakeTimers()
    const stepFn = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(payment())
    const { c, client } = await atIframe(stepFn as never)
    c.notifySurface('completed')
    await vi.advanceTimersByTimeAsync(0)
    expect(client.step).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(client.step).toHaveBeenCalledTimes(2)
    expect(c.getSnapshot().error).toBeUndefined()
    c.destroy()
  })

  it('is ignored outside a step screen and after destroy', async () => {
    const { c, client, types } = make()
    c.notifySurface('completed') // no session yet
    await c.start()
    c.notifySurface('closed') // methods screen
    expect(client.step).not.toHaveBeenCalled()
    expect(c.getSnapshot().surfaceClosed).toBe(false)
    expect(types()).not.toContain('surface.message')
    const h = await atIframe()
    h.c.destroy()
    h.c.notifySurface('completed')
    expect(h.client.step).not.toHaveBeenCalled()
  })
})
