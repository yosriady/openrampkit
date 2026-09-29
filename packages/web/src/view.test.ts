import { describe, expect, it } from 'vitest'
import type { Snapshot } from '@openrampkit/client'
import { USDC, orkError } from '@openrampkit/core'
import { METHODS, method, plan, quote, session, step } from '../../client/src/testctx.js'
import { en } from './messages.js'
import {
  amountModel,
  groupLabel,
  groupMethods,
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
  return { screen: 'methods', tab: 'crypto', amount: '', amountSide: 'source', quotes: [], quoteErrors: [], quotesLoading: false, busy: false, walletConnected: false, balances: [], ...p }
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
    expect(stepKey(step({ state: 'PAYMENT', sub: 'X', legIndex: 1, surface: { kind: 'OTP', channel: 'sms', to: '1' } }))).toBe('PAYMENT|X|1|OTP')
    expect(stepKey(step({ state: 'PROCESSING' }))).toBe('PROCESSING|||')
  })

  it('screenOf', () => {
    expect(screenOf(snap({ screen: 'quotes' }), undefined)).toBe('quotes')
    expect(screenOf(undefined, orkError('INTERNAL'))).toBe('error')
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
    expect(screenTitle(snap({ screen: 'quotes', method: method({ method: 'card' }) }), en)).toBe('Choose a quote')
    expect(screenTitle(snap({ screen: 'step', session: session('PAYMENT') }), en)).toBe('Complete payment')
    expect(screenTitle(snap({ screen: 'step', session: session('WEIRD' as never) }), en)).toBe('Deposit')
    expect(screenTitle(snap({ screen: 'step' }), en)).toBe('Deposit')
  })
})

describe('liveText', () => {
  it('announces loading, errors, quotes and step progress', () => {
    expect(liveText(undefined, undefined, en)).toBe('Loading')
    expect(liveText(undefined, orkError('UNAUTHORIZED'), en)).toBe('This session is not valid.')
    expect(liveText(snap({ quotesLoading: true }), undefined, en)).toBe('Getting quotes')
    expect(liveText(snap({ error: orkError('NO_QUOTES') }), undefined, en)).toMatch(/^No provider/)
    const s = session(
      step({
        state: 'PROCESSING',
        progress: {
          legs: [
            { adapterId: 'swapped', legId: 'a', provider: 'Swapped', status: 'succeeded' },
            { adapterId: 'relay_bridge', legId: 'b', status: 'mystery' as never },
          ],
        },
      }),
    )
    expect(liveText(snap({ screen: 'step', session: s }), undefined, en)).toBe('Processing. 1. Swapped: done. 2. Relay Bridge: mystery')
    expect(liveText(snap({ screen: 'step', session: session('WEIRD' as never) }), undefined, en)).toBe('')
    expect(liveText(snap(), undefined, en)).toBe('')
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
    expect(quoteSubtitle(quote({ id: 'a', input: { amount: '0', asset: { kind: 'fiat', currency: 'USD' } }, fees: [] }), en)).toBe('No fees')
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
    expect(transferTokens('eip155:137')).toEqual([
      { token: USDC['eip155:137'], symbol: 'USDC', decimals: 6 },
      { token: 'native', symbol: 'POL', decimals: 18 },
    ])
    expect(transferTokens('eip155:143')).toEqual([{ token: 'native', symbol: 'MON', decimals: 18 }])
    expect(transferTokens('eip155:777')).toEqual([{ token: 'native', symbol: 'ETH', decimals: 18 }])
  })

  it('sourceForChain keeps native, else picks the first token', () => {
    expect(sourceForChain('eip155:10', false)).toEqual({ chain: 'eip155:10', token: USDC['eip155:10'], symbol: 'USDC', decimals: 6 })
    expect(sourceForChain('eip155:10', true)).toEqual({ chain: 'eip155:10', token: 'native', symbol: 'ETH', decimals: 18 })
    expect(sourceForChain('eip155:143', false)).toEqual({ chain: 'eip155:143', token: 'native', symbol: 'MON', decimals: 18 })
  })
})
