import { describe, expect, it } from 'vitest'
import {
  OpenRampException, add, cmp, combinePolicies, createClientEvent, createWebhookEvent, currencyForCountry, evmChainId, fromScaled, isDecimal, isLegalMove,
  isOpenRampError, isRegionAllowed, methodAvailableIn, methodName, minorUnits, mulRatio, openRampError, planPathways, roundTo, sub,
  toScaled, validateStep, chainName, USDC,
} from './index.js'
import type { LegSpec } from './index.js'

describe('money edges', () => {
  it('handles negatives, scale and invalid input', () => {
    expect(isDecimal('1.5')).toBe(true)
    expect(isDecimal('1e5')).toBe(false)
    expect(() => toScaled('abc', 2)).toThrow(/Invalid decimal/)
    expect(toScaled('-1.25', 2)).toBe(-125n)
    expect(fromScaled(-125n, 2)).toBe('-1.25')
    expect(fromScaled(0n, 2)).toBe('0')
    expect(fromScaled(5n, 0)).toBe('5')
    expect(fromScaled(100n, 2, { minFraction: 2 })).toBe('1.00')
    expect(add('0.1', '0.2')).toBe('0.3')
    expect(sub('1', '1.5')).toBe('-0.5')
    expect(cmp('2', '10')).toBe(-1)
    expect(mulRatio('100', '0.000062')).toBe('0.0062')
    expect(roundTo('-1.005', 2)).toBe('-1.01')
    expect(roundTo('2.4', 0)).toBe('2')
  })
})

describe('codes', () => {
  it('knows minor units, currencies, chains and method names', () => {
    expect(minorUnits('idr')).toBe(0)
    expect(minorUnits('XYZ')).toBe(2)
    expect(currencyForCountry(undefined)).toBe('USD')
    expect(currencyForCountry('vn')).toBe('VND')
    expect(currencyForCountry('ZZ')).toBe('USD')
    expect(evmChainId('eip155:8453')).toBe(8453)
    expect(evmChainId('solana:abc')).toBeUndefined()
    expect(evmChainId('eip155:x')).toBeUndefined()
    expect(chainName('eip155:143')).toBe('Monad')
    expect(chainName('eip155:999999')).toBe('eip155:999999')
    expect(methodName('vietqr')).toBe('VietQR')
    expect(methodName('some_new_method')).toBe('Some New Method')
    expect(methodAvailableIn('gcash', 'VN')).toBe(false)
    expect(methodAvailableIn('gcash', 'ph')).toBe(true)
    expect(methodAvailableIn('card', 'VN')).toBe(true)
    expect(methodAvailableIn('gcash', undefined)).toBe(true)
  })
})

describe('region policy edges', () => {
  it('unknown country follows the wildcard', () => {
    expect(isRegionAllowed({ allow: ['*'], deny: [] })).toBe(true)
    expect(isRegionAllowed({ allow: ['*'], deny: ['*'] })).toBe(false)
    expect(isRegionAllowed({ allow: ['VN'], deny: [] })).toBe(false)
    expect(isRegionAllowed({ allow: ['VN'], deny: [] }, 'TH')).toBe(false)
    const both = combinePolicies({ allow: ['*'], deny: ['US'] }, { allow: ['US', 'VN'], deny: [] })
    expect(both('VN')).toBe(true)
    expect(both('US')).toBe(false)
    expect(both('TH')).toBe(false)
  })
})

describe('table and errors', () => {
  it('validates steps and moves', () => {
    expect(isLegalMove('QUOTE', 'PAYMENT')).toBe(true)
    expect(isLegalMove('COMPLETED', 'PAYMENT')).toBe(false)
    expect(isLegalMove('PAYMENT', 'PAYMENT')).toBe(true)
    expect(validateStep({ state: 'COMPLETED', transitions: [{ name: 'p', kind: 'AWAIT', poll: { intervalMs: 1, backoff: 1, maxIntervalMs: 1, giveUpAfterMs: 1 } }] })).toHaveLength(1)
    expect(validateStep({ state: 'PAYMENT', transitions: [{ name: 'a', kind: 'SUBMIT', label: 'A' }, { name: 'a', kind: 'SUBMIT', label: 'A' }] })[0]).toMatch(/Duplicate/)
    expect(validateStep({ state: 'NOPE' as never, transitions: [] })[0]).toMatch(/Unknown state/)
  })
  it('builds errors with defaults and overrides', () => {
    const e = openRampError('QUOTE_EXPIRED')
    expect(e).toMatchObject({ retryable: true })
    expect(openRampError('KYC_REJECTED').retryable).toBe(false)
    expect(openRampError('CUSTOM_CODE' as never).message).toBe('Something went wrong.')
    expect(openRampError('NO_QUOTES', { message: 'm', retryable: false, recovery: 'choose_other', legId: 'l' })).toEqual({ code: 'NO_QUOTES', message: 'm', retryable: false, recovery: 'choose_other', legId: 'l' })
    const x = new OpenRampException(e)
    expect(x.status).toBe(400)
    expect(isOpenRampError(x.error)).toBe(true)
    expect(isOpenRampError(null)).toBe(false)
  })
  it('creates client events: random id, ISO createdAt', () => {
    const ev = createClientEvent('method.selected', { method: 'card' }, { sessionId: 's', livemode: true })
    expect(ev).toMatchObject({ type: 'method.selected', livemode: true, sessionId: 's', data: { object: { method: 'card' } } })
    expect(ev.id).toMatch(/^evt_[0-9a-f]{24}$/)
    expect(new Date(ev.createdAt).toISOString()).toBe(ev.createdAt)
    expect(createClientEvent('modal.opened', {}).livemode).toBe(false)
  })
  it('creates webhook events: the given id, object event, apiVersion 1, ISO createdAt', () => {
    const session = { id: 's' } as never
    const ev = createWebhookEvent('session.created', { session }, { id: 'evt_fixed', sessionId: 's', livemode: false })
    expect(ev).toMatchObject({ id: 'evt_fixed', object: 'event', apiVersion: 1, type: 'session.created', sessionId: 's', livemode: false, data: { object: { session } } })
    expect(new Date(ev.createdAt).toISOString()).toBe(ev.createdAt)
  })
})

describe('planner edges', () => {
  const onramp: LegSpec = {
    id: 'o', kind: 'fiat_onramp', methods: ['card'],
    from: { asset: { kind: 'fiat', currencies: '*' }, location: ['user_account'] },
    to: { asset: { kind: 'crypto', chains: { 'eip155:8453': [USDC['eip155:8453']!] } }, location: ['address'] },
    regions: { allow: ['*'], deny: [] }, eta: { min: 1, max: 2 }, surfaces: ['REDIRECT'], limits: { min: '10', currency: 'USD' },
  }
  const dest = { type: 'crypto' as const, chain: 'eip155:143', token: '0xabc', address: '0x1' }
  it('maxLegs 1 drops hop pathways; client surfaces and disabled methods filter', () => {
    const bridge: LegSpec = { ...onramp, id: 'b', kind: 'bridge_swap', methods: undefined, from: { asset: { kind: 'crypto', chains: { 'eip155:8453': [USDC['eip155:8453']!] } }, location: ['address'] }, to: { asset: { kind: 'crypto', chains: '*' }, location: ['address'] } }
    const legs = [{ adapterId: 'p', provider: 'P', spec: onramp }, { adapterId: 'r', provider: 'R', spec: bridge }]
    expect(planPathways({ direction: 'deposit', destination: dest, user: { country: 'SG' }, legs, policy: { maxLegs: 1 } }).pathways).toHaveLength(0)
    const noRedirect = planPathways({ direction: 'deposit', destination: dest, user: { country: 'SG' }, legs, policy: { clientSurfaces: ['QR'] } })
    expect(noRedirect.methods[0]).toMatchObject({ group: 'unavailable', reason: { code: 'CLIENT_UPGRADE_REQUIRED' } })
    expect(planPathways({ direction: 'deposit', destination: dest, user: { country: 'SG' }, legs, policy: { disabledMethods: ['card'] } }).methods).toHaveLength(0)
    const appDenied = planPathways({ direction: 'deposit', destination: dest, user: { country: 'SG' }, legs, policy: { regions: { allow: ['*'], deny: ['SG'] } } })
    expect(appDenied.methods[0]!.reason!.code).toBe('REGION_UNSUPPORTED')
    const withLimits = planPathways({ direction: 'deposit', destination: dest, user: { country: 'SG' }, legs })
    expect(withLimits.methods[0]!.limits).toEqual({ min: '10', currency: 'USD' })
  })
  it('merchant destinations never hop; custom method priority wins', () => {
    const payin: LegSpec = { ...onramp, id: 'pi', kind: 'fiat_payin', methods: ['card', 'qris'], to: { asset: { kind: 'fiat', currencies: '*' }, location: ['merchant_account'] } }
    const r = planPathways({ direction: 'deposit', destination: { type: 'merchant', currency: 'IDR' }, user: { country: 'ID' }, legs: [{ adapterId: 'x', provider: 'X', spec: payin }], policy: { methodPriority: { ID: ['card', 'qris'] } } })
    expect(r.currency).toBe('IDR')
    expect(r.methods.map((m) => m.method)).toEqual(['card', 'qris'])
    expect(r.methods[0]!.group).toBe('recommended')
  })
})
