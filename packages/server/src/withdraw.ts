// Withdraw sessions: validate the source at creation, and the target the user picks.

import { CHAINS, OrkException, USDC, orkError } from '@openrampkit/core'
import type { Destination, WithdrawSource, WithdrawTarget } from '@openrampkit/core'
import type { Runtime } from './runtime.js'
import type { SessionRecord } from './store.js'

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const EVM_ZERO = /^0x0{40}$/
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const OTHER_ADDRESS = /^[\x21-\x7e]{8,128}$/
const CAIP2 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/
const CURRENCY = /^[A-Z]{3}$/
const SYMBOL = /^[A-Za-z0-9.$_-]{1,12}$/

const bad = (message: string) => new OrkException(orkError('BAD_REQUEST', { message }), 400)

/** True when `address` has the right format for `chain` (EVM: `0x` and 40 hex digits, not the zero address). */
export function isValidAddress(chain: string, address: string): boolean {
  if (chain.startsWith('eip155:')) return EVM_ADDRESS.test(address) && !EVM_ZERO.test(address)
  if (chain.startsWith('solana:')) return SOLANA_ADDRESS.test(address)
  return OTHER_ADDRESS.test(address)
}

function isValidToken(chain: string, token: string): boolean {
  if (token === 'native') return true
  if (chain.startsWith('eip155:')) return EVM_ADDRESS.test(token)
  if (chain.startsWith('solana:')) return SOLANA_ADDRESS.test(token)
  return OTHER_ADDRESS.test(token)
}

const normToken = (chain: string, token: string) => (chain.startsWith('eip155:') ? token.toLowerCase() : token)

/** Symbol and decimals we know for a token, else the (checked) values the caller gave. */
function tokenMeta(chain: string, token: string, given: { symbol?: unknown; decimals?: unknown }): { symbol?: string; decimals?: number } {
  if (USDC[chain] && USDC[chain] === token) return { symbol: 'USDC', decimals: 6 }
  if (token === 'native' && CHAINS[chain]) return { symbol: CHAINS[chain]!.nativeSymbol, decimals: chain.startsWith('solana:') ? 9 : 18 }
  const symbol = typeof given.symbol === 'string' && SYMBOL.test(given.symbol) ? given.symbol : undefined
  const decimals = typeof given.decimals === 'number' && Number.isInteger(given.decimals) && given.decimals >= 0 && given.decimals <= 36 ? given.decimals : undefined
  return { ...(symbol ? { symbol } : {}), ...(decimals !== undefined ? { decimals } : {}) }
}

/** Check and normalize the source of a new withdraw session. Throws a 400 when it is not valid. */
export function normalizeSource(src: WithdrawSource | undefined): WithdrawSource {
  if (!src || typeof src !== 'object') throw bad('A withdraw session needs `source` (chain, token and custody).')
  if (typeof src.chain !== 'string' || !CAIP2.test(src.chain)) throw bad('`source.chain` must be a CAIP-2 chain id, e.g. eip155:8453.')
  if (typeof src.token !== 'string' || !isValidToken(src.chain, src.token)) throw bad('`source.token` must be a token address or "native".')
  if (src.custody !== 'user_wallet' && src.custody !== 'app') throw bad('`source.custody` must be "user_wallet" or "app".')
  const token = normToken(src.chain, src.token)
  return { chain: src.chain, token, custody: src.custody, ...tokenMeta(src.chain, token, src) }
}

/** Parse the body of `POST /sessions/:id/target`. Throws a 400 when it is not valid. */
export function parseTarget(body: unknown): WithdrawTarget {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  if (b.type === 'fiat') {
    const currency = typeof b.currency === 'string' ? b.currency.toUpperCase() : ''
    if (!CURRENCY.test(currency)) throw bad('`currency` must be an ISO 4217 code, e.g. PHP.')
    return { type: 'fiat', currency }
  }
  if (b.type === 'crypto') {
    const chain = typeof b.chain === 'string' ? b.chain : ''
    if (!CAIP2.test(chain)) throw bad('`chain` must be a CAIP-2 chain id, e.g. eip155:42161.')
    const rawToken = typeof b.token === 'string' ? b.token : ''
    if (!isValidToken(chain, rawToken)) throw bad('`token` must be a token address or "native".')
    const address = typeof b.address === 'string' ? b.address.trim() : ''
    if (!isValidAddress(chain, address)) {
      throw new OrkException(orkError('BAD_REQUEST', { message: 'Enter a valid address for this network.' }), 400)
    }
    const token = normToken(chain, rawToken)
    return { type: 'crypto', chain, token, address, ...tokenMeta(chain, token, b) }
  }
  throw bad('`type` must be "crypto" or "fiat".')
}

/** Throw a 403 when the app does not allow this target. */
export function checkAllowed(rec: SessionRecord, t: WithdrawTarget): void {
  const allowed = rec.allowedTargets
  if (!allowed) return
  const refuse = () => new OrkException(orkError('TARGET_NOT_ALLOWED'), 403)
  if (t.type === 'crypto') {
    if (!allowed.crypto) throw refuse()
    if (allowed.crypto.chains && !allowed.crypto.chains.includes(t.chain)) throw refuse()
  } else {
    if (!allowed.fiat) throw refuse()
    if (allowed.fiat.currencies && !allowed.fiat.currencies.map((c) => c.toUpperCase()).includes(t.currency)) throw refuse()
  }
}

/** Run the app's `screenAddress` hook. Refused or failed checks throw (fail closed). */
export async function screenTarget(rt: Runtime, t: WithdrawTarget): Promise<void> {
  if (t.type !== 'crypto' || !rt.config.screenAddress) return
  let ok: boolean
  try {
    ok = await rt.config.screenAddress(t.address, t.chain)
  } catch (e) {
    rt.log.warn('screenAddress failed', { error: String(e) })
    throw new OrkException(orkError('PROVIDER_UNAVAILABLE', { message: 'We could not check this address. Try again.' }), 503)
  }
  if (ok !== true) throw new OrkException(orkError('ADDRESS_REJECTED'), 403)
}

/** The session destination for a target. Adapters read it as `ctx.destination`. */
export function targetDestination(t: WithdrawTarget): Destination {
  if (t.type === 'fiat') return { type: 'fiat', currency: t.currency }
  return {
    type: 'crypto',
    chain: t.chain,
    token: t.token,
    address: t.address,
    ...(t.symbol ? { symbol: t.symbol } : {}),
    ...(t.decimals !== undefined ? { decimals: t.decimals } : {}),
  }
}

/** Sender info for quotes and `start()` of the first withdraw leg. */
export function withdrawSender(rt: Runtime, rec: SessionRecord): { chain: string; token: string; address?: string } | undefined {
  const src = rec.source
  if (!src) return undefined
  const address = src.custody === 'app' ? rt.config.treasury?.address : rec.walletAddress
  return { chain: src.chain, token: src.token, ...(address ? { address } : {}) }
}
