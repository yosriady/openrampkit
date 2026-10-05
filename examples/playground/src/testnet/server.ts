// Testnet mode: the same in-browser OpenRampKit server, with one test-only wallet leg per testnet
// token. The leg is the mock adapter's `localChain` leg: with a destination settlement contract it
// asks the wallet for `approve` + `settle` (buildSettlementTxs) and completes only when
// `verifySettlement` finds the session's receipt on chain, read from the public testnet RPC.
// On Solana devnet, the leg is the mock adapter's `solanaLocalChain` leg: one SPL transfer, checked
// with getSignatureStatuses + getTransaction on the devnet RPC.
// No Relay, no API keys, no secrets.

import { mockAdapter } from '@openrampkit/adapter-mock'
import type { CreateSessionInput } from '@openrampkit/server'
import { createPlaygroundServer } from '../server.js'
import { baseUnits, vaultDepositData } from './chain.js'
import type { SolanaDevnetConfig, TestnetNetwork, TestnetToken } from './config.js'

export const caip2 = (n: TestnetNetwork) => `eip155:${n.chainId}`

/** One wallet leg per network and token, so each session finds the leg of its token */
export function testnetAdapters(networks: TestnetNetwork[]) {
  return networks.flatMap((n) =>
    n.tokens.map((t) =>
      mockAdapter({
        id: `testnet-${n.key}-${t.key}`,
        name: `${n.name} wallet`,
        settleMs: 0,
        // Only the wallet leg: no mock card or cash legs in testnet mode.
        methods: ['wallet'],
        localChain: { chain: caip2(n), rpcUrl: n.rpcUrl, token: t.address, symbol: t.symbol, decimals: t.decimals },
      }),
    ),
  )
}

/**
 * The Solana devnet leg: the mock adapter's `solanaLocalChain` leg. It asks the wallet for one SPL
 * transfer of devnet USDC to the destination, and completes only when the devnet RPC shows it.
 */
export function solanaAdapter(cfg: SolanaDevnetConfig) {
  return mockAdapter({
    id: `testnet-${cfg.key}-usdc`,
    name: `${cfg.name} wallet`,
    settleMs: 0,
    methods: ['wallet'],
    solanaLocalChain: { chain: cfg.chain, rpcUrl: cfg.rpcUrl, mint: cfg.token.mint, symbol: cfg.token.symbol, decimals: cfg.token.decimals },
  })
}

export function createTestnetServer(networks: TestnetNetwork[], solana?: SolanaDevnetConfig) {
  const norm = (u: string) => {
    try {
      return new URL(u).href
    } catch {
      return u
    }
  }
  const rpcUrls = new Set([...networks.map((n) => norm(n.rpcUrl)), ...(solana ? [norm(solana.rpcUrl)] : [])])
  return createPlaygroundServer({
    adapters: [...testnetAdapters(networks), ...(solana ? [solanaAdapter(solana)] : [])],
    // The server reads the chain from the public RPC: the settlement receipt and the Settled log,
    // and on Solana devnet the signature status and the parsed transaction.
    passthrough: (url) => rpcUrls.has(norm(url)),
  })
}

export type TestnetSessionInput = {
  network: TestnetNetwork
  token: TestnetToken
  /** The connected wallet: it gets the tokens, or the vault shares */
  recipient: string
  /** Deposit into the token's test vault, for a fixed amount */
  vault?: { amount: string }
}

/** The session your backend would create: a settlement on the testnet, optionally into the vault. */
export function testnetSessionInput(i: TestnetSessionInput): CreateSessionInput {
  const vault = i.vault && i.token.vault ? i.token.vault : undefined
  return {
    userId: 'testnet-user',
    country: 'US',
    allowedMethods: ['wallet'],
    metadata: { source: 'playground-testnet' },
    destination: {
      type: 'crypto',
      chain: caip2(i.network),
      token: i.token.address,
      symbol: i.token.symbol,
      decimals: i.token.decimals,
      address: i.recipient,
      settlement: { contract: i.network.settlement },
      ...(vault && i.vault ? { calls: [{ to: vault, data: vaultDepositData(baseUnits(i.vault.amount, i.token.decimals), i.recipient) }] } : {}),
    },
    // The vault call deposits a fixed amount, so the payment must be that amount.
    ...(vault && i.vault ? { amountBounds: { min: i.vault.amount, max: i.vault.amount, currency: i.token.symbol } } : {}),
  }
}
