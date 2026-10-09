// One `env` option ('sandbox' | 'production') on every first-party adapter, exposed as `adapter.env`.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { binance } from '@openrampkit/adapter-binance'
import { bridge } from '@openrampkit/adapter-bridge'
import { coinbase } from '@openrampkit/adapter-coinbase'
import { lifi } from '@openrampkit/adapter-lifi'
import { meld } from '@openrampkit/adapter-meld'
import { mockAdapter } from '@openrampkit/adapter-mock'
import { moonpay } from '@openrampkit/adapter-moonpay'
import { onramper } from '@openrampkit/adapter-onramper'
import { peer } from '@openrampkit/adapter-peer'
import type { PeerOptions } from '@openrampkit/adapter-peer'
import { relay } from '@openrampkit/adapter-relay'
import { stripe } from '@openrampkit/adapter-stripe'
import { swapped } from '@openrampkit/adapter-swapped'
import { transak } from '@openrampkit/adapter-transak'
import { xendit } from '@openrampkit/adapter-xendit'
import { resolveEnv, warnDeprecatedOnce } from './index.js'

afterEach(() => {
  vi.restoreAllMocks()
})

const PEER: PeerOptions = { enabled: true, apiKey: 'k', webhookSecret: 's', env: 'sandbox' }

describe('resolveEnv', () => {
  it('env wins; a legacy option is used only without env, with one warning; else the fallback', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(resolveEnv('x1', 'sandbox', { value: 'production', option: 'old' }, undefined)).toBe('sandbox')
    expect(warn).not.toHaveBeenCalled()
    expect(resolveEnv('x1', undefined, { value: 'production', option: 'old' }, undefined)).toBe('production')
    expect(resolveEnv('x1', undefined, { value: 'production', option: 'old' }, undefined)).toBe('production')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain("x1: the option old is deprecated. Use env: 'production'.")
    expect(resolveEnv('x1', undefined, undefined, 'production')).toBe('production')
    expect(resolveEnv('x1', undefined, { value: undefined, option: 'old' }, undefined)).toBeUndefined()
    expect(() => resolveEnv('x1', 'live' as never, undefined, undefined)).toThrow(/env must be 'sandbox' or 'production'/)
  })

  it('warnDeprecatedOnce warns once per key', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(warnDeprecatedOnce('k-test', 'm')).toBe(true)
    expect(warnDeprecatedOnce('k-test', 'm')).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('adapter.env', () => {
  it('each first-party adapter exposes its environment', () => {
    const cases: Array<[string, { env?: string }, string | undefined]> = [
      ['meld sandbox', meld({ apiKey: 'k', env: 'sandbox' }), 'sandbox'],
      ['meld production', meld({ apiKey: 'k', env: 'production' }), 'production'],
      ['moonpay', moonpay({ publishableKey: 'pk', secretKey: 'sk', env: 'sandbox' }), 'sandbox'],
      ['onramper', onramper({ apiKey: 'pk_test_1', secretKey: 'x', env: 'sandbox' }), 'sandbox'],
      ['bridge default', bridge({ apiKey: 'k', webhookPublicKey: 'p' }), 'production'],
      ['bridge sandbox', bridge({ apiKey: 'k', webhookPublicKey: 'p', env: 'sandbox' }), 'sandbox'],
      ['swapped default', swapped({ publicKey: 'pk', secretKey: 'sk' }), 'production'],
      ['transak sandbox', transak({ apiKey: 'K', apiSecret: 'S', referrerDomain: 'app.test', env: 'sandbox' }), 'sandbox'],
      ['peer', peer(PEER), 'sandbox'],
      ['peer production', peer({ ...PEER, env: 'production' }), 'production'],
      ['coinbase default (follows each session)', coinbase({ apiKeyId: 'k', apiKeySecret: 'x' }), undefined],
      ['coinbase production', coinbase({ apiKeyId: 'k', apiKeySecret: 'x', env: 'production' }), 'production'],
      ['stripe test key', stripe({ secretKey: 'sk_test_1', publishableKey: 'pk_test_1', webhookSecret: 'w' }), 'sandbox'],
      ['stripe live restricted key', stripe({ secretKey: 'rk_live_1', publishableKey: 'pk_live_1', webhookSecret: 'w' }), 'production'],
      ['xendit development key', xendit({ secretKey: 'xnd_development_1', webhookToken: 't' }), 'sandbox'],
      ['xendit production key', xendit({ secretKey: 'xnd_production_1', webhookToken: 't' }), 'production'],
      ['xendit unknown key, env set', xendit({ secretKey: 'other', webhookToken: 't', env: 'production' }), 'production'],
      ['binance (no sandbox)', binance({ apiUrl: 'https://b.test', clientId: 'c', accessToken: 't', privateKey: 'x', binancePublicKey: 'y' }), 'production'],
      ['lifi (no sandbox)', lifi({}), 'production'],
      ['relay mainnet', relay(), 'production'],
      ['relay testnets', relay({ baseUrl: 'https://api.testnets.relay.link' }), 'sandbox'],
      ['mock', mockAdapter(), 'sandbox'],
    ]
    for (const [name, a, env] of cases) expect([name, a.env]).toEqual([name, env])
  })

  it('old options still work as deprecated aliases, with one warning each', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(peer({ ...PEER, env: 'live' }).env).toBe('production')
    expect(transak({ apiKey: 'K', apiSecret: 'S', referrerDomain: 'app.test', env: 'staging' }).env).toBe('sandbox')
    expect(coinbase({ apiKeyId: 'k', apiKeySecret: 'x', sandbox: true }).env).toBe('sandbox')
    expect(coinbase({ apiKeyId: 'k', apiKeySecret: 'x', sandbox: false }).env).toBe('production')
    const text = warn.mock.calls.map((c) => String(c[0])).join('\n')
    expect(text).toContain("peer: the option env: 'live' is deprecated")
    expect(text).toContain("transak: the option env: 'staging' is deprecated")
    expect(text).toContain('coinbase: the option sandbox is deprecated')
    // Once per process
    peer({ ...PEER, env: 'live' })
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('peer:'))).toHaveLength(1)
  })

  it('stripe and xendit refuse an env that does not agree with the key', () => {
    expect(() => stripe({ secretKey: 'sk_live_1', publishableKey: 'pk', webhookSecret: 'w', env: 'sandbox' })).toThrow(/live mode key/)
    expect(() => xendit({ secretKey: 'xnd_development_1', webhookToken: 't', env: 'production' })).toThrow(/test mode/)
  })
})
