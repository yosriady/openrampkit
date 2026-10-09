import { cmp } from './money.js'
import type { PublicQuote } from './types.js'

/**
 * Rank quotes: most delivered first, then fastest. Marks 'best_price' and 'fastest'.
 * All quotes in one call must deliver the same asset (they do: same destination).
 */
export function rankQuotes<T extends PublicQuote>(quotes: T[]): T[] {
  const sorted = [...quotes].sort((a, b) => cmp(b.output.amount, a.output.amount) || a.eta.max - b.eta.max)
  if (!sorted.length) return sorted
  const fastest = [...sorted].sort((a, b) => a.eta.max - b.eta.max)[0]!
  return sorted.map((q, i) => {
    const badges: PublicQuote['badges'] = []
    if (i === 0) badges.push('best_price')
    if (q.id === fastest.id && sorted.length > 1) badges.push('fastest')
    return badges.length ? { ...q, badges } : q
  })
}
