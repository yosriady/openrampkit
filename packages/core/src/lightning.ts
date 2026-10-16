// Lightning payout targets: a Cash App `$cashtag` or a Lightning address (`user@domain`, LUD-16).

import type { CryptoAsset, Endpoint, LightningDestination } from './types.js'

/**
 * The chain id of Lightning payouts. It is not a CAIP-2 id on purpose: the namespace has 9 letters,
 * so no `crypto` target or deposit destination can name it (they must pass the CAIP-2 check). Only a
 * `lightning` target reaches it.
 */
export const LIGHTNING = 'lightning:bitcoin'

/** What a Lightning payout delivers: BTC (8 decimals; the providers count sats) */
export const LIGHTNING_BTC: CryptoAsset = { kind: 'crypto', chain: LIGHTNING, token: 'native', symbol: 'BTC', decimals: 8 }

/** The domain of Cash App Lightning addresses */
export const CASH_APP_DOMAIN = 'cash.app'

/** A Cash App name without `$`: 1 to 20 letters or digits, with at least one letter */
const CASHTAG_NAME = /^(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,20}$/
/** LUD-16 user name: letters, digits, `.`, `_`, `-` and `+`; no dot at the ends, no two dots */
const LN_USER = /^(?!\.)(?!.*\.\.)(?!.*\.$)[A-Za-z0-9._+-]{1,64}$/
/** A DNS host name with a letter TLD (so no IP address and no single label such as `localhost`) */
const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/**
 * Parse a Lightning payout target that a user typed: `$alice` or `alice` (a Cash App user), or
 * `user@domain` (a Lightning address). Returns the normalized target, or undefined when it is not
 * valid. Invoices (BOLT11, BOLT12), LNURL strings, URLs and IP addresses are refused. The domain is
 * made lower case. `alice@cash.app` is the Cash App user `$alice`.
 */
export function parseLightningTarget(input: unknown): LightningDestination | undefined {
  if (typeof input !== 'string') return undefined
  const v = input.trim()
  if (!v || v.length > 320) return undefined
  const at = v.indexOf('@')
  if (at < 0) {
    const name = v.startsWith('$') ? v.slice(1) : v
    if (!CASHTAG_NAME.test(name)) return undefined
    return { type: 'lightning', address: `${name}@${CASH_APP_DOMAIN}`, cashtag: `$${name}` }
  }
  if (v.indexOf('@', at + 1) >= 0) return undefined
  const user = v.slice(0, at)
  const domain = v.slice(at + 1).toLowerCase()
  if (!DOMAIN.test(domain)) return undefined
  if (domain === CASH_APP_DOMAIN) {
    const name = user.startsWith('$') ? user.slice(1) : user
    if (!CASHTAG_NAME.test(name)) return undefined
    return { type: 'lightning', address: `${name}@${CASH_APP_DOMAIN}`, cashtag: `$${name}` }
  }
  if (!LN_USER.test(user)) return undefined
  return { type: 'lightning', address: `${user}@${domain}` }
}

/** The domain of a normalized Lightning address */
export function lightningDomain(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase()
}

/**
 * True when `a` and `b` name the same Lightning recipient. Both are parsed first (so `$alice` and
 * `alice@cash.app` are the same), and compared without case. Undefined or invalid input is never the same.
 */
export function sameLightningAddress(a: string | undefined, b: string | undefined): boolean {
  const x = parseLightningTarget(a)
  const y = parseLightningTarget(b)
  return !!x && !!y && x.address.toLowerCase() === y.address.toLowerCase()
}

/** The planner endpoint of a Lightning target: BTC over Lightning to a Cash App user or a Lightning address */
export function lightningEndpoint(d: LightningDestination): Endpoint {
  return { asset: LIGHTNING_BTC, location: d.cashtag ? { kind: 'cash_app', address: d.address } : { kind: 'lightning_address', address: d.address } }
}
