// One real settlement on a testnet through the TypeScript client, the same path as the
// playground's testnet mode:
//
//   createOpenRamp (memory store) + the mock adapter's settlement leg (`localChain` + destination
//   `settlement`) -> plan -> quote -> select -> WALLET_TX (approve + settle from buildSettlementTxs)
//   -> the wallet signs and sends -> submit_tx -> the server checks with verifySettlement.
//
// It pays 5 test stablecoins (no value) from the deployer key for a fresh session id, then checks the
// session again with verifySettlement and prints the transaction links.
//
// Networks (NETWORK):
// - arbitrum-sepolia (default): Circle test USDC.
// - tempo-testnet: AlphaUSD, a TIP-20 test stablecoin from the Tempo faucet. Tempo has no gas token.
//   The transactions are plain EIP-1559 transactions, as a browser wallet sends them, and Tempo takes
//   the fee in pathUSD (the default fee token).
//
// Reads DEPLOYER_PRIVATE_KEY from the environment or from contracts/.env (or DEPLOYER_ENV_FILE).
// Never prints the key. Testnet only.
//
// Run: pnpm testnet:settle            (builds the packages first)
//      RECIPIENT=0x... AMOUNT=5 pnpm testnet:settle
//      NETWORK=tempo-testnet pnpm testnet:settle

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { verifySettlement } from '../packages/adapter/dist/index.js'
import { mockAdapter } from '../packages/adapters/mock/dist/index.js'
import { createOpenRampClient } from '../packages/client/dist/index.js'
import { createOpenRamp, memoryStore } from '../packages/server/dist/index.js'

// viem comes from the playground's dependencies (the root package has none).
const req = createRequire(new URL('../examples/playground/package.json', import.meta.url))
const { createPublicClient, createWalletClient, http } = await import(req.resolve('viem'))
const { privateKeyToAccount } = await import(req.resolve('viem/accounts'))
const { arbitrumSepolia } = await import(req.resolve('viem/chains'))

const NETWORKS = {
  'arbitrum-sepolia': {
    viemChain: arbitrumSepolia,
    rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
    token: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', // Circle test USDC, 6 decimals
    symbol: 'USDC',
    faucet: 'https://faucet.circle.com/',
    explorers: [
      ['Arbiscan', 'https://sepolia.arbiscan.io'],
      ['Blockscout', 'https://arbitrum-sepolia.blockscout.com'],
    ],
  },
  'tempo-testnet': {
    // A plain chain definition (no Tempo transaction type), so the transactions are standard EIP-1559.
    viemChain: { id: 42431, name: 'Tempo Testnet', nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.moderato.tempo.xyz'] } } },
    rpcUrl: 'https://rpc.moderato.tempo.xyz',
    token: '0x20c0000000000000000000000000000000000001', // AlphaUSD, TIP-20, 6 decimals
    symbol: 'AlphaUSD',
    faucet: 'https://docs.tempo.xyz/quickstart/faucet',
    explorers: [['Tempo Explorer', 'https://explore.testnet.tempo.xyz']],
  },
}
const NET = NETWORKS[process.env.NETWORK ?? 'arbitrum-sepolia']
if (!NET) throw new Error(`NETWORK must be one of: ${Object.keys(NETWORKS).join(', ')}`)
const CHAIN = `eip155:${NET.viemChain.id}`
const RPC_URL = process.env.RPC_URL ?? NET.rpcUrl
const SETTLEMENT = '0x12196D55b9009145c9CBAe7e256f3d32F9e27Af5'
const USDC = NET.token
const SYMBOL = NET.symbol
const AMOUNT = process.env.AMOUNT ?? '5'
const BASE_URL = 'https://testnet-settle.openrampkit.invalid/api/openramp'

function readKey() {
  if (process.env.DEPLOYER_PRIVATE_KEY) return process.env.DEPLOYER_PRIVATE_KEY
  const file = process.env.DEPLOYER_ENV_FILE ?? new URL('../contracts/.env', import.meta.url)
  const line = readFileSync(file, 'utf8').split('\n').find((l) => l.trim().startsWith('DEPLOYER_PRIVATE_KEY='))
  if (!line) throw new Error('DEPLOYER_PRIVATE_KEY is not set')
  return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')
}

const rawKey = readKey()
const account = privateKeyToAccount(rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`)
const recipient = process.env.RECIPIENT ?? account.address
const wallet = createWalletClient({ account, chain: NET.viemChain, transport: http(RPC_URL) })
const pub = createPublicClient({ chain: NET.viemChain, transport: http(RPC_URL) })
console.log(`Payer      ${account.address}`)
console.log(`Recipient  ${recipient}`)

// The server, as in the playground's testnet mode: one wallet leg for the test token on the network.
const quiet = { debug() {}, info() {}, warn: (m) => console.warn(`[openramp] ${m}`), error: (m) => console.error(`[openramp] ${m}`) }
const ramp = createOpenRamp({
  secret: crypto.getRandomValues(new Uint8Array(24)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), ''),
  baseUrl: BASE_URL,
  store: memoryStore(),
  adapters: [
    mockAdapter({
      id: `testnet-${process.env.NETWORK ?? 'arbitrum-sepolia'}`,
      name: `${NET.viemChain.name} wallet`,
      settleMs: 0,
      methods: ['wallet'],
      localChain: { chain: CHAIN, rpcUrl: RPC_URL, token: USDC, symbol: SYMBOL, decimals: 6 },
    }),
  ],
  logger: quiet,
})
const client = createOpenRampClient({ baseUrl: BASE_URL, fetch: (input, init) => ramp.handle(new Request(input, init)) })

const { id: sessionId, clientSecret } = await ramp.sessions.create({
  userId: 'testnet-settle-script',
  country: 'US',
  allowedMethods: ['wallet'],
  destination: { type: 'crypto', chain: CHAIN, token: USDC, symbol: SYMBOL, decimals: 6, address: recipient, settlement: { contract: SETTLEMENT } },
})
console.log(`Session    ${sessionId}`)

await client.plan(clientSecret, { walletConnected: true, walletAddress: account.address })
const q = await client.quotes(clientSecret, { method: 'wallet', amount: AMOUNT, amountSide: 'source', source: { chain: CHAIN, token: USDC } })
if (!q.quotes.length) throw new Error(`No quote: ${q.errors.map((e) => e.message).join('; ')}`)
const paying = await client.select(clientSecret, { quoteId: q.quotes[0].id, walletAddress: account.address })
const surface = paying.step.surface
if (surface?.kind !== 'WALLET_TX') throw new Error(`Expected a WALLET_TX step, got ${surface?.kind ?? paying.step.state}`)

const erc20 = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }]
const balance = await pub.readContract({ address: USDC, abi: erc20, functionName: 'balanceOf', args: [account.address] })
const amountBase = BigInt(Math.round(Number(AMOUNT) * 1e6))
if (balance < amountBase) throw new Error(`The payer has ${Number(balance) / 1e6} ${SYMBOL}, and this needs ${AMOUNT}. Get some at ${NET.faucet}`)

// The wallet step: approve, then settle. Each waits for its receipt.
let last
for (const [i, tx] of surface.txs.entries()) {
  const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, chain: NET.viemChain })
  const r = await pub.waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Error(`Transaction ${hash} failed`)
  console.log(`${i === 0 ? 'approve' : 'settle '}    ${hash}`)
  last = hash
}

// The server checks the session on chain (verifySettlement), as the playground does.
let session = await client.transition(clientSecret, 'submit_tx', { txHash: last })
for (let i = 0; i < 20 && session.step.state !== 'COMPLETED' && session.step.state !== 'FAILED'; i++) {
  await new Promise((r) => setTimeout(r, 1500))
  session = await client.getSession(clientSecret)
}
console.log(`Session    ${session.step.state}`)
if (session.step.state !== 'COMPLETED') throw new Error(session.step.error?.message ?? 'The session did not complete')

// And once more, directly.
const v = await verifySettlement({ rpcUrl: RPC_URL, contract: SETTLEMENT, sessionId, expect: { token: USDC, recipient, minAmount: amountBase }, fromBlock: Number(await pub.getBlockNumber()) - 5000 })
if (!v.settled || !v.ok) throw new Error(`verifySettlement: ${v.settled ? v.problem : 'not settled'}`)
console.log(`Verified   ${v.record.amount} base units of ${SYMBOL} from ${v.record.payer} to ${v.record.recipient}, block ${v.record.blockNumber}`)
for (const [name, url] of NET.explorers) console.log(`${name.padEnd(10)} ${url}/tx/${v.record.txHash}`)
