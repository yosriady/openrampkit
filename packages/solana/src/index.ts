// @openrampkit/solana: a WalletAdapter for Solana wallets (Wallet Standard) built on @solana/kit.
// Browser-side. It signs and sends the Solana transactions of a WALLET_TX surface:
// - `instructions`: instructions and lookup tables (Relay's Solana steps), built into a v0 transaction
// - `transaction`: a serialized transaction (base64 wire format)
// - `transfer`: SOL or an SPL token to an owner address (creates the recipient token account when missing)

import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getAddressEncoder,
  getBase16Encoder,
  getBase58Decoder,
  getBase64Decoder,
  getBase64Encoder,
  getProgramDerivedAddress,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit'
import type { Address, Instruction } from '@solana/kit'
import { getWallets } from '@wallet-standard/app'
import type { Wallet, WalletAccount } from '@wallet-standard/base'
import { StandardConnect, StandardDisconnect } from '@wallet-standard/features'
import type { StandardConnectFeature, StandardDisconnectFeature } from '@wallet-standard/features'
import { SolanaSignAndSendTransaction, SolanaSignTransaction } from '@solana/wallet-standard-features'
import type { SolanaSignAndSendTransactionFeature, SolanaSignTransactionFeature } from '@solana/wallet-standard-features'
import {
  SOLANA_DEVNET,
  SOLANA_MAINNET,
  SOLANA_NATIVE_DECIMALS,
  SOLANA_SYSTEM_PROGRAM,
  SPL_ASSOCIATED_TOKEN_PROGRAM,
  SPL_TOKEN_2022_PROGRAM,
  SPL_TOKEN_PROGRAM,
  TESTNET_USDC,
  USDC,
  fromSplAmount,
  isSolanaTx,
} from '@openrampkit/core'
import type { SolanaInstruction, SolanaTxRequest, TxRequest, WalletAdapter, WalletBalance } from '@openrampkit/core'

export type SolanaCommitment = 'confirmed' | 'finalized'

export type SolanaWalletOptions = {
  /**
   * The Wallet Standard wallet to use, or a function that returns it (read at each call).
   * Absent: the wallet named `walletName`, else the first registered wallet that can sign Solana transactions.
   */
  wallet?: Wallet | (() => Wallet | undefined)
  /** Pick a registered wallet by name, e.g. `Phantom`. Used when `wallet` is absent. */
  walletName?: string
  /** CAIP-2 chain. Default Solana mainnet. */
  chain?: string
  /** JSON-RPC URL for blockhashes, lookup tables, balances and confirmations. Default: the public RPC of `chain` (rate-limited). */
  rpcUrl?: string
  /** Custom fetch, for tests or proxies */
  fetch?: typeof fetch
  /** Wait for each transaction to confirm before sending the next. Default true. */
  waitBetweenTxs?: boolean
  /** Also wait for the last transaction to confirm before returning. Default false. */
  waitForLast?: boolean
  /** Commitment for blockhashes and confirmations. Default `confirmed`. */
  commitment?: SolanaCommitment
  /** How long to wait for a confirmation (ms). Default 60000. */
  confirmTimeoutMs?: number
  /** Extra SPL tokens to report in balances, besides USDC */
  tokens?: Array<{ mint: string; symbol: string; decimals: number }>
}

/** Public RPCs. Rate-limited: set `rpcUrl` for production. */
export const DEFAULT_SOLANA_RPC_URLS: Record<string, string> = {
  [SOLANA_MAINNET]: 'https://api.mainnet-beta.solana.com',
  [SOLANA_DEVNET]: 'https://api.devnet.solana.com',
}

/** CAIP-2 chain id to the Wallet Standard chain id (`solana:mainnet`, `solana:devnet`) */
export function walletStandardChain(chain: string): `solana:${string}` {
  if (chain === SOLANA_MAINNET) return 'solana:mainnet'
  if (chain === SOLANA_DEVNET) return 'solana:devnet'
  if (chain.startsWith('solana:')) return chain as `solana:${string}`
  throw new Error(`Not a Solana chain: ${chain}`)
}

/** True when a Wallet Standard wallet can sign Solana transactions */
export function isSolanaWallet(w: Wallet): boolean {
  return SolanaSignAndSendTransaction in w.features || SolanaSignTransaction in w.features
}

/** The registered Wallet Standard wallets that can sign Solana transactions (browser only; empty on the server). */
export function getSolanaWallets(): Wallet[] {
  if (typeof window === 'undefined') return []
  return getWallets().get().filter(isSolanaWallet)
}

// ---------------- encoding helpers ----------------

const addressEncoder = getAddressEncoder()
const base58 = getBase58Decoder()
const base64ToBytes = getBase64Encoder()
const bytesToBase64 = getBase64Decoder()
const hex = getBase16Encoder()

function hexBytes(data: string): Uint8Array {
  const h = data.replace(/^0x/, '')
  return h ? new Uint8Array(hex.encode(h.toLowerCase())) : new Uint8Array()
}

function role(isSigner: boolean, isWritable: boolean): AccountRole {
  if (isSigner) return isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER
  return isWritable ? AccountRole.WRITABLE : AccountRole.READONLY
}

/** Relay's JSON instruction to a @solana/kit instruction */
function toKitInstruction(i: SolanaInstruction): Instruction {
  return {
    programAddress: address(i.programId),
    accounts: i.keys.map((k) => ({ address: address(k.pubkey), role: role(k.isSigner, k.isWritable) })),
    data: hexBytes(i.data),
  }
}

function u64le(value: bigint): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, value, true)
  return out
}

/** Associated token account of `owner` for `mint` under `tokenProgram` */
export async function associatedTokenAddress(owner: string, mint: string, tokenProgram: string = SPL_TOKEN_PROGRAM): Promise<string> {
  const [ata] = await getProgramDerivedAddress({
    programAddress: address(SPL_ASSOCIATED_TOKEN_PROGRAM),
    seeds: [addressEncoder.encode(address(owner)), addressEncoder.encode(address(tokenProgram)), addressEncoder.encode(address(mint))],
  })
  return ata
}

/** System Program transfer of `lamports` */
function systemTransferInstruction(from: string, to: string, lamports: bigint): Instruction {
  const data = new Uint8Array(12)
  new DataView(data.buffer).setUint32(0, 2, true)
  data.set(u64le(lamports), 4)
  return {
    programAddress: address(SOLANA_SYSTEM_PROGRAM),
    accounts: [
      { address: address(from), role: AccountRole.WRITABLE_SIGNER },
      { address: address(to), role: AccountRole.WRITABLE },
    ],
    data,
  }
}

/** Instructions for an SPL transfer: create the recipient's token account when missing (idempotent), then TransferChecked. */
async function splTransferInstructions(p: { owner: string; to: string; mint: string; amount: bigint; decimals: number; tokenProgram?: string }): Promise<Instruction[]> {
  const program = p.tokenProgram ?? SPL_TOKEN_PROGRAM
  const source = address(await associatedTokenAddress(p.owner, p.mint, program))
  const dest = address(await associatedTokenAddress(p.to, p.mint, program))
  const createIdempotent: Instruction = {
    programAddress: address(SPL_ASSOCIATED_TOKEN_PROGRAM),
    accounts: [
      { address: address(p.owner), role: AccountRole.WRITABLE_SIGNER },
      { address: dest, role: AccountRole.WRITABLE },
      { address: address(p.to), role: AccountRole.READONLY },
      { address: address(p.mint), role: AccountRole.READONLY },
      { address: address(SOLANA_SYSTEM_PROGRAM), role: AccountRole.READONLY },
      { address: address(program), role: AccountRole.READONLY },
    ],
    data: new Uint8Array([1]),
  }
  const data = new Uint8Array(10)
  data[0] = 12 // TransferChecked
  data.set(u64le(p.amount), 1)
  data[9] = p.decimals
  const transferChecked: Instruction = {
    programAddress: address(program),
    accounts: [
      { address: source, role: AccountRole.WRITABLE },
      { address: address(p.mint), role: AccountRole.READONLY },
      { address: dest, role: AccountRole.WRITABLE },
      { address: address(p.owner), role: AccountRole.READONLY_SIGNER },
    ],
    data,
  }
  return [createIdempotent, transferChecked]
}

// ---------------- the adapter ----------------

type SolanaWalletAdapter = WalletAdapter & {
  /** The Wallet Standard wallet in use, if any */
  getWallet(): Wallet | undefined
  /** Ask the wallet to connect; returns the address of the first account */
  connect(opts?: { silent?: boolean }): Promise<string | undefined>
  disconnect(): Promise<void>
  /** Build the wire bytes of a Solana tx request for `payer` (no signature). For tests and previews. */
  buildTransaction(tx: SolanaTxRequest, payer: string): Promise<Uint8Array>
}

export function solanaWallet(opts: SolanaWalletOptions = {}): SolanaWalletAdapter {
  const chain = opts.chain ?? SOLANA_MAINNET
  const wsChain = walletStandardChain(chain)
  const commitment = opts.commitment ?? 'confirmed'
  const waitBetween = opts.waitBetweenTxs ?? true
  const doFetch = (...args: Parameters<typeof fetch>) => (opts.fetch ?? globalThis.fetch)(...args)

  function currentWallet(): Wallet | undefined {
    if (typeof opts.wallet === 'function') return opts.wallet()
    if (opts.wallet) return opts.wallet
    const list = getSolanaWallets()
    return opts.walletName ? list.find((w) => w.name === opts.walletName) : list[0]
  }

  function requireWallet(): Wallet {
    const w = currentWallet()
    if (!w) throw new Error('No Solana wallet found. Install a wallet that supports Wallet Standard.')
    return w
  }

  function accountsOf(w: Wallet | undefined): readonly WalletAccount[] {
    // An account without a chain list is taken as valid on every chain.
    return (w?.accounts ?? []).filter((a) => !a.chains.length || a.chains.includes(wsChain))
  }

  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    const url = opts.rpcUrl ?? DEFAULT_SOLANA_RPC_URLS[chain]
    if (!url) throw new Error(`No Solana RPC URL for ${chain}. Set rpcUrl.`)
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    if (!res.ok) throw new Error(`Solana RPC ${method}: HTTP ${res.status}`)
    const body = (await res.json()) as { result?: T; error?: { message?: string } }
    if (body.error) throw new Error(`Solana RPC ${method}: ${String(body.error.message ?? 'error').slice(0, 200)}`)
    return body.result as T
  }

  async function lookupTables(addresses: string[]): Promise<Record<Address, Address[]>> {
    if (!addresses.length) return {}
    const res = await rpc<{ value: Array<{ data?: { parsed?: { info?: { addresses?: string[] } } } } | null> }>('getMultipleAccounts', [
      addresses,
      { encoding: 'jsonParsed', commitment },
    ])
    const out: Record<Address, Address[]> = {}
    addresses.forEach((a, i) => {
      const list = res.value[i]?.data?.parsed?.info?.addresses
      if (!list) throw new Error(`Address lookup table ${a} was not found`)
      out[address(a)] = list.map((x) => address(x))
    })
    return out
  }

  async function tokenProgramOf(mint: string): Promise<string> {
    const res = await rpc<{ value: { owner: string } | null }>('getAccountInfo', [mint, { encoding: 'base64', commitment }])
    const owner = res.value?.owner
    if (owner !== SPL_TOKEN_PROGRAM && owner !== SPL_TOKEN_2022_PROGRAM) throw new Error(`${mint} is not an SPL token mint`)
    return owner
  }

  async function buildTransaction(tx: SolanaTxRequest, payer: string): Promise<Uint8Array> {
    if (tx.type === 'transaction') return new Uint8Array(base64ToBytes.encode(tx.transaction))
    let instructions: Instruction[]
    let tables: Record<Address, Address[]> = {}
    if (tx.type === 'instructions') {
      instructions = tx.instructions.map(toKitInstruction)
      tables = await lookupTables(tx.addressLookupTableAddresses ?? [])
    } else {
      const amount = BigInt(tx.amount)
      if (amount <= 0n) throw new Error('The transfer amount must be positive')
      instructions =
        tx.mint === 'native'
          ? [systemTransferInstruction(payer, tx.to, amount)]
          : await splTransferInstructions({ owner: payer, to: tx.to, mint: tx.mint, amount, decimals: tx.decimals, tokenProgram: await tokenProgramOf(tx.mint) })
    }
    const { value: latest } = await rpc<{ value: { blockhash: string; lastValidBlockHeight: number | string } }>('getLatestBlockhash', [{ commitment }])
    const base = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(address(payer), m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: latest.blockhash as never, lastValidBlockHeight: BigInt(latest.lastValidBlockHeight) }, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    )
    const message = Object.keys(tables).length ? compressTransactionMessageUsingAddressLookupTables(base, tables) : base
    return new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)))
  }

  async function signAndSend(w: Wallet, account: WalletAccount, bytes: Uint8Array): Promise<string> {
    const features = w.features as Partial<SolanaSignAndSendTransactionFeature & SolanaSignTransactionFeature>
    const direct = features[SolanaSignAndSendTransaction]
    if (direct) {
      const [out] = await direct.signAndSendTransaction({ account, chain: wsChain, transaction: bytes, options: { commitment: 'confirmed' } })
      if (!out) throw new Error('The wallet did not return a signature')
      return base58.decode(out.signature)
    }
    const signOnly = features[SolanaSignTransaction]
    if (!signOnly) throw new Error(`${w.name} cannot sign Solana transactions`)
    const [signed] = await signOnly.signTransaction({ account, chain: wsChain, transaction: bytes })
    if (!signed) throw new Error('The wallet did not return a signed transaction')
    return rpc<string>('sendTransaction', [bytesToBase64.decode(signed.signedTransaction), { encoding: 'base64', preflightCommitment: commitment }])
  }

  async function confirm(signature: string): Promise<void> {
    const timeout = opts.confirmTimeoutMs ?? 60_000
    const start = Date.now()
    for (let delay = 500; ; delay = Math.min(delay * 1.5, 3000)) {
      const res = await rpc<{ value: Array<{ err: unknown; confirmationStatus?: string | null } | null> }>('getSignatureStatuses', [[signature]])
      const s = res.value[0]
      if (s?.err) throw new Error(`Transaction ${signature} failed on chain`)
      if (s && (s.confirmationStatus === 'finalized' || (commitment === 'confirmed' && s.confirmationStatus === 'confirmed'))) return
      if (Date.now() - start > timeout) throw new Error(`Transaction ${signature} was not confirmed in time`)
      await new Promise((r) => setTimeout(r, delay))
    }
  }

  return {
    id: 'solana',
    namespaces: ['solana'],

    getWallet: currentWallet,

    async connect(o = {}) {
      const w = requireWallet()
      const feature = (w.features as Partial<StandardConnectFeature>)[StandardConnect]
      if (feature) await feature.connect(o.silent ? { silent: true } : undefined)
      return accountsOf(w)[0]?.address
    },

    async disconnect() {
      const w = currentWallet()
      await (w?.features as Partial<StandardDisconnectFeature> | undefined)?.[StandardDisconnect]?.disconnect()
    },

    buildTransaction,

    async getAccounts() {
      return accountsOf(currentWallet()).map((a) => ({ chain, address: a.address }))
    },

    async getBalances(accounts) {
      const usdc = USDC[chain] ?? TESTNET_USDC[chain]
      const tokens = [...(usdc ? [{ mint: usdc, symbol: 'USDC', decimals: 6 }] : []), ...(opts.tokens ?? [])].filter(
        (t, i, all) => all.findIndex((x) => x.mint === t.mint) === i,
      )
      const jobs: Array<Promise<WalletBalance>> = []
      for (const { chain: c, address: owner } of accounts) {
        if (c !== chain) continue
        jobs.push(
          rpc<{ value: number | string }>('getBalance', [owner, { commitment }]).then((r) => ({
            chain,
            token: 'native',
            symbol: 'SOL',
            decimals: SOLANA_NATIVE_DECIMALS,
            amount: fromSplAmount(BigInt(r.value), SOLANA_NATIVE_DECIMALS),
          })),
        )
        for (const t of tokens) {
          jobs.push(
            rpc<{ value: Array<{ account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }> }>('getTokenAccountsByOwner', [
              owner,
              { mint: t.mint },
              { encoding: 'jsonParsed', commitment },
            ]).then((r) => {
              const total = r.value.reduce((acc, v) => acc + BigInt(v.account.data.parsed.info.tokenAmount.amount), 0n)
              const amount = fromSplAmount(total, t.decimals)
              return { chain, token: t.mint, symbol: t.symbol, decimals: t.decimals, amount, ...(t.symbol === 'USDC' ? { usd: amount } : {}) }
            }),
          )
        }
      }
      // One failing RPC call must not hide the other balances.
      const settled = await Promise.allSettled(jobs)
      return settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []))
    },

    async switchChain(c) {
      if (c !== chain) throw new Error(`This Solana wallet adapter is set up for ${chain}, not ${c}`)
    },

    async sendTransactions(c: string, txs: TxRequest[]) {
      if (c !== chain) throw new Error(`This Solana wallet adapter is set up for ${chain}, not ${c}`)
      if (!txs.length) throw new Error('No transactions to send')
      const w = requireWallet()
      const account = accountsOf(w)[0]
      if (!account) throw new Error('Connect your Solana wallet first')
      let signature = ''
      for (let i = 0; i < txs.length; i++) {
        const tx = txs[i]!
        if (!isSolanaTx(tx)) throw new Error('solanaWallet sends Solana transactions only. Use @openrampkit/wagmi for EVM chains.')
        signature = await signAndSend(w, account, await buildTransaction(tx, account.address))
        const last = i === txs.length - 1
        if ((!last && waitBetween) || (last && opts.waitForLast)) await confirm(signature)
      }
      return { hash: signature }
    },
  }
}
