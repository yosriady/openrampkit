// HTTP client for the app's OpenRampKit server handler.

import { orkError } from '@openrampkit/core'
import type { OrkError, PlanResult, PublicSession, Quote } from '@openrampkit/core'

export type ClientOptions = {
  /** Base URL of the OpenRampKit server handler, e.g. `/api/openramp` or `https://ramp.example.workers.dev` */
  baseUrl: string
  fetch?: typeof fetch
}

export class OrkClientError extends Error {
  constructor(readonly error: OrkError, readonly status: number) {
    super(error.message)
  }
}

/**
 * Map anything thrown by the client, the controller or a wallet to an `OrkError`.
 * Accepts `OrkClientError`, objects that carry an `OrkError` in `.error` (like core's `OrkException`),
 * plain `OrkError` objects, `Error`s and other values.
 */
export function toOrkError(e: unknown): OrkError {
  if (e instanceof OrkClientError) return e.error
  if (isOrkError(e)) return e
  if (e && typeof e === 'object' && 'error' in e && isOrkError((e as { error: unknown }).error)) return (e as { error: OrkError }).error
  return orkError('INTERNAL', { message: e instanceof Error ? e.message : String(e) })
}

function isOrkError(v: unknown): v is OrkError {
  return !!v && typeof v === 'object' && typeof (v as OrkError).code === 'string' && typeof (v as OrkError).message === 'string'
}

/** Error for a non-OK response that has no `OrkError` body, for example an HTML 502 page from a proxy. */
function httpError(status: number): OrkError {
  if (status === 401 || status === 403) return orkError('UNAUTHORIZED')
  if (status === 404) return orkError('NOT_FOUND')
  if (status === 429) return orkError('RATE_LIMITED')
  if (status >= 500) return orkError('PROVIDER_UNAVAILABLE', { message: 'The deposit service is not available right now.' })
  return orkError('INTERNAL')
}

export function createOpenRampClient(opts: ClientOptions) {
  const f = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const base = opts.baseUrl.replace(/\/$/, '')

  async function call<T>(secret: string, method: 'GET' | 'POST', path: string, body?: unknown, idem?: string): Promise<T> {
    const res = await f(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${secret}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(idem ? { 'idempotency-key': idem } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const text = await res.text()
    let json: { error?: OrkError } | undefined
    try {
      json = text ? JSON.parse(text) : {}
    } catch {
      json = undefined
    }
    if (!res.ok) throw new OrkClientError(isOrkError(json?.error) ? json.error : httpError(res.status), res.status)
    if (json === undefined) throw new OrkClientError(orkError('INTERNAL', { message: 'The server sent a response that is not valid.' }), res.status)
    return json as T
  }

  const sessionId = (secret: string) => secret.split('.')[0]!

  return {
    baseUrl: base,
    getSession: (secret: string) => call<PublicSession>(secret, 'GET', `/sessions/${sessionId(secret)}`),
    plan: (secret: string, body: { walletConnected: boolean; walletAddress?: string; surfaces?: string[] }) =>
      call<PlanResult>(secret, 'POST', `/sessions/${sessionId(secret)}/plan`, body),
    quotes: (secret: string, body: { method: string; amount: string; amountSide: 'source' | 'destination'; source?: { chain: string; token: string } }) =>
      call<{ quotes: Quote[]; errors: OrkError[] }>(secret, 'POST', `/sessions/${sessionId(secret)}/quotes`, body),
    select: (secret: string, body: { quoteId: string; walletAddress?: string }) =>
      call<PublicSession>(secret, 'POST', `/sessions/${sessionId(secret)}/select`, body, idemKey()),
    transition: (secret: string, name: string, inputs?: Record<string, unknown>) =>
      call<PublicSession>(secret, 'POST', `/sessions/${sessionId(secret)}/transitions/${encodeURIComponent(name)}`, { inputs: inputs ?? {} }, idemKey()),
    step: (secret: string) => call<PublicSession>(secret, 'GET', `/sessions/${sessionId(secret)}/step`),
  }
}

export type OpenRampClient = ReturnType<typeof createOpenRampClient>

function idemKey(): string {
  const b = new Uint8Array(12)
  crypto.getRandomValues(b)
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}
