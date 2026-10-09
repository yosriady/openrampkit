import { describe, expect, it } from 'vitest'
import { ADDRESS_TRANSFER_METHODS, METHODS, USDC, bps, isAddressTransfer, cmp, fromBaseUnits, isRegionAllowed, planPathways, rankQuotes, roundTo, toBaseUnits, TRANSITION_TABLE, isTerminal, isLegalLegMove } from './index.js'
import type { LegSpec, Quote } from './index.js'

describe('money', () => {
  it('converts base units exactly', () => {
    expect(toBaseUnits('12.5', 6)).toBe('12500000')
    expect(fromBaseUnits('12500000', 6)).toBe('12.5')
    expect(fromBaseUnits('1', 18)).toBe('0.000000000000000001')
  })
  it('applies bps and rounds half up', () => {
    expect(bps('100', 12)).toBe('0.12')
    expect(roundTo('1.005', 2)).toBe('1.01')
    expect(roundTo('500000', 0)).toBe('500000')
    expect(cmp('10.0', '10')).toBe(0)
  })
})

describe('region policy', () => {
  const p = { allow: ['*', 'US-CA'], deny: ['US', 'KP'] }
  it('uses the most specific entry', () => {
    expect(isRegionAllowed(p, 'VN')).toBe(true)
    expect(isRegionAllowed(p, 'US', 'US-NY')).toBe(false)
    expect(isRegionAllowed(p, 'US', 'US-CA')).toBe(true)
    expect(isRegionAllowed(p, 'KP')).toBe(false)
  })
})

describe('table', () => {
  it('has terminal states from data', () => {
    expect(isTerminal('COMPLETED')).toBe(true)
    expect(isTerminal('PROCESSING')).toBe(false)
    expect(TRANSITION_TABLE.KYC.terminal).toBe(false)
  })

  it('moves a leg only forward', () => {
    expect(isLegalLegMove('pending', 'processing')).toBe(true)
    expect(isLegalLegMove('requires_action', 'requires_action')).toBe(true)
    expect(isLegalLegMove('processing', 'succeeded')).toBe(true)
    expect(isLegalLegMove('processing', 'refunded')).toBe(true)
    expect(isLegalLegMove('processing', 'pending')).toBe(false)
    expect(isLegalLegMove('processing', 'requires_action')).toBe(false)
    expect(isLegalLegMove('failed', 'succeeded')).toBe(false)
    expect(isLegalLegMove('succeeded', 'succeeded')).toBe(false)
    expect(isLegalLegMove('succeeded', 'refunded')).toBe(true)
    expect(isLegalLegMove('succeeded', 'reversed')).toBe(true)
    expect(isLegalLegMove('refunded', 'reversed')).toBe(false)
    expect(isLegalLegMove('failed', 'refunded')).toBe(false)
    expect(isTerminal('REVERSED')).toBe(true)
  })
})

const onramp: LegSpec = {
  id: 'card', kind: 'fiat_onramp', methods: ['card', 'vietqr'],
  from: { asset: { kind: 'fiat', currencies: '*' }, location: ['user_account'] },
  to: { asset: { kind: 'crypto', chains: { 'eip155:8453': [USDC['eip155:8453']!] } }, location: ['address'] },
  regions: { allow: ['*'], deny: ['US'] }, eta: { min: 60, max: 300 }, surfaces: ['REDIRECT'],
}
const bridge: LegSpec = {
  id: 'bridge', kind: 'bridge_swap',
  from: { asset: { kind: 'crypto', chains: { 'eip155:8453': [USDC['eip155:8453']!] } }, location: ['address'] },
  to: { asset: { kind: 'crypto', chains: '*' }, location: ['address'] },
  regions: { allow: ['*'], deny: [] }, eta: { min: 5, max: 30 }, surfaces: ['DEPOSIT_ADDRESS'],
}
const wallet: LegSpec = {
  id: 'wallet', kind: 'bridge_swap', methods: ['wallet'],
  from: { asset: { kind: 'crypto', chains: '*' }, location: ['user_wallet'] },
  to: { asset: { kind: 'crypto', chains: '*' }, location: ['address'] },
  regions: { allow: ['*'], deny: [] }, eta: { min: 5, max: 30 }, surfaces: ['WALLET_TX'], requires: ['wallet'],
}
const legs = [
  { adapterId: 'p', provider: 'P', spec: onramp },
  { adapterId: 'r', provider: 'R', spec: bridge },
  { adapterId: 'r', provider: 'R', spec: wallet },
]

describe('planner', () => {
  it('delivers directly when the onramp lists the destination', () => {
    const r = planPathways({ direction: 'deposit', destination: { type: 'crypto', chain: 'eip155:8453', token: USDC['eip155:8453']!, address: '0xabc' }, user: { country: 'VN' }, legs })
    const vietqr = r.pathways.find((p) => p.method === 'vietqr')!
    expect(vietqr.legs).toHaveLength(1)
    expect(r.methods.find((m) => m.method === 'vietqr')!.group).toBe('recommended')
    expect(r.currency).toBe('VND')
  })
  it('offers local methods only in their country', () => {
    const vn = planPathways({ direction: 'deposit', destination: { type: 'crypto', chain: 'eip155:8453', token: USDC['eip155:8453']!, address: '0xabc' }, user: { country: 'VN' }, legs: [{ adapterId: 'p', provider: 'P', spec: { ...onramp, methods: ['card', 'vietqr', 'gcash', 'qris'] } }] })
    expect(vn.methods.map((m) => m.method).sort()).toEqual(['card', 'vietqr'])
  })
  it('adds a bridge hop for an unlisted chain', () => {
    const r = planPathways({ direction: 'deposit', destination: { type: 'crypto', chain: 'eip155:143', token: '0x1234', address: '0xabc' }, user: { country: 'VN' }, legs })
    const p = r.pathways.find((x) => x.method === 'vietqr')!
    expect(p.legs.map((l) => l.legId)).toEqual(['card', 'bridge'])
    expect(p.eta).toEqual({ min: 65, max: 330 })
  })
  it('marks region and wallet problems as unavailable with a reason', () => {
    const r = planPathways({ direction: 'deposit', destination: { type: 'crypto', chain: 'eip155:8453', token: USDC['eip155:8453']!, address: '0xabc' }, user: { country: 'US' }, legs })
    expect(r.methods.find((m) => m.method === 'card')!.group).toBe('unavailable')
    expect(r.methods.find((m) => m.method === 'card')!.reason!.code).toBe('REGION_UNSUPPORTED')
    expect(r.methods.find((m) => m.method === 'wallet')!.group).toBe('unavailable')
  })
  it('groups the connected wallet first', () => {
    const r = planPathways({ direction: 'deposit', destination: { type: 'crypto', chain: 'eip155:8453', token: USDC['eip155:8453']!, address: '0xabc' }, user: { country: 'VN', walletConnected: true }, legs })
    expect(r.methods[0]!.method).toBe('wallet')
    expect(r.methods[0]!.group).toBe('connected')
  })
})

describe('rankQuotes', () => {
  it('orders by output and marks badges', () => {
    const q = (id: string, out: string, eta: number): Quote => ({
      id, pathwayId: id, method: 'card', provider: id, legs: [],
      input: { value: '100', asset: { kind: 'fiat', currency: 'USD' } },
      output: { value: out, asset: { kind: 'crypto', chain: 'eip155:8453', token: 'x' } }, fees: [], eta: { min: 0, max: eta },
      guarantee: 'estimate', expiresAt: '2099-01-01T00:00:00.000Z',
    })
    const r = rankQuotes([q('a', '97', 300), q('b', '98', 600), q('c', '95', 60)])
    expect(r.map((x) => x.id)).toEqual(['b', 'a', 'c'])
    expect(r[0]!.badges).toEqual(['best_price'])
    expect(r[2]!.badges).toEqual(['fastest'])
  })
})

describe('exchange_transfer method', () => {
  it('is an exchange method that sends to a deposit address, like transfer', () => {
    expect(METHODS.exchange_transfer).toEqual({ id: 'exchange_transfer', name: 'From an exchange', kind: 'exchange' })
    expect(ADDRESS_TRANSFER_METHODS).toEqual(['transfer', 'exchange_transfer'])
    expect(isAddressTransfer('exchange_transfer')).toBe(true)
    expect(isAddressTransfer('transfer')).toBe(true)
    expect(isAddressTransfer('exchange')).toBe(false)
    expect(isAddressTransfer(undefined)).toBe(false)
  })

  it('is never the recommended cash method', () => {
    const spec: LegSpec = {
      id: 'x', kind: 'bridge_swap', methods: ['exchange_transfer'],
      from: { asset: { kind: 'crypto', chains: '*' }, location: ['user_wallet'] },
      to: { asset: { kind: 'crypto', chains: '*' }, location: ['address'] },
      regions: { allow: ['*'], deny: [] }, eta: { min: 1, max: 2 }, surfaces: ['DEPOSIT_ADDRESS'],
    }
    const plan = planPathways({
      direction: 'deposit',
      destination: { type: 'crypto', chain: 'eip155:8453', token: USDC['eip155:8453']!, address: '0x000000000000000000000000000000000000beef' },
      user: { country: 'VN' },
      legs: [{ adapterId: 'm', provider: 'M', spec }],
    })
    expect(plan.methods).toEqual([expect.objectContaining({ method: 'exchange_transfer', kind: 'exchange', group: 'more', name: 'From an exchange' })])
  })
})
