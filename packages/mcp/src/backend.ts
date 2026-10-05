// How the MCP server reaches an OpenRampKit server: over HTTP (base URL plus an app key that the
// server's `authorize` hook checks), or in-process (an `OpenRamp` instance from `createOpenRamp`).

import type { AllowedTargets, Destination, WithdrawSource, WithdrawTarget } from '@openrampkit/core'

/** The subset of `CreateSessionInput` (from `@openrampkit/server`) that the MCP server sends. */
export type SessionInput = {
  userId: string
  direction: 'deposit' | 'withdraw'
  destination?: Destination
  source?: WithdrawSource
  allowedTargets?: AllowedTargets
  /** Withdraw: the target, set at creation */
  target?: WithdrawTarget
  /** Withdraw with `target`: nobody can change the target later */
  lockTarget?: boolean
  country?: string
  locale?: string
  amountBounds?: { min?: string; max?: string; currency: string }
  allowedMethods?: string[]
  metadata?: Record<string, string>
  ttlMinutes?: number
}

export type CreatedSession = { id: string; clientSecret: string; expiresAt: string }

/** The parts of an `OpenRamp` instance the MCP server uses. `createOpenRamp(...)` returns one. */
export type InProcessOpenRamp = {
  handle(req: Request): Promise<Response>
  sessions: { create(input: SessionInput): Promise<CreatedSession> }
}

export type Connection =
  | {
      /** Public base URL of the OpenRampKit server, e.g. `https://ramp.example.workers.dev` */
      baseUrl: string
      /** Key that the server's `authorize` hook checks before `POST /sessions` */
      appKey: string
      /** Header that carries `appKey`. Default `x-app-key`. */
      appKeyHeader?: string
      fetch?: typeof fetch
    }
  | { openramp: InProcessOpenRamp }

/** An error from the OpenRampKit server, with its `OrkError` code. */
export class RampError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'RampError'
  }
}

export type Backend = {
  create(input: SessionInput): Promise<CreatedSession>
  /** Call a session route with the session's client secret. `path` starts with `/sessions/`. */
  call<T>(clientSecret: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T>
}

const INTERNAL_BASE = 'http://openramp.internal'

export function createBackend(conn: Connection): Backend {
  if ('openramp' in conn) {
    const ramp = conn.openramp
    return {
      create: (input) => ramp.sessions.create(input),
      call: (secret, method, path, body) => send((req) => ramp.handle(req), INTERNAL_BASE, secret, method, path, body),
    }
  }
  const base = conn.baseUrl.replace(/\/$/, '')
  const doFetch = conn.fetch ?? ((req: Request) => fetch(req))
  const f = (req: Request) =>
    doFetch(req).catch(() => {
      throw new RampError('SERVER_UNREACHABLE', 'The OpenRampKit server did not answer. Try again later.', 503)
    })
  return {
    async create(input) {
      const req = new Request(`${base}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [conn.appKeyHeader ?? 'x-app-key']: conn.appKey },
        body: JSON.stringify(input),
      })
      return parse<CreatedSession>(await f(req))
    },
    call: (secret, method, path, body) => send(f, base, secret, method, path, body),
  }
}

async function send<T>(f: (req: Request) => Promise<Response>, base: string, secret: string, method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${secret}` }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (method === 'POST') headers['idempotency-key'] = crypto.randomUUID()
  const req = new Request(`${base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  return parse<T>(await f(req))
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text()
  let data: unknown
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = undefined
  }
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string } } | undefined)?.error
    throw new RampError(e?.code ?? 'HTTP_ERROR', e?.message ?? `The OpenRampKit server answered HTTP ${res.status}.`, res.status)
  }
  if (data === undefined) throw new RampError('BAD_RESPONSE', 'The OpenRampKit server did not answer with JSON.', res.status)
  return data as T
}
