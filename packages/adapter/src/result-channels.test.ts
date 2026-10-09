// How the server learns a leg result comes from status() and webhook, not from leg capabilities.
import { describe, expect, it } from 'vitest'
import { coinbase } from '@openrampkit/adapter-coinbase'
import { meld } from '@openrampkit/adapter-meld'
import { moonpay } from '@openrampkit/adapter-moonpay'
import { onramper } from '@openrampkit/adapter-onramper'
import { transak } from '@openrampkit/adapter-transak'
import { resultChannels } from './index.js'

describe('resultChannels', () => {
  it('polling from status(), webhooks from a webhook that can verify', () => {
    expect(resultChannels({})).toEqual({ polling: false, webhooks: false })
    expect(resultChannels({ status: async () => ({ state: 'PAYMENT', status: 'requires_action', transitions: [] }) })).toEqual({ polling: true, webhooks: false })
    const webhook = { verify: async () => true, parse: async () => [] }
    expect(resultChannels({ webhook })).toEqual({ polling: false, webhooks: true })
    expect(resultChannels({ webhook: { ...webhook, configured: false } })).toEqual({ polling: false, webhooks: false })
  })

  it('adapters with an optional webhook secret say when their webhook is not configured', () => {
    expect(resultChannels(coinbase({ apiKeyId: 'k', apiKeySecret: 'x' })).webhooks).toBe(false)
    expect(resultChannels(coinbase({ apiKeyId: 'k', apiKeySecret: 'x', webhookSecret: 'w' })).webhooks).toBe(true)
    expect(resultChannels(meld({ apiKey: 'k', env: 'sandbox' })).webhooks).toBe(false)
    expect(resultChannels(moonpay({ publishableKey: 'pk', secretKey: 'sk', env: 'sandbox' })).webhooks).toBe(false)
    expect(resultChannels(onramper({ apiKey: 'pk_test_1', secretKey: 'x', env: 'sandbox' })).webhooks).toBe(false)
  })

  it('Transak has no status(): it relies on its webhook (signed with the access token)', () => {
    expect(resultChannels(transak({ apiKey: 'K', apiSecret: 'S', referrerDomain: 'app.test' }))).toEqual({ polling: false, webhooks: true })
  })

  it('no built-in adapter declares a capability other than settlement or surface_after_processing', () => {
    for (const a of [coinbase({ apiKeyId: 'k', apiKeySecret: 'x' }), meld({ apiKey: 'k', env: 'sandbox' }), moonpay({ publishableKey: 'pk', secretKey: 'sk', env: 'sandbox' }), transak({ apiKey: 'K', apiSecret: 'S', referrerDomain: 'app.test' })]) {
      for (const l of a.legs) for (const c of l.capabilities ?? []) expect(['settlement', 'surface_after_processing']).toContain(c)
    }
  })
})
