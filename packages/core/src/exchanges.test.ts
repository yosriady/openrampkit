import { describe, expect, it } from 'vitest'
import { CHAINS, SOLANA_MAINNET } from './codes.js'
import { EXCHANGES, exchangeNetworkLabel, exchangeOptions, isExchangeMethod } from './exchanges.js'
import type { MethodOption } from './planner.js'

const opt = (method: string, extra: Partial<MethodOption> = {}): MethodOption => ({ method, name: method, kind: 'exchange', group: 'more', providers: [], pathwayIds: [], eta: { min: 1, max: 2 }, ...extra })

describe('exchange picker rows', () => {
  it('none without a connect method: the plain "From an exchange" row is enough', () => {
    expect(exchangeOptions([opt('exchange_transfer'), opt('card', { kind: 'card' })])).toEqual([])
  })

  it('connect rows where a method exists, deposit rows for the rest, then Other', () => {
    const rows = exchangeOptions([opt('coinbase_account'), opt('exchange_transfer')])
    expect(rows.map((r) => [r.id, r.mode, r.method])).toEqual([
      ['binance', 'deposit', 'exchange_transfer'],
      ['coinbase', 'connect', 'coinbase_account'],
      ['okx', 'deposit', 'exchange_transfer'],
      ['bybit', 'deposit', 'exchange_transfer'],
      ['kraken', 'deposit', 'exchange_transfer'],
      ['other', 'deposit', 'exchange_transfer'],
    ])
    expect(rows[1]!.fallback).toBe('exchange_transfer')
  })

  it('the generic `exchange` method counts for Binance only when the Binance adapter offers it', () => {
    expect(exchangeOptions([opt('exchange', { providers: ['Binance'] })]).map((r) => [r.id, r.method])).toEqual([['binance', 'exchange']])
    expect(exchangeOptions([opt('exchange', { providers: ['Other'] })])).toEqual([])
    // Binance Pay through Meld is the second choice; without exchange_transfer there is no fallback and no Other row
    const rows = exchangeOptions([opt('binance_pay', { kind: 'ewallet' })])
    expect(rows).toEqual([{ id: 'binance', name: 'Binance', mode: 'connect', method: 'binance_pay' }])
  })

  it('unavailable methods do not count', () => {
    expect(exchangeOptions([opt('coinbase_account', { group: 'unavailable' }), opt('exchange_transfer')])).toEqual([])
  })

  it('isExchangeMethod: kind exchange, and the connect methods of the list', () => {
    expect(isExchangeMethod({ method: 'binance_pay', kind: 'ewallet' })).toBe(true)
    expect(isExchangeMethod({ method: 'exchange_transfer', kind: 'exchange' })).toBe(true)
    expect(isExchangeMethod({ method: 'gcash', kind: 'ewallet' })).toBe(false)
  })
})

describe('exchange network labels', () => {
  it('the verified name per exchange and chain', () => {
    expect(exchangeNetworkLabel('binance', 'eip155:56')).toBe('BNB Smart Chain (BEP20)')
    expect(exchangeNetworkLabel('binance', 'eip155:1')).toBe('Ethereum (ERC20)')
    expect(exchangeNetworkLabel('binance', 'eip155:137')).toBe('Polygon POS')
    expect(exchangeNetworkLabel('okx', 'eip155:42161')).toBe('Arbitrum One')
    expect(exchangeNetworkLabel('okx', 'eip155:1')).toBe('ERC20')
    expect(exchangeNetworkLabel('kraken', 'eip155:42161')).toBe('Arbitrum One')
    expect(exchangeNetworkLabel('coinbase', 'eip155:42161')).toBe('Arbitrum')
    expect(exchangeNetworkLabel('coinbase', SOLANA_MAINNET)).toBe('Solana')
  })

  it('undefined with no verified value, for "Other exchange", or for an unknown exchange', () => {
    expect(exchangeNetworkLabel('bybit', 'eip155:8453')).toBeUndefined()
    expect(exchangeNetworkLabel('okx', 'eip155:10')).toBeUndefined()
    expect(exchangeNetworkLabel('coinbase', 'eip155:56')).toBeUndefined()
    expect(exchangeNetworkLabel('other', 'eip155:8453')).toBeUndefined()
    expect(exchangeNetworkLabel('nope', 'eip155:8453')).toBeUndefined()
    expect(exchangeNetworkLabel(undefined, 'eip155:8453')).toBeUndefined()
  })

  it('every value has a known chain, an https source on the exchange, and a read date', () => {
    for (const x of EXCHANGES) {
      for (const [chain, v] of Object.entries(x.networks ?? {})) {
        expect(CHAINS[chain], `${x.id} ${chain}`).toBeDefined()
        expect(v.label.trim()).not.toBe('')
        expect(new URL(v.source).protocol).toBe('https:')
        expect(new URL(v.source).hostname).toMatch(new RegExp(`(^|\\.)${x.id}\\.com$`))
        expect(v.read).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      }
    }
  })

  it('missing labels never hide an exchange', () => {
    const rows = exchangeOptions([opt('coinbase_account'), opt('exchange_transfer')])
    expect(rows.map((r) => r.id)).toEqual([...EXCHANGES.map((x) => x.id), 'other'])
  })
})
