// Testnet mode: the visitor's browser wallet (EIP-1193, e.g. MetaMask or Rabby) through wagmi's
// injected connector. Reads go to the public testnet RPC; writes go through the wallet.

import { connect, createConfig, disconnect, getAccount, http, injected, sendTransaction, switchChain, waitForTransactionReceipt, watchAccount } from '@wagmi/core'
import type { Config } from '@wagmi/core'
import { defineChain } from 'viem'
import type { Chain } from 'viem'
import { evmRpc } from '@openrampkit/adapter'
import { wagmiWallet } from '@openrampkit/wagmi'
import type { WalletAdapter } from '@openrampkit/core'
import { balanceOfData, friendlyWalletError, guardWallet, isSettledData, mintData } from './chain.js'
import type { TestnetNetwork, TestnetToken } from './config.js'

type Hex = `0x${string}`

export type WalletState = { address?: string; chainId?: number; status: 'connected' | 'connecting' | 'reconnecting' | 'disconnected' }

/** True when the page has an injected EIP-1193 wallet (window.ethereum) */
export function hasInjectedWallet(): boolean {
  return typeof window !== 'undefined' && !!(window as { ethereum?: unknown }).ethereum
}

function chainOf(n: TestnetNetwork): Chain {
  return defineChain({
    id: n.chainId,
    name: n.name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [n.rpcUrl] } },
    ...(n.explorers[0] ? { blockExplorers: { default: { name: n.explorers[0].name, url: n.explorers[0].url } } } : {}),
    testnet: true,
  })
}

export function createTestnetWallet(networks: TestnetNetwork[]) {
  const chains = networks.map(chainOf) as [Chain, ...Chain[]]
  const config: Config = createConfig({
    chains,
    connectors: [injected({ shimDisconnect: true })],
    transports: Object.fromEntries(networks.map((n) => [n.chainId, http(n.rpcUrl)])),
    // One wallet: window.ethereum. No EIP-6963 discovery list in this demo.
    multiInjectedProviderDiscovery: false,
  })

  const state = (): WalletState => {
    const a = getAccount(config)
    return { status: a.status, ...(a.address ? { address: a.address } : {}), ...(a.chainId !== undefined ? { chainId: a.chainId } : {}) }
  }

  const rpcFetch: typeof fetch = (input, init) => fetch(input, init)

  async function tokenBalance(n: TestnetNetwork, t: TestnetToken, owner: string): Promise<bigint> {
    const r = await evmRpc<string>(rpcFetch, n.rpcUrl, 'eth_call', [{ to: t.address, data: balanceOfData(owner) }, 'latest'])
    return BigInt(r && r !== '0x' ? r : '0x0')
  }

  async function ethBalance(n: TestnetNetwork, owner: string): Promise<bigint> {
    return BigInt(await evmRpc<string>(rpcFetch, n.rpcUrl, 'eth_getBalance', [owner, 'latest']))
  }

  return {
    config,
    state,
    watch(fn: (s: WalletState) => void): () => void {
      return watchAccount(config, { onChange: () => fn(state()) })
    },

    async connect(): Promise<WalletState> {
      if (!hasInjectedWallet()) throw new Error('No browser wallet found. Install MetaMask or Rabby, then reload this page.')
      const a = getAccount(config)
      if (a.status === 'connected') return state()
      try {
        await connect(config, { connector: config.connectors[0]! })
      } catch (e) {
        throw new Error(friendlyWalletError(e, { chainName: networks[0]!.name }))
      }
      return state()
    },

    async disconnect() {
      await disconnect(config).catch(() => {})
    },

    async switchTo(n: TestnetNetwork) {
      try {
        await switchChain(config, { chainId: n.chainId as Config['chains'][number]['id'] })
      } catch (e) {
        throw new Error(friendlyWalletError(e, { chainName: n.name }))
      }
    },

    tokenBalance,
    ethBalance,

    /** Mint test tokens to the connected account (open-mint test token only) and wait for the receipt. */
    async mint(n: TestnetNetwork, t: TestnetToken, amountBase: bigint): Promise<string> {
      const to = getAccount(config).address
      if (!to) throw new Error('Connect your wallet first.')
      try {
        if (getAccount(config).chainId !== n.chainId) await switchChain(config, { chainId: n.chainId as Config['chains'][number]['id'] })
        const hash = await sendTransaction(config, { chainId: n.chainId as Config['chains'][number]['id'], to: t.address as Hex, data: mintData(to, amountBase) as Hex })
        const r = await waitForTransactionReceipt(config, { hash, chainId: n.chainId as Config['chains'][number]['id'] })
        if (r.status !== 'success') throw new Error('The mint transaction failed on chain.')
        return hash
      } catch (e) {
        throw new Error(friendlyWalletError(e, { chainName: n.name, symbol: t.symbol }))
      }
    },

    /** The WalletAdapter for the widget: wagmiWallet, guarded for the chosen network and token. */
    adapter(n: TestnetNetwork, t: TestnetToken): WalletAdapter {
      const base = wagmiWallet(config, {
        waitBetweenTxs: true,
        // Wait for the settle receipt too, so the server finds the settlement at once.
        waitForLast: true,
        tokens: { [`eip155:${n.chainId}`]: [{ address: t.address, symbol: t.symbol, decimals: t.decimals }] },
      })
      return guardWallet(base, {
        chain: `eip155:${n.chainId}`,
        chainName: n.name,
        settlement: n.settlement,
        token: t,
        readBalance: async () => {
          const owner = getAccount(config).address
          return owner ? tokenBalance(n, t, owner) : 0n
        },
        isSettled: async (sid) => {
          const r = await evmRpc<string>(rpcFetch, n.rpcUrl, 'eth_call', [{ to: n.settlement, data: isSettledData(sid) }, 'latest'])
          return BigInt(r && r !== '0x' ? r : '0x0') !== 0n
        },
        topUpHint: t.mint ? 'Press "Mint" to get free test tokens.' : t.faucet ? `Get test ${t.symbol} at ${t.faucet}` : undefined,
      })
    },
  }
}

export type TestnetWallet = ReturnType<typeof createTestnetWallet>
