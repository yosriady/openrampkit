// SHA256withRSA (RSASSA-PKCS1-v1_5 with SHA-256) request signing with WebCrypto only.
//
// Binance Pay Onchain (Binance Connect) signs requests and webhooks with RSA keys:
// - the partner signs API requests with its private key (PKCS#8, base64 or PEM),
// - Binance signs webhooks with its private key; the partner verifies with Binance's public key
//   (X.509 SubjectPublicKeyInfo, base64 or PEM).
// Source: https://developers.binance.com/en/docs/products/connect-2.0/basics/3.request-signing (2026-10-05)
//
// The key parsing and the signature check are shared (`@openrampkit/adapter`). Only Binance signs, so
// the signing stays here.

import { bytesToBase64, rsaKeyDer } from '@openrampkit/adapter'

export { importRsaPublicKey, rsaKeyDer as keyDer, rsaVerify } from '@openrampkit/adapter'

const enc = new TextEncoder()
const ALG = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const

export function importRsaPrivateKey(key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', rsaKeyDer(key, 'private'), ALG, false, ['sign'])
}

/** base64(SHA256withRSA(message)) */
export async function rsaSign(key: CryptoKey, message: string): Promise<string> {
  const sig = await crypto.subtle.sign(ALG, key, enc.encode(message))
  return bytesToBase64(new Uint8Array(sig))
}
