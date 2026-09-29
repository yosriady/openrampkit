// CDP API JWT (Bearer) signing with WebCrypto only. Matches @coinbase/cdp-sdk `generateJwt`:
//   header  { alg: 'EdDSA' | 'ES256', kid: apiKeyId, typ: 'JWT', nonce: 16 random bytes hex }
//   claims  { sub: apiKeyId, iss: 'cdp', uris: ['METHOD host/path'], iat, nbf, exp = now + 120 }
// Keys:
//   - Ed25519: base64 of 64 bytes (32-byte seed + 32-byte public key), the CDP default
//   - ES256:   PEM, either SEC1 ("BEGIN EC PRIVATE KEY", legacy CDP keys) or PKCS#8 ("BEGIN PRIVATE KEY")

const enc = new TextEncoder()

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64.replace(/\s+/g, ''))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

export function base64url(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? enc.encode(input) : input
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function derLength(n: number): Uint8Array<ArrayBuffer> {
  if (n < 0x80) return Uint8Array.of(n)
  const bytes: number[] = []
  while (n > 0) {
    bytes.unshift(n & 0xff)
    n >>= 8
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes)
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** Wrap a SEC1 ECPrivateKey (P-256) into PKCS#8 PrivateKeyInfo, which WebCrypto can import. */
export function sec1ToPkcs8(sec1: Uint8Array): Uint8Array<ArrayBuffer> {
  const version = Uint8Array.of(0x02, 0x01, 0x00)
  // SEQUENCE { OID id-ecPublicKey 1.2.840.10045.2.1, OID prime256v1 1.2.840.10045.3.1.7 }
  const algId = Uint8Array.of(0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07)
  const octet = concat(Uint8Array.of(0x04), derLength(sec1.length), sec1)
  const body = concat(version, algId, octet)
  return concat(Uint8Array.of(0x30), derLength(body.length), body)
}

function pemBody(pem: string): { label: string; der: Uint8Array<ArrayBuffer> } {
  const m = /-----BEGIN ([A-Z ]+)-----([\s\S]+?)-----END \1-----/.exec(pem)
  if (!m) throw new Error('Invalid PEM key')
  return { label: m[1]!, der: base64ToBytes(m[2]!) }
}

export type CdpKey = { alg: 'EdDSA' | 'ES256'; key: CryptoKey }

/** Import a CDP API key secret (Ed25519 base64 or EC PEM). */
export async function importCdpKey(secret: string): Promise<CdpKey> {
  // Keys copied from .env files often carry literal "\n"
  const s = secret.includes('\\n') ? secret.replace(/\\n/g, '\n') : secret
  if (s.includes('-----BEGIN')) {
    const { label, der } = pemBody(s)
    const pkcs8 = label === 'EC PRIVATE KEY' ? sec1ToPkcs8(der) : der
    const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
    return { alg: 'ES256', key }
  }
  const raw = base64ToBytes(s.trim())
  if (raw.length !== 64) throw new Error('Invalid CDP key: expected an EC PEM key or a base64 Ed25519 key (64 bytes)')
  const jwk = { kty: 'OKP', crv: 'Ed25519', d: base64url(raw.subarray(0, 32)), x: base64url(raw.subarray(32)) }
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['sign'])
  return { alg: 'EdDSA', key }
}

function nonceHex(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}

export async function cdpJwt(p: {
  apiKeyId: string
  key: CdpKey
  method: string
  host: string
  path: string
  expiresIn?: number
  now?: number
}): Promise<string> {
  const now = Math.floor((p.now ?? Date.now()) / 1000)
  const header = { alg: p.key.alg, kid: p.apiKeyId, typ: 'JWT', nonce: nonceHex() }
  const claims = { sub: p.apiKeyId, iss: 'cdp', uris: [`${p.method.toUpperCase()} ${p.host}${p.path}`], iat: now, nbf: now, exp: now + (p.expiresIn ?? 120) }
  const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`
  const algo = p.key.alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'Ed25519' }
  // WebCrypto ECDSA returns r||s (IEEE P1363), which is the JWS ES256 format.
  const sig = new Uint8Array(await crypto.subtle.sign(algo, p.key.key, enc.encode(input)))
  return `${input}.${base64url(sig)}`
}
