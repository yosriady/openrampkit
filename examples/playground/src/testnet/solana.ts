// Solana devnet in testnet mode: error messages, the wallet guard and the session. Pure code with no
// Wallet Standard registry import, so the unit tests run in Node.

import { fromSplAmount, isSolanaTx, lamportsToSol, orkError } from '@openrampkit/core'
import type { TxRequest, WalletAdapter, WalletBalance } from '@openrampkit/core'
import type { CreateSessionInput } from '@openrampkit/server'
import type { Wallet } from '@wallet-standard/base'
import type { SolanaDevnetConfig } from './config.js'

/** The lowest SOL balance (lamports) that the page asks for: fees, with room to spare. 0.001 SOL. */
export const MIN_FEE_LAMPORTS = 1_000_000n

const SIGN_AND_SEND = 'solana:signAndSendTransaction'
const SIGN = 'solana:signTransaction'

/**
 * The wallet, made to sign only when it can: the page then sends the signed transaction through the
 * devnet RPC itself. Thus the transaction goes to devnet even when the wallet's own network setting
 * is mainnet. A wallet with only `signAndSendTransaction` stays as it is.
 */
export function signOnly(w: Wallet): Wallet {
  if (!(SIGN in w.features) || !(SIGN_AND_SEND in w.features)) return w
  const features = Object.fromEntries(Object.entries(w.features).filter(([k]) => k !== SIGN_AND_SEND))
  return {
    get version() {
      return w.version
    },
    get name() {
      return w.name
    },
    get icon() {
      return w.icon
    },
    get chains() {
      return w.chains
    },
    get accounts() {
      return w.accounts
    },
    features,
  } as Wallet
}

/** True when the account can be used on Solana devnet (an account with no chain list works on every chain) */
export function accountOnDevnet(a: { chains: readonly string[] }): boolean {
  return !a.chains.length || a.chains.includes('solana:devnet')
}

type ErrorLike = { code?: unknown; name?: unknown; message?: unknown; cause?: unknown; logs?: unknown }

function errorChain(e: unknown): ErrorLike[] {
  const out: ErrorLike[] = []
  let cur: unknown = e
  for (let i = 0; i < 8 && cur && typeof cur === 'object'; i++) {
    out.push(cur as ErrorLike)
    cur = (cur as ErrorLike).cause
  }
  if (!out.length && typeof e === 'string') out.push({ message: e })
  return out
}

export type SolanaErrorContext = { symbol: string; faucet: string; gasFaucet: string }

/** A short, plain message for a Solana wallet or RPC error */
export function friendlySolanaError(e: unknown, ctx: SolanaErrorContext): string {
  const all = errorChain(e)
  const codes = all.map((x) => x.code)
  const text = all
    .map((x) => [x.name, x.message, Array.isArray(x.logs) ? x.logs.join(' ') : ''].filter((v) => typeof v === 'string').join(' '))
    .join(' ')
  if (codes.includes(4001) || /user rejected|rejected the request|request rejected|user denied|approval denied|declined|user cancel|cancelled by user/i.test(text)) {
    return 'You rejected the request in your wallet. Nothing was sent.'
  }
  if (/no record of a prior credit|insufficient lamports|insufficient funds for fee|InsufficientFundsForFee|insufficient funds for rent|InsufficientFundsForRent/i.test(text)) {
    return `Not enough devnet SOL for fees. Get devnet SOL at ${ctx.gasFaucet}, then try again.`
  }
  if (/custom program error: 0x1\b|insufficient funds/i.test(text)) {
    return `Not enough ${ctx.symbol} in your wallet for this amount.`
  }
  if (/AccountNotFound|could not find account|InvalidAccountData|account does not exist/i.test(text)) {
    return `You have no devnet ${ctx.symbol} token account yet. Get devnet ${ctx.symbol} at ${ctx.faucet} (choose Solana Devnet), then try again.`
  }
  if (/Blockhash not found|BlockhashNotFound/i.test(text)) {
    return 'Your wallet seems to be on another Solana network. Switch your wallet to Devnet, then try again.'
  }
  if (/not confirmed in time/i.test(text)) {
    return 'The transaction was not confirmed in time. Look for it in Solana Explorer, then start a new deposit.'
  }
  if (/already pending|-32002/i.test(text)) return 'Your wallet has a request open already. Open your wallet to answer it.'
  const first = all.find((x) => typeof x.message === 'string' && x.message.trim())?.message
  return typeof first === 'string' ? first.split('\n')[0]!.trim() : 'The wallet could not send the transaction.'
}

export type SolanaTokenInfo = {
  /** Number of token accounts of the mint that the owner has */
  accounts: number
  /** Total balance in base units */
  amount: bigint
}

export type SolanaGuardOptions = {
  chain: string
  token: { mint: string; symbol: string; decimals: number; faucet: string }
  gasFaucet: string
  /** SOL balance of the connected account, in lamports */
  readSol(): Promise<bigint>
  /** Token accounts and balance of the connected account for the mint */
  readToken(): Promise<SolanaTokenInfo>
  /** Default MIN_FEE_LAMPORTS */
  minLamports?: bigint
}

/**
 * Wrap a Solana wallet adapter for devnet mode:
 * - It reports only devnet USDC, so the widget pays with it.
 * - Before it sends, it checks the token account, the token balance and the SOL for fees.
 * - It turns wallet errors into short messages that the widget shows.
 */
export function guardSolanaWallet(base: WalletAdapter, g: SolanaGuardOptions): WalletAdapter {
  const fail = (message: string) => orkError('BAD_REQUEST', { message, recovery: 'retry_payment' })
  const ctx = { symbol: g.token.symbol, faucet: g.token.faucet, gasFaucet: g.gasFaucet }
  const min = g.minLamports ?? MIN_FEE_LAMPORTS
  return {
    id: `${base.id}-devnet`,
    namespaces: ['solana'],
    async getAccounts() {
      return (await base.getAccounts()).filter((a) => a.chain === g.chain)
    },
    async getBalances(accounts) {
      const all = base.getBalances ? await base.getBalances(accounts) : []
      return all
        .filter((b: WalletBalance) => b.chain === g.chain && b.token === g.token.mint)
        .map((b) => ({ ...b, symbol: g.token.symbol, decimals: g.token.decimals }))
    },
    async switchChain(c: string) {
      if (c !== g.chain) throw fail('This page pays on Solana devnet only.')
    },
    async sendTransactions(chain: string, txs: TxRequest[]) {
      const need = txs.filter(isSolanaTx).reduce((n, t) => (t.type === 'transfer' && t.mint === g.token.mint ? n + BigInt(t.amount) : n), 0n)
      if (need > 0n) {
        const tok = await g.readToken()
        if (!tok.accounts) throw fail(`You have no devnet ${g.token.symbol} token account yet. Get devnet ${g.token.symbol} at ${g.token.faucet} (choose Solana Devnet), then try again.`)
        if (tok.amount < need) {
          const fmt = (v: bigint) => fromSplAmount(v, g.token.decimals)
          throw fail(`Not enough ${g.token.symbol}. You have ${fmt(tok.amount)}, and this payment needs ${fmt(need)}. Get devnet ${g.token.symbol} at ${g.token.faucet}`)
        }
      }
      const sol = await g.readSol()
      if (sol < min) throw fail(`Not enough devnet SOL for fees. You have ${lamportsToSol(sol)} SOL. Get devnet SOL at ${g.gasFaucet}, then try again.`)
      try {
        return await base.sendTransactions(chain, txs)
      } catch (e) {
        throw fail(friendlySolanaError(e, ctx))
      }
    },
  }
}

/** The session your backend would create: devnet USDC to the connected wallet (it pays itself back). */
export function solanaSessionInput(cfg: SolanaDevnetConfig, recipient: string): CreateSessionInput {
  return {
    userId: 'devnet-user',
    country: 'US',
    allowedMethods: ['wallet'],
    metadata: { source: 'playground-solana-devnet' },
    destination: { type: 'crypto', chain: cfg.chain, token: cfg.token.mint, symbol: cfg.token.symbol, decimals: cfg.token.decimals, address: recipient },
  }
}
