// SHA256withRSA (RSASSA-PKCS1-v1_5 with SHA-256) signing and verification with WebCrypto only.
//
// Binance Pay Onchain (Binance Connect) signs requests and webhooks with RSA keys:
// - the partner signs API requests with its private key (PKCS#8, base64 or PEM),
// - Binance signs webhooks with its private key; the partner verifies with Binance's public key
//   (X.509 SubjectPublicKeyInfo, base64 or PEM).
// Source: https://developers.binance.com/en/docs/products/connect-2.0/basics/3.request-signing (2026-10-05)

const enc = new TextEncoder()
const ALG = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64.replace(/\s+/g, ''))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/**
 * DER bytes of a key given as PEM ("-----BEGIN PRIVATE KEY-----" / "-----BEGIN PUBLIC KEY-----")
 * or as bare base64. Escaped newlines (`\n` in an environment variable) are accepted.
 */
export function keyDer(key: string, kind: 'private' | 'public'): Uint8Array<ArrayBuffer> {
  const text = key.replace(/\\n/g, '\n').trim()
  const m = /-----BEGIN ([A-Z ]+)-----([\s\S]+?)-----END \1-----/.exec(text)
  if (!m) return base64ToBytes(text)
  const label = m[1]!
  const want = kind === 'private' ? 'PRIVATE KEY' : 'PUBLIC KEY'
  // "RSA PRIVATE KEY" (PKCS#1) and "RSA PUBLIC KEY" are not PKCS#8 / SPKI; WebCrypto cannot import them.
  if (label !== want) throw new Error(`Expected a PEM "${want}" (PKCS#8 / SPKI), got "${label}". Convert it with openssl pkcs8 -topk8 or openssl rsa -pubout.`)
  return base64ToBytes(m[2]!)
}

export function importRsaPrivateKey(key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', keyDer(key, 'private'), ALG, false, ['sign'])
}

export function importRsaPublicKey(key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('spki', keyDer(key, 'public'), ALG, false, ['verify'])
}

/** base64(SHA256withRSA(message)) */
export async function rsaSign(key: CryptoKey, message: string): Promise<string> {
  const sig = await crypto.subtle.sign(ALG, key, enc.encode(message))
  return bytesToBase64(new Uint8Array(sig))
}

/** Verify base64(SHA256withRSA(message)). False for a malformed signature. */
export async function rsaVerify(key: CryptoKey, message: string, signatureB64: string): Promise<boolean> {
  let sig: Uint8Array<ArrayBuffer>
  try {
    sig = base64ToBytes(signatureB64.trim())
  } catch {
    return false
  }
  try {
    return await crypto.subtle.verify(ALG, key, sig, enc.encode(message))
  } catch {
    return false
  }
}
