// Streamable HTTP transport as a web-standard handler (Cloudflare Workers, Deno, Bun, Node 20+).
// Stateless: each request gets a fresh MCP server, and all of them share one set of ramp operations
// (so the session registry lives across requests).

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { timingSafeEqual } from '@openrampkit/core'
import type { OpenRampMcpConfig } from './config.js'
import { createRampOps } from './ramp.js'
import { createOpenRampMcpServer } from './server.js'

export type McpHttpOptions = {
  /** Required. Clients send `Authorization: Bearer <token>`. */
  bearerToken: string
  /** Largest request body, in bytes. Larger requests get HTTP 413. Default 1 MB. */
  maxBodyBytes?: number
}

/** Default body size limit for MCP requests (1 MB). */
export const MAX_BODY_BYTES = 1_000_000

/** A `(Request) => Promise<Response>` handler for the MCP Streamable HTTP transport. */
export function createMcpHttpHandler(config: OpenRampMcpConfig, opts: McpHttpOptions): (req: Request) => Promise<Response> {
  if (!opts.bearerToken || opts.bearerToken.length < 16) throw new Error('OpenRamp MCP: `bearerToken` must be at least 16 characters')
  const ops = createRampOps(config)
  const expected = `Bearer ${opts.bearerToken}`
  const maxBody = opts.maxBodyBytes ?? MAX_BODY_BYTES
  const rpcError = (status: number, code: number, message: string, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), { status, headers: { 'content-type': 'application/json', ...headers } })
  return async (req) => {
    if (!timingSafeEqual(req.headers.get('authorization') ?? '', expected)) return rpcError(401, -32001, 'Unauthorized', { 'www-authenticate': 'Bearer' })
    if (Number(req.headers.get('content-length') ?? 0) > maxBody) return rpcError(413, -32600, 'Request body too large')
    if (req.body) {
      // The length header can be missing or wrong: read the body with the limit.
      const body = await readLimited(req.body, maxBody)
      if (!body) return rpcError(413, -32600, 'Request body too large')
      req = new Request(req.url, { method: req.method, headers: req.headers, body, signal: req.signal })
    }
    const server = createOpenRampMcpServer(ops)
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await server.connect(transport)
    try {
      return await transport.handleRequest(req)
    } finally {
      // Stateless: the response is complete (JSON mode), so close this request's server.
      void server.close()
    }
  }
}

async function readLimited(stream: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const reader = stream.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      return undefined
    }
    parts.push(value)
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return out
}
