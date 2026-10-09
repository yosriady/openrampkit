// A Relay wallet payment through the server, with Relay's API stubbed: the completed session shows the
// origin transaction and the fill, and the output that Relay reports is checked against the quote.
import { describe, expect, it } from 'vitest'
import { relay } from '@openrampkit/adapter-relay'
import { USDC } from '@openrampkit/core'
import type { PublicSession, Quote } from '@openrampkit/core'
import { createOpenRamp } from './index.js'

const BASE = 'https://app.test/api/openramp'
const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const USER = '0x03508bB71268BBA25ECaCC8F620e01866650532c'
const DEST = '0x000000000000000000000000000000000000beef'
const ARB_USDC = USDC['eip155:42161']!
const ORIGIN_TX = `0x${'ab'.repeat(32)}`
const FILL_TX = `0x${'cd'.repeat(32)}`
const ETH = (chainId: number) => ({ chainId, address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', name: 'Ether', decimals: 18 })
const usdc = { chainId: 42161, address: ARB_USDC, symbol: 'USDC', name: 'USD Coin', decimals: 6 }
/** The live testnet run: Relay quoted and delivered 0.000491803942453585 ETH */
const OUT_BASE = '491803942453585'

function relayApi(delivered: string) {
  const quote = {
    requestId: '0xreq1',
    steps: [{ id: 'deposit', kind: 'transaction', requestId: '0xreq1', items: [{ status: 'incomplete', data: { from: USER, to: ARB_USDC, data: '0x', value: '0', chainId: 42161 } }] }],
    fees: {},
    details: { currencyIn: { currency: usdc, amount: '1000000' }, currencyOut: { currency: ETH(8453), amount: OUT_BASE }, timeEstimate: 2 },
  }
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input)
    if (url.includes('/quote/v2')) return Response.json(quote)
    if (url.includes('/intents/status/v3')) return Response.json({ status: 'success', inTxHashes: [ORIGIN_TX], txHashes: [FILL_TX] })
    if (url.includes('/requests/v3')) {
      return Response.json({ requests: [{ id: '0xreq1', status: 'success', createdAt: new Date().toISOString(), data: { outTxs: [{ hash: FILL_TX, chainId: 8453 }], metadata: { currencyOut: { currency: ETH(8453), amount: delivered } } } }] })
    }
    return new Response('{}', { status: 404 })
  }
  return fetchFn
}

async function pay(delivered: string) {
  const ramp = createOpenRamp({ secret: 's'.repeat(40), baseUrl: BASE, adapters: [relay({ apiKey: 'k' })], logger: quiet, fetch: relayApi(delivered) })
  const call = async <T>(path: string, secret: string, body?: unknown) => {
    const headers = new Headers({ authorization: `Bearer ${secret}` })
    if (body !== undefined) headers.set('content-type', 'application/json')
    const res = await ramp.handle(new Request(`${BASE}${path}`, { method: body === undefined ? 'GET' : 'POST', headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }))
    expect(res.status).toBe(200)
    return (await res.json()) as T
  }
  const s = await ramp.sessions.create({ userId: 'u', country: 'SG', destination: { type: 'crypto', chain: 'eip155:8453', token: 'native', address: DEST } })
  await call(`/sessions/${s.id}/plan`, s.clientSecret, { walletConnected: true, walletAddress: USER })
  const q = await call<{ quotes: Quote[] }>(`/sessions/${s.id}/quotes`, s.clientSecret, { method: 'wallet', amount: '1', source: { chain: 'eip155:42161', token: ARB_USDC } })
  const sel = await call<PublicSession>(`/sessions/${s.id}/select`, s.clientSecret, { quoteId: q.quotes[0]!.id })
  expect(sel.step).toMatchObject({ state: 'PAYMENT', surface: { kind: 'WALLET_TX' } })
  const sent = await call<PublicSession>(`/sessions/${s.id}/transitions/submit_tx`, s.clientSecret, { inputs: { txHash: ORIGIN_TX } })
  expect(sent.step.state).toBe('PROCESSING')
  await ramp.sessions.refresh(s.id)
  return (await ramp.sessions.retrieve(s.id))!
}

describe('Relay wallet payment through the server', () => {
  it('completes with the origin transaction, the fill, and a confirmed output', async () => {
    const pub = await pay(OUT_BASE)
    expect(pub.status).toBe('succeeded')
    expect(pub.result).toMatchObject({
      txHashes: [FILL_TX],
      sourceTxHashes: [ORIGIN_TX],
      output: { value: '0.000491803942453585', asset: { kind: 'crypto', chain: 'eip155:8453', token: 'native' } },
      outputConfirmed: true,
    })
    expect(pub.result!.amountMismatch).toBeUndefined()
    expect(pub.step.progress!.legs[0]).toMatchObject({ status: 'succeeded', txHash: FILL_TX, sourceTxHash: ORIGIN_TX })
  })

  it('flags a short delivery that Relay reports', async () => {
    const pub = await pay('400000000000000')
    expect(pub.status).toBe('succeeded')
    expect(pub.result).toMatchObject({ outputConfirmed: true, output: { value: '0.0004' }, amountMismatch: { reason: 'short', legIndex: 0 } })
  })
})
