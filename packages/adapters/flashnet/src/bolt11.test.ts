import { describe, expect, it } from 'vitest'
import { bolt11ExpiresAt, decodeBolt11 } from './bolt11.js'
import { makeInvoice } from './test-invoice.js'

describe('decodeBolt11', () => {
  it('reads the BOLT11 spec example (2500u, 60 s expiry)', () => {
    // "Please send $3 for a cup of coffee to the same peer, within one minute" (BOLT 11 examples)
    const spec =
      'lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh'
    const b = decodeBolt11(spec)!
    expect(b).toBeDefined()
    expect(b.network).toBe('bc')
    expect(b.amountMsat).toBe(250_000_000n)
    expect(b.timestamp).toBe(1496314658)
    expect(b.expirySec).toBe(60)
    expect(b.paymentHash).toBe('0001020304050607080900010203040506070809000102030405060708090102')
    expect(decodeBolt11(spec.toUpperCase())?.paymentHash).toBe(b.paymentHash)
  })

  it('reads an invoice from the test encoder', () => {
    const inv = makeInvoice({ sats: 44210n, timestamp: 1_800_000_000, expirySec: 86400, hash: 'ab'.repeat(32) })
    const b = decodeBolt11(inv)!
    expect(b.amountMsat).toBe(44_210_000n)
    expect(b.paymentHash).toBe('ab'.repeat(32))
    expect(bolt11ExpiresAt(b)).toBe((1_800_000_000 + 86400) * 1000)
  })

  it('refuses a bad checksum, mixed case, a testnet prefix with no amount check, and junk', () => {
    const inv = makeInvoice({ sats: 1000n, timestamp: 1_800_000_000, hash: 'cd'.repeat(32) })
    const flipped = inv.slice(0, -1) + (inv.endsWith('q') ? 'p' : 'q')
    expect(decodeBolt11(flipped)).toBeUndefined()
    expect(decodeBolt11(inv.slice(0, 20) + inv.slice(20).toUpperCase())).toBeUndefined()
    expect(decodeBolt11('lnbc1')).toBeUndefined()
    expect(decodeBolt11('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toBeUndefined()
    expect(decodeBolt11(makeInvoice({ sats: 1000n, timestamp: 1_800_000_000, hash: 'cd'.repeat(32), prefix: 'lntb' }))?.network).toBe('tb')
  })

  it('reads an amountless invoice as no amount', () => {
    expect(decodeBolt11(makeInvoice({ timestamp: 1_800_000_000, hash: 'ef'.repeat(32) }))?.amountMsat).toBeUndefined()
  })
})
