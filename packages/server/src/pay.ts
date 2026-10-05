// Hosted pay links: `GET {baseUrl}/pay/:credential` renders the web component for one session, so a
// person can open the link on a phone and pay. The credential is `{sessionId}.pay_{exp}_{linkId}_{sig}`:
// an HMAC over the session id, an expiry and a random link id, signed with `config.secret` like the
// start URLs. It works as a client secret for that session until it expires or the app revokes its
// link id (`sessions.revokePayLink`). It cannot mint or revoke links.

import { OrkException, orkError } from '@openrampkit/core'
import { PAY_LINK_GRACE_MS } from './config.js'
import { hmacHex, randomHex, safeEqual } from './crypto.js'
import { saveSession } from './outbox.js'
import type { Runtime } from './runtime.js'
import type { SessionRecord } from './store.js'

const PREFIX = 'pay_'
const DEFAULT_SCRIPT_URL = 'https://esm.sh/@openrampkit/web@0'

/** `id` identifies the link. Give it to `sessions.revokePayLink` to make the link stop working. */
export type PayLink = { id: string; url: string; expiresAt: string }

const LINK_ID = /^[0-9a-f]{16}$/
/** Most revoked link ids kept per session. This keeps the session record small. */
export const MAX_REVOKED_PAY_LINKS = 100

export const isPayCredential = (secret: string) => secret.startsWith(PREFIX)

async function paySignature(rt: Runtime, sessionId: string, exp: string, linkId: string): Promise<string> {
  // A different message shape from start URLs (`{id}.{token}`), so one signature never passes as the other.
  return (await hmacHex(rt.config.secret, `pay:${sessionId}:${exp}:${linkId}`)).slice(0, 32)
}

/** The parts of a pay credential secret (after the session id), or undefined when the shape is wrong. */
function parsePaySecret(secret: string): { exp: string; linkId: string; sig: string } | undefined {
  if (!isPayCredential(secret)) return undefined
  const [exp, linkId, sig, ...rest] = secret.slice(PREFIX.length).split('_')
  if (!exp || !linkId || !sig || rest.length || !/^[0-9a-z]{1,12}$/.test(exp) || !LINK_ID.test(linkId)) return undefined
  return { exp, linkId, sig }
}

/** True when `secret` is a pay credential whose link the app revoked. */
export function isRevokedPayLink(rec: SessionRecord, secret: string): boolean {
  const linkId = parsePaySecret(secret)?.linkId
  return !!linkId && !!rec.revokedPayLinks?.includes(linkId)
}

/** Add a link id to the revoked list of `rec`. Throws a 400 when the id is not valid or the list is full. */
export function revokeOn(rec: SessionRecord, linkId: unknown): void {
  if (typeof linkId !== 'string' || !LINK_ID.test(linkId)) throw new OrkException(orkError('BAD_REQUEST', { message: '`id` must be a pay link id.' }), 400)
  const list = rec.revokedPayLinks ?? []
  if (list.includes(linkId)) return
  if (list.length >= MAX_REVOKED_PAY_LINKS) throw new OrkException(orkError('BAD_REQUEST', { message: 'Too many revoked pay links for this session.' }), 400)
  rec.revokedPayLinks = [...list, linkId]
}

/**
 * Make one pay link stop working, with a retry on a concurrent change. Returns false when the session
 * does not exist. A link of another session, or a link id that was never made, changes nothing.
 */
export async function revokePayLink(rt: Runtime, sessionId: string, linkId: string): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    const rec = await rt.store.get(sessionId)
    if (!rec) return false
    if (rec.revokedPayLinks?.includes(linkId)) return true
    revokeOn(rec, linkId)
    try {
      await saveSession(rt, rec)
      return true
    } catch (e) {
      if (!(e instanceof OrkException && e.status === 409) || attempt >= 4) throw e
    }
  }
}

/**
 * Make a pay link for a session. It expires after `ttlMinutes`, and never later than the session
 * expiry plus a grace period (so a payment in progress can finish on the page).
 */
export async function createPayLink(rt: Runtime, rec: SessionRecord, ttlMinutes?: number): Promise<PayLink> {
  if (rt.config.payPage === false) throw new OrkException(orkError('NOT_FOUND'), 404)
  const max = rec.expiresAt + PAY_LINK_GRACE_MS
  const wanted = ttlMinutes !== undefined && Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? Date.now() + ttlMinutes * 60_000 : max
  const exp = Math.floor(Math.min(wanted, max) / 1000).toString(36)
  const linkId = randomHex(8)
  const credential = `${rec.id}.${PREFIX}${exp}_${linkId}_${await paySignature(rt, rec.id, exp, linkId)}`
  return { id: linkId, url: `${rt.base}/pay/${credential}`, expiresAt: new Date(parseInt(exp, 36) * 1000).toISOString() }
}

/** Check the secret part of a pay credential. */
export async function checkPayCredential(rt: Runtime, sessionId: string, secret: string): Promise<'ok' | 'expired' | 'invalid'> {
  const parts = parsePaySecret(secret)
  if (rt.config.payPage === false || !parts) return 'invalid'
  const { exp, linkId, sig } = parts
  if (!safeEqual(sig, await paySignature(rt, sessionId, exp, linkId))) return 'invalid'
  return parseInt(exp, 36) * 1000 < Date.now() ? 'expired' : 'ok'
}

const text = (body: string, status: number) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } })

/** GET /pay/:credential: a small HTML page that mounts `<openramp-modal>` for the session. */
export async function payRoute(rt: Runtime, credential: string): Promise<Response> {
  if (rt.config.payPage === false) return text('Not found.', 404)
  const dot = credential.indexOf('.')
  const sid = credential.slice(0, dot)
  const secret = credential.slice(dot + 1)
  if (dot < 1) return text('This link is not valid.', 401)
  const check = await checkPayCredential(rt, sid, secret)
  if (check === 'invalid') return text('This link is not valid.', 401)
  if (check === 'expired') return text('This link expired. Ask for a new link.', 410)
  const rec = await rt.store.get(sid)
  if (!rec) return text('This payment no longer exists.', 404)
  if (isRevokedPayLink(rec, secret)) return text('This link no longer works. Ask for a new link.', 410)

  const opts = rt.config.payPage || {}
  const scriptUrl = new URL(opts.scriptUrl ?? DEFAULT_SCRIPT_URL, rt.base)
  const self = new URL(rt.base).origin
  const scriptSrc = scriptUrl.origin === self ? "'self'" : `'self' ${scriptUrl.origin}`
  const nonce = randomHex(16)
  const data = { baseUrl: rt.base, clientSecret: credential, direction: rec.direction, scriptUrl: scriptUrl.href, ...(rec.locale ? { locale: rec.locale } : {}) }
  const title = escapeHtml(opts.title ?? (rec.direction === 'withdraw' ? 'Receive funds' : 'Pay'))
  const html = `<!doctype html>
<html lang="${escapeHtml(rec.locale ?? 'en')}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${title}</title>
<style>body{margin:0;min-height:100vh;display:flex;justify-content:center;align-items:flex-start;padding:24px 16px;box-sizing:border-box;background:#f4f5f7;font-family:system-ui,sans-serif}#openramp{width:100%;max-width:440px}@media(prefers-color-scheme:dark){body{background:#111318;color:#e8e8ea}}</style>
</head><body><main id="openramp"><noscript>Turn on JavaScript to continue.</noscript></main>
<script type="application/json" id="openramp-pay">${jsonForHtml(data)}</script>
<script type="module" nonce="${nonce}">
const cfg = JSON.parse(document.getElementById('openramp-pay').textContent)
const root = document.getElementById('openramp')
try {
  const m = await import(cfg.scriptUrl)
  const open = cfg.direction === 'withdraw' ? m.openWithdraw : m.openDeposit
  open({ baseUrl: cfg.baseUrl, clientSecret: cfg.clientSecret, embedded: true, container: root, ...(cfg.locale ? { locale: cfg.locale } : {}) })
} catch (e) {
  root.textContent = 'The payment page could not load. Check your connection and try again.'
}
</script></body></html>`
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' ${scriptSrc}`,
    `connect-src 'self' ${scriptUrl.origin}`,
    "style-src 'unsafe-inline'",
    'img-src data: https:',
    'font-src data: https:',
    'frame-src https:',
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'content-security-policy': csp,
    },
  })
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

/** JSON that is safe inside a `<script>` element. */
function jsonForHtml(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}
