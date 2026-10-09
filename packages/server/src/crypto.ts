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

// ---------- Standard Webhooks (https://www.standardwebhooks.com) ----------

const SECRET_PREFIX = 'whsec_'

function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function toBase64(b: Uint8Array): string {
  let bin = ''
  for (const x of b) bin += String.fromCharCode(x)
  return btoa(bin)
}

/**
 * The HMAC key of a webhook secret. A Standard Webhooks secret (`whsec_` and base64) gives the decoded
 * bytes, as every Standard Webhooks library does. Another string is a raw secret: its UTF-8 bytes.
 */
export function webhookKey(secret: string): Uint8Array<ArrayBuffer> {
  if (!secret.startsWith(SECRET_PREFIX)) return enc.encode(secret)
  try {
    return fromBase64(secret.slice(SECRET_PREFIX.length))
  } catch {
    throw new Error('OpenRamp: a `whsec_` webhook secret must be base64 after the prefix')
  }
}

/** A new Standard Webhooks secret: `whsec_` and 32 random bytes in base64. */
export function generateWebhookSecret(): string {
  const b = new Uint8Array(32)
  crypto.getRandomValues(b)
  return `${SECRET_PREFIX}${toBase64(b)}`
}

/**
 * Sign an outbound webhook (Standard Webhooks): `v1,` and the base64 HMAC-SHA256 of
 * `{id}.{timestamp}.{body}`, with the key from `webhookKey(secret)`.
 */
export async function signWebhook(secret: string, id: string, timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', webhookKey(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${id}.${timestamp}.${body}`)))
  return `v1,${toBase64(sig)}`
}

/**
 * Verify a webhook from the OpenRampKit server on the app side (Standard Webhooks). It reads the
 * `webhook-id`, `webhook-timestamp` and `webhook-signature` headers, refuses a timestamp more than
 * `toleranceSec` from the clock, and accepts any of the space-separated `v1,` signatures. Use the raw
 * body text. Any Standard Webhooks library verifies these webhooks too.
 */
export async function verifyWebhook(
  secret: string,
  headers: { get(name: string): string | null },
  body: string,
  toleranceSec = 300,
): Promise<boolean> {
  const id = headers.get('webhook-id')
  const tsText = headers.get('webhook-timestamp')
  const sigs = headers.get('webhook-signature')
  if (!id || !tsText || !sigs || !/^\d{1,12}$/.test(tsText)) return false
  const ts = Number(tsText)
  if (Math.abs(Date.now() / 1000 - ts) > toleranceSec) return false
  let expected: string
  try {
    expected = await signWebhook(secret, id, ts, body)
  } catch {
    return false // a secret that is not valid
  }
  // Compare every one: no early exit that shows which one matched.
  let ok = false
  for (const s of sigs.split(' ')) if (s && safeEqual(s, expected)) ok = true
  return ok
}
