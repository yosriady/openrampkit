// Withdraw sessions: validate the source at creation, and the target the user picks.

import { erc20BalanceOfData, evmRpc } from '@openrampkit/adapter'
import { CHAINS, OpenRampException, cmp, fromBaseUnits, isUsdc, lightningDomain, nativeDecimals, normalizeToken, openRampError, parseLightningTarget, sameToken } from '@openrampkit/core'
import type { Amount, Destination, OpenRampError, WithdrawSource, WithdrawDestination } from '@openrampkit/core'
import type { Runtime } from './runtime.js'
import type { SessionRecord } from './store.js'

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const EVM_ZERO = /^0x0{40}$/
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const OTHER_ADDRESS = /^[\x21-\x7e]{8,128}$/
/** Bitcoin mainnet: base58 P2PKH or P2SH (`1...`, `3...`), or bech32 / bech32m (`bc1...`, one case only). Format only, no checksum. */
const BITCOIN_ADDRESS = /^(?:[13][1-9A-HJ-NP-Za-km-z]{25,34}|bc1[ac-hj-np-z02-9]{11,71}|BC1[AC-HJ-NP-Z02-9]{11,71})$/
/** Tron: base58, `T` and 33 more characters. Format only, no checksum. */
const TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
export const CAIP2 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/
const CURRENCY = /^[A-Z]{3}$/
const SYMBOL = /^[A-Za-z0-9.$_-]{1,12}$/

const bad = (message: string) => new OpenRampException(openRampError('BAD_REQUEST', { message }), 400)

/** True when `address` has the right format for `chain` (EVM: `0x` and 40 hex digits, not the zero address). */
export function isValidAddress(chain: string, address: string): boolean {
  if (chain.startsWith('eip155:')) return EVM_ADDRESS.test(address) && !EVM_ZERO.test(address)
  if (chain.startsWith('solana:')) return SOLANA_ADDRESS.test(address)
  if (chain.startsWith('bip122:')) return BITCOIN_ADDRESS.test(address)
  if (chain.startsWith('tron:')) return TRON_ADDRESS.test(address)
  return OTHER_ADDRESS.test(address)
}

export function isValidToken(chain: string, token: string): boolean {
  if (token === 'native') return true
  if (chain.startsWith('eip155:')) return EVM_ADDRESS.test(token)
  if (chain.startsWith('solana:')) return SOLANA_ADDRESS.test(token)
  // Bitcoin has no tokens here: only `native` (BTC)
  if (chain.startsWith('bip122:')) return false
  if (chain.startsWith('tron:')) return TRON_ADDRESS.test(token)
  return OTHER_ADDRESS.test(token)
}

const normToken = (chain: string, token: string) => normalizeToken(chain, token)

/** Symbol and decimals we know for a token, else the (checked) values the caller gave. */
function tokenMeta(chain: string, token: string, given: { symbol?: unknown; decimals?: unknown }): { symbol?: string; decimals?: number } {
  if (isUsdc(chain, token)) return { symbol: 'USDC', decimals: 6 }
  if (token === 'native' && CHAINS[chain]) return { symbol: CHAINS[chain]!.nativeSymbol, decimals: nativeDecimals(chain) }
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
export function parseTarget(body: unknown): WithdrawDestination {
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
      throw new OpenRampException(openRampError('BAD_REQUEST', { message: 'Enter a valid address for this network.' }), 400)
    }
    const token = normToken(chain, rawToken)
    return { type: 'crypto', chain, token, address, ...tokenMeta(chain, token, b) }
  }
  if (b.type === 'lightning') {
    // Only the address the user typed counts. A `cashtag` field in the body is ignored: the server sets it.
    const t = parseLightningTarget(b.address)
    if (!t) throw bad('Enter a valid $cashtag or Lightning address (name@domain).')
    return t
  }
  throw bad('`type` must be "crypto", "fiat" or "lightning".')
}

/** Throw a 403 when the app does not allow this target. */
export function checkAllowed(rec: SessionRecord, t: WithdrawDestination): void {
  const allowed = rec.allowedDestinations
  if (!allowed) return
  const refuse = () => new OpenRampException(openRampError('DESTINATION_NOT_ALLOWED'), 403)
  if (t.type === 'crypto') {
    if (!allowed.crypto) throw refuse()
    if (allowed.crypto.chains && !allowed.crypto.chains.includes(t.chain)) throw refuse()
  } else if (t.type === 'lightning') {
    if (!allowed.lightning) throw refuse()
    const domains = allowed.lightning.domains
    if (domains && !domains.map((d) => String(d).toLowerCase()).includes(lightningDomain(t.address))) throw refuse()
  } else {
    if (!allowed.fiat) throw refuse()
    if (allowed.fiat.currencies && !allowed.fiat.currencies.map((c) => c.toUpperCase()).includes(t.currency)) throw refuse()
  }
}

/**
 * Run the app's screening hook: `screenAddress` for a crypto target, `screenLightningAddress` for a
 * Lightning target. Refused or failed checks throw (fail closed). An app that screens crypto addresses
 * but has no Lightning hook gets no unscreened Lightning payout: the target is refused.
 */
export async function screenTarget(rt: Runtime, t: WithdrawDestination): Promise<void> {
  if (t.type === 'lightning') return screenLightning(rt, t)
  if (t.type !== 'crypto' || !rt.config.screenAddress) return
  let ok: boolean
  try {
    ok = await rt.config.screenAddress(t.address, t.chain)
  } catch (e) {
    rt.log.warn('screenAddress failed', { error: String(e) })
    throw new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message: 'We could not check this address. Try again.' }), 503)
  }
  if (ok !== true) throw new OpenRampException(openRampError('ADDRESS_REJECTED'), 403)
}

async function screenLightning(rt: Runtime, t: Extract<WithdrawDestination, { type: 'lightning' }>): Promise<void> {
  const hook = rt.config.screenLightningAddress
  if (!hook) {
    if (!rt.config.screenAddress) return
    rt.log.warn('a Lightning target was refused: `screenAddress` is set but `screenLightningAddress` is not')
    throw new OpenRampException(openRampError('DESTINATION_NOT_ALLOWED', { message: 'This app cannot pay to a Lightning address.' }), 403)
  }
  let ok: boolean
  try {
    ok = await hook(t.address, t.cashtag ? { cashtag: t.cashtag } : {})
  } catch (e) {
    rt.log.warn('screenLightningAddress failed', { error: String(e) })
    throw new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message: 'We could not check this address. Try again.' }), 503)
  }
  if (ok !== true) throw new OpenRampException(openRampError('ADDRESS_REJECTED'), 403)
}

/** The session destination for a target. Adapters read it as `ctx.destination`. */
export function targetDestination(t: WithdrawDestination): Destination {
  if (t.type === 'fiat') return { type: 'fiat', currency: t.currency }
  if (t.type === 'lightning') return { type: 'lightning', address: t.address, ...(t.cashtag ? { cashtag: t.cashtag } : {}) }
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

/** Default timeout of the balance RPC call (`withdraw.checkBalance.timeoutMs`) */
export const BALANCE_CHECK_TIMEOUT_MS = 3000

/** The user's balance of the session source, as a decimal string in the source token. */
export type SourceBalance = { chain: string; token: string; value: string; symbol?: string }

/**
 * `withdraw.checkBalance`: read the balance of the session source in the user's wallet. Returns
 * undefined when the check does not apply: it is off, the custody is not `user_wallet`, there is no
 * wallet address yet, the chain is not EVM or has no RPC URL, or the decimals of the token are not
 * known. An RPC error or timeout also returns undefined (fail open), with a warning in the log.
 */
export async function readSourceBalance(rt: Runtime, rec: SessionRecord): Promise<SourceBalance | undefined> {
  const cfg = rt.config.withdraw?.checkBalance
  const src = rec.source
  const owner = rec.walletAddress
  if (!cfg || !src || src.custody !== 'user_wallet' || !owner) return undefined
  // EVM only. Other chains (Solana, for example) have no check yet, so the wallet rejects a low balance.
  if (!src.chain.startsWith('eip155:') || !isValidAddress(src.chain, owner)) return undefined
  const url = cfg.rpcUrls?.[src.chain]
  if (!url || src.decimals === undefined) return undefined
  const timeoutMs = cfg.timeoutMs ?? BALANCE_CHECK_TIMEOUT_MS
  try {
    // A native source (ETH, POL, ...) has no contract: read the account balance instead of balanceOf.
    const hex =
      src.token === 'native'
        ? await evmRpc<string>(rt.fetch, url, 'eth_getBalance', [owner, 'latest'], { timeoutMs })
        : await evmRpc<string>(rt.fetch, url, 'eth_call', [{ to: src.token, data: erc20BalanceOfData(owner) }, 'latest'], { timeoutMs })
    if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(hex)) throw new Error(`unexpected RPC result: ${String(hex).slice(0, 80)}`)
    return { chain: src.chain, token: src.token, value: fromBaseUnits(BigInt(hex).toString(), src.decimals), ...(src.symbol ? { symbol: src.symbol } : {}) }
  } catch (e) {
    rt.log.warn('withdraw balance check failed; continuing without it', { sessionId: rec.id, chain: src.chain, error: e instanceof Error ? e.message : String(e) })
    return undefined
  }
}

/** `AMOUNT_TOO_HIGH` when `amount` of the source token is above the balance, else undefined. */
export function balanceError(balance: SourceBalance | undefined, amount: string | Amount): OpenRampError | undefined {
  if (!balance) return undefined
  let value: string
  if (typeof amount === 'string') value = amount
  else {
    // Only an amount of the source token can be compared with the balance.
    const a = amount.asset
    if (a.kind !== 'crypto' || a.chain !== balance.chain || !sameToken(balance.chain, a.token, balance.token)) return undefined
    value = amount.value
  }
  if (cmp(value, balance.value) <= 0) return undefined
  const has = `${balance.value}${balance.symbol ? ` ${balance.symbol}` : ''}`
  return openRampError('AMOUNT_TOO_HIGH', { message: `Your wallet has ${has}. Enter a lower amount.`, recovery: 'requote' })
}
