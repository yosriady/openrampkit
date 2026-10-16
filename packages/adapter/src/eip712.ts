// EIP-712 hashing and secp256k1 signer recovery. The curve and keccak256 come from the audited
// @noble/curves and @noble/hashes; this file only encodes the EIP-712 data.
// The server uses it to check a wallet signature (gas abstraction) before it sends it to a provider.

import { secp256k1 } from '@noble/curves/secp256k1'
import { keccak_256 } from '@noble/hashes/sha3'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'
import type { TypedDataRequest } from '@openrampkit/core'
import { hexToBytes } from './keccak.js'

/** keccak256 of bytes, or of the UTF-8 bytes of a string, as 0x-prefixed lower-case hex */
const keccak256 = (data: Uint8Array | string): string => `0x${bytesToHex(keccak_256(typeof data === 'string' ? utf8ToBytes(data) : data))}`

type Field = { name: string; type: string }
type Types = Record<string, Field[]>

const DOMAIN_FIELDS: Field[] = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
  { name: 'salt', type: 'bytes32' },
]

const word = (v: bigint) => v.toString(16).padStart(64, '0')

function toBigInt(v: unknown, type: string): bigint {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v)
  if (typeof v === 'string' && /^-?(0x[0-9a-fA-F]+|\d+)$/.test(v.trim())) {
    const t = v.trim()
    return t.startsWith('-') ? -BigInt(t.slice(1)) : BigInt(t)
  }
  throw new Error(`EIP-712: not a ${type} value`)
}

function baseType(type: string): string {
  const i = type.indexOf('[')
  return i < 0 ? type : type.slice(0, i)
}

/** The struct types that `primary` uses, `primary` first and the others sorted by name */
function dependencies(primary: string, types: Types, found = new Set<string>()): Set<string> {
  if (found.has(primary) || !types[primary]) return found
  found.add(primary)
  for (const f of types[primary]!) dependencies(baseType(f.type), types, found)
  return found
}

function encodeType(primary: string, types: Types): string {
  const [first, ...rest] = [...dependencies(primary, types)]
  return [first!, ...rest.sort()].map((t) => `${t}(${types[t]!.map((f) => `${f.type} ${f.name}`).join(',')})`).join('')
}

/** The 32-byte encoding of one value (hex, no 0x) */
function encodeValue(type: string, value: unknown, types: Types): string {
  if (type.endsWith(']')) {
    const inner = type.slice(0, type.lastIndexOf('['))
    if (!Array.isArray(value)) throw new Error(`EIP-712: ${type} needs an array`)
    return keccak256(hexToBytes(value.map((v) => encodeValue(inner, v, types)).join(''))).slice(2)
  }
  if (types[type]) return hashStruct(type, (value ?? {}) as Record<string, unknown>, types).slice(2)
  if (type === 'string') return keccak256(String(value ?? '')).slice(2)
  if (type === 'bytes') return keccak256(hexToBytes(String(value ?? '0x'))).slice(2)
  if (type === 'bool') return word(value === true || value === 'true' ? 1n : 0n)
  if (type === 'address') {
    const a = String(value ?? '')
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error('EIP-712: not an address')
    return a.slice(2).toLowerCase().padStart(64, '0')
  }
  const int = /^(u?)int(\d*)$/.exec(type)
  if (int) {
    const v = toBigInt(value, type)
    const bits = BigInt(int[2] || '256')
    if (int[1] === 'u' ? v < 0n || v >= 1n << bits : v < -(1n << (bits - 1n)) || v >= 1n << (bits - 1n)) throw new Error(`EIP-712: ${type} out of range`)
    return word(v < 0n ? (1n << 256n) + v : v)
  }
  const fixed = /^bytes(\d+)$/.exec(type)
  if (fixed) {
    const b = String(value ?? '').replace(/^0x/, '')
    if (b.length !== Number(fixed[1]) * 2 || !/^[0-9a-fA-F]*$/.test(b)) throw new Error(`EIP-712: not a ${type} value`)
    return b.toLowerCase().padEnd(64, '0')
  }
  throw new Error(`EIP-712: unknown type ${type}`)
}

function hashStruct(primary: string, data: Record<string, unknown>, types: Types): string {
  const fields = types[primary]
  if (!fields) throw new Error(`EIP-712: unknown type ${primary}`)
  const typeHash = keccak256(encodeType(primary, types)).slice(2)
  return keccak256(hexToBytes(typeHash + fields.map((f) => encodeValue(f.type, data[f.name], types)).join('')))
}

/** The EIP-712 digest of typed data: keccak256(0x1901 || domainSeparator || hashStruct(message)) */
export function hashTypedData(data: TypedDataRequest): string {
  const domain = data.domain as Record<string, unknown>
  const domainFields = (data.types as Types).EIP712Domain ?? DOMAIN_FIELDS.filter((f) => domain[f.name] !== undefined)
  const types: Types = { ...(data.types as Types), EIP712Domain: domainFields }
  const separator = hashStruct('EIP712Domain', domain, types).slice(2)
  return keccak256(hexToBytes(`1901${separator}${hashStruct(data.primaryType, data.message, types).slice(2)}`))
}

// ---------------- signer recovery ----------------

/**
 * The address that signed `digest` (a 32-byte hex hash), from a 65-byte `r || s || v` signature
 * (`v` 27/28 or 0/1). Undefined when the signature is not valid.
 */
export function recoverAddress(digest: string, signature: string): string | undefined {
  const sig = signature.replace(/^0x/, '')
  if (!/^[0-9a-fA-F]{130}$/.test(sig) || !/^0x[0-9a-fA-F]{64}$/.test(digest)) return undefined
  let v = parseInt(sig.slice(128, 130), 16)
  if (v >= 27) v -= 27
  if (v > 1) return undefined
  try {
    const point = secp256k1.Signature.fromCompact(sig.slice(0, 128)).addRecoveryBit(v).recoverPublicKey(digest.slice(2))
    // The address: the last 20 bytes of keccak256 of the uncompressed key without its 0x04 prefix.
    return `0x${keccak256(point.toRawBytes(false).slice(1)).slice(-40)}`
  } catch {
    return undefined
  }
}

/** The address that signed EIP-712 typed data, or undefined when the signature or the data is not valid */
export function recoverTypedDataSigner(data: TypedDataRequest, signature: string): string | undefined {
  try {
    return recoverAddress(hashTypedData(data), signature)
  } catch {
    return undefined
  }
}
