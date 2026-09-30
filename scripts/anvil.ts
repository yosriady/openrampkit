// Start a local Anvil chain for manual tests: chain id 31337, no fork, a mock USDC (6 decimals)
// deployed and minted to Anvil's default dev account 0. Prints the RPC URL and the token address,
// then runs until you press Ctrl+C. Test keys and test tokens only.
//
//   pnpm chain:local                  # a free port
//   pnpm chain:local -- --port 8545   # a fixed port
//
// Needs Foundry (`anvil` on PATH) and Node 22.18 or later (it runs this TypeScript file directly).

import { ANVIL_ACCOUNT, ANVIL_CHAIN, hasAnvil, startTestChain } from '../packages/wagmi/src/testchain.ts'

if (!hasAnvil()) {
  console.error('anvil is not on PATH. Install Foundry: https://book.getfoundry.sh/getting-started/installation')
  process.exit(1)
}

const i = process.argv.indexOf('--port')
const port = i > 0 ? Number(process.argv[i + 1]) : undefined
const chain = await startTestChain({ mintTo: ANVIL_ACCOUNT, mintAmount: 1_000_000n * 1_000_000n, ...(port ? { port } : {}) })

console.log(JSON.stringify({ chain: ANVIL_CHAIN, rpcUrl: chain.rpcUrl, usdc: chain.usdc, account: ANVIL_ACCOUNT, minted: '1000000 USDC' }, null, 2))
console.log('Anvil is running. Press Ctrl+C to stop.')

const stop = async () => {
  await chain.stop()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
setInterval(() => {}, 1 << 30)
