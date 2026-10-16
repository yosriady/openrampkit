// Live check of the Relay adapter against the real Relay API with your key.
// Reads RELAY_API_KEY from the environment first, then from examples/next-demo/.env.local.
// Never prints the key. Moves no money. Without a key, it skips and exits 0.
// Run: pnpm live:relay (or node scripts/live-relay.mjs after a build)
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

// Writes a line to the GitHub Actions job summary, when the script runs in Actions.
function summary(line) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`)
}

function keyFromEnvFile() {
  const file = new URL('../examples/next-demo/.env.local', import.meta.url)
  if (!existsSync(file)) return undefined
  const env = Object.fromEntries(
    readFileSync(file, 'utf8')
      .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^["']|["']$/g, '')]),
  )
  return env.RELAY_API_KEY || undefined
}

const fromEnv = process.env.RELAY_API_KEY?.trim() || undefined
const apiKey = fromEnv ?? keyFromEnvFile()
if (!apiKey) {
  const msg = 'SKIP Relay live check: RELAY_API_KEY is not set. Set it in the environment or in examples/next-demo/.env.local. In GitHub Actions, add the RELAY_API_KEY repository secret.'
  console.log(msg)
  summary(`### Relay live check skipped\n\n${msg}`)
  process.exit(0)
}
console.log(`Using a Relay key from ${fromEnv ? 'the RELAY_API_KEY environment variable' : 'examples/next-demo/.env.local'}`)

// Load the built packages only after the key check, so the skip works without a build.
const { relay } = await import('../packages/adapters/relay/dist/index.js')
const { makeCtx } = await import('../packages/adapter/dist/testing.js')

const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const USDC_ARB = '0xaf88d065e77c8cc2239327c5edb3a432268e5831'
const DEST = '0x000000000000000000000000000000000000dEaD'
const a = relay({ apiKey })
const ctx = makeCtx({ fetch: (...args) => fetch(...args), destination: { type: 'crypto', chain: 'eip155:8453', token: USDC_BASE, address: DEST } })
const leg = (legId, fromLoc) => ({
  adapterId: 'relay', legId,
  from: { asset: { kind: 'crypto', chain: 'eip155:42161', token: USDC_ARB }, location: { kind: fromLoc } },
  to: { asset: { kind: 'crypto', chain: 'eip155:8453', token: USDC_BASE }, location: { kind: 'address', address: DEST } },
})

let failed = 0
async function check(name, fn) {
  try {
    const r = await fn()
    console.log(`ok   ${name}${r ? `: ${r}` : ''}`)
  } catch (e) {
    failed++
    console.log(`FAIL ${name}: ${e?.error?.message ?? e?.message ?? e}`)
  }
}

await check('health (GET /chains)', async () => {
  const h = await a.health(ctx)
  if (!h.ok) throw new Error(h.detail ?? 'not ok')
})
await check('wallet quote 25 USDC Arbitrum to Base (with key)', async () => {
  const q = await a.quote({ leg: leg('wallet', 'user_wallet'), amountIn: { value: '25', asset: { kind: 'crypto', chain: 'eip155:42161', token: USDC_ARB } }, source: { chain: 'eip155:42161', token: USDC_ARB, address: DEST }, deliverTo: { address: DEST } }, ctx)
  return `receive ${q.output.value} USDC, fees ${q.fees.map((f) => `${f.amount} ${f.currency}`).join(' + ')}`
})
let depositAddress
await check('open deposit address (transfer leg)', async () => {
  const q = await a.quote({ leg: leg('transfer', 'user_wallet'), amountIn: { value: '0', asset: { kind: 'crypto', chain: 'eip155:42161', token: USDC_ARB } }, source: { chain: 'eip155:42161', token: USDC_ARB } }, ctx)
  const step = await a.start({ leg: leg('transfer', 'user_wallet'), quote: q }, ctx)
  depositAddress = step.surface?.address
  return `deposit address ${depositAddress}`
})
await check('deposit-address status via /requests/v3 (needs the key)', async () => {
  const s = await a.status({ leg: leg('transfer', 'user_wallet'), ref: depositAddress }, ctx)
  return `state ${s.state} (${s.status}); no deposit sent, so waiting is correct`
})
const result = failed ? `${failed} check(s) failed` : 'All Relay checks passed'
console.log(`\n${result}`)
summary(`### Relay live check\n\n${result}`)
process.exit(failed ? 1 : 0)
