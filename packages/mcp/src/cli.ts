#!/usr/bin/env node
// openrampkit-mcp: run the OpenRampKit MCP server over stdio (default) or Streamable HTTP (--http).
//
//   OPENRAMP_URL        Base URL of your OpenRampKit server
//   OPENRAMP_APP_KEY    Key your server's `authorize` hook checks (header x-app-key)
//   OPENRAMP_MCP_CONFIG Path to a JSON file with the guardrails (deposit, withdraw, maxAmounts, ...)
//   MCP_HTTP_TOKEN      --http only: bearer token that MCP clients must send
//   PORT                --http only: port (default 3333)
//   HOST                --http only: interface to listen on (default 127.0.0.1). Set 0.0.0.0 only behind TLS.
//
// Payouts: the CLI cannot run an `approve` hook, so it needs bound targets (`withdraw.targets`)
// unless the config file sets `withdraw.requireBoundTarget` to false.

import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { OpenRampMcpConfig } from './config.js'
import { createMcpHttpHandler, MAX_BODY_BYTES } from './http.js'
import { createOpenRampMcpServer } from './server.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}

function loadConfig(): OpenRampMcpConfig {
  const path = arg('config') ?? process.env.OPENRAMP_MCP_CONFIG
  if (!path) throw new Error('Set OPENRAMP_MCP_CONFIG (or --config) to a JSON file with the guardrails.')
  const file = JSON.parse(readFileSync(path, 'utf8')) as Omit<OpenRampMcpConfig, 'connection'> & { baseUrl?: string; appKeyHeader?: string }
  const baseUrl = process.env.OPENRAMP_URL ?? file.baseUrl
  const appKey = process.env.OPENRAMP_APP_KEY
  if (!baseUrl || !appKey) throw new Error('Set OPENRAMP_URL and OPENRAMP_APP_KEY.')
  const { baseUrl: _b, appKeyHeader, ...rest } = file
  if (rest.withdraw) {
    // Safe default: no pay link payouts. The file must opt out with `"requireBoundTarget": false`.
    if (rest.withdraw.requireBoundTarget === undefined) {
      if (!rest.withdraw.targets?.length) {
        throw new Error('Payouts in the CLI need withdraw.targets (bound wallets). To allow pay link payouts, set withdraw.requireBoundTarget to false.')
      }
      rest.withdraw = { ...rest.withdraw, requireBoundTarget: true }
    }
    if (rest.withdraw.requireBoundTarget === false) {
      console.error('openrampkit-mcp: warning: withdraw.requireBoundTarget is false. Each payout pay link lets whoever opens it pick where the funds go.')
    }
    if (!rest.limits) console.error('openrampkit-mcp: warning: payouts are on with no `limits`. Set limits.maxTotalPerDay and limits.maxSessionsPerHour.')
  }
  return { ...rest, connection: { baseUrl, appKey, ...(appKeyHeader ? { appKeyHeader } : {}) } }
}

class TooLarge extends Error {}

async function toRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > MAX_BODY_BYTES) throw new TooLarge()
    chunks.push(c as Buffer)
  }
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
  const body = chunks.length && req.method !== 'GET' && req.method !== 'HEAD' ? Buffer.concat(chunks) : undefined
  return new Request(new URL(req.url ?? '/', origin), { method: req.method ?? 'GET', headers, ...(body ? { body } : {}) })
}

async function send(res: ServerResponse, r: Response) {
  res.writeHead(r.status, Object.fromEntries(r.headers))
  if (r.body) for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk)
  res.end()
}

async function main() {
  const config = loadConfig()
  if (process.argv.includes('--http')) {
    const token = process.env.MCP_HTTP_TOKEN
    if (!token) throw new Error('Set MCP_HTTP_TOKEN for --http.')
    const handler = createMcpHttpHandler(config, { bearerToken: token })
    const port = Number(arg('port') ?? process.env.PORT ?? 3333)
    const host = arg('host') ?? process.env.HOST ?? '127.0.0.1'
    createServer((req, res) => {
      if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) {
        res.writeHead(413, { connection: 'close' }).end()
        req.destroy()
        return
      }
      toRequest(req, `http://localhost:${port}`)
        .then(handler)
        .then((r) => send(res, r))
        .catch((e: unknown) => {
          res.statusCode = e instanceof TooLarge ? 413 : 500
          res.end()
          if (e instanceof TooLarge) req.destroy()
        })
    }).listen(port, host, () => console.error(`openrampkit-mcp: Streamable HTTP on http://${host.includes(':') ? `[${host}]` : host}:${port}/mcp`))
    return
  }
  const server = createOpenRampMcpServer(config)
  await server.connect(new StdioServerTransport())
  console.error('openrampkit-mcp: ready on stdio')
}

main().catch((e: unknown) => {
  console.error(`openrampkit-mcp: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
