// An agent-like loop over MCP. It asks for methods and quotes, creates a deposit session, shows the
// pay link to "the person", and waits until the payment completes. Mock provider: no money moves.
//
//   node agent.mjs           a script plays the person (pays with VietQR through the pay link)
//   node agent.mjs --serve   you play the person: open the pay link in a browser or on a phone

import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mockAdapter } from '@openrampkit/adapter-mock'
import { createOpenRampMcpServer } from '@openrampkit/mcp'
import { createOpenRamp } from '@openrampkit/server'

const SERVE = process.argv.includes('--serve')
const PORT = Number(process.env.PORT ?? 8788)
const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, '')
const BASE = `${PUBLIC_URL}/api/openramp`
const quiet = { debug() {}, info() {}, warn() {}, error() {} }

// 1. The OpenRampKit server (in process). The pay page loads the web component from this process.
const ramp = createOpenRamp({
  secret: process.env.OPENRAMP_SECRET ?? 'dev-secret-dev-secret-dev-secret-dev-secret',
  baseUrl: BASE,
  adapters: [mockAdapter({ settleMs: 2000 })],
  payPage: { scriptUrl: '/openramp-web.js' },
  logger: quiet,
})

let server
if (SERVE) {
  const bundle = await bundleWebComponent()
  server = createServer(async (req, res) => {
    if (req.url === '/openramp-web.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      return res.end(bundle)
    }
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = chunks.length ? Buffer.concat(chunks) : undefined
    const r = await ramp.handle(new Request(`${PUBLIC_URL}${req.url}`, { method: req.method, headers: req.headers, ...(body && req.method !== 'GET' ? { body } : {}) }))
    res.writeHead(r.status, Object.fromEntries(r.headers))
    res.end(Buffer.from(await r.arrayBuffer()))
  }).listen(PORT)
}

// 2. The MCP server with guardrails. The agent can fund only "treasury", with at most 2,000,000 VND per session.
const mcp = createOpenRampMcpServer({
  connection: { openramp: ramp },
  deposit: {
    destinations: [
      { name: 'treasury', description: 'Agent wallet on Base', chain: 'eip155:8453', token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', address: '0x000000000000000000000000000000000000beef', symbol: 'USDC', decimals: 6 },
    ],
  },
  maxAmounts: { VND: '2000000', USDC: '50' },
  pollIntervalMs: 1000,
})

// 3. The agent: an MCP client. A real agent (Claude) picks these tool calls itself.
const [a, b] = InMemoryTransport.createLinkedPair()
const agent = new Client({ name: 'example-agent', version: '1.0.0' })
await Promise.all([mcp.connect(a), agent.connect(b)])

async function tool(name, args) {
  const r = await agent.callTool({ name, arguments: args })
  const data = JSON.parse(r.content[0].text)
  console.log(`\n> ${name} ${JSON.stringify(args)}\n${JSON.stringify(data, null, 2)}`)
  if (r.isError) throw new Error(data.error.message)
  return data
}

const { tools } = await agent.listTools()
console.log('Tools:', tools.map((t) => t.name).join(', '))

await tool('list_payment_methods', { country: 'VN' })
await tool('get_quotes', { country: 'VN', amount: '500000', method: 'vietqr' })
const session = await tool('create_deposit_session', { country: 'VN', max_amount: '1000000', reference: 'agent-demo-1' })

console.log(`\nAgent: "Please open this link and pay with VietQR: ${session.pay_url}"`)
if (SERVE) console.log('Open the link, pick VietQR, enter an amount, then press "Simulate payment (test mode)".')
else await personPays(session.pay_url)

for (;;) {
  const s = await tool('wait_for_completion', { session_id: session.session_id, timeout_seconds: 60 })
  if (s.done) {
    console.log(`\nAgent: "Done. Status ${s.status}: you paid ${s.paid}, the wallet got ${s.received}."`)
    break
  }
}
await agent.close()
server?.close()

/** The person, as a script: open the pay link, then pay with VietQR (the mock's test button stands in for the bank app). */
async function personPays(payUrl) {
  const page = await ramp.handle(new Request(payUrl))
  console.log(`\nPerson opens the pay link: HTTP ${page.status}, ${page.headers.get('content-type')}`)
  const credential = payUrl.slice(`${BASE}/pay/`.length)
  const id = credential.split('.')[0]
  const call = async (path, body) => {
    const r = await ramp.handle(new Request(`${BASE}/sessions/${id}${path}`, { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${await r.text()}`)
    return r.json()
  }
  await call('/plan', {})
  const { quotes } = await call('/quotes', { method: 'vietqr', amount: '500000' })
  const s = await call('/select', { quoteId: quotes[0].id })
  console.log(`Person sees a VietQR code for ${s.step.surface.amount} ${s.step.surface.currency} and pays in the bank app.`)
  await call('/transitions/simulate_payment', {})
}

/** One ES module with the web component and its dependencies, served same-origin for the pay page. */
async function bundleWebComponent() {
  const esbuild = await import('esbuild')
  const entry = createRequire(import.meta.url).resolve('@openrampkit/web')
  const out = await esbuild.build({ entryPoints: [entry.replace(/index\.cjs$/, 'index.js')], bundle: true, format: 'esm', write: false, minify: true, platform: 'browser' })
  return out.outputFiles[0].text
}
