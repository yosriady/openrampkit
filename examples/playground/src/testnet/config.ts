// Testnet mode: the networks, contracts and tokens that the playground can pay with for real.
// All of them are public testnet contracts. Nothing here is secret.

export type TestnetToken = {
  /** Key in the URL and the token select */
  key: string
  /** Label in the token select */
  label: string
  address: string
  /** Shown in the widget and in balances */
  symbol: string
  decimals: number
  /** The token has an open `mint(address,uint256)` (a test token with no value) */
  mint?: boolean
  /** Where to get the token when it has no open mint */
  faucet?: string
  /** An ERC-4626 vault for this token that the settlement contract allows as a call target */
  vault?: string
}

export type TestnetExplorer = { name: string; url: string }

export type TestnetNetwork = {
  /** Key in the URL and the network select */
  key: string
  chainId: number
  name: string
  rpcUrl: string
  /** The OpenRampSettlement contract */
  settlement: string
  /** Block explorers, for transaction links */
  explorers: TestnetExplorer[]
  /** Where to get test ETH for gas */
  gasFaucet?: string
  tokens: TestnetToken[]
}

const SETTLEMENT = '0xBF66696115128B8f9f794780061348b4213A7132'
/** Test USDC with an open mint (no value), the same address on both testnets */
const TEST_TOKEN = '0x9A38C55160186C3E1e770e193fA96997e60ed425'
/** Test ERC-4626 vault over the test token, allowlisted as a call target on both deployments */
const TEST_VAULT = '0xA83fE1B79cEd7772f5d90D19833b2fDD844c7801'

const testToken: TestnetToken = {
  key: 'test',
  label: 'Test token (free, mint in one click)',
  address: TEST_TOKEN,
  symbol: 'tUSDC',
  decimals: 6,
  mint: true,
  vault: TEST_VAULT,
}

export const DEFAULT_NETWORKS: TestnetNetwork[] = [
  {
    key: 'arbitrum-sepolia',
    chainId: 421614,
    name: 'Arbitrum Sepolia',
    rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
    settlement: SETTLEMENT,
    explorers: [
      { name: 'Arbiscan', url: 'https://sepolia.arbiscan.io' },
      { name: 'Blockscout', url: 'https://arbitrum-sepolia.blockscout.com' },
    ],
    gasFaucet: 'https://www.alchemy.com/faucets/arbitrum-sepolia',
    tokens: [
      testToken,
      {
        key: 'usdc',
        label: 'Circle test USDC',
        address: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
        symbol: 'USDC',
        decimals: 6,
        faucet: 'https://faucet.circle.com/',
      },
    ],
  },
  {
    key: 'robinhood-testnet',
    chainId: 46630,
    name: 'Robinhood Chain Testnet',
    rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
    settlement: SETTLEMENT,
    explorers: [{ name: 'Blockscout', url: 'https://explorer.testnet.chain.robinhood.com' }],
    tokens: [testToken],
  },
]

declare global {
  interface Window {
    /**
     * Test only: replace the testnet networks, for example with a local Anvil chain in the
     * Playwright tests. The page reads it once at startup.
     */
    __OPENRAMP_TESTNET__?: { networks: TestnetNetwork[] }
  }
}

/** The networks of this page: the public testnets, or the test override when one is set. */
export function testnetNetworks(): TestnetNetwork[] {
  const o = typeof window !== 'undefined' ? window.__OPENRAMP_TESTNET__ : undefined
  return o?.networks?.length ? o.networks : DEFAULT_NETWORKS
}

/** The banner text of testnet mode */
export function testnetBanner(network: TestnetNetwork): string {
  return `Testnet: real transactions on ${network.name}, test tokens with no value.`
}

/** Transaction links on every explorer of the network */
export function txLinks(network: TestnetNetwork, hash: string): Array<{ name: string; href: string }> {
  return network.explorers.map((e) => ({ name: e.name, href: `${e.url.replace(/\/+$/, '')}/tx/${hash}` }))
}
