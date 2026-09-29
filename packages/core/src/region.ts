import type { RegionPolicy } from './types.js'

export const ALLOW_ALL: RegionPolicy = { allow: ['*'], deny: [] }

function specificity(entry: string): number {
  if (entry === '*') return 0
  return entry.includes('-') ? 2 : 1
}

function matches(entry: string, country: string, region?: string): boolean {
  if (entry === '*') return true
  const e = entry.toUpperCase()
  if (e.includes('-')) return region?.toUpperCase() === e
  return country.toUpperCase() === e
}

/**
 * Decide if a user in `country` (and optional ISO 3166-2 `region`, e.g. `US-NY`) is allowed.
 * The most specific matching entry wins. On a tie, deny wins.
 * An unknown country is allowed only if `*` is allowed and nothing denies `*`.
 */
export function isRegionAllowed(policy: RegionPolicy, country?: string, region?: string): boolean {
  if (!country) {
    return policy.allow.includes('*') && !policy.deny.includes('*')
  }
  let best: { spec: number; allow: boolean } | undefined
  for (const entry of policy.deny) {
    if (!matches(entry, country, region)) continue
    const spec = specificity(entry)
    if (!best || spec >= best.spec) best = { spec, allow: false }
  }
  for (const entry of policy.allow) {
    if (!matches(entry, country, region)) continue
    const spec = specificity(entry)
    if (!best || spec > best.spec) best = { spec, allow: true }
  }
  return best?.allow ?? false
}

export function combinePolicies(...policies: RegionPolicy[]): (country?: string, region?: string) => boolean {
  return (country, region) => policies.every((p) => isRegionAllowed(p, country, region))
}
