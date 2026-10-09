// WebCrypto only, so the server runs on Node 20+, Bun, Deno and Cloudflare Workers.

import { timingSafeEqual } from '@openrampkit/core'

const enc = new TextEncoder()

export function randomHex(bytes = 16): string {
  const b = new Uint8Array(bytes)
  crypto.getRandomValues(b)
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}

export async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))
  return [...d].map((x) => x.toString(16).padStart(2, '0')).join('')
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)))
  return [...sig].map((x) => x.toString(16).padStart(2, '0')).join('')
}

/** Constant-time string compare (`timingSafeEqual` from core). Server modules import it from here, so tests can watch it. */
export const safeEqual: (a: string, b: string) => boolean = timingSafeEqual

/** Sign an outbound webhook: HMAC-SHA256 over `id.timestamp.body`. */
export async function signWebhook(secret: string, id: string, timestamp: number, body: string): Promise<string> {
  return `v1=${await hmacHex(secret, `${id}.${timestamp}.${body}`)}`
}

/** Verify an OpenRampKit webhook on the app side. */
export async function verifyWebhook(
  secret: string,
  headers: { get(name: string): string | null },
  body: string,
  toleranceSec = 300,
): Promise<boolean> {
  const id = headers.get('openramp-id')
  const ts = Number(headers.get('openramp-timestamp'))
  const sig = headers.get('openramp-signature')
  if (!id || !ts || !sig) return false
  if (Math.abs(Date.now() / 1000 - ts) > toleranceSec) return false
  return safeEqual(sig, await signWebhook(secret, id, ts, body))
}
