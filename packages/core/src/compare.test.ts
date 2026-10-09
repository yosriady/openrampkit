import { describe, expect, it } from 'vitest'
import { timingSafeEqual } from './index.js'

describe('timingSafeEqual', () => {
  it('is true for equal strings only', () => {
    expect(timingSafeEqual('', '')).toBe(true)
    expect(timingSafeEqual('abc', 'abc')).toBe(true)
    expect(timingSafeEqual('abc', 'abd')).toBe(false)
    expect(timingSafeEqual('abc', 'ABC')).toBe(false)
  })

  it('is false for different lengths, also when one is a prefix', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
    expect(timingSafeEqual('abcd', 'abc')).toBe(false)
    expect(timingSafeEqual('', 'a')).toBe(false)
  })

  it('compares UTF-16 code units', () => {
    expect(timingSafeEqual('é', 'é')).toBe(true)
    expect(timingSafeEqual('é', 'e')).toBe(false)
  })
})
