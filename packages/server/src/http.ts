import type { OrkError } from '@openrampkit/core'
import { IDEMPOTENCY_TTL_SEC } from './config.js'
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

/** Replay the stored response for a repeated `Idempotency-Key` within the same session. */
export async function withIdempotency(rt: Runtime, sessionId: string, req: Request, run: () => Promise<Response>): Promise<Response> {
  const key = req.headers.get('idempotency-key')
  if (!key) return run()
  const k = `idem:${sessionId}:${key}`
  const hit = await rt.store.kv.get<{ status: number; body: string }>(k)
  if (hit) return new Response(hit.body, { status: hit.status, headers: { 'content-type': 'application/json', 'idempotent-replay': 'true' } })
  const res = await run()
  await rt.store.kv.put(k, { status: res.status, body: await res.clone().text() }, IDEMPOTENCY_TTL_SEC)
  return res
}

export async function readJson<T>(req: Request, fallback?: T): Promise<T> {
  try {
    return (await req.json()) as T
  } catch {
    if (fallback !== undefined) return fallback
    throw new SyntaxError('Request body must be JSON')
  }
}
