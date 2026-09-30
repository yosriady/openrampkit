import { OrkException, orkError } from '@openrampkit/core'
import type { OrkError } from '@openrampkit/core'
import { IDEMPOTENCY_TTL_SEC, MAX_JSON_BODY_BYTES } from './config.js'
import type { Runtime } from './runtime.js'

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

export const errorResponse = (e: OrkError, status: number) => json({ error: e }, status)

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

/**
 * Replay the stored response for a repeated `Idempotency-Key` within the same session and route.
 * `scope` names the route (e.g. `select`), so one key cannot replay the answer of another route.
 */
export async function withIdempotency(rt: Runtime, sessionId: string, scope: string, req: Request, run: () => Promise<Response>): Promise<Response> {
  const key = req.headers.get('idempotency-key')
  if (!key) return run()
  if (!IDEMPOTENCY_KEY.test(key)) throw new OrkException(orkError('BAD_REQUEST', { message: '`Idempotency-Key` must be 1 to 255 printable ASCII characters.' }), 400)
  const k = `idem:${sessionId}:${scope}:${key}`
  const hit = await rt.store.kv.get<{ status: number; body: string }>(k)
  if (hit) return new Response(hit.body, { status: hit.status, headers: { 'content-type': 'application/json', 'idempotent-replay': 'true' } })
  const res = await run()
  await rt.store.kv.put(k, { status: res.status, body: await res.clone().text() }, IDEMPOTENCY_TTL_SEC)
  return res
}

/**
 * Read the body as text, up to `max` bytes. A larger body gets a 413 before it is read in full:
 * the `Content-Length` header is checked first, then the bytes as they arrive.
 */
export async function readText(req: Request, max: number): Promise<string> {
  const tooLarge = () => new OrkException(orkError('BAD_REQUEST', { message: `The request body is larger than ${max} bytes.` }), 413)
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) throw tooLarge()
  if (!req.body) return ''
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
    throw new OrkException(orkError('BAD_REQUEST', { message: 'Request body must be JSON' }), 400)
  }
}
