// A Solana devnet key for the proof settlement (pnpm solana:settle). Devnet only: the tokens have no value.
//
// - Creates examples/playground/.solana-devnet-key.json when it is missing (Solana CLI format: a JSON
//   array of 64 bytes, the secret seed then the public key). The file is in .gitignore.
// - Prints the public address and the devnet SOL and USDC balances. It never prints the secret.
// - With --airdrop: asks the public devnet RPC for devnet SOL (rate limited, so it tries a few times, with smaller amounts).
//
// Run: pnpm solana:key             (create the key, or show it)
//      pnpm solana:key --airdrop   (also ask for devnet SOL)
// Env: SOLANA_DEVNET_KEY_FILE (another key file), SOLANA_RPC_URL (another devnet RPC)

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'

const KEY_FILE = process.env.SOLANA_DEVNET_KEY_FILE ?? new URL('../examples/playground/.solana-devnet-key.json', import.meta.url)
const RPC_URL = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com'
const USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58(bytes) {
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  let out = ''
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out
    n /= 58n
  }
  for (const b of bytes) {
    if (b !== 0) break
    out = `1${out}`
  }
  return out
}

async function createKeyFile() {
  const kp = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const pkcs8 = new Uint8Array(await webcrypto.subtle.exportKey('pkcs8', kp.privateKey))
  const pub = new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey))
  // The Ed25519 PKCS#8 encoding ends with the 32-byte seed.
  const bytes = [...pkcs8.slice(-32), ...pub]
  writeFileSync(KEY_FILE, `${JSON.stringify(bytes)}\n`, { mode: 0o600 })
}

async function rpc(method, params) {
  const res = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const body = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }))
  if (body.error) throw new Error(`${method}: ${body.error.message ?? 'error'}`)
  return body.result
}

const created = !existsSync(KEY_FILE)
if (created) await createKeyFile()
const bytes = JSON.parse(readFileSync(KEY_FILE, 'utf8'))
if (!Array.isArray(bytes) || bytes.length !== 64) throw new Error('The key file must hold a JSON array of 64 bytes')
const address = base58(Uint8Array.from(bytes.slice(32)))
console.log(`${created ? 'Created' : 'Key file'}   ${typeof KEY_FILE === 'string' ? KEY_FILE : KEY_FILE.pathname}`)
console.log(`Address    ${address}`)

if (process.argv.includes('--airdrop')) {
  let done = false
  for (let i = 1; i <= 5 && !done; i++) {
    try {
      const sig = await rpc('requestAirdrop', [address, [1_000_000_000, 500_000_000, 500_000_000, 200_000_000, 200_000_000][i - 1], { commitment: 'confirmed' }])
      console.log(`Airdrop    ${sig}`)
      for (let j = 0; j < 30; j++) {
        const st = await rpc('getSignatureStatuses', [[sig]])
        const s = st.value[0]
        if (s?.err) throw new Error('the airdrop transaction failed')
        if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') break
        await new Promise((r) => setTimeout(r, 1000))
      }
      done = true
    } catch (e) {
      console.log(`Airdrop    try ${i} failed: ${e instanceof Error ? e.message : String(e)}`)
      if (i < 5) await new Promise((r) => setTimeout(r, 4000 * i))
    }
  }
  if (!done) console.log('Airdrop    the public faucet refused. Get devnet SOL at https://faucet.solana.com/')
}

const sol = await rpc('getBalance', [address, { commitment: 'confirmed' }])
const tokens = await rpc('getTokenAccountsByOwner', [address, { mint: USDC_MINT }, { encoding: 'jsonParsed', commitment: 'confirmed' }])
const usdc = tokens.value.reduce((s, v) => s + BigInt(v.account.data.parsed.info.tokenAmount.amount), 0n)
console.log(`SOL        ${Number(sol.value) / 1e9}`)
console.log(`USDC       ${Number(usdc) / 1e6}${tokens.value.length ? '' : ' (no token account yet)'}`)
if (!usdc) console.log('Get devnet USDC at https://faucet.circle.com/ (choose Solana Devnet) for the address above.')
