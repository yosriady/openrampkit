// Encrypt a Link OAuth token before it goes into the session store. AES-256-GCM with a key from
// HKDF-SHA256. The caller gives the additional data (the session, user, leg and customer), so a
// sealed token only opens for them.
// Web-standard APIs only (WebCrypto), so it runs on Cloudflare Workers.

import { base64ToBytes, bytesToBase64 } from '@openrampkit/adapter'

const VERSION = 'v1'
const enc = new TextEncoder()

/** An AES-256-GCM key from `secret` (HKDF-SHA256, fixed salt and info) */
export async function sealKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error('stripe-link: the token key is empty')
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('openrampkit'), info: enc.encode('stripe-link oauth token v1') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** `v1.<iv>.<ciphertext>` (base64). `aad` binds the value to one leg. */
export async function seal(key: CryptoKey, plain: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, enc.encode(plain)))
  return `${VERSION}.${bytesToBase64(iv)}.${bytesToBase64(ct)}`
}

/** The plain value, or undefined when the value is not ours, was changed, or belongs to another leg */
export async function unseal(key: CryptoKey, sealed: unknown, aad: string): Promise<string | undefined> {
  if (typeof sealed !== 'string') return undefined
  const [v, iv, ct] = sealed.split('.')
  if (v !== VERSION || !iv || !ct) return undefined
  try {
    const out = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(iv), additionalData: enc.encode(aad) }, key, base64ToBytes(ct))
    return new TextDecoder().decode(out)
  } catch {
    return undefined
  }
}
