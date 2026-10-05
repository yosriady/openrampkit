// One real payment on Solana devnet through the TypeScript client, the same path as the playground's
// Solana devnet mode:
//
//   createOpenRamp (memory store) + the mock adapter's `solanaLocalChain` leg -> plan -> quote ->
//   select -> WALLET_TX (one SPL transfer to the destination) -> solanaWallet (@openrampkit/solana)
//   builds it, a Wallet Standard style signer signs it, the RPC sends it -> submit_tx -> the server
//   checks the signature on chain (getSignatureStatuses + getTransaction).
//
// Then it tries the same signature for a second session, which must fail ("already used").
//
// The payer pays itself back (destination = its own address), so no funds are lost. Devnet only.
// The key is examples/playground/.solana-devnet-key.json (create it with `pnpm solana:key`). It is in
// .gitignore. The script never prints the secret.
//
// Run: pnpm solana:settle                   (1 devnet USDC; needs devnet USDC and a little SOL)
//      TOKEN=sol pnpm solana:settle         (0.001 SOL to itself; needs devnet SOL only)
//      AMOUNT=2 SOLANA_RPC_URL=https://... pnpm solana:settle

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { SOLANA_DEVNET, SOLANA_DEVNET_USDC_MINT } from '../packages/core/dist/index.js'
import { mockAdapter } from '../packages/adapters/mock/dist/index.js'
import { createOpenRampClient } from '../packages/client/dist/index.js'
import { createOpenRamp, memoryStore } from '../packages/server/dist/index.js'
import { solanaWallet } from '../packages/solana/dist/index.js'

// @solana/kit comes from the Solana package's dependencies (the root package has none).
const req = createRequire(new URL('../packages/solana/package.json', import.meta.url))
const { createKeyPairFromBytes, getAddressFromPublicKey, getTransactionDecoder, getTransactionEncoder, signTransaction } = await import(req.resolve('@solana/kit'))

const KEY_FILE = process.env.SOLANA_DEVNET_KEY_FILE ?? new URL('../examples/playground/.solana-devnet-key.json', import.meta.url)
const RPC_URL = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com'
const NATIVE = (process.env.TOKEN ?? 'usdc').toLowerCase() === 'sol'
const MINT = NATIVE ? 'native' : SOLANA_DEVNET_USDC_MINT
const SYMBOL = NATIVE ? 'SOL' : 'USDC'
const DECIMALS = NATIVE ? 9 : 6
const AMOUNT = process.env.AMOUNT ?? (NATIVE ? '0.001' : '1')
const BASE_URL = 'https://solana-devnet-settle.openrampkit.invalid/api/openramp'
const explorer = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`

async function rpc(method, params) {
  const res = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const body = await res.json()
  if (body.error) throw new Error(`${method}: ${body.error.message}`)
  return body.result
}

let bytes
try {
  bytes = Uint8Array.from(JSON.parse(readFileSync(KEY_FILE, 'utf8')))
} catch {
  throw new Error('No devnet key. Run `pnpm solana:key` first.')
}
const keyPair = await createKeyPairFromBytes(bytes)
const payer = await getAddressFromPublicKey(keyPair.publicKey)
console.log(`Payer      ${payer} (pays itself back)`)
console.log(`Token      ${AMOUNT} ${SYMBOL}${NATIVE ? '' : ` (${MINT})`}`)

// Funds first, with plain messages.
const lamports = BigInt((await rpc('getBalance', [payer, { commitment: 'confirmed' }])).value)
console.log(`SOL        ${Number(lamports) / 1e9}`)
if (lamports < 1_000_000n + (NATIVE ? BigInt(Math.round(Number(AMOUNT) * 1e9)) : 0n)) {
  throw new Error(`Not enough devnet SOL for fees. Get devnet SOL for ${payer} at https://faucet.solana.com/`)
}
if (!NATIVE) {
  const tokens = await rpc('getTokenAccountsByOwner', [payer, { mint: MINT }, { encoding: 'jsonParsed', commitment: 'confirmed' }])
  const have = tokens.value.reduce((s, v) => s + BigInt(v.account.data.parsed.info.tokenAmount.amount), 0n)
  console.log(`USDC       ${Number(have) / 1e6}`)
  if (!tokens.value.length) throw new Error(`No devnet USDC token account. Get devnet USDC for ${payer} at https://faucet.circle.com/ (choose Solana Devnet). Or run with TOKEN=sol.`)
  if (have < BigInt(Math.round(Number(AMOUNT) * 1e6))) throw new Error(`Not enough devnet USDC. Get more at https://faucet.circle.com/ (choose Solana Devnet).`)
}

// A Wallet Standard style wallet over the local key: it signs only. solanaWallet then sends through the RPC.
const account = { address: payer, publicKey: new Uint8Array(32), chains: ['solana:devnet'], features: ['solana:signTransaction'] }
const signer = {
  version: '1.0.0',
  name: 'Local devnet key',
  icon: 'data:image/svg+xml;base64,AA==',
  chains: ['solana:devnet'],
  accounts: [account],
  features: {
    'solana:signTransaction': {
      version: '1.0.0',
      supportedTransactionVersions: ['legacy', 0],
      signTransaction: async (...inputs) =>
        Promise.all(
          inputs.map(async (i) => {
            const signed = await signTransaction([keyPair], getTransactionDecoder().decode(i.transaction))
            return { signedTransaction: new Uint8Array(getTransactionEncoder().encode(signed)) }
          }),
        ),
    },
  },
}
const wallet = solanaWallet({ wallet: signer, chain: SOLANA_DEVNET, rpcUrl: RPC_URL, waitForLast: true, confirmTimeoutMs: 90_000 })

// The server, as in the playground: one wallet leg for the token on Solana devnet.
const quiet = { debug() {}, info() {}, warn: (m) => console.warn(`[openramp] ${m}`), error: (m) => console.error(`[openramp] ${m}`) }
const ramp = createOpenRamp({
  secret: crypto.getRandomValues(new Uint8Array(24)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), ''),
  baseUrl: BASE_URL,
  store: memoryStore(),
  adapters: [
    mockAdapter({ id: 'testnet-solana-devnet', name: 'Solana Devnet wallet', settleMs: 0, methods: ['wallet'], solanaLocalChain: { chain: SOLANA_DEVNET, rpcUrl: RPC_URL, mint: MINT, symbol: SYMBOL, decimals: DECIMALS } }),
  ],
  logger: quiet,
})
const client = createOpenRampClient({ baseUrl: BASE_URL, fetch: (input, init) => ramp.handle(new Request(input, init)) })

async function startSession() {
  const { id, clientSecret } = await ramp.sessions.create({
    userId: 'solana-devnet-settle-script',
    country: 'US',
    allowedMethods: ['wallet'],
    destination: { type: 'crypto', chain: SOLANA_DEVNET, token: MINT, symbol: SYMBOL, decimals: DECIMALS, address: payer },
  })
  await client.plan(clientSecret, { walletConnected: true, walletAddress: payer })
  const q = await client.quotes(clientSecret, { method: 'wallet', amount: AMOUNT, amountSide: 'source', source: { chain: SOLANA_DEVNET, token: MINT } })
  if (!q.quotes.length) throw new Error(`No quote: ${q.errors.map((e) => e.message).join('; ')}`)
  const paying = await client.select(clientSecret, { quoteId: q.quotes[0].id, walletAddress: payer })
  const surface = paying.step.surface
  if (surface?.kind !== 'WALLET_TX') throw new Error(`Expected a WALLET_TX step, got ${surface?.kind ?? paying.step.state}`)
  return { id, clientSecret, surface }
}

const first = await startSession()
console.log(`Session    ${first.id}`)
const { hash: signature } = await wallet.sendTransactions(first.surface.chain, first.surface.txs)
console.log(`Signature  ${signature}`)

// The server checks the signature on chain, as the playground does.
let session = await client.transition(first.clientSecret, 'submit_tx', { txHash: signature })
for (let i = 0; i < 30 && session.step.state !== 'COMPLETED' && session.step.state !== 'FAILED'; i++) {
  await new Promise((r) => setTimeout(r, 2000))
  session = await client.getSession(first.clientSecret)
}
console.log(`Session    ${session.step.state}`)
if (session.step.state !== 'COMPLETED') throw new Error(session.step.error?.message ?? 'The session did not complete')
console.log(`Explorer   ${explorer(signature)}`)

// Replay: the same signature for a new session must fail.
const second = await startSession()
const replay = await client.transition(second.clientSecret, 'submit_tx', { txHash: signature })
console.log(`Replay     ${replay.step.state}: ${replay.step.error?.message ?? ''}`)
if (replay.step.state !== 'FAILED') throw new Error('The server accepted a used signature')
