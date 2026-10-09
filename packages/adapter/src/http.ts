// HTTP helpers for adapter authors: a JSON fetch with a timeout, and one mapping from
// failed provider calls to OrkException, so every adapter reports errors the same way.

import { OrkException, orkError } from '@openrampkit/core'
import type { Logger } from './index.js'

/** The error `fetchJson` throws. `status` is set for HTTP errors, `timeout` when the call timed out. */
export type HttpError = Error & { status?: number; body?: unknown; timeout?: boolean }

export type FetchJsonInit = RequestInit & { timeoutMs?: number }

export const DEFAULT_TIMEOUT_MS = 8000

export async function fetchJson<T>(f: typeof fetch, url: string, init: FetchJsonInit = {}): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, headers: extra, ...rest } = init
  const host = new URL(url).host
  const headers = new Headers({ accept: 'application/json', ...(rest.body ? { 'content-type': 'application/json' } : {}) })
  // Headers, arrays and plain objects are all accepted.
  new Headers(extra).forEach((v, k) => headers.set(k, v))
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    let res: Response
    try {
      res = await f(url, { ...rest, signal: ctrl.signal, headers: Object.fromEntries(headers) })
    } catch (e) {
      if (ctrl.signal.aborted) {
        throw Object.assign(new Error(`Timeout after ${timeoutMs} ms from ${host}`), { name: 'TimeoutError', timeout: true }) as HttpError
      }
      throw e
    }
    const text = await res.text()
    let body: unknown
    let parseError: unknown
    try {
      body = text ? JSON.parse(text) : undefined
    } catch (e) {
      // Error pages (HTML from a proxy, plain text) must not hide the HTTP status.
      parseError = e
    }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} from ${host}: ${text.slice(0, 300)}`) as HttpError
      err.status = res.status
      err.body = body
      throw err
    }
    if (parseError) {
      const err = new Error(`Invalid JSON from ${host}: ${text.slice(0, 100)}`) as HttpError
      err.status = res.status
      throw err
    }
    return body as T
  } finally {
    clearTimeout(timer)
  }
}

/** HTTP status of an error thrown by `fetchJson` (or any error with a numeric `status`). */
export function httpStatus(e: unknown): number | undefined {
  const s = (e as { status?: unknown } | undefined)?.status
  return typeof s === 'number' ? s : undefined
}

/** The provider's own error message from an error body, when it has one. */
export function providerMessage(e: unknown): string | undefined {
  const body = (e as { body?: unknown } | undefined)?.body
  if (!body || typeof body !== 'object') return undefined
  const b = body as { message?: unknown; errorMessage?: unknown; error?: unknown }
  const nested = b.error && typeof b.error === 'object' ? (b.error as { message?: unknown }).message : b.error
  for (const m of [b.message, b.errorMessage, nested]) if (typeof m === 'string' && m.trim()) return m.trim()
  return undefined
}

export type HttpErrorOptions = {
  /** What the call tried to do, for the 4xx fallback message: "price this amount" gives "Relay could not price this amount." */
  what?: string
  /** 4xx statuses that mean "no quote for this request". Default 400, 404, 409 and 422. Other 4xx are PROVIDER_UNAVAILABLE. */
  noQuoteStatuses?: number[]
  /**
   * Log for unexpected failures. 5xx, network errors and timeouts go to `warn`. A 401 or 403 (a setup
   * error) goes to `error`, or to `warn` when the logger has no `error`.
   */
  log?: Pick<Logger, 'warn'> & Partial<Pick<Logger, 'error'>>
  /** For a 401 or 403: what the operator must check, added to the error log (for example which key or allowlist) */
  setupHint?: string
}

const NO_QUOTE_STATUSES = [400, 404, 409, 422]
const SETUP_STATUSES = [401, 403]

/**
 * The error for a provider that refused our credentials or setup (401, 403). A retry cannot fix it, so it is
 * not retryable, and the user can choose another method. The user message is neutral: the operator gets the details.
 */
export function providerSetupError(provider: string): OrkException {
  return new OrkException(
    orkError('PROVIDER_UNAVAILABLE', { message: `${provider} is not set up for this app yet. Try another method.`, retryable: false, recovery: 'choose_other' }),
    502,
  )
}

/**
 * Map a failed provider call to an OrkException with a message that is safe to show:
 * - OrkException: returned as is
 * - 429: RATE_LIMITED (429)
 * - 400, 404, 409, 422: NO_QUOTES (422) with the provider's message when it gives one
 * - 401, 403 (our credentials or setup): PROVIDER_UNAVAILABLE (502), not retryable, recovery `choose_other`,
 *   with one error log for the operator that names the provider
 * - timeout: PROVIDER_UNAVAILABLE (504)
 * - other 4xx, 5xx, network errors: PROVIDER_UNAVAILABLE (502)
 */
export function httpErrorToOrk(e: unknown, provider: string, opts: HttpErrorOptions = {}): OrkException {
  if (e instanceof OrkException) return e
  const status = httpStatus(e)
  if (status === 429) return new OrkException(orkError('RATE_LIMITED'), 429)
  if (status !== undefined && (opts.noQuoteStatuses ?? NO_QUOTE_STATUSES).includes(status)) {
    const msg = providerMessage(e)
    const message = msg ? `${provider}: ${msg}`.slice(0, 200) : `${provider} could not ${opts.what ?? 'handle this request'}.`
    return new OrkException(orkError('NO_QUOTES', { message }), 422)
  }
  const detail = String((e as Error | undefined)?.message ?? e).slice(0, 300)
  if (status !== undefined && SETUP_STATUSES.includes(status)) {
    const log = opts.log?.error ?? opts.log?.warn
    const hint = opts.setupHint ?? 'Check the API key and secret, the environment (sandbox or production) and any IP or domain allowlist.'
    log?.call(opts.log, `${provider}: cannot ${opts.what ?? 'handle this request'}: the provider refused our credentials or setup (HTTP ${status}). This is a setup error, and a retry cannot fix it. ${hint}`, { status, error: detail })
    return providerSetupError(provider)
  }
  if ((e as HttpError | undefined)?.timeout) {
    opts.log?.warn(`${provider}: request timed out`, { error: detail })
    return new OrkException(orkError('PROVIDER_UNAVAILABLE', { message: `${provider} did not answer in time.` }), 504)
  }
  opts.log?.warn(`${provider}: request failed`, { status, error: detail })
  return new OrkException(orkError('PROVIDER_UNAVAILABLE', { message: `${provider} is not available right now.` }), 502)
}
