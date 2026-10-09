// The quotes route must never send adapter `data` (provider URLs, request bodies, nonces) to the browser.
import { describe, expect, it } from 'vitest'
import { createAdapter } from '@openrampkit/adapter'
import type { Adapter } from '@openrampkit/adapter'
import { fakeFetch } from '@openrampkit/adapter/testing'
import { mockAdapter } from '@openrampkit/adapter-mock'
import { coinbase } from '@openrampkit/adapter-coinbase'
import { stripe } from '@openrampkit/adapter-stripe'
import { USDC } from '@openrampkit/core'
import type { LegQuote } from '@openrampkit/core'
import { createOpenRamp } from './index.js'
import { publicQuote } from './planning.js'

const BASE = 'https://app.test/api/openramp'
const SECRET = 's'.repeat(40)
const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const DEST = { type: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']!, address: '0x000000000000000000000000000000000000beef' }

function make(adapters: Adapter[], fetch?: typeof globalThis.fetch) {
  const ramp = createOpenRamp({ secret: SECRET, baseUrl: BASE, adapters, logger: quiet, ...(fetch ? { fetch } : {}) })
  const call = (path: string, secret: string, body?: unknown) =>
    ramp.handle(
      new Request(`${BASE}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  return { ramp, call }
}

/** Plan and quote one method. Returns the raw JSON of the quotes response. */
async function quoteRaw(ramp: ReturnType<typeof make>['ramp'], call: ReturnType<typeof make>['call'], country: string, method: string, amount: string) {
  const s = await ramp.sessions.create({ userId: 'u', country, destination: DEST })
  expect((await call(`/sessions/${s.id}/plan`, s.clientSecret, {})).status).toBe(200)
  const res = await call(`/sessions/${s.id}/quotes`, s.clientSecret, { method, amount })
  const text = await res.text()
  return { s, status: res.status, text, json: JSON.parse(text) as { quotes: Array<{ id: string; legs: Array<Record<string, unknown>> }>; errors: unknown[] } }
}

function expectNoLegData(json: { quotes: Array<{ legs: Array<Record<string, unknown>> }> }) {
  expect(json.quotes.length).toBeGreaterThan(0)
  for (const q of json.quotes) {
    expect(q.legs.length).toBeGreaterThan(0)
    for (const l of q.legs) expect(l).not.toHaveProperty('data')
  }
}

describe('public quotes', () => {
  it('publicQuote drops each leg data and keeps the rest', () => {
    const leg: LegQuote = {
      adapterId: 'x', legId: 'card',
      input: { value: '10', asset: { kind: 'fiat', currency: 'USD' } },
      output: { value: '9', asset: { kind: 'crypto', chain: 'eip155:8453', token: '0xabc' } },
      fees: [], eta: { min: 1, max: 2 }, data: { onrampUrl: 'https://secret.test/?sessionToken=t', nonce: 'n' },
    }
    const q = { id: 'q_1', pathwayId: 'p', method: 'card', provider: 'X', legs: [leg], input: leg.input, output: leg.output, fees: [], eta: leg.eta }
    const pub = publicQuote(q)
    expect(pub.legs[0]).not.toHaveProperty('data')
    expect(pub.legs[0]).toMatchObject({ adapterId: 'x', legId: 'card', input: leg.input, output: leg.output })
    // The source quote is not changed: the server still needs the data for start().
    expect(q.legs[0]!.data).toEqual(leg.data)
  })

  it('mock: the quotes response has no leg data, and select still passes the data to start()', async () => {
    const base = mockAdapter({ settleMs: 0 })
    let seen: unknown
    const leaky = createAdapter({
      ...base,
      async quote(input, ctx) {
        return { ...(await base.quote(input, ctx)), data: { nonce: 'idem-123', providerUrl: 'https://provider.test/?token=secret' } }
      },
      async start(input, ctx) {
        seen = input.quote.data
        return base.start(input, ctx)
      },
    })
    const { ramp, call } = make([leaky])
    const { s, status, text, json } = await quoteRaw(ramp, call, 'VN', 'vietqr', '500000')
    expect(status).toBe(200)
    expectNoLegData(json)
    expect(text).not.toContain('idem-123')
    expect(text).not.toContain('token=secret')
    expect((await call(`/sessions/${s.id}/select`, s.clientSecret, { quoteId: json.quotes[0]!.id })).status).toBe(200)
    expect(seen).toEqual({ nonce: 'idem-123', providerUrl: 'https://provider.test/?token=secret' })
  })

  it('stubbed Coinbase: the onramp URL in the quote data does not reach the browser', async () => {
    const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
    const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey)
    const dec = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0))
    const secret = btoa(String.fromCharCode(...dec(jwk.d!), ...dec(jwk.x!)))
    const { fetch } = fakeFetch([
      {
        method: 'POST',
        match: '/platform/v2/onramp/sessions',
        reply: () => ({
          session: { onrampUrl: 'https://pay.coinbase.com/buy?sessionToken=SECRET_TOKEN' },
          quote: { paymentTotal: '100.00', paymentSubtotal: '98.52', paymentCurrency: 'USD', purchaseAmount: '98.520000', purchaseCurrency: 'USDC', destinationNetwork: 'base', exchangeRate: '1', fees: [] },
        }),
      },
    ])
    const { ramp, call } = make([coinbase({ apiKeyId: 'key-id', apiKeySecret: secret })], fetch)
    const { status, text, json } = await quoteRaw(ramp, call, 'US', 'card', '100')
    expect(status).toBe(200)
    expectNoLegData(json)
    expect(text).not.toContain('SECRET_TOKEN')
    expect(text).not.toContain('onrampUrl')
  })

  it('stubbed Stripe: the idempotency nonce in the quote data does not reach the browser', async () => {
    const { fetch } = fakeFetch([
      {
        match: '/v1/crypto/onramp_quotes',
        reply: () => ({
          id: 'cpqt_1', source_amount: '100.00', source_currency: 'usd',
          destination_network_quotes: { base_network: [{ id: 'q1', destination_currency: 'usdc', destination_network: 'base', destination_amount: '97.912345', source_total_amount: '103.26', fees: { transaction_fee_monetary: '3.25' } }] },
        }),
      },
    ])
    const { ramp, call } = make([stripe({ secretKey: 'sk_test_51abc', publishableKey: 'pk_test_51abc', webhookSecret: 'whsec_test', surface: 'redirect' })], fetch)
    const { status, text, json } = await quoteRaw(ramp, call, 'US', 'card', '100')
    expect(status).toBe(200)
    expectNoLegData(json)
    expect(text).not.toContain('nonce')
  })
})
