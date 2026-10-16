// Gas abstraction: the checks on Relay's permit messages (EIP-712) before the wallet signs them and
// again before the server posts the signatures. Every check fails closed: a message that is not
// exactly one of the known shapes, or a field that cannot be read, refuses the whole permit.
//
// Shapes from https://docs.relay.link/features/gasless-swaps (EIP-3009 permits, and the
// MulticallAuthorization of Relay's approval proxy 3.2) and a live keyless quote on 2026-10-16.

import type { TypedDataRequest } from '@openrampkit/core'
import type { RelayStep } from './types.js'

/** Where Relay takes permit signatures (https://docs.relay.link/references/api/execute-permits) */
export const PERMIT_ENDPOINT = '/execute/permits'

/**
 * Relay's ApprovalProxy contracts (https://docs.relay.link/references/api/api_resources/contract-addresses),
 * London and Cancun EVMs. A single EIP-3009 permit (no MulticallAuthorization) pays a v3 proxy. A
 * MulticallAuthorization exists only on v3.2, and its EIP-3009 permit pays the same v3.2 proxy.
 */
export const RELAY_APPROVAL_PROXIES_V3: ReadonlySet<string> = new Set(['0x8754bc615047de01228a7527b712806a71a8dc9a', '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be'])
export const RELAY_APPROVAL_PROXIES_V32: ReadonlySet<string> = new Set(['0xe4dfbd5e6784db1058124e2c87554c0591f0fb7b', '0x5567954cd026cebfe486062cb75848e0f1c12e58'])

/** Relay's EVM solver: the only `relayer` a MulticallAuthorization may name */
export const RELAY_SOLVER = '0xf70da97812cb96acdf810712aa562db8dfa3dbef'

/**
 * Where a MulticallAuthorization may send the origin token: the solver and RelayReceiver. Never a router
 * or a proxy: tokens left there can be taken by any later call. Nothing else is allowed, because the
 * effect of any other call (a router `multicall`, nested calls, an approval) cannot be bounded here.
 */
export const RELAY_TOKEN_RECIPIENTS: ReadonlySet<string> = new Set([RELAY_SOLVER, '0xa5f565650890fba1824ee0f21ebbbf660a179934'])

/** A permit may be valid for at most this long (Relay's default `permitExpiry` is 10 minutes) */
export const PERMIT_MAX_TTL_SEC = 3600
/** Allowed difference between our clock and the permit's `validAfter` */
const CLOCK_SKEW_SEC = 300

const EIP3009_FIELDS = [
  ['from', 'address'],
  ['to', 'address'],
  ['value', 'uint256'],
  ['validAfter', 'uint256'],
  ['validBefore', 'uint256'],
  ['nonce', 'bytes32'],
]
/** The exact `types` of each message the adapter accepts, and the `/execute/permits` kind it is posted with */
const SHAPES: Record<string, { kind: string; types: Record<string, string[][]> }> = {
  ReceiveWithAuthorization: { kind: 'eip3009', types: { ReceiveWithAuthorization: EIP3009_FIELDS } },
  TransferWithAuthorization: { kind: 'eip3009', types: { TransferWithAuthorization: EIP3009_FIELDS } },
  MulticallAuthorization: {
    kind: 'multicall-authorization',
    types: {
      MulticallAuthorization: [
        ['from', 'address'],
        ['relayer', 'address'],
        ['msgValue', 'uint256'],
        ['refundTo', 'address'],
        ['nftRecipient', 'address'],
        ['metadata', 'bytes'],
        ['fundingIndex', 'uint256'],
        ['calls', 'Call3Value[]'],
        ['funding', 'FundingAuthorization[]'],
      ],
      Call3Value: [
        ['target', 'address'],
        ['allowFailure', 'bool'],
        ['value', 'uint256'],
        ['callData', 'bytes'],
      ],
      FundingAuthorization: [
        ['token', 'address'],
        ['from', 'address'],
        ['value', 'uint256'],
        ['validAfter', 'uint256'],
        ['validBefore', 'uint256'],
      ],
    },
  },
}

/** ERC-20 `transfer(address,uint256)`: the only call a MulticallAuthorization may make, and only on the origin token */
const TRANSFER_SELECTOR = '0xa9059cbb'
/** 0x + selector (8) + two 32-byte words (128): exactly, no trailing bytes */
const TRANSFER_CALLDATA_LENGTH = 2 + 8 + 128

export type PermitItem = { typedData: TypedDataRequest; body: Record<string, unknown> }
export type PermitCheck = { chainId: number; token: string; user: string; maxBase: bigint; requestId: string; nowSec: number }

/**
 * The EIP-712 items of Relay's permit steps (`authorize1`), in order. Undefined when the route also
 * needs a transaction (for example an approval), when an item is already complete, or when an item is
 * not an EIP-712 signature for `POST /execute/permits`: then the wallet must pay gas.
 */
export function permitItems(steps: RelayStep[]): PermitItem[] | undefined {
  const out: PermitItem[] = []
  for (const st of steps) {
    if (st.kind !== 'signature') return undefined
    for (const it of st.items ?? []) {
      // An item we did not see signed is not ours to skip.
      if (it.status !== 'incomplete') return undefined
      const sign = it.data?.sign
      const post = it.data?.post
      if (sign?.signatureKind !== 'eip712' || !isObject(sign.domain) || !isObject(sign.types) || typeof sign.primaryType !== 'string' || !isObject(sign.value)) return undefined
      if (post?.endpoint !== PERMIT_ENDPOINT || (post.method !== undefined && String(post.method).toUpperCase() !== 'POST') || !isObject(post.body)) return undefined
      const { EIP712Domain: _domain, ...types } = sign.types
      out.push({ typedData: { domain: sign.domain as TypedDataRequest['domain'], types, primaryType: sign.primaryType, message: sign.value }, body: post.body })
    }
  }
  return out.length ? out : undefined
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const addr = (v: unknown): string | undefined => (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : undefined)

/** A uint256 field, or undefined when it is not a non-negative integer */
function uint(v: unknown): bigint | undefined {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : undefined
  if (typeof v === 'string' && /^(0x[0-9a-fA-F]+|\d+)$/.test(v)) return BigInt(v)
  return undefined
}

function sameTypes(types: TypedDataRequest['types'], want: Record<string, string[][]>): boolean {
  const names = Object.keys(types)
  if (names.length !== Object.keys(want).length) return false
  return names.every((n) => {
    const w = want[n]
    const got = types[n]
    return !!w && Array.isArray(got) && got.length === w.length && got.every((f, i) => f?.name === w[i]![0] && f?.type === w[i]![1])
  })
}

/** A validity window that is open now, and closes within `PERMIT_MAX_TTL_SEC` */
function windowProblem(validAfter: unknown, validBefore: unknown, nowSec: number): string | undefined {
  const after = uint(validAfter)
  const before = uint(validBefore)
  if (after === undefined || before === undefined) return 'the permit has no valid time window'
  if (after > BigInt(nowSec + CLOCK_SKEW_SEC)) return 'the permit is not valid yet'
  if (before <= BigInt(nowSec)) return 'the permit has expired'
  if (before > BigInt(nowSec + PERMIT_MAX_TTL_SEC)) return 'the permit stays valid for too long'
  return undefined
}

function eip3009Problem(t: TypedDataRequest, p: PermitCheck): string | undefined {
  const m = t.message
  if (addr(t.domain.verifyingContract) !== p.token.toLowerCase()) return 'the permit is for another token'
  if (addr(m.from) !== p.user.toLowerCase()) return 'the permit is for another account'
  const to = addr(m.to)
  if (!to || !(RELAY_APPROVAL_PROXIES_V3.has(to) || RELAY_APPROVAL_PROXIES_V32.has(to))) return 'the permit pays an address that is not Relay'
  const value = uint(m.value)
  if (value === undefined || value === 0n || value > p.maxBase) return 'the permit moves more than the quoted amount'
  if (typeof m.nonce !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(m.nonce)) return 'the permit has no valid nonce'
  return windowProblem(m.validAfter, m.validBefore, p.nowSec)
}

/**
 * A token transfer in a MulticallAuthorization call, fully decoded: `transfer(to, amount)` on the origin
 * token, exact calldata length, a clean 20-byte address, `to` a Relay recipient and `amount` above zero.
 * Returns the amount, or a problem.
 */
function transferOf(c: Record<string, unknown>, token: string): bigint | string {
  if (typeof c.allowFailure !== 'boolean' || c.allowFailure) return 'the authorization has an invalid call'
  if (uint(c.value) !== 0n) return 'the authorization sends native value'
  const target = addr(c.target)
  const data = typeof c.callData === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(c.callData) ? c.callData.toLowerCase() : undefined
  if (!target || data === undefined) return 'the authorization has an invalid call'
  if (target !== token || data.slice(0, 10) !== TRANSFER_SELECTOR || data.length !== TRANSFER_CALLDATA_LENGTH) return 'the authorization makes a call that cannot be checked'
  // The address word: 12 zero bytes, then the address (no dirty high bits).
  if (data.slice(10, 34) !== '0'.repeat(24) || !RELAY_TOKEN_RECIPIENTS.has(`0x${data.slice(34, 74)}`)) return 'the authorization moves the token to an address that is not Relay'
  const amount = BigInt(`0x${data.slice(74, 138)}`)
  if (amount === 0n) return 'the authorization has an invalid call'
  return amount
}

function multicallProblem(t: TypedDataRequest, p: PermitCheck): string | undefined {
  const m = t.message
  const user = p.user.toLowerCase()
  const token = p.token.toLowerCase()
  const proxy = addr(t.domain.verifyingContract)
  if (!proxy || !RELAY_APPROVAL_PROXIES_V32.has(proxy)) return 'the authorization is for a contract that is not Relay'
  if (addr(m.from) !== user) return 'the permit is for another account'
  // Refunds and anything left over go back to the user.
  if (addr(m.refundTo) !== user || addr(m.nftRecipient) !== user) return 'the authorization refunds to another account'
  if (addr(m.relayer) !== RELAY_SOLVER) return 'the authorization names a relayer that is not Relay'
  if (uint(m.msgValue) !== 0n) return 'the authorization sends native value'
  // Metadata whose effect the docs do not fix is refused.
  if (m.metadata !== '0x') return 'the authorization has metadata that cannot be checked'
  // One EIP-3009 permit funds the calls: exactly one funding entry, at index 0.
  const funding = m.funding
  if (!Array.isArray(funding) || funding.length !== 1) return 'the authorization must have exactly one funding entry'
  if (uint(m.fundingIndex) !== 0n) return 'the authorization has an invalid funding index'
  const f = funding[0]
  if (!isObject(f) || addr(f.token) !== token || addr(f.from) !== user) return 'the permit funds from another token or account'
  const funded = uint(f.value)
  if (funded === undefined || funded === 0n || funded > p.maxBase) return 'the permit moves more than the quoted amount'
  const w = windowProblem(f.validAfter, f.validBefore, p.nowSec)
  if (w) return w
  // Every call is a decoded token transfer to Relay; together they move exactly the funded amount,
  // so no token stays in the proxy and nothing moves beyond the bound.
  const calls = m.calls
  if (!Array.isArray(calls) || !calls.length) return 'the authorization has no calls'
  let moved = 0n
  for (const c of calls) {
    if (!isObject(c)) return 'the authorization has an invalid call'
    const r = transferOf(c, token)
    if (typeof r === 'string') return r
    moved += r
  }
  if (moved !== funded) return 'the authorization calls do not move exactly the funded amount'
  return undefined
}

/** The message has exactly the fields of its type, and each struct (also in arrays) the fields of its own */
function extraFields(value: unknown, type: string, types: TypedDataRequest['types']): boolean {
  if (type.endsWith('[]')) return !Array.isArray(value) || value.some((v) => extraFields(v, type.slice(0, -2), types))
  const fields = types[type]
  if (!fields) return false
  if (!isObject(value)) return true
  const keys = Object.keys(value)
  if (keys.length !== fields.length || !fields.every((f) => keys.includes(f.name))) return true
  return fields.some((f) => extraFields(value[f.name], f.type, types))
}

/**
 * Checks what Relay asks the wallet to sign, before the user sees it and again before the server
 * posts the signatures. Each item must be a known message type with exactly the known `types` and
 * fields, for the origin chain and this request, posted with the matching kind. Exactly one EIP-3009
 * authorization: from the user, for the origin token, at most the quoted input, open now for at most
 * `PERMIT_MAX_TTL_SEC`. Alone, it pays a v3 approval proxy. With a MulticallAuthorization (v3.2, before
 * it), it pays that proxy exactly the one funding entry, and the calls only transfer exactly that amount
 * of the origin token to Relay's solver or RelayReceiver. Any other call is refused, also to a Relay
 * contract: its effect cannot be bounded. Returns the first problem, or undefined.
 */
export function permitProblem(items: PermitItem[], p: PermitCheck): string | undefined {
  let eip3009: TypedDataRequest | undefined
  let multicall: TypedDataRequest | undefined
  for (const { typedData: t, body } of items) {
    const shape = SHAPES[t.primaryType]
    if (!shape) return `the permit has an unknown message type (${t.primaryType.slice(0, 40)})`
    if (!sameTypes(t.types, shape.types)) return 'the permit message has unexpected fields'
    if (extraFields(t.message, t.primaryType, t.types)) return 'the permit message has unexpected fields'
    if (body.kind !== shape.kind) return 'the permit is posted with another kind'
    if (typeof body.requestId !== 'string' || body.requestId.toLowerCase() !== p.requestId.toLowerCase()) return 'the permit is for another request'
    if (uint(t.domain.chainId) !== BigInt(p.chainId)) return 'the permit is for another chain'
    const problem = shape.kind === 'eip3009' ? eip3009Problem(t, p) : multicallProblem(t, p)
    if (problem) return problem
    if (shape.kind === 'eip3009') {
      if (eip3009) return 'the permit has more than one token authorization'
      eip3009 = t
    } else {
      // Relay's order: the MulticallAuthorization is posted first.
      if (multicall || eip3009) return 'the permit has its authorizations in an unexpected order'
      multicall = t
    }
  }
  if (!eip3009) return 'the permit has no token authorization'
  const to = addr(eip3009.message.to)!
  if (!multicall) return RELAY_APPROVAL_PROXIES_V3.has(to) ? undefined : 'the permit pays an address that is not Relay'
  // The token authorization funds the approval proxy that runs the authorized calls, with exactly the funded amount.
  if (to !== addr(multicall.domain.verifyingContract)) return 'the token authorization pays another contract than the authorized calls'
  const f = (multicall.message.funding as Array<Record<string, unknown>>)[0]!
  if (uint(eip3009.message.value) !== uint(f.value) || uint(eip3009.message.validBefore) !== uint(f.validBefore)) return 'the token authorization does not match the funding'
  return undefined
}

/** The EIP-3009 nonce of a checked permit, for the one-use claim */
export function permitNonce(items: PermitItem[]): string | undefined {
  const t = items.find((i) => SHAPES[i.typedData.primaryType]?.kind === 'eip3009')?.typedData
  return typeof t?.message.nonce === 'string' ? t.message.nonce.toLowerCase() : undefined
}
