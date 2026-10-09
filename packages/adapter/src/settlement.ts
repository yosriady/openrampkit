// OpenRampSettlement helpers: build the WALLET_TX calls (approve + settle), build the EIP-712 intent
// the server signs, and verify a settlement on chain over JSON-RPC. The contract lives in `contracts/`.
// Web-standard APIs only (fetch), no viem.

import { OrkException, orkError } from '@openrampkit/core'
import type { ContractCall, EvmTxRequest } from '@openrampkit/core'
import { evmRpc } from './evm.js'
import type { Logger } from './index.js'
import { hexToBytes, keccak256 } from './keccak.js'
import { bytesToHex } from './util.js'

export { OPEN_RAMP_SETTLEMENT_ABI } from './settlement-abi.js'
export { keccak256 } from './keccak.js'

/** Selectors and topics of OpenRampSettlement (checked against the compiled contract in the tests) */
export const SETTLEMENT_SELECTORS = {
  settle: '0x4fcc438f',
  settleFromBalance: '0x3c883a61',
  receiptOf: '0x72a41fdd',
  isSettled: '0xbd07f3c9',
  intentSigner: '0x29ef5bdc',
} as const

/** keccak256("Settled(bytes32,address,address,address,uint256,bytes32)") */
export const SETTLED_TOPIC = '0x414a2c95616c9c998cf27641378370e66a5c4a032fb296f1dc10b4b356b73e90'

/** EIP-712 types of the intent that the OpenRampKit server signs */
export const SETTLEMENT_INTENT_TYPES = {
  SettlementIntent: [
    { name: 'sessionId', type: 'bytes32' },
    { name: 'payer', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'recipient', type: 'address' },
    { name: 'minAmount', type: 'uint256' },
    { name: 'calls', type: 'Call[]' },
    { name: 'deadline', type: 'uint256' },
  ],
  Call: [
    { name: 'target', type: 'address' },
    { name: 'data', type: 'bytes' },
  ],
} as const

/**
 * EIP-712 types of the intent for `settleFromBalance`. It binds the exact `amount`, not a minimum,
 * because that path pays from a balance that can hold the funds of other sessions.
 */
export const SETTLEMENT_BALANCE_INTENT_TYPES = {
  BalanceSettlementIntent: [
    { name: 'sessionId', type: 'bytes32' },
    { name: 'payer', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'recipient', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'calls', type: 'Call[]' },
    { name: 'deadline', type: 'uint256' },
  ],
  Call: SETTLEMENT_INTENT_TYPES.Call,
} as const

const CALL_TYPEHASH = keccak256('Call(address target,bytes data)')
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const HEX_RE = /^0x([0-9a-fA-F]{2})*$/

/** One call of the settlement call bundle. `target` gets an allowance of the settled amount for the call. */
export type SettlementCall = { target: string; data: string }

/**
 * The server authorization for a settlement (empty when the contract has no intent signer).
 * For `settleFromBalance`, `minAmount` is the exact signed amount and must equal the settled `amount`.
 */
export type SettlementIntent = { payer: string; minAmount: bigint; deadline: bigint; signature: string }

export type SettlementParams = {
  /** The OpenRampKit session id (`ors_...`). Encoded with `sessionIdToBytes32`. */
  sessionId: string
  token: string
  /** Base units */
  amount: bigint
  recipient: string
  calls?: SettlementCall[]
}

/** EIP-712 typed data for a settlement intent, ready for viem `signTypedData` or a KMS signer */
export type SettlementIntentTypedData = {
  domain: { name: 'OpenRampSettlement'; version: '1'; chainId: number; verifyingContract: string }
  types: typeof SETTLEMENT_INTENT_TYPES
  primaryType: 'SettlementIntent'
  message: {
    sessionId: string
    payer: string
    token: string
    recipient: string
    minAmount: bigint
    calls: SettlementCall[]
    deadline: bigint
  }
}

/** EIP-712 typed data for a `settleFromBalance` intent */
export type SettlementBalanceIntentTypedData = {
  domain: SettlementIntentTypedData['domain']
  types: typeof SETTLEMENT_BALANCE_INTENT_TYPES
  primaryType: 'BalanceSettlementIntent'
  message: Omit<SettlementIntentTypedData['message'], 'minAmount'> & { amount: bigint }
}

// ---------- encoding ----------

export function isEvmAddress(a: unknown): a is string {
  return typeof a === 'string' && ADDRESS_RE.test(a)
}

/**
 * A session id as bytes32: its UTF-8 bytes, right-padded with zeros (like Solidity `bytes32("...")`).
 * Readable on block explorers and reversible with `bytes32ToSessionId`. At most 32 bytes.
 */
export function sessionIdToBytes32(sessionId: string): string {
  const b = new TextEncoder().encode(sessionId)
  if (!b.length || b.length > 32) throw new OrkException(orkError('BAD_REQUEST', { message: 'A settlement session id must be 1 to 32 bytes.' }), 400)
  return `0x${bytesToHex(b).padEnd(64, '0')}`
}

export function bytes32ToSessionId(word: string): string {
  const bytes = hexToBytes(word)
  let end = bytes.length
  while (end > 0 && bytes[end - 1] === 0) end--
  return new TextDecoder().decode(bytes.slice(0, end))
}

/** The settlement calls of a destination (`ContractCall` uses `to`; the contract calls it `target`) */
export function settlementCallsFrom(calls: ContractCall[] | undefined): SettlementCall[] {
  return (calls ?? []).map((c) => {
    if (!isEvmAddress(c.to) || !HEX_RE.test(c.data)) throw new OrkException(orkError('BAD_REQUEST', { message: 'Each destination call needs a `to` address and hex `data`.' }), 400)
    if (c.value && BigInt(c.value) !== 0n) throw new OrkException(orkError('BAD_REQUEST', { message: 'Destination calls cannot send native value.' }), 400)
    return { target: c.to, data: c.data }
  })
}

type AbiValue = { t: 'word'; v: string } | { t: 'bytes'; v: string } | { t: 'tuple'; v: AbiValue[] } | { t: 'array'; v: AbiValue[] }

const word = (v: string | bigint | number): AbiValue => ({
  t: 'word',
  v: (typeof v === 'string' ? v.toLowerCase().replace(/^0x/, '') : BigInt(v).toString(16)).padStart(64, '0'),
})
const dynamic = (x: AbiValue): boolean => x.t === 'bytes' || x.t === 'array' || (x.t === 'tuple' && x.v.some(dynamic))

function enc(x: AbiValue): string {
  switch (x.t) {
    case 'word':
      return x.v
    case 'bytes': {
      const hex = x.v.replace(/^0x/, '').toLowerCase()
      return word(hex.length / 2).v + hex.padEnd(Math.ceil(hex.length / 64) * 64, '0')
    }
    case 'tuple':
      return encSeq(x.v)
    case 'array':
      return word(x.v.length).v + encSeq(x.v)
  }
}

/** ABI head/tail encoding of a sequence (tuple fields or array items) */
function encSeq(items: AbiValue[]): string {
  const parts = items.map((i) => ({ dyn: dynamic(i), data: enc(i) }))
  const headSize = parts.reduce((n, p) => n + (p.dyn ? 32 : p.data.length / 2), 0)
  let head = ''
  let tail = ''
  for (const p of parts) {
    if (p.dyn) {
      head += word(headSize + tail.length / 2).v
      tail += p.data
    } else head += p.data
  }
  return head + tail
}

function settlementTuple(p: SettlementParams): AbiValue {
  return {
    t: 'tuple',
    v: [
      word(sessionIdToBytes32(p.sessionId)),
      word(p.token),
      word(p.amount),
      word(p.recipient),
      { t: 'array', v: (p.calls ?? []).map((c) => ({ t: 'tuple', v: [word(c.target), { t: 'bytes', v: c.data }] }) as AbiValue) },
    ],
  }
}

/**
 * Calldata of `settle(settlement, intent)` (or `settleFromBalance` with `fromBalance`).
 * With `fromBalance`, the intent must come from `settlementBalanceIntentTypedData` and its
 * `minAmount` must equal `amount` (the contract reverts otherwise).
 */
export function encodeSettle(p: SettlementParams, intent?: SettlementIntent, opts: { fromBalance?: boolean } = {}): string {
  if (opts.fromBalance && intent && intent.minAmount !== p.amount) {
    throw new OrkException(orkError('BAD_REQUEST', { message: 'For settleFromBalance, the intent amount must equal the settled amount.' }), 400)
  }
  const i = intent ?? { payer: ZERO_ADDRESS, minAmount: 0n, deadline: 0n, signature: '0x' }
  const selector = opts.fromBalance ? SETTLEMENT_SELECTORS.settleFromBalance : SETTLEMENT_SELECTORS.settle
  const args = encSeq([settlementTuple(p), { t: 'tuple', v: [word(i.payer), word(i.minAmount), word(i.deadline), { t: 'bytes', v: i.signature }] }])
  return `${selector}${args}`
}

/** ERC-20 approve(spender, amount) calldata */
export function erc20ApproveData(spender: string, amountBase: bigint): string {
  return `0x095ea7b3${word(spender).v}${word(amountBase).v}`
}

/**
 * The WALLET_TX transactions that pay a session through the settlement contract:
 * `approve(contract, amount)` on the token, then `settle(...)` on the contract.
 */
export function buildSettlementTxs(input: SettlementParams & { chainId: number; contract: string; intent?: SettlementIntent }): EvmTxRequest[] {
  return [
    { to: input.token, data: erc20ApproveData(input.contract, input.amount), chainId: input.chainId },
    { to: input.contract, data: encodeSettle(input, input.intent), chainId: input.chainId },
  ]
}

// ---------- EIP-712 ----------

/** EIP-712 hash of a call bundle; equals the contract's `hashCalls` and the `callsHash` of `Settled` */
export function hashSettlementCalls(calls: SettlementCall[]): string {
  const hashes = calls.map((c) => keccak256(hexToBytes(CALL_TYPEHASH + word(c.target).v + keccak256(hexToBytes(c.data)).slice(2))).slice(2))
  return keccak256(hexToBytes(hashes.join('')))
}

/** The typed data the intent signer signs for a settlement. `payer` zero means any caller. */
export function settlementIntentTypedData(input: {
  chainId: number
  contract: string
  sessionId: string
  token: string
  recipient: string
  minAmount: bigint
  calls?: SettlementCall[]
  deadline: bigint
  payer?: string
}): SettlementIntentTypedData {
  return {
    domain: { name: 'OpenRampSettlement', version: '1', chainId: input.chainId, verifyingContract: input.contract },
    types: SETTLEMENT_INTENT_TYPES,
    primaryType: 'SettlementIntent',
    message: {
      sessionId: sessionIdToBytes32(input.sessionId),
      payer: input.payer ?? ZERO_ADDRESS,
      token: input.token,
      recipient: input.recipient,
      minAmount: input.minAmount,
      calls: input.calls ?? [],
      deadline: input.deadline,
    },
  }
}

/**
 * The typed data the intent signer signs for `settleFromBalance`. It binds the exact `amount`.
 * Sign it only for funds that you saw arrive in the contract for this session, or set `payer` to the
 * solver that fills and settles in one transaction. Pass `amount` as the intent `minAmount`.
 */
export function settlementBalanceIntentTypedData(input: {
  chainId: number
  contract: string
  sessionId: string
  token: string
  recipient: string
  amount: bigint
  calls?: SettlementCall[]
  deadline: bigint
  payer?: string
}): SettlementBalanceIntentTypedData {
  return {
    domain: { name: 'OpenRampSettlement', version: '1', chainId: input.chainId, verifyingContract: input.contract },
    types: SETTLEMENT_BALANCE_INTENT_TYPES,
    primaryType: 'BalanceSettlementIntent',
    message: {
      sessionId: sessionIdToBytes32(input.sessionId),
      payer: input.payer ?? ZERO_ADDRESS,
      token: input.token,
      recipient: input.recipient,
      amount: input.amount,
      calls: input.calls ?? [],
      deadline: input.deadline,
    },
  }
}

// ---------- verification ----------

export type SettlementRecord = {
  sessionId: string
  payer: string
  token: string
  recipient: string
  /** Base units */
  amount: bigint
  /** Unix seconds */
  settledAt: number
  /** From the `Settled` log */
  callsHash: string
  txHash: string
  blockNumber: number
}

export type VerifySettlementResult =
  | { settled: false }
  | { settled: true; ok: boolean; problem?: string; record: SettlementRecord }

const addrFromWord = (w: string) => `0x${w.slice(-40)}`.toLowerCase()

/**
 * Check a session on an OpenRampSettlement contract over JSON-RPC. It reads the stored receipt
 * (`receiptOf`), then the `Settled` log of the session (indexed by session id) for the transaction
 * hash and the calls hash. With `expect`, `ok` tells whether the settlement pays what the session
 * asked for; `problem` says what differs.
 *
 * Use `fromBlock` (hex or number) to narrow the log search on RPCs that limit block ranges,
 * e.g. the block at which the session started.
 */
export async function verifySettlement(input: {
  rpcUrl: string
  contract: string
  sessionId: string
  fetch?: typeof fetch
  log?: Logger
  fromBlock?: string | number
  expect?: { token?: string; recipient?: string; minAmount?: bigint; callsHash?: string }
}): Promise<VerifySettlementResult> {
  const f = input.fetch ?? fetch
  const opts = input.log ? { log: input.log } : {}
  const sid = sessionIdToBytes32(input.sessionId)
  const ret = await evmRpc<string>(f, input.rpcUrl, 'eth_call', [{ to: input.contract, data: `${SETTLEMENT_SELECTORS.receiptOf}${sid.slice(2)}` }, 'latest'], opts)
  const hex = (ret ?? '0x').replace(/^0x/, '')
  if (hex.length < 64 * 5) throw new OrkException(orkError('PROVIDER_UNAVAILABLE', { message: 'The settlement contract returned no receipt. Check the contract address and chain.' }), 502)
  const w = (i: number) => hex.slice(i * 64, i * 64 + 64)
  const settledAt = Number(BigInt(`0x${w(1)}`))
  if (settledAt === 0) return { settled: false }

  const fromBlock = input.fromBlock === undefined ? '0x0' : typeof input.fromBlock === 'number' ? `0x${input.fromBlock.toString(16)}` : input.fromBlock
  const logs = await evmRpc<Array<{ data: string; topics: string[]; transactionHash: string; blockNumber: string }>>(
    f,
    input.rpcUrl,
    'eth_getLogs',
    [{ address: input.contract, fromBlock, toBlock: 'latest', topics: [SETTLED_TOPIC, sid] }],
    opts,
  )
  const log = logs?.[0]
  if (!log) throw new OrkException(orkError('PROVIDER_UNAVAILABLE', { message: 'The session settled, but its Settled log was not found. Check `fromBlock`.' }), 502)
  const data = log.data.replace(/^0x/, '')

  const record: SettlementRecord = {
    sessionId: input.sessionId,
    payer: addrFromWord(w(0)),
    settledAt,
    token: addrFromWord(w(2)),
    recipient: addrFromWord(w(3)),
    amount: BigInt(`0x${w(4)}`),
    callsHash: `0x${data.slice(128, 192)}`,
    txHash: log.transactionHash,
    blockNumber: Number(BigInt(log.blockNumber)),
  }

  const e = input.expect ?? {}
  let problem: string | undefined
  if (e.token && e.token.toLowerCase() !== record.token) problem = 'The settlement paid a different token.'
  else if (e.recipient && e.recipient.toLowerCase() !== record.recipient) problem = 'The settlement paid a different recipient.'
  else if (e.minAmount !== undefined && record.amount < e.minAmount) problem = 'The settlement paid less than the quoted amount.'
  else if (e.callsHash && e.callsHash.toLowerCase() !== record.callsHash.toLowerCase()) problem = 'The settlement ran different destination calls.'
  return { settled: true, ok: !problem, ...(problem ? { problem } : {}), record }
}
