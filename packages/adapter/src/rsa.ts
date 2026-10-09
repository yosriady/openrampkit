// RSA (RSASSA-PKCS1-v1_5 with SHA-256, also known as SHA256withRSA) key import and signature check,
// with WebCrypto only. Binance and Bridge sign webhooks this way.

import { base64ToBytes } from './util.js'

const enc = new TextEncoder()
const RSA_PKCS1_SHA256 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const

/**
 * DER bytes of an RSA key given as PEM ("-----BEGIN PRIVATE KEY-----" or "-----BEGIN PUBLIC KEY-----")
 * or as bare base64. Escaped newlines (`\n` in an environment variable) are accepted. A PKCS#1 PEM
 * ("RSA PRIVATE KEY", "RSA PUBLIC KEY") throws: WebCrypto imports PKCS#8 and SPKI only.
 */
export function rsaKeyDer(key: string, kind: 'private' | 'public'): Uint8Array<ArrayBuffer> {
  const text = key.replace(/\\n/g, '\n').trim()
  const m = /-----BEGIN ([A-Z ]+)-----([\s\S]+?)-----END \1-----/.exec(text)
  if (!m) return base64ToBytes(text)
  const label = m[1]!
  const want = kind === 'private' ? 'PRIVATE KEY' : 'PUBLIC KEY'
  if (label !== want) throw new Error(`Expected a PEM "${want}" (PKCS#8 / SPKI), got "${label}". Convert it with openssl pkcs8 -topk8 or openssl rsa -pubout.`)
  return base64ToBytes(m[2]!)
}

/** Import an RSA public key (SPKI, as PEM or base64) for RSASSA-PKCS1-v1_5 with SHA-256 */
export function importRsaPublicKey(key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('spki', rsaKeyDer(key, 'public'), RSA_PKCS1_SHA256, false, ['verify'])
}

/**
 * Check a base64 RSASSA-PKCS1-v1_5 SHA-256 signature of `data` (a string is UTF-8 encoded). WebCrypto
 * hashes `data` with SHA-256 first. `publicKey` is an SPKI key as PEM or base64 (imported on each call),
 * or a `CryptoKey` from `importRsaPublicKey` (import once, then reuse it). Returns false for a wrong or
 * malformed signature. Throws when the key string is not a valid public key.
 */
export async function rsaVerify(publicKey: string | CryptoKey, data: string | Uint8Array, signatureB64: string): Promise<boolean> {
  const key = typeof publicKey === 'string' ? await importRsaPublicKey(publicKey) : publicKey
  let sig: Uint8Array<ArrayBuffer>
  try {
    sig = base64ToBytes(signatureB64.trim())
  } catch {
    return false
  }
  try {
    return await crypto.subtle.verify(RSA_PKCS1_SHA256, key, sig, typeof data === 'string' ? enc.encode(data) : new Uint8Array(data))
  } catch {
    return false
  }
}
