// Planner: withdraw pathways (crypto and fiat targets, custody by the user or the app).
import { describe, expect, it } from 'vitest'
import { USDC } from './codes.js'
import { destinationEndpoint, planPathways, withdrawSourceEndpoint } from './planner.js'
import type { PlannerInput, PlannerLeg } from './planner.js'
import type { LegSpec, WithdrawSource } from './types.js'

const ANY = { allow: ['*'], deny: [] }
const usdcChains = Object.fromEntries(Object.entries(USDC).map(([c, t]) => [c, [t]]))

const wallet: LegSpec = {
  id: 'wallet', kind: 'bridge_swap', methods: ['wallet'],
  from: { asset: { kind: 'crypto', chains: '*' }, location: ['user_wallet'] },
  to: { asset: { kind: 'crypto', chains: '*' }, location: ['address'] },
  regions: ANY, eta: { min: 5, max: 60 }, surfaces: ['WALLET_TX'], requires: ['wallet'],
}
const transfer: LegSpec = { ...wallet, id: 'transfer', methods: ['transfer'], surfaces: ['DEPOSIT_ADDRESS'], requires: [] }
const onramp: LegSpec = {
  id: 'card', kind: 'fiat_onramp', methods: ['card'],
  from: { asset: { kind: 'fiat', currencies: '*' }, location: ['user_account'] },
  to: { asset: { kind: 'crypto', chains: usdcChains }, location: ['address'] },
  regions: ANY, eta: { min: 60, max: 300 }, surfaces: ['REDIRECT'],
}
const offramp: LegSpec = {
  id: 'offramp', kind: 'crypto_offramp', methods: ['bank_transfer', 'gcash', 'momo', 'promptpay'],
  from: { asset: { kind: 'crypto', chains: usdcChains }, location: ['user_wallet', 'address'] },
  to: { asset: { kind: 'fiat', currencies: ['PHP', 'VND', 'THB'] }, location: ['user_account'] },
  regions: { allow: ['PH', 'VN', 'TH'], deny: [] }, limits: { min: '5', max: '5000', currency: 'USD' },
  eta: { min: 60, max: 900 }, surfaces: ['FORM', 'WALLET_TX'],
}
/** A sell leg that only takes deposits at an address (the app's treasury can use it, a user wallet cannot) */
const treasuryOnly: LegSpec = { ...offramp, id: 'sell', methods: ['bank_transfer'], from: { ...offramp.from, location: ['address'] } }

const legs = (...specs: LegSpec[]): PlannerLeg[] => specs.map((spec) => ({ adapterId: 'p', provider: 'P', spec }))
const BASE_USDC: WithdrawSource = { chain: 'eip155:8453', token: USDC['eip155:8453']!.toUpperCase().replace('0X', '0x'), symbol: 'USDC', decimals: 6, custody: 'user_wallet' }
const TO_ARB = { type: 'crypto' as const, chain: 'eip155:42161', token: USDC['eip155:42161']!, address: '0x2222222222222222222222222222222222222222' }

function plan(p: Partial<PlannerInput> & { source?: WithdrawSource; treasury?: boolean }) {
  const { source = BASE_USDC, treasury = false, ...rest } = p
  return planPathways({
    direction: 'withdraw',
    destination: TO_ARB,
    user: { country: 'PH', walletConnected: true },
    legs: legs(wallet, transfer, onramp, offramp),
    withdraw: { source, treasury },
    ...rest,
  })
}

describe('withdraw planning', () => {
  it('endpoints: the source in the user wallet or at the app, fiat targets at the user account', () => {
    expect(withdrawSourceEndpoint(BASE_USDC)).toEqual({ asset: { kind: 'crypto', chain: 'eip155:8453', token: USDC['eip155:8453'], symbol: 'USDC', decimals: 6 }, location: { kind: 'user_wallet' } })
    expect(withdrawSourceEndpoint({ chain: 'eip155:1', token: 'native', custody: 'app' })).toEqual({ asset: { kind: 'crypto', chain: 'eip155:1', token: 'native' }, location: { kind: 'address', address: 'app' } })
    expect(destinationEndpoint({ type: 'fiat', currency: 'PHP' })).toEqual({ asset: { kind: 'fiat', currency: 'PHP' }, location: { kind: 'user_account' } })
  })

  it('a withdraw plan needs the source', () => {
    expect(() => planPathways({ direction: 'withdraw', destination: TO_ARB, user: {}, legs: [] })).toThrow(/withdraw.source/)
  })

  it('to a crypto address: only legs that send with a signed tx (wallet), not deposit-address or onramp legs', () => {
    const r = plan({})
    expect(r.methods.map((m) => [m.method, m.group])).toEqual([['wallet', 'connected']])
    expect(r.pathways).toHaveLength(1)
    expect(r.pathways[0]).toMatchObject({
      id: 'wallet:p.wallet',
      legs: [{ legId: 'wallet', method: 'wallet', from: { location: { kind: 'user_wallet' }, asset: { chain: 'eip155:8453' } }, to: { location: { kind: 'address', address: TO_ARB.address } } }],
    })
    expect(r.currency).toBe('PHP')
  })

  it('without a connected wallet the user-wallet method is unavailable with a reason', () => {
    const r = plan({ user: { country: 'PH', walletConnected: false } })
    expect(r.methods[0]).toMatchObject({ method: 'wallet', group: 'unavailable', reason: { message: 'Connect your wallet to withdraw.' } })
  })

  it('to cash: offramp payout methods for the country, recommended by the priority table', () => {
    const r = plan({ destination: { type: 'fiat', currency: 'PHP' } })
    expect(r.currency).toBe('PHP')
    expect(r.methods.map((m) => [m.method, m.group])).toEqual([['gcash', 'recommended'], ['bank_transfer', 'more']])
    expect(r.methods[0]!.limits).toEqual({ min: '5', max: '5000', currency: 'USD' })
    const vn = plan({ destination: { type: 'fiat', currency: 'VND' }, user: { country: 'VN', walletConnected: true } })
    expect(vn.methods.map((m) => m.method)).toEqual(['momo', 'bank_transfer'])
    // A currency the offramp does not pay out: nothing to offer.
    expect(plan({ destination: { type: 'fiat', currency: 'EUR' } }).methods).toEqual([])
  })

  it('region, surfaces and disabled methods apply to withdraw legs', () => {
    const sg = plan({ destination: { type: 'fiat', currency: 'PHP' }, user: { country: 'SG', walletConnected: true } })
    expect(sg.methods).toEqual([expect.objectContaining({ method: 'bank_transfer', group: 'unavailable', reason: expect.objectContaining({ code: 'REGION_UNSUPPORTED' }) })])
    const old = plan({ policy: { clientSurfaces: ['QR'] } })
    expect(old.methods[0]!.reason?.code).toBe('CLIENT_UPGRADE_REQUIRED')
    expect(plan({ destination: { type: 'fiat', currency: 'PHP' }, policy: { disabledMethods: ['gcash'] } }).methods.map((m) => m.method)).toEqual(['bank_transfer'])
  })

  it('the source must be an asset the leg accepts', () => {
    const r = plan({ destination: { type: 'fiat', currency: 'PHP' }, source: { chain: 'eip155:56', token: '0x' + '5'.repeat(40), custody: 'user_wallet' } })
    expect(r.methods).toEqual([])
  })

  it('custody app: legs that start at an address qualify, and a missing treasury makes them unavailable', () => {
    const app: WithdrawSource = { ...BASE_USDC, custody: 'app' }
    const input = { destination: { type: 'fiat' as const, currency: 'PHP' }, legs: legs(offramp, treasuryOnly), user: { country: 'PH' } }
    const none = plan({ ...input, source: app })
    expect(none.methods.every((m) => m.group === 'unavailable' && m.reason?.message === 'Withdrawals are not set up for this app yet.')).toBe(true)
    const ok = plan({ ...input, source: app, treasury: true })
    expect(ok.methods.map((m) => [m.method, m.group, m.pathwayIds.length])).toEqual([['gcash', 'recommended', 1], ['bank_transfer', 'more', 2]])
    expect(ok.pathways[0]!.legs[0]!.from.location).toEqual({ kind: 'address', address: 'app' })
    // A user wallet cannot pay into the address-only leg.
    const user = plan({ ...input, user: { country: 'PH', walletConnected: true } })
    expect(user.pathways.map((p) => p.legs[0]!.legId)).toEqual(['offramp', 'offramp'])
    // Custody app to a crypto address: the wallet leg is recommended, no wallet connection needed.
    const cryptoApp = plan({ source: app, treasury: true, user: { country: 'PH' } })
    expect(cryptoApp.methods).toEqual([expect.objectContaining({ method: 'wallet', group: 'recommended' })])
  })

  it('deposit pathways record the method on the first leg', () => {
    const r = planPathways({ direction: 'deposit', destination: TO_ARB, user: { country: 'US' }, legs: legs(onramp) })
    expect(r.pathways.map((p) => p.legs[0]!.method)).toEqual(['card'])
  })
})
