import { describe, expect, it } from 'vitest'
import { LIGHTNING, LIGHTNING_BTC, destinationEndpoint, lightningDomain, parseLightningTarget, sameLightningAddress } from './index.js'

describe('parseLightningTarget', () => {
  it('reads a Cash App $cashtag (with or without $, or as name@cash.app), case kept', () => {
    expect(parseLightningTarget('$alice')).toEqual({ type: 'lightning', address: 'alice@cash.app', cashtag: '$alice' })
    expect(parseLightningTarget('  Alice99 ')).toEqual({ type: 'lightning', address: 'Alice99@cash.app', cashtag: '$Alice99' })
    expect(parseLightningTarget('alice@CASH.APP')).toEqual({ type: 'lightning', address: 'alice@cash.app', cashtag: '$alice' })
    expect(parseLightningTarget('$alice@cash.app')).toEqual({ type: 'lightning', address: 'alice@cash.app', cashtag: '$alice' })
    expect(parseLightningTarget('$' + 'a'.repeat(20))).toBeTruthy()
  })

  it('refuses cashtags that Cash App does not allow', () => {
    for (const v of ['$', '$123', '123', '$' + 'a'.repeat(21), '$al ice', '$al-ice', '$al.ice', '$$alice', '$alicé', 'a_b@cash.app', '12@cash.app']) {
      expect(parseLightningTarget(v), v).toBeUndefined()
    }
  })

  it('reads a Lightning address and lowers the domain only', () => {
    expect(parseLightningTarget('Bob.Smith+tips@Wallet.Example.org')).toEqual({ type: 'lightning', address: 'Bob.Smith+tips@wallet.example.org' })
    expect(parseLightningTarget('bob_1-x@sub.example.co.uk')).toEqual({ type: 'lightning', address: 'bob_1-x@sub.example.co.uk' })
  })

  it('refuses invoices, LNURLs, URLs, IP addresses and junk', () => {
    const bad = [
      '',
      '   ',
      'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp',
      'lno1pg257enxv4ezqcneype82um50ynhxgrwdajx283qfwdpl28qqmc78ymlvhmxcsywdk5wrjnj36jryg488qwlrnzyjczs',
      'LNURL1DP68GURN8GHJ7UM9WFMXJCM99E3K7MF0V9CXJ0M385EKVCENXC6R2C35XVUKXEFCV5MKVV34X5EKZD3EV56NYD3HXQURZEPEXEJXXEPNXSCRVWFNV9NXZCN9XQ6XYEFHVGCXXCMYXYMNSERXFQ5FNS',
      'https://cash.app/$alice',
      'lightning:alice@cash.app',
      'alice@localhost',
      'alice@127.0.0.1',
      'alice@[::1]',
      'alice@example',
      'alice@-example.com',
      'alice@example.c',
      'a@b@example.com',
      '@example.com',
      'alice@',
      '.alice@example.com',
      'al..ice@example.com',
      'alice.@example.com',
      'al ice@example.com',
      'alice@exa mple.com',
      'alice@example.com/path',
      'x'.repeat(65) + '@example.com',
      `alice@${'a'.repeat(250)}.com`,
      42,
      undefined,
      null,
    ]
    for (const v of bad) expect(parseLightningTarget(v), String(v)).toBeUndefined()
  })
})

describe('Lightning helpers', () => {
  it('compares recipients across forms and case', () => {
    expect(sameLightningAddress('$alice', 'alice@cash.app')).toBe(true)
    expect(sameLightningAddress('Alice@Cash.App', '$alice')).toBe(true)
    expect(sameLightningAddress('bob@example.com', 'BOB@example.com')).toBe(true)
    expect(sameLightningAddress('$alice', '$alicia')).toBe(false)
    expect(sameLightningAddress(undefined, '$alice')).toBe(false)
    expect(sameLightningAddress('https://x.com/a', 'https://x.com/a')).toBe(false)
  })

  it('gives the domain and the planner endpoint (Cash App or other Lightning address)', () => {
    expect(lightningDomain('bob@example.com')).toBe('example.com')
    expect(destinationEndpoint(parseLightningTarget('$alice')!)).toEqual({ asset: LIGHTNING_BTC, location: { kind: 'cash_app', address: 'alice@cash.app' } })
    expect(destinationEndpoint(parseLightningTarget('bob@example.com')!)).toEqual({ asset: LIGHTNING_BTC, location: { kind: 'lightning_address', address: 'bob@example.com' } })
    // Not a CAIP-2 chain id: no crypto target can name it
    expect(/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/.test(LIGHTNING)).toBe(false)
  })
})
