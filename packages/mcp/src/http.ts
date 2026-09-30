// Streamable HTTP transport as a web-standard handler (Cloudflare Workers, Deno, Bun, Node 20+).
// Stateless: each request gets a fresh MCP server, and all of them share one set of ramp operations
// (so the session registry lives across requests).

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { OpenRampMcpConfig } from './config.js'
import { createRampOps } from './ramp.js'
import { createOpenRampMcpServer } from './server.js'

export type McpHttpOptions = {
  /** Required. Clients send `Authorization: Bearer <token>`. */
  bearerToken: string
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let r = 0
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return r === 0
}

/** A `(Request) => Promise<Response>` handler for the MCP Streamable HTTP transport. */
export function createMcpHttpHandler(config: OpenRampMcpConfig, opts: McpHttpOptions): (req: Request) => Promise<Response> {
  if (!opts.bearerToken || opts.bearerToken.length < 16) throw new Error('OpenRamp MCP: `bearerToken` must be at least 16 characters')
  const ops = createRampOps(config)
  const expected = `Bearer ${opts.bearerToken}`
  return async (req) => {
    if (!safeEqual(req.headers.get('authorization') ?? '', expected)) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null }), {
        status: 401,
        headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer' },
      })
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
