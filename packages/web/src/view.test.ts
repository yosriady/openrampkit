import { describe, expect, it } from 'vitest'
import type { Snapshot } from '@openrampkit/client'
import { SOLANA_MAINNET, USDC, openRampError } from '@openrampkit/core'
import { METHODS, method, payment, plan, quote, session, step } from '../../client/src/testctx.js'
import { en, vi as viMessages } from './messages.js'
import {
  amountModel,
  groupLabel,
  groupMethods,
  historyRow,
  historyTone,
  liveText,
  methodSubtitle,
  methodTabs,
  nextQuoteId,
  quoteSubtitle,
  resolveMode,
  screenOf,
  screenTitle,
  sourceForChain,
  stepKey,
  transferChains,
  transferTokens,
} from './view.js'

function snap(p: Partial<Snapshot> = {}): Snapshot {
  return { screen: 'methods', tab: 'crypto', amount: '', amountSide: 'source', quotes: [], quoteErrors: [], quotesLoading: false, busy: false, walletConnected: false, balances: [], surfaceClosed: false, ...p }
}

describe('mode, keys and screens', () => {
  it('resolveMode', () => {
    expect(resolveMode(undefined, true)).toBe('light')
    expect(resolveMode({ mode: 'light' }, true)).toBe('light')
    expect(resolveMode({ mode: 'dark' }, false)).toBe('dark')
    expect(resolveMode({ mode: 'auto' }, true)).toBe('dark')
    expect(resolveMode({ mode: 'auto' }, false)).toBe('light')
  })

  it('stepKey', () => {
    expect(stepKey(undefined)).toBe('')
    expect(stepKey(step({ state: 'PAYMENT', detail: { code: 'confirming' }, legIndex: 1, surface: { kind: 'OTP', channel: 'sms', to: '1' } }))).toBe('PAYMENT|confirming|1|OTP')
    expect(stepKey(step({ state: 'PROCESSING' }))).toBe('PROCESSING|||')
  })

  it('screenOf', () => {
    expect(screenOf(snap({ screen: 'quotes' }), undefined)).toBe('quotes')
    expect(screenOf(undefined, openRampError('INTERNAL'))).toBe('error')
    expect(screenOf(undefined, undefined)).toBe('loading')
  })
})

describe('screenTitle', () => {
  it('uses the appearance title, the method name and step titles', () => {
    expect(screenTitle(undefined, en)).toBe('Deposit')
    expect(screenTitle(undefined, en, { title: 'Top up' })).toBe('Top up')
    expect(screenTitle(snap({ screen: 'methods' }), en, { title: 'Top up' })).toBe('Top up')
    expect(screenTitle(snap({ screen: 'amount', method: method({ method: 'card', name: 'Card' }) }), en)).toBe('Card')
    expect(screenTitle(snap({ screen: 'amount' }), en)).toBe('Deposit')
    expect(screenTitle(snap({ screen: 'quotes', method: method({ method: 'transfer' }) }), en)).toBe('Transfer crypto')
    expect(screenTitle(snap({ screen: 'quotes', method: method({ method: 'exchange_transfer' }) }), en)).toBe('Send from an exchange')
    expect(screenTitle(snap({ screen: 'quotes', method: method({ method: 'card' }) }), en)).toBe('Choose a quote')
    expect(screenTitle(snap({ screen: 'step', session: session('PAYMENT') }), en)).toBe('Complete payment')
    expect(screenTitle(snap({ screen: 'step', session: session('WEIRD' as never) }), en)).toBe('Deposit')
    expect(screenTitle(snap({ screen: 'step' }), en)).toBe('Deposit')
  })
})

describe('liveText', () => {
  it('announces loading, errors, quotes and step progress', () => {
    expect(liveText(undefined, undefined, en)).toBe('Loading')
    expect(liveText(undefined, openRampError('UNAUTHORIZED'), en)).toBe('This session is not valid.')
    expect(liveText(snap({ quotesLoading: true }), undefined, en)).toBe('Getting quotes')
    expect(liveText(snap({ error: openRampError('NO_QUOTES') }), undefined, en)).toMatch(/^No provider/)
    const s = session(step({ state: 'PROCESSING' }), {
      payment: payment([
        { adapterId: 'swapped', legId: 'a', provider: 'Swapped', status: 'succeeded' },
        { adapterId: 'relay_bridge', legId: 'b', status: 'mystery' as never },
      ]),
    })
    expect(liveText(snap({ screen: 'step', session: s }), undefined, en)).toBe('Processing. 1. Swapped: done. 2. Relay Bridge: mystery')
    expect(liveText(snap({ screen: 'step', session: session('WEIRD' as never) }), undefined, en)).toBe('')
    expect(liveText(snap(), undefined, en)).toBe('')
  })

  it('announces the result', () => {
    const done = session(step({ state: 'COMPLETED' }))
    const failed = session(step({ state: 'FAILED' }))
    expect(liveText(snap({ screen: 'result', session: done }), undefined, en)).toBe('Deposit complete')
    expect(liveText(snap({ screen: 'result', session: done, direction: 'withdraw' }), undefined, en)).toBe('Withdrawal complete')
    expect(liveText(snap({ screen: 'result', session: failed }), undefined, en)).toBe('Payment failed')
    expect(liveText(snap({ screen: 'result', session: failed, direction: 'withdraw' }), undefined, en)).toBe('Withdrawal failed')
    expect(liveText(snap({ screen: 'result', session: session(step({ state: 'EXPIRED' })) }), undefined, en)).toBe('Session expired')
    expect(liveText(snap({ screen: 'result', session: session(step({ state: 'REVERSED' })) }), undefined, en)).toBe('Payment reversed')
  })
})

describe('methods', () => {
  const crypto = METHODS.filter((m) => m.kind === 'crypto')
  const cash = METHODS.filter((m) => m.kind !== 'crypto')

  it('methodTabs shows tabs only when both sides have methods', () => {
    expect(methodTabs(crypto, cash, 'cash')).toEqual({ showTabs: true, tab: 'cash', list: cash })
    expect(methodTabs(crypto, [], 'cash')).toEqual({ showTabs: false, tab: 'crypto', list: crypto })
    expect(methodTabs([], cash, 'crypto')).toEqual({ showTabs: false, tab: 'cash', list: cash })
    expect(methodTabs([], [], 'crypto')).toEqual({ showTabs: false, tab: 'cash', list: [] })
  })

  it('groupMethods keeps display order and drops empty groups', () => {
    const g = groupMethods([...METHODS].reverse())
    expect(g.map((x) => x.group)).toEqual(['connected', 'recommended', 'more', 'unavailable'])
    expect(groupMethods(cash).map((x) => x.group)).toEqual(['recommended', 'unavailable'])
    expect(groupLabel('connected', en)).toBe('Connected')
    expect(groupLabel('recommended', en)).toBe('Most popular')
    expect(groupLabel('more', en)).toBe('Other options')
    expect(groupLabel('unavailable', en)).toBe('Not available')
  })

  it('methodSubtitle', () => {
    const [wallet, , card, pix] = METHODS
    expect(methodSubtitle(wallet!, '0x1111111111111111111111111111111111111111', en)).toBe('0x1111...1111 · via Test provider')
    expect(methodSubtitle(wallet!, undefined, en)).toBe('via Test provider')
    expect(methodSubtitle(card!, undefined, en)).toBe('via Test provider · $20,000 limit')
    expect(methodSubtitle(pix!, undefined, en)).toBe('Not in your region.')
    expect(methodSubtitle(method({ method: 'x', group: 'unavailable' }), undefined, en)).toBe('')
    expect(methodSubtitle(method({ method: 'x', providers: [] }), undefined, en)).toBe('')
  })
})

describe('amountModel', () => {
  it("the app's presets: at most 4, no repeats, inside bounds of the same currency; else the defaults", () => {
    const s = snap({ method: method({ method: 'card', limits: { min: '10', max: '1000', currency: 'USD' } }), plan: { currency: 'USD', methods: [], pathways: [] }, presets: { USD: ['5', '20', '20', '50', '100', '500', '900', '2000'] } })
    expect(amountModel(s, en).chips.map((c) => c.value)).toEqual(['20', '50', '100', '500'])
    // Bounds in another currency do not filter
    const other = snap({ method: method({ method: 'card', limits: { min: '100000', currency: 'VND' } }), plan: { currency: 'USD', methods: [], pathways: [] }, presets: { USD: ['5'] } })
    expect(amountModel(other, en).chips.map((c) => c.value)).toEqual(['5'])
    // No presets for this currency: the built-in chips
    const none = snap({ method: method({ method: 'card' }), plan: { currency: 'USD', methods: [], pathways: [] }, presets: { EUR: ['5'] } })
    expect(amountModel(none, en).chips.length).toBeGreaterThan(0)
    expect(amountModel(none, en).chips.map((c) => c.value)).not.toEqual(['5'])
  })

  it('fiat: plan currency, symbol prefix, bounds from the session and preset chips', () => {
    const s = snap({
      screen: 'amount',
      method: method({ method: 'vietqr' }),
      plan: plan(METHODS, 'VND'),
      session: session('SELECT_METHOD', { amountBounds: { min: '100000', max: '50000000', currency: 'VND' } }),
      amount: '500000',
    })
    const a = amountModel(s, en)
    expect(a).toMatchObject({ isWallet: false, currency: 'VND', prefix: '₫', valid: true, balance: undefined })
    expect(a.boundsText).toBe('Min ₫100,000, max ₫50,000,000')
    expect(a.chips.map((c) => c.value)).toEqual(['200000', '500000', '1000000', '2000000'])
    expect(a.chips[0]!.label).toBe('₫200,000')
    expect(a.width).toBeCloseTo(6.3)
  })

  it('fiat without plan uses the session currency, method limits, and a suffix for codes without a symbol', () => {
    const s = snap({ method: method({ method: 'card', limits: { min: '10', currency: 'CHF' } }), session: session('SELECT_METHOD', { currency: 'CHF' }) })
    const a = amountModel(s, en)
    expect(a.currency).toBe('CHF')
    expect(a.prefix).toBe('')
    expect(a.boundsText.replace(/\s/g, ' ')).toBe('Minimum CHF 10')
    expect(a.valid).toBe(false)
    expect(a.width).toBeCloseTo(1.3)
    expect(amountModel(snap({ method: method({ method: 'card' }) }), en)).toMatchObject({ currency: 'USD', boundsText: '' })
  })

  it('wallet: token currency, balance and percentage chips', () => {
    const b = { chain: 'eip155:42161', token: USDC['eip155:42161']!, symbol: 'USDC', decimals: 6, amount: '250' }
    const s = snap({
      method: method({ method: 'wallet', kind: 'crypto', limits: { max: '1', currency: 'USD' } }),
      balances: [b],
      source: { chain: b.chain, token: b.token, symbol: 'USDC', decimals: 6 },
      amount: '0',
    })
    const a = amountModel(s, en)
    expect(a).toMatchObject({ isWallet: true, currency: 'USDC', prefix: '', boundsText: '', balance: b, valid: false })
    expect(a.chips).toEqual([
      { label: '25%', value: '62.5' },
      { label: '50%', value: '125' },
      { label: 'Max', value: '250' },
    ])
    expect(amountModel(snap({ method: method({ method: 'wallet' }) }), en)).toMatchObject({ currency: 'USDC', chips: [], balance: undefined })
  })
})

describe('quotes', () => {
  it('quoteSubtitle', () => {
    expect(quoteSubtitle(quote({ id: 'a' }), en)).toBe('You pay $100.00 · Fees $2.50')
    expect(quoteSubtitle(quote({ id: 'a', input: { value: '0', asset: { kind: 'fiat', currency: 'USD' } }, fees: [] }), en)).toBe('No fees')
    // Fees in the rate: a known amount shows; an amount that the provider does not give never says "No fees"
    const unstated = { kind: 'provider' as const, label: 'guardarian fee', amount: null, included: true }
    const known = { kind: 'network' as const, label: 'Network fee', amount: { value: '4.8', asset: { kind: 'fiat' as const, currency: 'USD' } }, included: true }
    expect(quoteSubtitle(quote({ id: 'a', input: { value: '100', asset: { kind: 'fiat', currency: 'EUR' } }, fees: [unstated] }), en)).toBe('You pay €100.00 · Fees included in the rate')
    expect(quoteSubtitle(quote({ id: 'a', fees: [known] }), en)).toBe('You pay $100.00 · Fees $4.80')
    expect(quoteSubtitle(quote({ id: 'a', fees: [known, unstated] }), en)).toBe('You pay $100.00 · Fees $4.80 + a fee in the rate')
  })

  it('nextQuoteId wraps both ways', () => {
    const qs = [quote({ id: 'a' }), quote({ id: 'b' }), quote({ id: 'c' })]
    expect(nextQuoteId(qs, 'a', 1)).toBe('b')
    expect(nextQuoteId(qs, 'c', 1)).toBe('a')
    expect(nextQuoteId(qs, 'a', -1)).toBe('c')
    expect(nextQuoteId(qs, undefined, 1)).toBe('a')
    expect(nextQuoteId([], 'a', 1)).toBeUndefined()
  })
})

describe('transfer source picker', () => {
  it('transferChains lists USDC chains and adds an unknown source chain', () => {
    expect(transferChains(undefined)).toEqual(Object.keys(USDC))
    expect(transferChains('eip155:8453')).toEqual(Object.keys(USDC))
    expect(transferChains('eip155:143')).toEqual([...Object.keys(USDC), 'eip155:143'])
  })

  it('transferTokens offers USDC when known and the native token', () => {
    expect(transferTokens('eip155:137').map(({ token, symbol, decimals }) => ({ token, symbol, decimals }))).toEqual([
      { token: USDC['eip155:137'], symbol: 'USDC', decimals: 6 },
      { token: 'native', symbol: 'POL', decimals: 18 },
    ])
    expect(transferTokens('eip155:143')).toEqual([{ chain: 'eip155:143', token: 'native', symbol: 'MON', decimals: 18 }])
    expect(transferTokens('eip155:777')).toEqual([{ chain: 'eip155:777', token: 'native', symbol: 'ETH', decimals: 18 }])
    // SOL has 9 decimals, not 18
    expect(transferTokens(SOLANA_MAINNET).find((o) => o.token === 'native')).toMatchObject({ token: 'native', symbol: 'SOL', decimals: 9 })
  })

  it('the server list replaces the defaults: its chains, its tokens, and the current chain when missing', () => {
    const usdt = { chain: 'eip155:42161', token: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', symbol: 'USDT', decimals: 6 }
    const sources = [{ chain: 'eip155:42161', name: 'Arbitrum', tokens: [usdt] }]
    expect(transferChains(undefined, sources)).toEqual(['eip155:42161'])
    expect(transferChains('eip155:8453', sources)).toEqual(['eip155:42161', 'eip155:8453'])
    expect(transferTokens('eip155:42161', sources)).toEqual([usdt])
    // a chain the list does not have keeps the defaults
    expect(transferTokens('eip155:8453', sources).map((t) => t.symbol)).toEqual(['USDC', 'ETH'])
    expect(sourceForChain('eip155:42161', false, sources)).toEqual({ chain: 'eip155:42161', token: usdt.token, symbol: 'USDT', decimals: 6 })
  })

  it('sourceForChain keeps native, else picks the first token', () => {
    expect(sourceForChain('eip155:10', false)).toEqual({ chain: 'eip155:10', token: USDC['eip155:10'], symbol: 'USDC', decimals: 6 })
    expect(sourceForChain('eip155:10', true)).toEqual({ chain: 'eip155:10', token: 'native', symbol: 'ETH', decimals: 18 })
    expect(sourceForChain('eip155:143', false)).toEqual({ chain: 'eip155:143', token: 'native', symbol: 'MON', decimals: 18 })
  })
})

describe('history', () => {
  const now = Date.parse('2026-10-16T12:00:00Z')

  it('screenTitle and historyTone', () => {
    expect(screenTitle(snap({ screen: 'history' }), en)).toBe('History')
    expect(historyTone('succeeded')).toBe('success')
    for (const s of ['processing', 'requires_action', 'requires_payment_method'] as const) expect(historyTone(s)).toBe('pending')
    for (const s of ['failed', 'canceled', 'expired', 'refunded', 'reversed'] as const) expect(historyTone(s)).toBe('failure')
  })

  it('historyRow: title, amount, asset, relative date, status and a safe link', () => {
    const base = { id: 'ors_a', kind: 'session' as const, direction: 'deposit' as const, status: 'succeeded' as const, createdAt: '2026-10-16T11:00:00Z' }
    expect(
      historyRow(
        {
          ...base,
          amount: { value: '25', asset: { kind: 'fiat', currency: 'USD' } },
          destination: { type: 'crypto', chain: 'eip155:8453', token: USDC['eip155:8453']! },
          tx: { chain: 'eip155:8453', hash: '0x1', explorerUrl: 'https://basescan.org/tx/0x1' },
        },
        en,
        now,
      ),
    ).toEqual({ id: 'ors_a', title: 'Deposit', amount: '$25.00', to: 'USDC on Base', when: '1 hour ago', status: 'Complete', tone: 'success', explorerUrl: 'https://basescan.org/tx/0x1' })
    // A link that is not https is dropped. A native token gets the symbol of the chain. A fiat payout shows its currency.
    expect(historyRow({ ...base, tx: { chain: 'x', hash: 'h', explorerUrl: 'http://evil.test/tx' } }, en, now).explorerUrl).toBeUndefined()
    expect(historyRow({ ...base, destination: { type: 'crypto', chain: 'eip155:10', token: 'native' } }, en, now).to).toBe('ETH on Optimism')
    expect(historyRow({ ...base, direction: 'withdraw', status: 'failed', destination: { type: 'fiat', currency: 'php' } }, en, now)).toMatchObject({ title: 'Withdrawal', to: 'PHP', amount: '', tone: 'failure', status: 'Failed' })
    expect(historyRow({ ...base, kind: 'standing' }, en, now).title).toBe('Deposit to your address')
    // Another locale: the catalog and the date format follow it.
    const row = historyRow({ ...base, destination: { type: 'crypto', chain: 'eip155:8453', token: USDC['eip155:8453']! } }, { ...viMessages, locale: 'vi' }, now)
    expect(row).toMatchObject({ title: 'Nạp tiền', to: 'USDC trên Base', status: 'Hoàn tất', when: '1 giờ trước' })
  })
})
