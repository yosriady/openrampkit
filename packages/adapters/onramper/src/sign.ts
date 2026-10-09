// Onramper "Signature V2" (https://docs.onramper.com/docs/api-sign-requests-v2):
// Ed25519 over a canonical string, sent in x-onramper-signature / -timestamp / -nonce headers.
// Web-standard only: WebCrypto Ed25519, atob/btoa, TextEncoder.

import { bytesToBase64, bytesToHex } from '@openrampkit/adapter'

const enc = new TextEncoder()

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, ''))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** PKCS#8 prefix for an Ed25519 private key (RFC 8410): wraps a 32-byte seed */
const PKCS8_ED25519_PREFIX = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]

/**
 * Import an Ed25519 private key for signing. Accepts a PKCS#8 PEM ("-----BEGIN PRIVATE KEY-----", what
 * Onramper's docs use), base64 PKCS#8 DER, or a base64 / hex 32-byte seed.
 */
export async function importEd25519Key(key: string): Promise<CryptoKey> {
  const k = key.trim()
  let der: Uint8Array<ArrayBuffer>
  if (k.includes('-----BEGIN')) {
    der = b64ToBytes(k.replace(/-----(BEGIN|END)[^-]+-----/g, ''))
  } else if (/^[0-9a-fA-F]{64}$/.test(k)) {
    der = new Uint8Array(k.match(/../g)!.map((h) => parseInt(h, 16)))
  } else {
    der = b64ToBytes(k)
  }
  if (der.length === 32) der = new Uint8Array([...PKCS8_ED25519_PREFIX, ...der])
  return crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign'])
}

/** base64 Ed25519 signature of `message` */
export async function ed25519Sign(key: CryptoKey, message: string | Uint8Array): Promise<string> {
  const data = typeof message === 'string' ? enc.encode(message) : new Uint8Array(message)
  return bytesToBase64(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, data)))
}

export async function sha256Hex(s: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest('SHA-256', enc.encode(s)))
}

/**
 * RFC 8785 (JSON Canonicalization Scheme) for the JSON we send: object keys sorted by UTF-16 code units,
 * no whitespace, numbers and strings as ECMAScript JSON.stringify prints them.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('canonicalJson: non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

export type SignV2Input = {
  apiKey: string
  method: string
  /** Path without query, e.g. /checkout/v2/intent */
  path: string
  /** Query parameters (sorted before signing) */
  query?: URLSearchParams
  /** Canonical JSON body, when there is one */
  body?: string
  timestamp: string
  nonce: string
}

/**
 * The canonical string:
 *   ONRAMPER-SIG-V2 \n timestamp \n nonce \n METHOD \n path \n sorted query \n
 *   authorization:<apiKey> [\n content-type:application/json] \n sha256hex(body)
 */
export async function canonicalStringV2(i: SignV2Input): Promise<string> {
  const q = new URLSearchParams(i.query)
  q.sort()
  const headers = [`authorization:${i.apiKey}`, ...(i.body !== undefined ? ['content-type:application/json'] : [])].join('\n')
  return ['ONRAMPER-SIG-V2', i.timestamp, i.nonce, i.method.toUpperCase(), i.path, q.toString(), headers, await sha256Hex(i.body ?? '')].join('\n')
}

/** Headers for a Signature V2 request */
export async function signV2(key: CryptoKey, i: SignV2Input): Promise<Record<string, string>> {
  const sig = await ed25519Sign(key, await canonicalStringV2(i))
  return {
    authorization: i.apiKey,
    'x-onramper-signature': `v2:${sig}`,
    'x-onramper-timestamp': i.timestamp,
    'x-onramper-nonce': i.nonce,
  }
}
