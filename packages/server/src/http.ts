import { OpenRampException, openRampError } from '@openrampkit/core'
import type { OpenRampError } from '@openrampkit/core'
import { IDEMPOTENCY_TTL_SEC, MAX_JSON_BODY_BYTES } from './config.js'
import { sha256Hex } from './crypto.js'
import type { Runtime } from './runtime.js'

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

export const errorResponse = (e: OpenRampError, status: number) => json({ error: e }, status)

export function corsHeaders(rt: Runtime, req: Request): Record<string, string> {
  const origin = req.headers.get('origin')
  const allowed = rt.config.cors?.origins
  if (!origin || !allowed) return {}
  if (allowed !== '*' && !allowed.includes(origin)) return {}
  return {
    'access-control-allow-origin': allowed === '*' ? '*' : origin,
    'access-control-allow-headers': 'authorization, content-type, idempotency-key',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-max-age': '600',
    vary: 'origin',
  }
}

export function withCors(res: Response, cors: Record<string, string>): Response {
  if (!Object.keys(cors).length) return res
  const h = new Headers(res.headers)
  for (const [k, v] of Object.entries(cors)) h.set(k, v)
  return new Response(res.body, { status: res.status, headers: h })
}

/** Country and region from the config hook, else Cloudflare or Vercel geo headers. */
export function geoOf(rt: Runtime, req: Request): { country?: string; region?: string } {
  if (rt.config.geo) return rt.config.geo(req) ?? {}
  const country = req.headers.get('cf-ipcountry') ?? req.headers.get('x-vercel-ip-country') ?? undefined
  const r = req.headers.get('x-vercel-ip-country-region')
  return { ...(country && country !== 'XX' ? { country } : {}), ...(country && r ? { region: `${country}-${r}` } : {}) }
}

export function clientIp(req: Request): string | undefined {
  const h = req.headers
  return h.get('cf-connecting-ip') ?? h.get('x-real-ip') ?? h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? undefined
}

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/

/** What the store keeps for one `Idempotency-Key` */
type IdemEntry = { status?: number; body?: string; hash?: string; pending?: true }

/** How long a request with a key holds it before its answer is stored */
const IDEMPOTENCY_PENDING_SEC = 60

/**
 * `Idempotency-Key` on a POST. The first request with a key runs and its answer is stored for 24 hours,
 * with a hash of the request body. A repeat with the same body gets the stored answer (header
 * `idempotent-replay: true`). A repeat with another body gets `422 IDEMPOTENCY_MISMATCH`. A repeat
 * while the first request still runs gets `409 CONFLICT` (retryable). `scopeId` and `scope` name the
 * caller and the route (e.g. a session id and `select`), so one key cannot replay the answer of another
 * route or session. A request that throws stores nothing: the key is free again.
 */
export async function withIdempotency(rt: Runtime, scopeId: string, scope: string, req: Request, run: () => Promise<Response>): Promise<Response> {
  const key = req.headers.get('idempotency-key')
  if (!key) return run()
  if (!IDEMPOTENCY_KEY.test(key)) throw new OpenRampException(openRampError('BAD_REQUEST', { message: '`Idempotency-Key` must be 1 to 255 printable ASCII characters.' }), 400)
  const body = await readText(req.clone(), MAX_JSON_BODY_BYTES)
  const hash = (await sha256Hex(`${req.method} ${scope}\n${body}`)).slice(0, 32)
  const k = `idem:${scopeId}:${scope}:${key}`
  const kv = rt.store.kv
  const answer = (hit: IdemEntry): Response => {
    // Entries from earlier versions have no hash: they replay as before.
    if (hit.hash !== undefined && hit.hash !== hash) return errorResponse(openRampError('IDEMPOTENCY_MISMATCH', { message: 'This Idempotency-Key was used with another request body. Use a new key for a new request.' }), 422)
    if (hit.pending) return errorResponse(openRampError('CONFLICT', { message: 'A request with this Idempotency-Key is still running. Try again later.' }), 409)
    return new Response(hit.body ?? '', { status: hit.status ?? 200, headers: { 'content-type': 'application/json', 'idempotent-replay': 'true' } })
  }
  const hit = await kv.get<IdemEntry | null>(k)
  if (hit) return answer(hit)
  const pending: IdemEntry = { pending: true, hash }
  if (kv.putIfAbsent) {
    if (!(await kv.putIfAbsent(k, pending, IDEMPOTENCY_PENDING_SEC))) {
      const other = await kv.get<IdemEntry | null>(k)
      if (other) return answer(other)
    }
  } else {
    await kv.put(k, pending, IDEMPOTENCY_PENDING_SEC)
  }
  let res: Response
  try {
    res = await run()
  } catch (e) {
    await kv.put(k, null, 1)
    throw e
  }
  await kv.put(k, { status: res.status, body: await res.clone().text(), hash } satisfies IdemEntry, IDEMPOTENCY_TTL_SEC)
  return res
}

/**
 * Read the body as text, up to `max` bytes. A larger body gets a 413 before it is read in full:
 * the `Content-Length` header is checked first, then the bytes as they arrive.
 */
export async function readText(req: Request, max: number): Promise<string> {
  const tooLarge = () => new OpenRampException(openRampError('BAD_REQUEST', { message: `The request body is larger than ${max} bytes.` }), 413)
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) throw tooLarge()
  if (req.body === null) return ''
  if (req.body === undefined) {
    // Firefox has no `Request.body` stream (for example for the playground's in-page server): read it whole.
    const text = await req.text()
    if (new TextEncoder().encode(text).byteLength > max) throw tooLarge()
    return text
  }
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      throw tooLarge()
    }
    chunks.push(value)
  }
  const all = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.byteLength
  }
  return new TextDecoder().decode(all)
}

export async function readJson<T>(req: Request, fallback?: T): Promise<T> {
  const text = await readText(req, MAX_JSON_BODY_BYTES)
  try {
    return JSON.parse(text) as T
  } catch {
    if (fallback !== undefined) return fallback
    throw new OpenRampException(openRampError('BAD_REQUEST', { message: 'Request body must be JSON' }), 400)
  }
}
