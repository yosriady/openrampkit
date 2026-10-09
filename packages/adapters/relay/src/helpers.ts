// Pure helpers: chain and token ids, assets, fees, and leg steps. No options and no I/O.

import { awaitPoll, httpErrorToOpenRamp, httpStatus } from '@openrampkit/adapter'
import type { AdapterContext, Logger } from '@openrampkit/adapter'
import { CHAINS, OpenRampException, evmChainId, fromBaseUnits, isSolanaAddress, isUsdc, openRampError, sameToken } from '@openrampkit/core'
import type { Amount, CryptoAsset, Fee, LegQuote, LegStep, StepSub } from '@openrampkit/core'
import { EVM_NATIVE, PLACEHOLDER_SOLANA_USER, PLACEHOLDER_USER, RELAY_POLL, RELAY_SOLANA_CHAIN_ID, SOLANA_CAIP2, SOLANA_NATIVE } from './config.js'
import type { RelayAmount, RelayQuoteResponse, RelayRequest } from './types.js'

/** CAIP-2 chain -> Relay numeric chain id */
export function relayChainId(chain: string): number {
  if (chain === SOLANA_CAIP2 || chain === 'solana') return RELAY_SOLANA_CHAIN_ID
  const id = evmChainId(chain)
  if (id === undefined) throw new OpenRampException(openRampError('BAD_REQUEST', { message: `Relay does not support chain ${chain}.` }))
  return id
}

export function caip2FromRelay(chainId: number): string {
  return chainId === RELAY_SOLANA_CHAIN_ID ? SOLANA_CAIP2 : `eip155:${chainId}`
}

export function isSolana(chain: string) {
  return chain.startsWith('solana:')
}

/** Our token id -> Relay currency address */
export function relayCurrency(chain: string, token: string): string {
  if (token === 'native') return isSolana(chain) ? SOLANA_NATIVE : EVM_NATIVE
  return token
}

export function isNative(chain: string, token: string) {
  const t = token.toLowerCase()
  return t === 'native' || t === EVM_NATIVE || (isSolana(chain) && token === SOLANA_NATIVE)
}

export function sameAsset(aChain: string, aToken: string, bChain: string, bToken: string) {
  if (aChain !== bChain) return false
  if (isNative(aChain, aToken) && isNative(bChain, bToken)) return true
  // EVM addresses are case-insensitive; Solana mints are case-sensitive
  return sameToken(aChain, aToken, bToken)
}

/** Key form of an address: EVM addresses lowercased, Solana (base58, case-sensitive) as given */
export function addrKey(address: string): string {
  return address.startsWith('0x') ? address.toLowerCase() : address
}

/** True when `address` is a valid account of `chain`'s VM (the format only) */
export function fitsChain(chain: string, address: string | undefined): address is string {
  if (!address) return false
  return isSolana(chain) ? isSolanaAddress(address) : /^0x[0-9a-fA-F]{40}$/.test(address)
}

/** The `user` for a Relay quote: the given address when it fits the origin chain, else a placeholder */
export function quoteUser(originChain: string, address: string | undefined): string {
  if (fitsChain(originChain, address)) return address
  return isSolana(originChain) ? PLACEHOLDER_SOLANA_USER : PLACEHOLDER_USER
}

export function sameUser(chain: string, a: unknown, b: string) {
  return typeof a === 'string' && (isSolana(chain) ? a === b : a.toLowerCase() === b.toLowerCase())
}

export function cryptoAsset(a: Amount | undefined, what: string): CryptoAsset {
  if (!a || a.asset.kind !== 'crypto') throw new OpenRampException(openRampError('BAD_REQUEST', { message: `Relay needs a crypto ${what}.` }))
  if (a.asset.chain === '*' || a.asset.token === '*') throw new OpenRampException(openRampError('BAD_REQUEST', { message: 'Choose the token you want to pay with.' }))
  return a.asset
}

export function knownDecimals(chain: string, token: string): number | undefined {
  if (isNative(chain, token)) return isSolana(chain) ? 9 : 18
  if (isUsdc(chain, token)) return 6
  return undefined
}

export function knownSymbol(chain: string, token: string): string | undefined {
  if (isNative(chain, token)) return isSolana(chain) ? 'SOL' : CHAINS[chain]?.nativeSymbol
  if (isUsdc(chain, token)) return 'USDC'
  return undefined
}

export function fmt(r: RelayAmount): string {
  return fromBaseUnits(r.amount, r.currency.decimals)
}

/**
 * A Relay amount as our `Amount`. When it is the same asset as `expected` (the quoted output), it takes
 * the quoted asset, so the server's output check compares like with like (for example Relay names the
 * native token `0x0000...0000`, the quote names it `native`). Undefined when the amount is not usable.
 */
export function relayOutput(out: RelayAmount | undefined, expected?: Amount): Amount | undefined {
  if (!out?.currency || typeof out.currency.chainId !== 'number' || typeof out.currency.address !== 'string') return undefined
  if (typeof out.amount !== 'string' || !/^[0-9]+$/.test(out.amount) || typeof out.currency.decimals !== 'number') return undefined
  const chain = caip2FromRelay(out.currency.chainId)
  const token = out.currency.address
  const exp = expected?.asset
  const asset: CryptoAsset =
    exp?.kind === 'crypto' && sameAsset(exp.chain, exp.token, chain, token)
      ? exp
      : { kind: 'crypto', chain, token, symbol: out.currency.symbol, decimals: out.currency.decimals }
  return { value: fmt(out), asset }
}

/**
 * What a Relay request delivered: the actual route output (`data.route.actual.destination.outputCurrency`),
 * else `data.metadata.currencyOut`. Never the quoted route.
 */
export function deliveredOutput(r: RelayRequest | undefined, expected?: Amount): Amount | undefined {
  return relayOutput(r?.data?.route?.actual?.destination?.outputCurrency, expected) ?? relayOutput(r?.data?.metadata?.currencyOut, expected)
}

/** A Relay currency as our crypto asset. Relay names the native token `0x0000...0000` (EVM) or the system program (Solana). */
export function relayAsset(c: RelayAmount['currency']): CryptoAsset {
  const chain = caip2FromRelay(c.chainId)
  return { kind: 'crypto', chain, token: isNative(chain, c.address) ? 'native' : c.address, symbol: c.symbol, decimals: c.decimals }
}

/**
 * The fees of a Relay quote, each in its own token. `gas` is the origin-chain gas that the user's wallet
 * pays on top of `input` (not included). Relay takes the relayer and app fees from the amount it routes,
 * so `currencyOut` already counts them (included).
 */
export function feesFrom(q: RelayQuoteResponse): Fee[] {
  const out: Fee[] = []
  const add = (kind: Fee['kind'], label: string, included: boolean, f?: RelayAmount) => {
    if (!f?.currency || !f.amount || f.amount === '0') return
    out.push({ kind, label, amount: { value: fmt(f), asset: relayAsset(f.currency) }, included })
  }
  add('network', 'Network fee', false, q.fees?.gas)
  // `relayer` already includes relayerGas and relayerService, so we do not add those.
  add('provider', 'Relay fee', true, q.fees?.relayer)
  add('app', 'App fee', true, q.fees?.app)
  return out
}

/**
 * How firm a Relay quote is. Relay guarantees the minimum output after slippage
 * (`details.currencyOut.minimumAmount`), so a quote with it is `min_output`, in the asset of `output`.
 * Without it the output is only an `estimate`. `slippageBps` is the `slippageTolerance` the adapter sent;
 * when it sends none, Relay picks a value and we do not state one.
 */
export function guaranteeOf(q: RelayQuoteResponse, output: CryptoAsset, slippageBps?: number): Pick<LegQuote, 'guarantee' | 'minOutput' | 'slippageBps'> {
  const out = q.details?.currencyOut
  if (!out?.minimumAmount || !/^[0-9]+$/.test(out.minimumAmount) || typeof out.currency?.decimals !== 'number') return { guarantee: 'estimate' }
  return {
    guarantee: 'min_output',
    minOutput: { value: fromBaseUnits(out.minimumAmount, out.currency.decimals), asset: output },
    ...(slippageBps !== undefined ? { slippageBps } : {}),
  }
}

export const toHex = (n: bigint) => `0x${n.toString(16)}`
export const hexOr = (v: string | undefined, d: bigint) => (v ? BigInt(v) : d)
export const cmpBig = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0)

export function etaFrom(q: RelayQuoteResponse, fallback: { min: number; max: number }) {
  const t = q.details?.timeEstimate
  if (typeof t !== 'number' || !Number.isFinite(t)) return fallback
  return { min: Math.max(1, Math.round(t)), max: Math.max(fallback.max, Math.round(t * 4)) }
}

/**
 * Map a failed Relay HTTP call to an OpenRampException with a safe message. A 401 or 403 is a setup error
 * (see `httpErrorToOpenRamp`). A 401 with errorCode `UNAUTHORIZED_QUOTE` means Relay requires a valid API key
 * for `POST /quote/v2` (announced policy from 2026-10-02; a quote with a `referrer` and no key is refused now).
 */
export function toOpenRamp(e: unknown, log?: Pick<Logger, 'warn'> & Partial<Pick<Logger, 'error'>>): OpenRampException {
  const unauthorizedQuote = httpStatus(e) === 401 && (e as { body?: { errorCode?: unknown } } | undefined)?.body?.errorCode === 'UNAUTHORIZED_QUOTE'
  return httpErrorToOpenRamp(e, 'Relay', {
    what: 'find a route for this pair right now',
    ...(log ? { log } : {}),
    ...(unauthorizedQuote ? { setupHint: 'Relay refused the quote (401 UNAUTHORIZED_QUOTE): Relay quotes need a valid API key. Set relay({ apiKey }), for example from RELAY_API_KEY.' } : {}),
  })
}

export const POLL_TRANSITION = awaitPoll(RELAY_POLL)
export const SUBMIT_TX = { name: 'submit_tx', kind: 'SURFACE_RESULT', expects: 'tx_hash' } as const

/**
 * The `Step.sub` for a Relay request or intent status that is not final. The raw status goes into
 * `LegStep.providerStatus` (timeline only), not to the browser.
 */
export function relaySub(status: string): StepSub {
  switch (status) {
    case 'waiting':
      return 'waiting_for_deposit'
    case 'pending':
      return 'bridging'
    case 'submitted':
      return 'confirming'
    case 'delayed':
      return 'delayed'
    default:
      return 'processing'
  }
}

/** Terminal LegStep for a Relay request or intent status, or undefined while it is still running */
export function terminalStep(status: string, extra: { ref: string; txHash?: string; output?: Amount }): LegStep | undefined {
  switch (status) {
    case 'success':
      return { state: 'COMPLETED', status: 'succeeded', transitions: [], ...extra }
    case 'failure':
      return {
        state: 'FAILED',
        status: 'failed',
        transitions: [],
        error: openRampError('DELIVERY_FAILED', { message: 'Relay could not complete the transfer.', recovery: 'contact_support' }),
        ...extra,
      }
    case 'refund':
      return { state: 'REFUNDED', status: 'refunded', transitions: [], ...extra }
    default:
      return undefined
  }
}

/** Relay's request id from a quote response (top level or on a step) */
export function requestIdOf(q: RelayQuoteResponse): string | undefined {
  return q.requestId ?? q.steps?.find((s) => s.requestId)?.requestId
}

export function withMeta(asset: CryptoAsset, decimals: number, symbol?: string): CryptoAsset {
  const s = asset.symbol ?? symbol ?? knownSymbol(asset.chain, asset.token)
  return { ...asset, decimals, ...(s ? { symbol: s } : {}) }
}

/** The settlement contract of the destination, when this leg delivers to the destination itself */
export function settlementOf(ctx: AdapterContext, deliverTo?: { address: string }): { contract: string } | undefined {
  const d = ctx.destination
  if (d.type !== 'crypto' || !d.settlement) return undefined
  // A hop leg delivers to the next leg's deposit address, not to the destination.
  if (deliverTo?.address && deliverTo.address.toLowerCase() !== d.address.toLowerCase()) return undefined
  return d.settlement
}

export function recipientOf(ctx: AdapterContext, deliverTo?: { address: string }): string {
  if (deliverTo?.address) return deliverTo.address
  if (ctx.destination.type === 'crypto') return ctx.destination.address
  throw new OpenRampException(openRampError('BAD_REQUEST', { message: 'Relay legs need a crypto destination.' }))
}

export function destAsset(ctx: AdapterContext, legTo: CryptoAsset | undefined): CryptoAsset {
  if (legTo && legTo.chain !== '*') return legTo
  const d = ctx.destination
  if (d.type !== 'crypto') throw new OpenRampException(openRampError('BAD_REQUEST', { message: 'Relay legs need a crypto destination.' }))
  return { kind: 'crypto', chain: d.chain, token: d.token, ...(d.symbol ? { symbol: d.symbol } : {}), ...(d.decimals !== undefined ? { decimals: d.decimals } : {}) }
}

/** Key that marks a transaction as used. EVM hashes are lowercased; Solana signatures are case-sensitive. */
export function usedKey(chain: string, hash: string) {
  return `txused:${chain}:${isSolana(chain) ? hash : hash.toLowerCase()}`
}
