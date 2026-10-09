/**
 * Compare two strings in constant time for a given length, for secrets such as tokens and signatures.
 * Strings of different lengths give false at once, so only the length can leak. Compare fixed-length
 * values (for example hex digests) when the length is secret too.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let r = 0
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return r === 0
}
