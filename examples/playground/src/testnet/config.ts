// Testnet mode: the networks, contracts and tokens that the playground can pay with for real.
// All of them are public testnet contracts. Nothing here is secret.

import { SOLANA_DEVNET, SOLANA_DEVNET_USDC_MINT } from '@openrampkit/core'

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
  /** Name of the faucet in the link text (default: Circle faucet) */
  faucetName?: string
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
  /**
   * Set when the network has no gas token and takes fees in a stablecoin (Tempo). The wallet shows
   * this symbol as the native currency, and error messages name it instead of test ETH.
   */
  feeToken?: { symbol: string; faucet: string }
  tokens: TestnetToken[]
}

const SETTLEMENT = '0xBF66696115128B8f9f794780061348b4213A7132'
/** Test USDC with an open mint (no value), the same address on every EVM testnet */
const TEST_TOKEN = '0x9A38C55160186C3E1e770e193fA96997e60ed425'
/** Test ERC-4626 vault over the test token, allowlisted as a call target on every deployment */
const TEST_VAULT = '0xA83fE1B79cEd7772f5d90D19833b2fDD844c7801'

/** The Tempo testnet faucet page (no sign-in). It sends pathUSD, AlphaUSD, BetaUSD and ThetaUSD. */
const TEMPO_FAUCET = 'https://docs.tempo.xyz/quickstart/faucet'

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
  {
    // Tempo Moderato. No gas token: Tempo takes the fee in pathUSD (the default fee token), so the
    // wallet needs some pathUSD. The Tempo faucet sends pathUSD and AlphaUSD.
    key: 'tempo-testnet',
    chainId: 42431,
    name: 'Tempo Testnet',
    rpcUrl: 'https://rpc.moderato.tempo.xyz',
    settlement: SETTLEMENT,
    explorers: [{ name: 'Tempo Explorer', url: 'https://explore.testnet.tempo.xyz' }],
    gasFaucet: TEMPO_FAUCET,
    feeToken: { symbol: 'pathUSD', faucet: TEMPO_FAUCET },
    tokens: [
      testToken,
      {
        key: 'alphausd',
        label: 'AlphaUSD (TIP-20, Tempo faucet)',
        address: '0x20c0000000000000000000000000000000000001',
        symbol: 'AlphaUSD',
        decimals: 6,
        faucet: TEMPO_FAUCET,
        faucetName: 'Tempo faucet',
      },
    ],
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

// ---------------- Solana devnet ----------------

/** Solana devnet in testnet mode: the visitor's Wallet Standard wallet pays devnet USDC to itself. */
export type SolanaDevnetConfig = {
  /** Key in the network select */
  key: string
  name: string
  /** CAIP-2 chain id */
  chain: string
  /** JSON-RPC URL: the wallet adapter reads balances and blockhashes, and the server checks the transfer */
  rpcUrl: string
  token: { mint: string; symbol: string; decimals: number; label: string; faucet: string }
  /** Where to get devnet SOL for fees */
  gasFaucet: string
  /** Solana Explorer, for transaction links */
  explorer: string
}

export const SOLANA_DEVNET_CONFIG: SolanaDevnetConfig = {
  key: 'solana-devnet',
  name: 'Solana Devnet',
  chain: SOLANA_DEVNET,
  rpcUrl: 'https://api.devnet.solana.com',
  token: { mint: SOLANA_DEVNET_USDC_MINT, symbol: 'USDC', decimals: 6, label: 'Devnet USDC (Circle faucet)', faucet: 'https://faucet.circle.com/' },
  gasFaucet: 'https://faucet.solana.com/',
  explorer: 'https://explorer.solana.com',
}

declare global {
  interface Window {
    /**
     * Test only: replace the Solana devnet settings (for example the RPC URL), or hide Solana with
     * `null`. The page reads it once at startup.
     */
    __OPENRAMP_SOLANA__?: Partial<SolanaDevnetConfig> | null
  }
}

/** The Solana devnet settings of this page, or undefined when a test hides Solana */
export function solanaDevnet(): SolanaDevnetConfig | undefined {
  const o = typeof window !== 'undefined' ? window.__OPENRAMP_SOLANA__ : undefined
  if (o === null) return undefined
  return { ...SOLANA_DEVNET_CONFIG, ...(o ?? {}) }
}

/** The banner text of Solana devnet mode */
export const DEVNET_BANNER = 'Devnet: real transactions on Solana devnet, test tokens with no value.'

/** The Solana Explorer link of a devnet transaction */
export function solanaTxLink(cfg: SolanaDevnetConfig, signature: string): string {
  return `${cfg.explorer.replace(/\/+$/, '')}/tx/${signature}?cluster=devnet`
}
