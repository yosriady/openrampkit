// Solana devnet in testnet mode: the visitor's Wallet Standard wallet (Phantom, Solflare, Backpack)
// through @openrampkit/solana. Reads go to the devnet RPC; the wallet signs; the page sends.
// Loaded on demand, when the visitor picks Solana Devnet.

import { getWallets } from '@wallet-standard/app'
import type { Wallet, WalletAccount } from '@wallet-standard/base'
import { isSolanaWallet, solanaWallet } from '@openrampkit/solana'
import type { WalletAdapter } from '@openrampkit/core'
import type { SolanaDevnetConfig } from './config.js'
import { accountOnDevnet, friendlySolanaError, guardSolanaWallet, signOnly } from './solana.js'
import type { SolanaTokenInfo } from './solana.js'

export type SolanaState = {
  /** Names of the Solana wallets on the page */
  wallets: string[]
  /** The chosen wallet */
  wallet?: string
  /** The connected account that can use devnet */
  address?: string
  /** The wallet has accounts, but none of them can use devnet */
  noDevnetAccount: boolean
}

type EventsFeature = { 'standard:events'?: { on(event: 'change', fn: (p: { accounts?: readonly WalletAccount[] }) => void): () => void } }

export function createSolanaDevnet(cfg: SolanaDevnetConfig) {
  const registry = getWallets()
  let chosen: string | undefined

  const list = (): Wallet[] => registry.get().filter(isSolanaWallet)
  const current = (): Wallet | undefined => list().find((w) => w.name === chosen) ?? list()[0]
  const ctx = { symbol: cfg.token.symbol, faucet: cfg.token.faucet, gasFaucet: cfg.gasFaucet }

  const base = solanaWallet({
    wallet: () => {
      const w = current()
      return w ? signOnly(w) : undefined
    },
    chain: cfg.chain,
    rpcUrl: cfg.rpcUrl,
    // Wait for the confirmation, so the server finds the transaction at once.
    waitForLast: true,
    tokens: [{ mint: cfg.token.mint, symbol: cfg.token.symbol, decimals: cfg.token.decimals }],
  })

  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    const res = await fetch(cfg.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    if (!res.ok) throw new Error(`Solana RPC ${method}: HTTP ${res.status}`)
    const body = (await res.json()) as { result?: T; error?: { message?: string } }
    if (body.error) throw new Error(`Solana RPC ${method}: ${body.error.message ?? 'error'}`)
    return body.result as T
  }

  function state(): SolanaState {
    const w = current()
    const accounts = w?.accounts ?? []
    const usable = accounts.find(accountOnDevnet)
    return {
      wallets: list().map((x) => x.name),
      ...(w ? { wallet: w.name } : {}),
      ...(usable ? { address: usable.address } : {}),
      noDevnetAccount: accounts.length > 0 && !usable,
    }
  }

  return {
    config: cfg,
    state,

    select(name: string) {
      chosen = name
    },

    /** Calls `fn` when a wallet registers or leaves the page */
    onWallets(fn: () => void): () => void {
      const offs = [registry.on('register', fn), registry.on('unregister', fn)]
      return () => offs.forEach((o) => o())
    },

    /** Calls `fn` when the chosen wallet's accounts change */
    watch(fn: () => void): () => void {
      let off: (() => void) | undefined
      let watched: Wallet | undefined
      const attach = () => {
        const w = current()
        if (w === watched) return
        off?.()
        watched = w
        off = (w?.features as EventsFeature | undefined)?.['standard:events']?.on('change', fn)
      }
      attach()
      const offWallets = this.onWallets(() => {
        attach()
        fn()
      })
      return () => {
        off?.()
        offWallets()
      }
    },

    async connect(opts: { silent?: boolean } = {}): Promise<SolanaState> {
      if (!current()) throw new Error('No Solana wallet found. Install Phantom, Solflare or Backpack, then reload this page.')
      try {
        await base.connect(opts)
      } catch (e) {
        if (opts.silent) return state()
        throw new Error(friendlySolanaError(e, ctx))
      }
      return state()
    },

    async disconnect() {
      await base.disconnect().catch(() => {})
    },

    /** SOL balance in lamports */
    async solBalance(owner: string): Promise<bigint> {
      const r = await rpc<{ value: number | string }>('getBalance', [owner, { commitment: 'confirmed' }])
      return BigInt(r.value)
    },

    /** The owner's token accounts of the mint and their total balance */
    async tokenInfo(owner: string): Promise<SolanaTokenInfo> {
      const r = await rpc<{ value: Array<{ account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }> }>('getTokenAccountsByOwner', [
        owner,
        { mint: cfg.token.mint },
        { encoding: 'jsonParsed', commitment: 'confirmed' },
      ])
      return { accounts: r.value.length, amount: r.value.reduce((s, v) => s + BigInt(v.account.data.parsed.info.tokenAmount.amount), 0n) }
    },

    /** The WalletAdapter for the widget: solanaWallet on devnet, guarded for devnet USDC. */
    adapter(): WalletAdapter {
      const owner = () => {
        const a = state().address
        if (!a) throw new Error('Connect your Solana wallet first.')
        return a
      }
      return guardSolanaWallet(base, {
        chain: cfg.chain,
        token: cfg.token,
        gasFaucet: cfg.gasFaucet,
        readSol: () => this.solBalance(owner()),
        readToken: () => this.tokenInfo(owner()),
      })
    },
  }
}

export type SolanaDevnet = ReturnType<typeof createSolanaDevnet>
