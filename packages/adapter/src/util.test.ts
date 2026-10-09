import { describe, expect, it } from 'vitest'
import { minWithToleranceBps } from './index.js'

/** The bigint formula the Relay adapter used before the helper moved here */
const reference = (expectedBase: string, bps: number) => {
  const expected = BigInt(expectedBase)
  return (expected - (expected * BigInt(bps)) / 10_000n).toString()
}

describe('minWithToleranceBps', () => {
  it('takes the tolerance off the expected amount', () => {
    expect(minWithToleranceBps('1000000', 50)).toBe('995000') // 0.5%
    expect(minWithToleranceBps('1000000', 500)).toBe('950000') // 5%
    expect(minWithToleranceBps('1000000', 0)).toBe('1000000')
    expect(minWithToleranceBps('1000000', 10_000)).toBe('0')
  })

  it('rounds the tolerance down, so the minimum rounds up', () => {
    // 999 * 50 / 10000 = 4.995: the tolerance is 4, not 5
    expect(minWithToleranceBps('999', 50)).toBe('995')
    // 199 * 50 / 10000 = 0.995: no tolerance at all
    expect(minWithToleranceBps('199', 50)).toBe('199')
    expect(minWithToleranceBps('1', 9_999)).toBe('1')
  })

  it('is exact above 2^53', () => {
    expect(minWithToleranceBps('123456789012345678901234567890', 50)).toBe('122839505067283950506728395051')
  })

  it('matches the earlier Relay formula', () => {
    for (const expected of ['1', '7', '10000', '123457', '5000000', '18446744073709551615']) {
      for (const bps of [0, 1, 50, 333, 500, 9_999, 10_000]) expect(minWithToleranceBps(expected, bps)).toBe(reference(expected, bps))
    }
  })

  it('throws for a non-integer amount or bps', () => {
    expect(() => minWithToleranceBps('1.5', 50)).toThrow()
    expect(() => minWithToleranceBps('100', 0.5)).toThrow()
  })
})
