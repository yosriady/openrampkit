// Chain watching for adapters: JSON-RPC calls with per-chain URLs and a rate limit, ERC-20 Transfer
// logs to an address (page by page, with a block range cap), and Solana signatures and transactions.
// No provider is involved. The Relay adapter (same-chain transfers) and the chain-watch adapter
// (standing addresses with no bridge) both use it. Web-standard APIs only (fetch), no viem.

import { OpenRampException, SOLANA_DEVNET, SOLANA_MAINNET, chainName, isSolanaChain, openRampError } from '@openrampkit/core'
import { ERC20_TRANSFER_TOPIC, evmRpc, topicAddress } from './evm.js'
import type { AdapterContext } from './index.js'
import type { SolanaParsedTx } from './solana.js'

/** Public RPCs per CAIP-2 chain. They are rate limited: set your own in production. */
export const PUBLIC_RPC_URLS: Readonly<Record<string, string>> = {
  'eip155:1': 'https://ethereum-rpc.publicnode.com',
  'eip155:8453': 'https://mainnet.base.org',
  'eip155:42161': 'https://arb1.arbitrum.io/rpc',
  'eip155:10': 'https://mainnet.optimism.io',
  'eip155:137': 'https://polygon-rpc.com',
  'eip155:4217': 'https://rpc.tempo.xyz',
  [SOLANA_MAINNET]: 'https://api.mainnet-beta.solana.com',
  [SOLANA_DEVNET]: 'https://api.devnet.solana.com',
  'eip155:421614': 'https://sepolia-rollup.arbitrum.io/rpc',
  'eip155:46630': 'https://rpc.testnet.chain.robinhood.com',
}

/** Default most blocks in one `eth_getLogs` call */
export const DEFAULT_LOG_BLOCK_RANGE = 2000
/** The cap on `logBlockRange`: many RPCs refuse a wider range */
export const MAX_LOG_BLOCK_RANGE = 10_000
/** Default most `eth_getLogs` pages in one check; the next check goes on from where this one stopped */
export const DEFAULT_LOG_PAGES = 5
/** The cap on `maxLogPages` */
export const MAX_LOG_PAGES = 50
/** Default blocks on top of a block before a log in it counts (EVM) */
export const DEFAULT_CONFIRMATIONS = 12

export type ChainWatchOptions = {
  /** JSON-RPC URLs per CAIP-2 chain. They win over `defaultRpcUrls`. */
  rpcUrls?: Record<string, string>
  /** The URLs for chains that `rpcUrls` does not name. Default `PUBLIC_RPC_URLS`. Pass `{}` to use only `rpcUrls`. */
  defaultRpcUrls?: Readonly<Record<string, string>>
  /** Most blocks in one `eth_getLogs` call. Default 2000, at most 10000. */
  logBlockRange?: number
  /** Most `eth_getLogs` pages in one check. Default 5, at most 50. */
  maxLogPages?: number
  /**
   * Most RPC requests per second to one RPC URL, in this process (calls wait for their turn). Default:
   * no limit. Public RPCs allow a few requests per second.
   */
  requestsPerSecond?: number
  /** Timeout of one RPC call (ms). Default 8000. */
  timeoutMs?: number
  /**
   * EVM: blocks on top of the block of a log before the log counts, so a re-org cannot take it back.
   * A number for every chain, or one per CAIP-2 chain (other chains get 12). Default 12.
   */
  confirmations?: number | Record<string, number>
  /** Solana: the commitment of signature and transaction reads. Default `finalized`. */
  solanaCommitment?: 'confirmed' | 'finalized'
}

/** One ERC-20 Transfer log, as `eth_getLogs` returns it (the fields the checks read) */
export type TransferLog = { data: string; transactionHash: string; blockNumber?: string; logIndex?: string; removed?: boolean; topics?: string[] }

/** One page of Transfer logs: the block range, and the logs in it oldest first (removed logs left out) */
export type TransferLogPage = { from: bigint; to: bigint; logs: TransferLog[] }

/** One entry of `getSignaturesForAddress` */
export type SolanaSignatureInfo = { signature: string; err: unknown; blockTime?: number | null; slot?: number }

type RpcCtx = Pick<AdapterContext, 'fetch' | 'log'>

const clamp = (n: number | undefined, d: number, min: number, max: number) => Math.max(min, Math.min(max, Math.floor(Number.isFinite(n) ? n! : d)))
export const toHexBlock = (n: bigint) => `0x${n.toString(16)}`
const hexOr = (v: string | undefined, d: bigint) => (v ? BigInt(v) : d)
const cmpBig = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Key that marks a transaction as used (`claimOnce`). EVM hashes are lowercased; Solana signatures
 * are case-sensitive. A log of a transaction adds `:{logIndex}`.
 */
export function txUsedKey(chain: string, hash: string): string {
  return `txused:${chain}:${isSolanaChain(chain) ? hash : hash.toLowerCase()}`
}

export type ChainWatch = ReturnType<typeof createChainWatch>

/** A chain watcher with its RPC settings. One per adapter instance: the rate limit is per instance. */
export function createChainWatch(opts: ChainWatchOptions = {}) {
  const defaults = opts.defaultRpcUrls ?? PUBLIC_RPC_URLS
  const logBlockRange = BigInt(clamp(opts.logBlockRange, DEFAULT_LOG_BLOCK_RANGE, 1, MAX_LOG_BLOCK_RANGE))
  const maxLogPages = clamp(opts.maxLogPages, DEFAULT_LOG_PAGES, 1, MAX_LOG_PAGES)
  const gapMs = opts.requestsPerSecond && opts.requestsPerSecond > 0 ? 1000 / opts.requestsPerSecond : 0
  const solanaCommitment = opts.solanaCommitment ?? 'finalized'
  /** The time of the next free request slot, per RPC URL */
  const nextSlot = new Map<string, number>()

  function rpcUrl(chain: string): string | undefined {
    return (opts.rpcUrls ?? {})[chain] ?? defaults[chain]
  }

  function confirmationsFor(chain: string): number {
    const c = opts.confirmations
    const n = typeof c === 'number' ? c : c?.[chain]
    return n === undefined || !Number.isFinite(n) || n < 0 ? DEFAULT_CONFIRMATIONS : Math.floor(n)
  }

  /** Wait for this URL's next request slot (the rate limit) */
  async function slot(url: string): Promise<void> {
    if (!gapMs) return
    const now = Date.now()
    const at = Math.max(now, nextSlot.get(url) ?? 0)
    nextSlot.set(url, at + gapMs)
    if (at > now) await new Promise((r) => setTimeout(r, at - now))
  }

  /** One JSON-RPC call on `chain`. No URL for the chain: PROVIDER_UNAVAILABLE (502). */
  async function rpc<T>(ctx: RpcCtx, chain: string, method: string, params: unknown[]): Promise<T> {
    const url = rpcUrl(chain)
    if (!url) throw new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message: `No RPC is configured to verify transfers on ${chainName(chain)}.` }), 502)
    await slot(url)
    return evmRpc<T>(ctx.fetch, url, method, params, { log: ctx.log, ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) })
  }

  /** The latest block number (EVM) */
  async function latestBlock(ctx: RpcCtx, chain: string): Promise<bigint> {
    return BigInt(await rpc<string>(ctx, chain, 'eth_blockNumber', []))
  }

  /**
   * The ERC-20 `token` Transfer logs to `to`, from block `from` up to block `latest`, one page of at most
   * `logBlockRange` blocks at a time, at most `maxLogPages` pages. Each page has its logs oldest first
   * (block, then log index), with removed logs left out. Stop early to read fewer pages.
   */
  async function* transferLogPages(ctx: RpcCtx, q: { chain: string; token: string; to: string; from: bigint; latest: bigint }): AsyncGenerator<TransferLogPage> {
    let from = q.from
    for (let page = 0; page < maxLogPages && from <= q.latest; page++) {
      const to = from + logBlockRange - 1n < q.latest ? from + logBlockRange - 1n : q.latest
      const logs = await rpc<TransferLog[] | null>(ctx, q.chain, 'eth_getLogs', [
        { fromBlock: toHexBlock(from), toBlock: toHexBlock(to), address: q.token, topics: [ERC20_TRANSFER_TOPIC, null, topicAddress(q.to)] },
      ])
      const start = from
      const ordered = (logs ?? []).filter((l) => !l.removed).sort((a, b) => cmpBig(hexOr(a.blockNumber, start), hexOr(b.blockNumber, start)) || cmpBig(hexOr(a.logIndex, 0n), hexOr(b.logIndex, 0n)))
      yield { from, to, logs: ordered }
      from = to + 1n
    }
  }

  /** A Solana transaction (`jsonParsed`), or null when the node does not have it at this commitment */
  function solanaTx<T = SolanaParsedTx>(ctx: RpcCtx, chain: string, signature: string, commitment: 'confirmed' | 'finalized' = solanaCommitment) {
    return rpc<T | null>(ctx, chain, 'getTransaction', [signature, { encoding: 'jsonParsed', commitment, maxSupportedTransactionVersion: 0 }])
  }

  /** Signatures for an account, newest first (`getSignaturesForAddress`) */
  async function solanaSignatures(
    ctx: RpcCtx,
    chain: string,
    account: string,
    q: { limit: number; commitment?: 'confirmed' | 'finalized'; before?: string; until?: string },
  ): Promise<SolanaSignatureInfo[]> {
    const cfg = { limit: q.limit, commitment: q.commitment ?? solanaCommitment, ...(q.before ? { before: q.before } : {}), ...(q.until ? { until: q.until } : {}) }
    return (await rpc<SolanaSignatureInfo[] | null>(ctx, chain, 'getSignaturesForAddress', [account, cfg])) ?? []
  }

  /** The token accounts of `mint` that `owner` owns */
  async function solanaTokenAccounts(ctx: RpcCtx, chain: string, owner: string, mint: string, commitment: 'confirmed' | 'finalized' = solanaCommitment): Promise<string[]> {
    const res = await rpc<{ value?: Array<{ pubkey: string }> } | null>(ctx, chain, 'getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment }])
    return (res?.value ?? []).map((v) => v.pubkey)
  }

  return { rpcUrl, rpc, confirmationsFor, latestBlock, transferLogPages, solanaTx, solanaSignatures, solanaTokenAccounts, logBlockRange, maxLogPages, solanaCommitment }
}
