// Relay adapter: crypto bridge and swap legs (https://docs.relay.link).
//
// Legs:
// - `wallet`   The user's connected wallet signs Relay's transaction steps (WALLET_TX).
// - `transfer` The user sends any amount to a Relay open deposit address (DEPOSIT_ADDRESS).
// - `bridge`   Hop leg after an onramp: the onramp delivers USDC into a Relay open deposit
//              address, and Relay moves it to the destination chain and token.
//
// Server-side only. Web-standard APIs only (fetch, WebCrypto), so it runs on Cloudflare Workers.

import {
  ERC20_TRANSFER_TOPIC,
  POLL,
  awaitPoll,
  buildSettlementTxs,
  claimOnce,
  createAdapter,
  erc20PaidTo,
  erc20TransferData,
  evmRpc,
  fetchJson,
  hashSettlementCalls,
  httpErrorToOrk,
  randomHex,
  settlementCallsFrom,
  settlementIntentTypedData,
  topicAddress,
  verifySettlement,
} from '@openrampkit/adapter'
import type { AdapterContext, EvmReceipt, Logger, QuoteInput, SettlementIntent, SettlementIntentTypedData, StartInput } from '@openrampkit/adapter'
import {
  CHAINS,
  OrkException,
  SOLANA_DEVNET,
  SOLANA_MAINNET,
  USDC,
  chainName,
  cmp,
  evmChainId,
  fromBaseUnits,
  isSolanaAddress,
  isSolanaSignature,
  isSolanaTx,
  isUsdc,
  orkError,
  sameToken,
  toBaseUnits,
} from '@openrampkit/core'
import type { Amount, CryptoAsset, Fee, LegQuote, LegSpec, LegStep, PollSpec, SolanaInstruction, TxRequest } from '@openrampkit/core'

export type RelayOptions = {
  /** Relay API key (x-api-key). Needed for GET /requests/v3 and higher rate limits. */
  apiKey?: string
  /** Default https://api.relay.link. Testnets: https://api.testnets.relay.link */
  baseUrl?: string
  /** App fee in basis points, paid to `recipient` (accrues as a claimable balance at Relay) */
  appFee?: { bps: number; recipient: string }
  /** Relay `referrer` string, for attribution */
  referrer?: string
  /**
   * Where Relay refunds failed deposit-address requests.
   * 'origin' (default) sends the origin chain's native-currency address, which turns on
   * automatic refund to the original sender. Or pass an explicit address.
   */
  refundTo?: 'origin' | string
  /**
   * JSON-RPC URLs per CAIP-2 chain, used to verify same-chain, same-token moves on chain
   * (Relay is not involved there). EVM chains use `eth_*` methods, Solana uses
   * `getSignatureStatuses` and `getTransaction`. Defaults to public RPCs for the main chains;
   * set your own for production. A chain without an RPC URL cannot use same-chain moves.
   */
  rpcUrls?: Record<string, string>
  /**
   * Signs the EIP-712 intent for a settlement contract that has an `intentSigner` (destination
   * `settlement`). Return the signature, e.g. from viem `signTypedData` or a KMS. Leave it out when
   * the contract has no intent signer.
   */
  signSettlementIntent?: (typedData: SettlementIntentTypedData) => Promise<string>
  /** Seconds a signed settlement intent stays valid. Default 1800. */
  settlementIntentTtlSec?: number
  /**
   * Relay `slippageTolerance` in basis points (0 to 10000), sent with every quote. Default: Relay
   * picks a value. The quote data carries Relay's `minimumAmount` as `minOutput`.
   */
  slippageBps?: number
  /**
   * How far below the expected amount (in basis points) a deposit can be and still complete a
   * `transfer` leg. Default 50 (0.5%). A `bridge` leg uses at least 500 (5%), because the onramp
   * can deliver a little less than its quote.
   */
  amountToleranceBps?: number
  /** Most blocks in one `eth_getLogs` call (same-chain `transfer` checks). Default 2000. */
  logBlockRange?: number
}

/** Public RPCs for on-chain verification. Rate-limited: use your own in production. */
export const DEFAULT_RPC_URLS: Record<string, string> = {
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

/** Allowed difference between our clock and block timestamps when a direct payment checks its tx age */
const DIRECT_TX_CLOCK_SKEW_MS = 5 * 60_000

export const RELAY_SOLANA_CHAIN_ID = 792703809
const SOLANA_CAIP2 = SOLANA_MAINNET
const EVM_NATIVE = '0x0000000000000000000000000000000000000000'
const SOLANA_NATIVE = '11111111111111111111111111111111'
/**
 * Relay accepts any address of the origin chain's VM as `user` for quotes; used when no wallet
 * is connected yet. Relay rejects a `user` of another VM (an EVM address for a Solana origin).
 */
const PLACEHOLDER_USER = '0x000000000000000000000000000000000000dEaD'
const PLACEHOLDER_SOLANA_USER = SOLANA_NATIVE
const DEPOSIT_ADDRESS_TTL_SEC = 24 * 60 * 60
/** An open deposit watch (see `Watcher`) counts as a rival for this long after its leg started */
const WATCH_TTL_SEC = 24 * 60 * 60
/** How long a used transaction, log or Relay request stays recorded */
const USED_TTL_SEC = 90 * 24 * 60 * 60
const DEFAULT_TOLERANCE_BPS = 50
const HOP_TOLERANCE_BPS = 500
const DEFAULT_LOG_BLOCK_RANGE = 2000
/** Most `eth_getLogs` pages in one status check; the next check goes on from where this one stopped */
const LOG_PAGES_PER_CHECK = 5
const WALLET_QUOTE_REUSE_MS = 20_000
const WALLET_QUOTE_TTL_MS = 60_000

export const RELAY_POLL: PollSpec = POLL.onchain
const RECORD_TTL_SEC = 7 * 24 * 60 * 60

const HOP_CHAINS = ['eip155:8453', 'eip155:42161', 'eip155:10', 'eip155:137', 'eip155:1'] as const

// ---------------- Relay API types (only the fields we read) ----------------

type RelayCurrency = { chainId: number; address: string; symbol: string; decimals: number }
type RelayAmount = { currency: RelayCurrency; amount: string; amountFormatted?: string }
/** EVM items carry `to`/`data`/`chainId`; Solana items carry `instructions` and lookup tables. */
type RelayStepItem = {
  status?: string
  data?: {
    from?: string
    to?: string
    data?: string
    value?: string
    chainId?: number
    gas?: string
    instructions?: SolanaInstruction[]
    addressLookupTableAddresses?: string[]
  }
}
type RelayStep = { id: string; kind: 'transaction' | 'signature' | string; items?: RelayStepItem[]; requestId?: string; depositAddress?: string }
export type RelayQuoteResponse = {
  requestId?: string
  steps: RelayStep[]
  fees?: Partial<Record<'gas' | 'relayer' | 'app', RelayAmount>>
  details?: { currencyIn?: RelayAmount; currencyOut?: RelayAmount & { minimumAmount?: string }; timeEstimate?: number }
}
type RelayIntentStatus = { status: string; details?: string; inTxHashes?: string[]; txHashes?: string[] }
type RelayTx = { hash?: string; txHash?: string; chainId?: number }
type RelayRequest = {
  id: string
  status: string
  createdAt: string
  /** Set for deposit-address requests. `depositTxHash` is the transfer into the address. */
  depositAddress?: { address?: string; depositTxHash?: string; depositor?: string } | null
  data?: {
    outTxs?: RelayTx[]
    inTxs?: RelayTx[]
    failReason?: string | null
    metadata?: { currencyIn?: RelayAmount; currencyOut?: RelayAmount }
    route?: { actual?: { destination?: { outputCurrency?: RelayAmount } }; quoted?: { destination?: { outputCurrency?: RelayAmount } } }
  }
}

// ---------------- helpers ----------------

/** CAIP-2 chain -> Relay numeric chain id */
export function relayChainId(chain: string): number {
  if (chain === SOLANA_CAIP2 || chain === 'solana') return RELAY_SOLANA_CHAIN_ID
  const id = evmChainId(chain)
  if (id === undefined) throw new OrkException(orkError('BAD_REQUEST', { message: `Relay does not support chain ${chain}.` }))
  return id
}

export function caip2FromRelay(chainId: number): string {
  return chainId === RELAY_SOLANA_CHAIN_ID ? SOLANA_CAIP2 : `eip155:${chainId}`
}

function isSolana(chain: string) {
  return chain.startsWith('solana:')
}

/** Our token id -> Relay currency address */
export function relayCurrency(chain: string, token: string): string {
  if (token === 'native') return isSolana(chain) ? SOLANA_NATIVE : EVM_NATIVE
  return token
}

function isNative(chain: string, token: string) {
  const t = token.toLowerCase()
  return t === 'native' || t === EVM_NATIVE || (isSolana(chain) && token === SOLANA_NATIVE)
}

function sameAsset(aChain: string, aToken: string, bChain: string, bToken: string) {
  if (aChain !== bChain) return false
  if (isNative(aChain, aToken) && isNative(bChain, bToken)) return true
  // EVM addresses are case-insensitive; Solana mints are case-sensitive
  return sameToken(aChain, aToken, bToken)
}

/** Key form of an address: EVM addresses lowercased, Solana (base58, case-sensitive) as given */
function addrKey(address: string): string {
  return address.startsWith('0x') ? address.toLowerCase() : address
}

/** True when `address` is a valid account of `chain`'s VM (the format only) */
function fitsChain(chain: string, address: string | undefined): address is string {
  if (!address) return false
  return isSolana(chain) ? isSolanaAddress(address) : /^0x[0-9a-fA-F]{40}$/.test(address)
}

/** The `user` for a Relay quote: the given address when it fits the origin chain, else a placeholder */
function quoteUser(originChain: string, address: string | undefined): string {
  if (fitsChain(originChain, address)) return address
  return isSolana(originChain) ? PLACEHOLDER_SOLANA_USER : PLACEHOLDER_USER
}

function sameUser(chain: string, a: unknown, b: string) {
  return typeof a === 'string' && (isSolana(chain) ? a === b : a.toLowerCase() === b.toLowerCase())
}

function cryptoAsset(a: Amount | undefined, what: string): CryptoAsset {
  if (!a || a.asset.kind !== 'crypto') throw new OrkException(orkError('BAD_REQUEST', { message: `Relay needs a crypto ${what}.` }))
  if (a.asset.chain === '*' || a.asset.token === '*') throw new OrkException(orkError('BAD_REQUEST', { message: 'Choose the token you want to pay with.' }))
  return a.asset
}

function knownDecimals(chain: string, token: string): number | undefined {
  if (isNative(chain, token)) return isSolana(chain) ? 9 : 18
  if (isUsdc(chain, token)) return 6
  return undefined
}

function knownSymbol(chain: string, token: string): string | undefined {
  if (isNative(chain, token)) return isSolana(chain) ? 'SOL' : CHAINS[chain]?.nativeSymbol
  if (isUsdc(chain, token)) return 'USDC'
  return undefined
}

function fmt(r: RelayAmount): string {
  return fromBaseUnits(r.amount, r.currency.decimals)
}

function feesFrom(q: RelayQuoteResponse): Fee[] {
  const out: Fee[] = []
  const add = (kind: Fee['kind'], label: string, f?: RelayAmount) => {
    if (!f || !f.amount || f.amount === '0') return
    out.push({ kind, label, amount: fmt(f), currency: f.currency.symbol })
  }
  add('network', 'Network fee', q.fees?.gas)
  // `relayer` already includes relayerGas and relayerService, so we do not add those.
  add('provider', 'Relay fee', q.fees?.relayer)
  add('app', 'App fee', q.fees?.app)
  return out
}

/** Relay's minimum output after slippage (`details.currencyOut.minimumAmount`), as a decimal string */
function minOutputOf(q: RelayQuoteResponse): { minOutput?: string } {
  const out = q.details?.currencyOut
  if (!out?.minimumAmount || !/^[0-9]+$/.test(out.minimumAmount)) return {}
  return { minOutput: fromBaseUnits(out.minimumAmount, out.currency.decimals) }
}

const toHex = (n: bigint) => `0x${n.toString(16)}`
const hexOr = (v: string | undefined, d: bigint) => (v ? BigInt(v) : d)
const cmpBig = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0)

function etaFrom(q: RelayQuoteResponse, fallback: { min: number; max: number }) {
  const t = q.details?.timeEstimate
  if (typeof t !== 'number' || !Number.isFinite(t)) return fallback
  return { min: Math.max(1, Math.round(t)), max: Math.max(fallback.max, Math.round(t * 4)) }
}

/** ERC-20 transfer(address,uint256) calldata (from `@openrampkit/adapter`) */
export { erc20TransferData }

/** Map a failed Relay HTTP call to an OrkException with a safe message. */
function toOrk(e: unknown, log?: Pick<Logger, 'warn'>): OrkException {
  return httpErrorToOrk(e, 'Relay', { what: 'find a route for this pair right now', ...(log ? { log } : {}) })
}

const POLL_TRANSITION = awaitPoll(RELAY_POLL)
const SUBMIT_TX = { name: 'submit_tx', kind: 'SURFACE_RESULT', expects: 'tx_hash' } as const

/** Terminal LegStep for a Relay request or intent status, or undefined while it is still running */
function terminalStep(status: string, extra: { ref: string; txHash?: string; output?: Amount }): LegStep | undefined {
  switch (status) {
    case 'success':
      return { state: 'COMPLETED', status: 'succeeded', transitions: [], ...extra }
    case 'failure':
      return {
        state: 'FAILED',
        status: 'failed',
        transitions: [],
        error: orkError('DELIVERY_FAILED', { message: 'Relay could not complete the transfer.', recovery: 'contact_support' }),
        ...extra,
      }
    case 'refund':
      return { state: 'REFUNDED', status: 'refunded', transitions: [], ...extra }
    default:
      return undefined
  }
}

/** Relay's request id from a quote response (top level or on a step) */
function requestIdOf(q: RelayQuoteResponse): string | undefined {
  return q.requestId ?? q.steps?.find((s) => s.requestId)?.requestId
}

// ---------------- stored state ----------------

type WalletRecord = {
  mode: 'relay' | 'direct'
  requestId?: string
  txHash?: string
  output?: Amount
  /** Origin chain: tells how to read `txHash` (EVM hash or Solana signature) */
  chain?: string
  token?: string
  recipient?: string
  amountBase?: string
  /** When the direct payment started (ms). A transaction mined before it cannot pay this session. */
  since?: number
  /** Direct payment through an OpenRampSettlement contract: its address, the calls hash and the start block */
  settlement?: { contract: string; callsHash: string; fromBlock: string }
}
type DepositRecord = {
  address: string
  since: number
  mode: 'relay' | 'direct'
  output?: Amount
  chain?: string
  token?: string
  fromBlock?: string
  /** Expected deposit (base units of the origin token), when the user gave an amount */
  expectedBase?: string
  /** Smallest deposit that completes the leg: `expectedBase` minus the tolerance */
  minBase?: string
  /** EVM direct: the next block to scan for Transfer logs */
  scanFrom?: string
  /** Relay: the key (deposit tx hash, else request id) and id of the request bound to this leg */
  bound?: { key: string; id: string }
}
/**
 * An open deposit leg on an address, kept in `shared` so that legs of other sessions on the same
 * address can see it. A deposit that two open legs could both claim is ambiguous: neither leg takes it.
 */
type Watcher = { owner: string; since: number; fromBlock?: string; expectedBase?: string; minBase?: string; until: number }

export function relay(opts: RelayOptions = {}) {
  const baseUrl = (opts.baseUrl ?? 'https://api.relay.link').replace(/\/+$/, '')
  let warnedV2 = false
  const toleranceBps = Math.max(0, Math.min(10_000, Math.round(opts.amountToleranceBps ?? DEFAULT_TOLERANCE_BPS)))
  const logBlockRange = BigInt(Math.max(1, Math.floor(opts.logBlockRange ?? DEFAULT_LOG_BLOCK_RANGE)))

  /** Warn once, on the first adapter call, when no API key is set: status then uses /requests/v2. */
  function warnNoKey(log: Pick<Logger, 'warn'>) {
    if (opts.apiKey || warnedV2) return
    warnedV2 = true
    log.warn('relay: no apiKey, using deprecated GET /requests/v2 (Relay retires it on 2026-11-24). Set relay({ apiKey }) to use /requests/v3.')
  }

  const headers = (): Record<string, string> => (opts.apiKey ? { 'x-api-key': opts.apiKey } : {})

  async function api<T>(ctx: Pick<AdapterContext, 'fetch'>, path: string, body?: unknown): Promise<T> {
    return fetchJson<T>(ctx.fetch, `${baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      timeoutMs: 8000,
    })
  }

  async function decimalsOf(ctx: Pick<AdapterContext, 'fetch' | 'shared'>, asset: CryptoAsset): Promise<number> {
    if (typeof asset.decimals === 'number') return asset.decimals
    const known = knownDecimals(asset.chain, asset.token)
    if (known !== undefined) return known
    const key = `dec:${asset.chain}:${isSolana(asset.chain) ? asset.token : asset.token.toLowerCase()}`
    const cached = await ctx.shared.get<number>(key)
    if (typeof cached === 'number') return cached
    const list = await api<Array<{ decimals: number }>>(ctx, '/currencies/v2', {
      chainIds: [relayChainId(asset.chain)],
      address: relayCurrency(asset.chain, asset.token),
      limit: 1,
    }).catch((e) => {
      throw toOrk(e)
    })
    const d = list?.[0]?.decimals
    if (typeof d !== 'number') throw new OrkException(orkError('BAD_REQUEST', { message: 'Relay does not know this token.' }))
    await ctx.shared.put(key, d, 7 * 24 * 60 * 60)
    return d
  }

  function withMeta(asset: CryptoAsset, decimals: number, symbol?: string): CryptoAsset {
    const s = asset.symbol ?? symbol ?? knownSymbol(asset.chain, asset.token)
    return { ...asset, decimals, ...(s ? { symbol: s } : {}) }
  }

  function refundTo(originChain: string): string {
    if (opts.refundTo && opts.refundTo !== 'origin') return opts.refundTo
    return isSolana(originChain) ? SOLANA_NATIVE : EVM_NATIVE
  }

  function baseBody(origin: CryptoAsset, dest: CryptoAsset) {
    return {
      originChainId: relayChainId(origin.chain),
      originCurrency: relayCurrency(origin.chain, origin.token),
      destinationChainId: relayChainId(dest.chain),
      destinationCurrency: relayCurrency(dest.chain, dest.token),
      ...(opts.referrer ? { referrer: opts.referrer } : {}),
      ...(opts.slippageBps !== undefined ? { slippageTolerance: String(Math.max(0, Math.min(10_000, Math.round(opts.slippageBps)))) } : {}),
      ...(opts.appFee && opts.appFee.bps > 0 ? { appFees: [{ recipient: opts.appFee.recipient, fee: String(Math.round(opts.appFee.bps)) }] } : {}),
    }
  }

  /** The settlement contract of the destination, when this leg delivers to the destination itself */
  function settlementOf(ctx: AdapterContext, deliverTo?: { address: string }): { contract: string } | undefined {
    const d = ctx.destination
    if (d.type !== 'crypto' || !d.settlement) return undefined
    // A hop leg delivers to the next leg's deposit address, not to the destination.
    if (deliverTo?.address && deliverTo.address.toLowerCase() !== d.address.toLowerCase()) return undefined
    return d.settlement
  }

  function recipientOf(ctx: AdapterContext, deliverTo?: { address: string }): string {
    if (deliverTo?.address) return deliverTo.address
    if (ctx.destination.type === 'crypto') return ctx.destination.address
    throw new OrkException(orkError('BAD_REQUEST', { message: 'Relay legs need a crypto destination.' }))
  }

  function destAsset(ctx: AdapterContext, legTo: CryptoAsset | undefined): CryptoAsset {
    if (legTo && legTo.chain !== '*') return legTo
    const d = ctx.destination
    if (d.type !== 'crypto') throw new OrkException(orkError('BAD_REQUEST', { message: 'Relay legs need a crypto destination.' }))
    return { kind: 'crypto', chain: d.chain, token: d.token, ...(d.symbol ? { symbol: d.symbol } : {}), ...(d.decimals !== undefined ? { decimals: d.decimals } : {}) }
  }

  // ---------- open deposit addresses ----------

  function depositKey(recipient: string, origin: CryptoAsset, dest: CryptoAsset) {
    const norm = (chain: string, token: string) => (isSolana(chain) ? token : token.toLowerCase())
    return `da:${addrKey(recipient)}:${origin.chain}:${norm(origin.chain, origin.token)}:${dest.chain}:${norm(dest.chain, dest.token)}`
  }

  /**
   * Quote with an open deposit address. Returns the raw quote and the deposit address.
   * Relay gives a new address for each quote. The adapter keeps one address per session and route
   * (in the session store, for 24 h), so the hop quote and the onramp use the same address. It never
   * gives the address of one session to another session.
   */
  async function depositQuote(
    ctx: Pick<AdapterContext, 'fetch' | 'store'>,
    p: { origin: CryptoAsset; dest: CryptoAsset; recipient: string; amountBase: string },
  ): Promise<{ q: RelayQuoteResponse; address: string; requestId?: string }> {
    const q = await api<RelayQuoteResponse>(ctx, '/quote/v2', {
      // `user` must be an address of the origin chain's VM (e.g. EVM origin, Solana recipient)
      user: quoteUser(p.origin.chain, p.recipient),
      recipient: p.recipient,
      ...baseBody(p.origin, p.dest),
      amount: p.amountBase,
      tradeType: 'EXACT_INPUT',
      useDepositAddress: true,
      refundTo: refundTo(p.origin.chain),
    }).catch((e) => {
      throw toOrk(e)
    })
    const key = depositKey(p.recipient, p.origin, p.dest)
    const cached = await ctx.store.get<string>(key)
    const fresh = q.steps?.find((s) => s.depositAddress)?.depositAddress
    const address = cached ?? fresh
    if (!address) throw new OrkException(orkError('PROVIDER_UNAVAILABLE', { message: 'Relay did not return a deposit address.' }), 502)
    if (!cached) await ctx.store.put(key, address, DEPOSIT_ADDRESS_TTL_SEC)
    const requestId = requestIdOf(q)
    return { q, address, ...(requestId ? { requestId } : {}) }
  }

  /** Get this session's open deposit address for a route, creating it with a nominal quote when missing. */
  async function openDepositAddress(ctx: Pick<AdapterContext, 'fetch' | 'shared' | 'store'>, origin: CryptoAsset, dest: CryptoAsset, recipient: string): Promise<string> {
    if (sameAsset(origin.chain, origin.token, dest.chain, dest.token)) return recipient
    const cached = await ctx.store.get<string>(depositKey(recipient, origin, dest))
    if (cached) return cached
    const decimals = await decimalsOf(ctx, origin)
    const { address } = await depositQuote(ctx, { origin, dest, recipient, amountBase: toBaseUnits(nominalAmount(decimals), decimals) })
    return address
  }

  /** Amount used to price an open deposit address when the user did not give one */
  function nominalAmount(decimals: number): string {
    return decimals <= 8 ? '10' : '0.005'
  }

  // ---------- status of deposit-address legs ----------

  async function listRequests(ctx: AdapterContext, query: string): Promise<RelayRequest[]> {
    warnNoKey(ctx.log)
    const path = opts.apiKey ? '/requests/v3' : '/requests/v2'
    const res = await api<{ requests?: RelayRequest[] }>(ctx, `${path}?${query}`)
    return res.requests ?? []
  }

  /** The deposit of a Relay request, in base units of the origin token (`metadata.currencyIn`) */
  function requestDeposit(r: RelayRequest): bigint | undefined {
    const a = r.data?.metadata?.currencyIn?.amount
    return a && /^[0-9]+$/.test(a) ? BigInt(a) : undefined
  }

  /** A request is bound by the transfer into the address (Relay can re-quote under a new id), else by id */
  function requestKey(r: RelayRequest): string {
    const h = r.depositAddress?.depositTxHash ?? r.data?.inTxs?.[0]?.hash ?? r.data?.inTxs?.[0]?.txHash
    return h ? `tx:${h.startsWith('0x') ? h.toLowerCase() : h}` : `id:${r.id}`
  }

  /**
   * Status of a deposit-address leg. Each Relay request completes one leg only. A request counts when
   * it was created after the leg started (1 minute of slack), it is not bound to another leg, its
   * deposit is at least `minBase` (when the user gave an amount), and no other open leg on the same
   * address could claim it. The first such request (oldest first) is bound to the leg for good.
   */
  async function findRelayDeposit(ctx: AdapterContext, ref: string, rec: DepositRecord | undefined, waiting: LegStep): Promise<LegStep> {
    const address = rec?.address ?? ref
    const owner = ownerOf(ctx, ref)
    const list = await listRequests(ctx, `depositAddress=${encodeURIComponent(address)}&limit=20`)
    if (rec?.bound) {
      const bound = rec.bound
      const r = list.find((x) => requestKey(x) === bound.key) ?? (await listRequests(ctx, `id=${encodeURIComponent(bound.id)}`))[0]
      return r ? finish(ctx, ref, rec, mapRequest(r, ref)) : { state: 'PROCESSING', sub: 'processing', status: 'processing', transitions: [POLL_TRANSITION], ref }
    }
    const since = rec?.since ?? 0
    const min = rec?.minBase ? BigInt(rec.minBase) : undefined
    const candidates = list
      .filter((r) => Date.parse(r.createdAt) >= since - 60_000)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    let ambiguous = false
    for (const r of candidates) {
      const key = requestKey(r)
      const used = `relayreq:${key}`
      const usedBy = await ctx.shared.get<string>(used)
      if (usedBy && usedBy !== owner) continue
      const amount = requestDeposit(r)
      if (min !== undefined && (amount === undefined || amount < min)) continue // dust, or less than the user said
      if (!usedBy) {
        if (rec && (await contested(ctx, rec, owner, { ...(amount !== undefined ? { amount } : {}), time: Date.parse(r.createdAt) }))) {
          ambiguous = true
          continue
        }
        if (!(await claimOnce(ctx.shared, used, owner, USED_TTL_SEC))) continue
      }
      if (rec) {
        rec.bound = { key, id: r.id }
        await ctx.store.put(`d:${addrKey(ref)}`, rec, RECORD_TTL_SEC)
      }
      return finish(ctx, ref, rec, mapRequest(r, ref))
    }
    if (ambiguous) return ambiguousStep(ctx, ref, address, waiting)
    return waiting
  }

  // ---------- one deposit for one leg ----------

  /** Who claims a deposit: the session and the leg ref */
  function ownerOf(ctx: AdapterContext, ref: string): string {
    return `${ctx.session.id}:${ref}`
  }

  /** Smallest deposit that completes a leg: the expected amount minus the tolerance (bigint math) */
  function minFor(expectedBase: string | undefined, legId: 'transfer' | 'bridge'): string | undefined {
    if (!expectedBase) return undefined
    const expected = BigInt(expectedBase)
    if (expected <= 0n) return undefined
    const bps = BigInt(legId === 'bridge' ? Math.max(toleranceBps, HOP_TOLERANCE_BPS) : toleranceBps)
    return (expected - (expected * bps) / 10_000n).toString()
  }

  function watchKey(rec: DepositRecord): string {
    if (rec.mode === 'relay') return `watch:relay:${addrKey(rec.address)}`
    const token = rec.token ? (isSolana(rec.chain ?? '') ? rec.token : rec.token.toLowerCase()) : ''
    return `watch:${rec.chain}:${token}:${addrKey(rec.address)}`
  }

  async function addWatcher(ctx: AdapterContext, rec: DepositRecord, owner: string) {
    const key = watchKey(rec)
    const now = Date.now()
    const list = ((await ctx.shared.get<Watcher[]>(key)) ?? []).filter((w) => w.until > now && w.owner !== owner)
    list.push({
      owner,
      since: rec.since,
      until: rec.since + WATCH_TTL_SEC * 1000,
      ...(rec.fromBlock ? { fromBlock: rec.fromBlock } : {}),
      ...(rec.expectedBase ? { expectedBase: rec.expectedBase } : {}),
      ...(rec.minBase ? { minBase: rec.minBase } : {}),
    })
    await ctx.shared.put(key, list, WATCH_TTL_SEC)
  }

  async function removeWatcher(ctx: AdapterContext, rec: DepositRecord, owner: string) {
    const key = watchKey(rec)
    const list = (await ctx.shared.get<Watcher[]>(key)) ?? []
    if (!list.some((w) => w.owner === owner)) return
    await ctx.shared.put(key, list.filter((w) => w.owner !== owner && w.until > Date.now()), WATCH_TTL_SEC)
  }

  /** True when the amount is the leg's expected amount, within the tolerance on both sides */
  function exact(w: { expectedBase?: string; minBase?: string }, amount: bigint | undefined): boolean {
    if (amount === undefined || !w.expectedBase || !w.minBase) return false
    const expected = BigInt(w.expectedBase)
    return amount >= BigInt(w.minBase) && amount <= expected + (expected - BigInt(w.minBase))
  }

  /**
   * True when another open leg on the same address could also claim this deposit. A deposit that
   * matches this leg's exact amount, and no rival's exact amount, is not contested.
   */
  async function contested(ctx: AdapterContext, rec: DepositRecord, owner: string, ev: { amount?: bigint; time?: number; block?: bigint }): Promise<boolean> {
    const now = Date.now()
    const rivals = ((await ctx.shared.get<Watcher[]>(watchKey(rec))) ?? []).filter((w) => {
      if (w.owner === owner || w.until <= now) return false
      if (ev.block !== undefined && w.fromBlock && BigInt(w.fromBlock) > ev.block) return false
      if (ev.time !== undefined && Number.isFinite(ev.time) && ev.time < w.since - 60_000) return false
      if (ev.amount !== undefined && w.minBase && ev.amount < BigInt(w.minBase)) return false
      return true
    })
    if (!rivals.length) return false
    if (exact(rec, ev.amount) && !rivals.some((w) => exact(w, ev.amount))) return false
    return true
  }

  /** The leg is done: remove its watch so it no longer contests deposits of other legs */
  async function finish(ctx: AdapterContext, ref: string, rec: DepositRecord | undefined, step: LegStep): Promise<LegStep> {
    if (rec && (step.status === 'succeeded' || step.status === 'failed' || step.status === 'refunded')) await removeWatcher(ctx, rec, ownerOf(ctx, ref))
    return step
  }

  function ambiguousStep(ctx: AdapterContext, ref: string, address: string, waiting: LegStep): LegStep {
    ctx.log.warn(
      `relay: a deposit to ${address} matches more than one open session (ref ${ref}). No session takes it. Use a unique address per session, or a wallet payment or a settlement contract.`,
    )
    return { ...waiting, sub: 'ambiguous_deposit' }
  }

  function requestOutput(r: RelayRequest): Amount | undefined {
    const out = r.data?.route?.actual?.destination?.outputCurrency ?? r.data?.route?.quoted?.destination?.outputCurrency ?? r.data?.metadata?.currencyOut
    if (!out?.currency || !out.amount) return undefined
    return {
      amount: fmt(out),
      asset: { kind: 'crypto', chain: caip2FromRelay(out.currency.chainId), token: out.currency.address, symbol: out.currency.symbol, decimals: out.currency.decimals },
    }
  }

  function requestTxHash(r: RelayRequest): string | undefined {
    const t = r.data?.outTxs?.[0]
    return t?.txHash ?? t?.hash
  }

  function mapRequest(r: RelayRequest, ref: string): LegStep {
    const txHash = requestTxHash(r)
    const output = requestOutput(r)
    const extra = { ref, ...(txHash ? { txHash } : {}), ...(output ? { output } : {}) }
    return terminalStep(r.status, extra) ?? { state: 'PROCESSING', sub: r.status, status: 'processing', transitions: [POLL_TRANSITION], ...extra }
  }

  // ---------- leg specs ----------

  const usdcHops: Record<string, string[]> = Object.fromEntries(HOP_CHAINS.filter((c) => USDC[c]).map((c) => [c, [USDC[c]!]]))

  const legs: LegSpec[] = [
    {
      id: 'wallet',
      kind: 'bridge_swap',
      methods: ['wallet'],
      from: { asset: { kind: 'crypto', chains: '*' }, location: ['user_wallet'] },
      to: { asset: { kind: 'crypto', chains: '*' }, location: ['address'] },
      regions: { allow: ['*'], deny: [] },
      eta: { min: 5, max: 60 },
      surfaces: ['WALLET_TX'],
      requires: ['wallet'],
      // `settlement`: same chain and token only (approve + settle on the destination chain)
      capabilities: ['polling', 'settlement'],
    },
    {
      id: 'transfer',
      kind: 'bridge_swap',
      methods: ['transfer'],
      from: { asset: { kind: 'crypto', chains: '*' }, location: ['user_wallet'] },
      to: { asset: { kind: 'crypto', chains: '*' }, location: ['address'] },
      regions: { allow: ['*'], deny: [] },
      eta: { min: 10, max: 120 },
      surfaces: ['DEPOSIT_ADDRESS'],
      capabilities: ['polling', 'refunds'],
    },
    {
      id: 'bridge',
      kind: 'bridge_swap',
      from: { asset: { kind: 'crypto', chains: usdcHops }, location: ['address'] },
      to: { asset: { kind: 'crypto', chains: '*' }, location: ['address'] },
      regions: { allow: ['*'], deny: [] },
      eta: { min: 5, max: 60 },
      // Not shown to the user: the previous leg delivers into the address.
      surfaces: ['DEPOSIT_ADDRESS'],
      capabilities: ['polling', 'refunds'],
    },
  ]

  // ---------- quote per leg ----------

  async function quoteWallet(input: QuoteInput, ctx: AdapterContext): Promise<LegQuote> {
    const origin: CryptoAsset = input.source
      ? { kind: 'crypto', chain: input.source.chain, token: input.source.token }
      : cryptoAsset(input.amountIn ?? { amount: '0', asset: input.leg.from.asset }, 'source')
    if (!origin.chain.startsWith('eip155:') && origin.chain !== SOLANA_CAIP2) {
      throw new OrkException(orkError('BAD_REQUEST', { message: 'Wallet payments support EVM chains and Solana only. Use "Transfer crypto" instead.' }))
    }
    const dest = destAsset(ctx, input.leg.to.asset.kind === 'crypto' ? input.leg.to.asset : undefined)
    const recipient = recipientOf(ctx, input.deliverTo)
    const user = quoteUser(origin.chain, input.source?.address)
    const inDec = await decimalsOf(ctx, { ...origin, ...(input.amountIn?.asset.kind === 'crypto' && input.amountIn.asset.decimals !== undefined ? { decimals: input.amountIn.asset.decimals } : {}) })
    const originMeta = withMeta(origin, inDec)
    const legEta = legs[0]!.eta

    const settling = settlementOf(ctx, input.deliverTo)
    if (settling && !sameAsset(origin.chain, origin.token, dest.chain, dest.token)) {
      throw new OrkException(
        orkError('BAD_REQUEST', { message: `This payment settles on ${chainName(dest.chain)}. Pay with ${dest.symbol ?? 'the destination token'} on ${chainName(dest.chain)}.`, recovery: 'choose_other' }),
      )
    }

    // Same chain and token: a plain transfer (or a settlement contract call), no Relay.
    if (sameAsset(origin.chain, origin.token, dest.chain, dest.token)) {
      const amount = input.amountIn?.amount ?? input.amountOut?.amount ?? '0'
      return {
        adapterId: 'relay',
        legId: 'wallet',
        input: { amount, asset: originMeta },
        output: { amount, asset: withMeta(dest, inDec) },
        fees: [],
        eta: { min: 5, max: 30 },
        data: { direct: true, recipient, amountBase: toBaseUnits(amount, inDec), decimals: inDec, user },
      }
    }

    const outDec = await decimalsOf(ctx, dest)
    const exactOut = !input.amountIn && !!input.amountOut
    const body = {
      user,
      recipient,
      ...baseBody(origin, dest),
      amount: exactOut ? toBaseUnits(input.amountOut!.amount, outDec) : toBaseUnits(input.amountIn?.amount ?? '0', inDec),
      tradeType: exactOut ? 'EXACT_OUTPUT' : 'EXACT_INPUT',
    }
    const q = await api<RelayQuoteResponse>(ctx, '/quote/v2', body).catch((e) => {
      throw toOrk(e, ctx.log)
    })
    const cin = q.details?.currencyIn
    const cout = q.details?.currencyOut
    if (!cin || !cout) throw new OrkException(orkError('PROVIDER_UNAVAILABLE', { message: 'Relay returned an incomplete quote.' }), 502)
    return {
      adapterId: 'relay',
      legId: 'wallet',
      input: { amount: fmt(cin), asset: withMeta(origin, cin.currency.decimals, cin.currency.symbol) },
      output: { amount: fmt(cout), asset: withMeta(dest, cout.currency.decimals, cout.currency.symbol) },
      fees: feesFrom(q),
      eta: etaFrom(q, legEta),
      expiresAt: new Date(Date.now() + WALLET_QUOTE_TTL_MS).toISOString(),
      data: { direct: false, body, user, quotedAt: Date.now(), steps: q.steps ?? [], requestId: requestIdOf(q), ...minOutputOf(q) },
    }
  }

  async function quoteDeposit(legId: 'transfer' | 'bridge', input: QuoteInput, ctx: AdapterContext): Promise<LegQuote> {
    const origin: CryptoAsset =
      legId === 'transfer' && input.source
        ? { kind: 'crypto', chain: input.source.chain, token: input.source.token }
        : cryptoAsset(input.amountIn ?? { amount: '0', asset: input.leg.from.asset }, 'source')
    const dest = destAsset(ctx, input.leg.to.asset.kind === 'crypto' ? input.leg.to.asset : undefined)
    const recipient = recipientOf(ctx, input.deliverTo)
    const inDec = await decimalsOf(ctx, { ...origin, ...(input.amountIn?.asset.kind === 'crypto' && input.amountIn.asset.decimals !== undefined ? { decimals: input.amountIn.asset.decimals } : {}) })
    const originMeta = withMeta(origin, inDec)
    const spec = legs.find((l) => l.id === legId)!
    const given = input.amountIn?.amount ?? '0'
    const anyAmount = legId === 'transfer'

    if (sameAsset(origin.chain, origin.token, dest.chain, dest.token)) {
      return {
        adapterId: 'relay',
        legId,
        input: { amount: given, asset: originMeta },
        output: { amount: given, asset: withMeta(dest, inDec) },
        fees: [],
        eta: { min: 5, max: 60 },
        data: { direct: true, depositAddress: recipient, anyAmount, nominal: false, ...(cmp(given, '0') > 0 ? { amountBase: toBaseUnits(given, inDec) } : {}) },
      }
    }

    const nominal = cmp(given, '0') <= 0
    const amount = nominal ? nominalAmount(inDec) : given
    const { q, address, requestId } = await depositQuote(ctx, { origin, dest, recipient, amountBase: toBaseUnits(amount, inDec) })
    const cin = q.details?.currencyIn
    const cout = q.details?.currencyOut
    if (!cin || !cout) throw new OrkException(orkError('PROVIDER_UNAVAILABLE', { message: 'Relay returned an incomplete quote.' }), 502)
    return {
      adapterId: 'relay',
      legId,
      input: { amount: fmt(cin), asset: withMeta(origin, cin.currency.decimals, cin.currency.symbol) },
      output: { amount: fmt(cout), asset: withMeta(dest, cout.currency.decimals, cout.currency.symbol) },
      fees: feesFrom(q),
      eta: etaFrom(q, spec.eta),
      // Open deposit addresses accept any amount; the output is the rate-based estimate for `input`.
      data: { direct: false, depositAddress: address, requestId, anyAmount, nominal, recipient, ...(nominal ? {} : { amountBase: cin.amount, ...minOutputOf(q) }) },
    }
  }

  // ---------- start per leg ----------

  /** Wallet transactions from Relay steps. `unsupported` names the first step kind we cannot run (e.g. `signature`). */
  function walletTxsFrom(steps: RelayStep[]): { txs: TxRequest[]; unsupported?: string } {
    const txs: TxRequest[] = []
    let unsupported: string | undefined
    for (const s of steps) {
      if (s.kind !== 'transaction') {
        unsupported ??= s.kind || 'unknown'
        continue
      }
      for (const it of s.items ?? []) {
        if (it.status === 'complete' || !it.data) continue
        const d = it.data
        if (d.instructions) {
          // Solana: the wallet builds a v0 transaction from the instructions and lookup tables.
          txs.push({
            kind: 'solana',
            type: 'instructions',
            instructions: d.instructions,
            ...(d.addressLookupTableAddresses?.length ? { addressLookupTableAddresses: d.addressLookupTableAddresses } : {}),
          })
          continue
        }
        if (!d.to || typeof d.chainId !== 'number') {
          unsupported ??= 'unknown transaction'
          continue
        }
        txs.push({
          to: d.to,
          ...(d.data && d.data !== '0x' ? { data: d.data } : {}),
          ...(d.value && d.value !== '0' ? { value: d.value } : {}),
          chainId: d.chainId,
          ...(d.gas ? { gas: d.gas } : {}),
        })
      }
    }
    return { txs, ...(unsupported ? { unsupported } : {}) }
  }

  function payStep(chain: string, txs: TxRequest[], ref: string): LegStep {
    return {
      state: 'PAYMENT',
      surface: { kind: 'WALLET_TX', chain, txs },
      transitions: [SUBMIT_TX],
      status: 'awaiting_user',
      ref,
    }
  }

  async function rpc<T>(ctx: Pick<AdapterContext, 'fetch' | 'log'>, chain: string, method: string, params: unknown[]): Promise<T> {
    const url = (opts.rpcUrls ?? {})[chain] ?? DEFAULT_RPC_URLS[chain]
    if (!url) throw new OrkException(orkError('PROVIDER_UNAVAILABLE', { message: `No RPC is configured to verify transfers on ${chainName(chain)}.` }), 502)
    return evmRpc<T>(ctx.fetch, url, method, params, { log: ctx.log })
  }

  /** A same-chain wallet payment counts only when the receipt shows it paid the recipient at least the amount. */
  async function verifyDirectWallet(ctx: AdapterContext, ref: string, rec: WalletRecord): Promise<LegStep> {
    const chain = rec.chain!
    if (isSolana(chain)) return verifySolanaWallet(ctx, ref, rec)
    const receipt = await rpc<EvmReceipt | null>(ctx, chain, 'eth_getTransactionReceipt', [rec.txHash])
    const extra = { ref, txHash: rec.txHash! }
    if (!receipt) return { state: 'PROCESSING', sub: 'confirming', status: 'processing', transitions: [POLL_TRANSITION], ...extra }
    const fail = (message: string): LegStep => ({ state: 'FAILED', status: 'failed', transitions: [], error: orkError('DELIVERY_FAILED', { message }), ...extra })
    if (receipt.status !== '0x1') return fail('The transaction failed on chain.')
    // The transaction must be newer than this payment: an older transfer to the same recipient (for
    // example a shared merchant address) must not complete a new session.
    if (rec.since !== undefined) {
      const block = receipt.blockNumber ? await rpc<{ timestamp?: string } | null>(ctx, chain, 'eth_getBlockByNumber', [receipt.blockNumber, false]) : null
      if (!block?.timestamp) return { state: 'PROCESSING', sub: 'confirming', status: 'processing', transitions: [POLL_TRANSITION], ...extra }
      if (Number(BigInt(block.timestamp)) * 1000 < rec.since - DIRECT_TX_CLOCK_SKEW_MS) return fail('The transaction was sent before this payment started.')
    }
    const recipient = (rec.recipient ?? '').toLowerCase()
    let paid = 0n
    if (isNative(chain, rec.token ?? '')) {
      const tx = await rpc<{ to?: string; value?: string } | null>(ctx, chain, 'eth_getTransactionByHash', [rec.txHash])
      if (tx?.to?.toLowerCase() === recipient) paid = BigInt(tx.value ?? '0x0')
    } else {
      paid = erc20PaidTo(receipt, rec.token ?? '', recipient)
    }
    return settleDirect(ctx, ref, rec, paid)
  }

  /** Key that marks a transaction as used. EVM hashes are lowercased; Solana signatures are case-sensitive. */
  function usedKey(chain: string, hash: string) {
    return `txused:${chain}:${isSolana(chain) ? hash : hash.toLowerCase()}`
  }

  /** Common end of a same-chain wallet check: the amount, then one transaction for one payment only. */
  async function settleDirect(ctx: AdapterContext, ref: string, rec: WalletRecord, paid: bigint): Promise<LegStep> {
    const extra = { ref, txHash: rec.txHash! }
    const fail = (message: string): LegStep => ({ state: 'FAILED', status: 'failed', transitions: [], error: orkError('DELIVERY_FAILED', { message }), ...extra })
    if (paid < BigInt(rec.amountBase ?? '0')) return fail('The transaction does not pay the destination the quoted amount.')
    // One transaction can complete one payment only: an old hash must not be reused for a new session.
    const key = usedKey(rec.chain!, rec.txHash!)
    // A transfer leg on the same address may have taken a log of this transaction already.
    if (await ctx.shared.get<string>(`${key}:log`)) return fail('This transaction was already used for another payment.')
    if (!(await claimOnce(ctx.shared, key, ref, USED_TTL_SEC))) return fail('This transaction was already used for another payment.')
    return { state: 'COMPLETED', status: 'succeeded', transitions: [], ...extra, ...(rec.output ? { output: rec.output } : {}) }
  }

  // ---------- Solana on-chain checks (same chain, same token) ----------

  type SolTokenBalance = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }
  type SolTx = {
    blockTime?: number | null
    meta: { err: unknown; preBalances: number[]; postBalances: number[]; preTokenBalances?: SolTokenBalance[]; postTokenBalances?: SolTokenBalance[] } | null
    transaction: { message: { accountKeys: Array<string | { pubkey: string }> } }
  }
  type SolStatus = { err: unknown; confirmationStatus?: 'processed' | 'confirmed' | 'finalized' | null } | null

  /** Net amount (base units) that `tx` moved to `owner`: SOL lamports for `native`, else the SPL `mint` */
  function solanaReceived(tx: SolTx, chain: string, owner: string, token: string): bigint {
    const meta = tx.meta
    if (!meta) return 0n
    if (isNative(chain, token)) {
      const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey))
      const i = keys.indexOf(owner)
      return i < 0 ? 0n : BigInt(meta.postBalances[i] ?? 0) - BigInt(meta.preBalances[i] ?? 0)
    }
    // Sum the change of every token account of `mint` that `owner` owns (a new account has no pre balance).
    const mine = (b: SolTokenBalance) => b.owner === owner && b.mint === token
    const pre = new Map<number, bigint>()
    for (const b of meta.preTokenBalances ?? []) if (mine(b)) pre.set(b.accountIndex, BigInt(b.uiTokenAmount.amount))
    let total = 0n
    for (const b of meta.postTokenBalances ?? []) if (mine(b)) total += BigInt(b.uiTokenAmount.amount) - (pre.get(b.accountIndex) ?? 0n)
    return total
  }

  function solanaTx(ctx: AdapterContext, chain: string, signature: string) {
    return rpc<SolTx | null>(ctx, chain, 'getTransaction', [signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }])
  }

  /**
   * A same-chain Solana payment counts only when the signature is confirmed without error, the
   * transaction is not older than the leg, and it moved at least the amount to the recipient.
   */
  async function verifySolanaWallet(ctx: AdapterContext, ref: string, rec: WalletRecord): Promise<LegStep> {
    const chain = rec.chain!
    const sig = rec.txHash!
    const extra = { ref, txHash: sig }
    const waiting: LegStep = { state: 'PROCESSING', sub: 'confirming', status: 'processing', transitions: [POLL_TRANSITION], ...extra }
    const fail = (message: string): LegStep => ({ state: 'FAILED', status: 'failed', transitions: [], error: orkError('DELIVERY_FAILED', { message }), ...extra })
    const st = await rpc<{ value?: SolStatus[] } | null>(ctx, chain, 'getSignatureStatuses', [[sig], { searchTransactionHistory: true }])
    const s = st?.value?.[0]
    if (!s) return waiting
    if (s.err) return fail('The transaction failed on chain.')
    if (s.confirmationStatus !== 'confirmed' && s.confirmationStatus !== 'finalized') return waiting
    const tx = await solanaTx(ctx, chain, sig)
    if (!tx?.meta) return waiting
    if (tx.meta.err) return fail('The transaction failed on chain.')
    // Like EVM: the transaction must be newer than this payment (block time in seconds).
    if (rec.since !== undefined) {
      if (typeof tx.blockTime !== 'number') return waiting
      if (tx.blockTime * 1000 < rec.since - DIRECT_TX_CLOCK_SKEW_MS) return fail('The transaction was sent before this payment started.')
    }
    return settleDirect(ctx, ref, rec, solanaReceived(tx, chain, rec.recipient ?? '', rec.token ?? ''))
  }

  /**
   * Transfer to the destination itself on Solana: look at recent signatures of the recipient's
   * token accounts (or of the recipient, for SOL) since the leg started. Each signature counts
   * for one payment only.
   */
  async function findSolanaDeposit(ctx: AdapterContext, ref: string, rec: DepositRecord): Promise<LegStep | undefined> {
    const chain = rec.chain!
    const token = rec.token!
    let watch: string[] = [rec.address]
    if (!isNative(chain, token)) {
      const res = await rpc<{ value?: Array<{ pubkey: string }> } | null>(ctx, chain, 'getTokenAccountsByOwner', [rec.address, { mint: token }, { encoding: 'jsonParsed', commitment: 'confirmed' }])
      watch = (res?.value ?? []).map((v) => v.pubkey)
      if (!watch.length) return undefined
    }
    const since = Math.floor(rec.since / 1000) - 60
    // The same address can serve several sessions: a signature belongs to the first session that counts it.
    const owner = `${ctx.session.id}:${ref}`
    const seen = new Set<string>()
    let total = 0n
    let last: string | undefined
    const counted: string[] = []
    for (const account of watch) {
      const sigs = await rpc<Array<{ signature: string; err: unknown; blockTime?: number | null }> | null>(ctx, chain, 'getSignaturesForAddress', [account, { limit: 20, commitment: 'confirmed' }])
      for (const s of sigs ?? []) {
        if (s.err || seen.has(s.signature) || typeof s.blockTime !== 'number' || s.blockTime < since) continue
        seen.add(s.signature)
        const usedBy = await ctx.shared.get<string>(usedKey(chain, s.signature))
        if (usedBy && usedBy !== owner) continue
        const tx = await solanaTx(ctx, chain, s.signature)
        if (!tx?.meta || tx.meta.err) continue
        const got = solanaReceived(tx, chain, rec.address, token)
        if (got <= 0n) continue
        total += got
        counted.push(s.signature)
        last ??= s.signature // newest first
      }
    }
    if (total <= 0n || !last) return undefined
    // Dust, or less than the user said: wait (and do not take the signatures).
    if (rec.minBase && total < BigInt(rec.minBase)) return undefined
    for (const sig of counted) await ctx.shared.put(usedKey(chain, sig), owner, 90 * 24 * 3600)
    const decimals = rec.output?.asset.kind === 'crypto' ? (rec.output.asset.decimals ?? 6) : 6
    return {
      state: 'COMPLETED',
      status: 'succeeded',
      transitions: [],
      ref,
      txHash: last,
      ...(rec.output ? { output: { ...rec.output, amount: fromBaseUnits(total.toString(), decimals) } } : {}),
    }
  }

  /**
   * Same chain and token, through an OpenRampSettlement contract: the wallet approves the contract and
   * calls `settle`. The contract records the session id, so the leg is verified by session id, not by tx hash.
   */
  async function startSettlement(
    input: StartInput,
    ctx: AdapterContext,
    p: { contract: string; chainId: number; recipient: string; amountBase: string },
  ): Promise<LegStep> {
    const origin = cryptoAsset(input.quote.input, 'input')
    const calls = settlementCallsFrom(ctx.destination.type === 'crypto' ? ctx.destination.calls : undefined)
    const amount = BigInt(p.amountBase)
    let intent: SettlementIntent | undefined
    if (opts.signSettlementIntent) {
      const typed = settlementIntentTypedData({
        chainId: p.chainId,
        contract: p.contract,
        sessionId: ctx.session.id,
        token: origin.token,
        recipient: p.recipient,
        minAmount: amount,
        calls,
        deadline: BigInt(Math.floor(Date.now() / 1000) + (opts.settlementIntentTtlSec ?? 1800)),
        ...(input.source?.address ? { payer: input.source.address } : {}),
      })
      intent = { payer: typed.message.payer, minAmount: amount, deadline: typed.message.deadline, signature: await opts.signSettlementIntent(typed) }
    }
    const txs = buildSettlementTxs({ chainId: p.chainId, contract: p.contract, sessionId: ctx.session.id, token: origin.token, amount, recipient: p.recipient, calls, ...(intent ? { intent } : {}) })
    const fromBlock = await rpc<string>(ctx, origin.chain, 'eth_blockNumber', [])
    const ref = `settle:${ctx.session.id}:${randomHex()}`
    await ctx.store.put(
      `w:${ref}`,
      {
        mode: 'direct',
        output: input.quote.output,
        chain: origin.chain,
        token: origin.token,
        recipient: p.recipient,
        amountBase: p.amountBase,
        settlement: { contract: p.contract, callsHash: hashSettlementCalls(calls), fromBlock },
      } satisfies WalletRecord,
      RECORD_TTL_SEC,
    )
    return payStep(origin.chain, txs, ref)
  }

  /** A settlement counts when the contract has a receipt for this session that pays the quoted amount. */
  async function verifySettlementWallet(ctx: AdapterContext, ref: string, rec: WalletRecord): Promise<LegStep> {
    const chain = rec.chain!
    const s = rec.settlement!
    const url = (opts.rpcUrls ?? {})[chain] ?? DEFAULT_RPC_URLS[chain]
    if (!url) throw new OrkException(orkError('PROVIDER_UNAVAILABLE', { message: `No RPC is configured to verify transfers on ${chainName(chain)}.` }), 502)
    const r = await verifySettlement({
      rpcUrl: url,
      contract: s.contract,
      sessionId: ctx.session.id,
      fetch: ctx.fetch,
      log: ctx.log,
      fromBlock: s.fromBlock,
      expect: { token: rec.token!, recipient: rec.recipient!, minAmount: BigInt(rec.amountBase ?? '0'), callsHash: s.callsHash },
    })
    const fail = (message: string, txHash?: string): LegStep => ({
      state: 'FAILED',
      status: 'failed',
      transitions: [],
      error: orkError('DELIVERY_FAILED', { message }),
      ref,
      ...(txHash ? { txHash } : {}),
    })
    if (r.settled) {
      if (!r.ok) return fail(r.problem!, r.record.txHash)
      return { state: 'COMPLETED', status: 'succeeded', transitions: [], ref, txHash: r.record.txHash, ...(rec.output ? { output: rec.output } : {}) }
    }
    if (!rec.txHash) return { state: 'PAYMENT', transitions: [SUBMIT_TX], status: 'awaiting_user', ref }
    const receipt = await rpc<EvmReceipt | null>(ctx, chain, 'eth_getTransactionReceipt', [rec.txHash])
    if (!receipt) return { state: 'PROCESSING', sub: 'confirming', status: 'processing', transitions: [POLL_TRANSITION], ref, txHash: rec.txHash }
    if (receipt.status !== '0x1') return fail('The transaction failed on chain.', rec.txHash)
    return fail('The transaction did not settle this session.', rec.txHash)
  }

  type TransferLog = { data: string; transactionHash: string; blockNumber?: string; logIndex?: string; removed?: boolean }

  /**
   * Transfer to the destination itself (same chain and token, EVM): read the token's Transfer logs to
   * the address, page by page (`logBlockRange` blocks each, at most `LOG_PAGES_PER_CHECK` pages per
   * check). One log completes the leg when it pays at least `minBase` (no sum of small transfers),
   * no other leg has it, and no other open leg on the address could also claim it. The log is then
   * recorded as used, by (chain, tx hash, log index), so it never completes a second session.
   */
  async function findDirectDeposit(ctx: AdapterContext, ref: string, rec: DepositRecord, waiting: LegStep): Promise<LegStep | undefined> {
    if (rec.chain && rec.token && isSolana(rec.chain)) return findSolanaDeposit(ctx, ref, rec)
    if (!rec.chain || !rec.token || !rec.fromBlock || isNative(rec.chain, rec.token)) return undefined
    const chain = rec.chain
    const owner = ownerOf(ctx, ref)
    const min = rec.minBase ? BigInt(rec.minBase) : 1n
    const latest = BigInt(await rpc<string>(ctx, chain, 'eth_blockNumber', []))
    const start = BigInt(rec.scanFrom ?? rec.fromBlock)
    let from = start
    let holdAt: bigint | undefined
    for (let page = 0; page < LOG_PAGES_PER_CHECK && from <= latest; page++) {
      const to = from + logBlockRange - 1n < latest ? from + logBlockRange - 1n : latest
      const logs = await rpc<TransferLog[] | null>(ctx, chain, 'eth_getLogs', [
        { fromBlock: toHex(from), toBlock: toHex(to), address: rec.token, topics: [ERC20_TRANSFER_TOPIC, null, topicAddress(rec.address)] },
      ])
      const ordered = (logs ?? []).filter((l) => !l.removed).sort((a, b) => cmpBig(hexOr(a.blockNumber, from), hexOr(b.blockNumber, from)) || cmpBig(hexOr(a.logIndex, 0n), hexOr(b.logIndex, 0n)))
      for (const l of ordered) {
        const amount = BigInt(l.data)
        if (amount < min) continue // dust, or less than the user said
        const block = hexOr(l.blockNumber, from)
        const key = `${usedKey(chain, l.transactionHash)}:${hexOr(l.logIndex, 0n).toString()}`
        const usedBy = await ctx.shared.get<string>(key)
        if (usedBy && usedBy !== owner) continue
        if (!usedBy) {
          // A same-chain wallet payment already used this transaction.
          if (await ctx.shared.get<string>(usedKey(chain, l.transactionHash))) continue
          if (await contested(ctx, rec, owner, { amount, block })) {
            holdAt ??= block
            continue
          }
          if (!(await claimOnce(ctx.shared, key, owner, USED_TTL_SEC))) continue
          await ctx.shared.put(`${usedKey(chain, l.transactionHash)}:log`, owner, USED_TTL_SEC)
        }
        const decimals = rec.output?.asset.kind === 'crypto' ? (rec.output.asset.decimals ?? 6) : 6
        return finish(ctx, ref, rec, {
          state: 'COMPLETED',
          status: 'succeeded',
          transitions: [],
          ref,
          txHash: l.transactionHash,
          ...(rec.output ? { output: { ...rec.output, amount: fromBaseUnits(amount.toString(), decimals) } } : {}),
        })
      }
      from = to + 1n
    }
    // Go on from here next time. Keep an ambiguous log in range: a rival leg can end and free it.
    const next = holdAt ?? from
    if (next !== start) await ctx.store.put(`d:${addrKey(ref)}`, { ...rec, scanFrom: toHex(next) } satisfies DepositRecord, RECORD_TTL_SEC)
    return holdAt !== undefined ? ambiguousStep(ctx, ref, rec.address, waiting) : undefined
  }

  async function startWallet(input: StartInput, ctx: AdapterContext): Promise<LegStep> {
    const data = (input.quote.data ?? {}) as Record<string, unknown>
    const origin = cryptoAsset(input.quote.input, 'input')

    if (data.direct) {
      const recipient = String(data.recipient)
      const amountBase = String(data.amountBase)
      let tx: TxRequest
      if (isSolana(origin.chain)) {
        const decimals = typeof data.decimals === 'number' ? data.decimals : (origin.decimals ?? knownDecimals(origin.chain, origin.token) ?? 9)
        tx = { kind: 'solana', type: 'transfer', to: recipient, mint: isNative(origin.chain, origin.token) ? 'native' : origin.token, amount: amountBase, decimals }
      } else {
        const chainId = evmChainId(origin.chain)!
        const settling = settlementOf(ctx, input.deliverTo)
        if (settling) return startSettlement(input, ctx, { contract: settling.contract, chainId, recipient, amountBase })
        tx = isNative(origin.chain, origin.token)
          ? { to: recipient, value: amountBase, chainId }
          : { to: origin.token, data: erc20TransferData(recipient, amountBase), chainId }
      }
      const ref = `direct:${ctx.session.id}:${randomHex()}`
      await ctx.store.put(
        `w:${ref}`,
        { mode: 'direct', output: input.quote.output, chain: origin.chain, token: origin.token, recipient, amountBase, since: Date.now() } satisfies WalletRecord,
        RECORD_TTL_SEC,
      )
      return payStep(origin.chain, [tx], ref)
    }

    // Reuse the quote's steps when they are fresh and built for this user, otherwise re-quote.
    let steps = data.steps as RelayStep[] | undefined
    let requestId = data.requestId as string | undefined
    // Only an address of the origin chain's VM can sign (an EVM address cannot pay from Solana).
    const given = input.source?.address
    const user = fitsChain(origin.chain, given) ? given : undefined
    if (isSolana(origin.chain) && !user) {
      throw new OrkException(orkError('BAD_REQUEST', { message: 'Connect a Solana wallet to pay from Solana.', recovery: 'choose_other' }))
    }
    const fresh = typeof data.quotedAt === 'number' && Date.now() - data.quotedAt < WALLET_QUOTE_REUSE_MS
    if (!steps || !fresh || (user && !sameUser(origin.chain, data.user, user))) {
      if (!data.body) throw new OrkException(orkError('QUOTE_EXPIRED'), 410)
      const body = { ...(data.body as Record<string, unknown>), ...(user ? { user } : {}) }
      const q = await api<RelayQuoteResponse>(ctx, '/quote/v2', body).catch((e) => {
        throw toOrk(e, ctx.log)
      })
      steps = q.steps ?? []
      requestId = requestIdOf(q)
    }
    const { txs, unsupported } = walletTxsFrom(steps)
    const ref = requestId ?? `relay:${ctx.session.id}:${randomHex()}`
    if (unsupported || !txs.length) {
      return {
        state: 'FAILED',
        status: 'failed',
        transitions: [],
        ref,
        error: orkError('PROVIDER_DECLINED', {
          message: unsupported
            ? `This route needs a ${unsupported} step, which is not supported yet. Try another token or "Transfer crypto".`
            : 'Relay returned no transactions for this route.',
          recovery: 'choose_other',
        }),
      }
    }
    await ctx.store.put(`w:${ref}`, { mode: 'relay', requestId: ref, chain: origin.chain } satisfies WalletRecord, RECORD_TTL_SEC)
    const first = txs[0]!
    return payStep(isSolanaTx(first) ? origin.chain : caip2FromRelay(first.chainId), txs, ref)
  }

  async function startDeposit(legId: 'transfer' | 'bridge', input: StartInput, ctx: AdapterContext): Promise<LegStep> {
    const data = (input.quote.data ?? {}) as Record<string, unknown>
    const origin = cryptoAsset(input.quote.input, 'input')
    let address = data.depositAddress as string | undefined
    if (!address) {
      const dest = cryptoAsset(input.quote.output, 'output')
      address = await openDepositAddress(ctx, origin, dest, recipientOf(ctx, input.deliverTo))
    }
    // One ref per session and address: the server's ref index then maps one ref to one session.
    const ref = depositRef(ctx, address)
    const key = `d:${addrKey(ref)}`
    const prev = await ctx.store.get<DepositRecord>(key)
    const since = prev?.since ?? Date.now()
    // Same chain and token: the address is the destination itself, so we watch transfers to it from now on
    // (EVM: Transfer logs from this block; Solana: signatures since `since`).
    const fromBlock = data.direct && !isSolana(origin.chain) ? (prev?.fromBlock ?? (await rpc<string>(ctx, origin.chain, 'eth_blockNumber', []))) : undefined
    const expectedBase = expectedOf(input.quote, data, origin)
    const minBase = minFor(expectedBase, legId)
    const rec: DepositRecord = {
      address,
      since,
      mode: data.direct ? 'direct' : 'relay',
      output: input.quote.output,
      chain: origin.chain,
      token: origin.token,
      ...(fromBlock ? { fromBlock } : {}),
      ...(expectedBase ? { expectedBase } : {}),
      ...(minBase ? { minBase } : {}),
      ...(prev?.scanFrom ? { scanFrom: prev.scanFrom } : {}),
      ...(prev?.bound ? { bound: prev.bound } : {}),
    }
    await ctx.store.put(key, rec, RECORD_TTL_SEC)
    await addWatcher(ctx, rec, ownerOf(ctx, ref))

    if (legId === 'bridge') {
      return { state: 'PROCESSING', sub: 'waiting_for_deposit', transitions: [POLL_TRANSITION], status: 'processing', ref }
    }
    const symbol = origin.symbol ?? knownSymbol(origin.chain, origin.token) ?? 'the token'
    const name = chainName(origin.chain)
    return {
      state: 'PAYMENT',
      surface: {
        kind: 'DEPOSIT_ADDRESS',
        chain: origin.chain,
        chainName: name,
        token: origin.token,
        symbol,
        address,
        warning: `Send only ${symbol} on ${name}. Other tokens or chains may be lost.`,
      },
      transitions: [POLL_TRANSITION],
      status: 'awaiting_user',
      ref,
    }
  }

  function depositRef(ctx: Pick<AdapterContext, 'session'>, address: string): string {
    return `dep:${ctx.session.id}:${address}`
  }

  /** The deposit the user said they will send (base units of the origin token), when they gave an amount */
  function expectedOf(quote: LegQuote, data: Record<string, unknown>, origin: CryptoAsset): string | undefined {
    if (typeof data.amountBase === 'string' && /^[0-9]+$/.test(data.amountBase)) return data.amountBase
    if (data.nominal || data.depositAddress) return undefined
    // A quote without our data (e.g. from an older server): use its input when the decimals are known.
    const decimals = origin.decimals ?? knownDecimals(origin.chain, origin.token)
    if (decimals === undefined || cmp(quote.input.amount, '0') <= 0) return undefined
    return toBaseUnits(quote.input.amount, decimals)
  }

  return createAdapter({
    id: 'relay',
    name: 'Relay',
    legs,

    async quote(input, ctx) {
      warnNoKey(ctx.log)
      switch (input.leg.legId) {
        case 'wallet':
          return quoteWallet(input, ctx)
        case 'transfer':
          return quoteDeposit('transfer', input, ctx)
        case 'bridge':
          return quoteDeposit('bridge', input, ctx)
        default:
          throw new OrkException(orkError('NOT_FOUND', { message: `Unknown Relay leg ${input.leg.legId}` }), 404)
      }
    },

    async prepareDeposit(input, ctx) {
      const origin = cryptoAsset({ amount: '0', asset: input.leg.from.asset }, 'hop asset')
      const dest = destAsset(ctx, input.leg.to.asset.kind === 'crypto' ? input.leg.to.asset : undefined)
      const recipient = recipientOf(ctx)
      warnNoKey(ctx.log)
      const address = await openDepositAddress(ctx, origin, dest, recipient)
      // Remember when this session first used the address, so status ignores older deposits.
      const ref = depositRef(ctx, address)
      const key = `d:${addrKey(ref)}`
      if (!(await ctx.store.get(key))) {
        await ctx.store.put(key, { address, since: Date.now(), mode: address === recipient ? 'direct' : 'relay' } satisfies DepositRecord, RECORD_TTL_SEC)
      }
      return { address, ref }
    },

    async start(input, ctx) {
      switch (input.leg.legId) {
        case 'wallet':
          return startWallet(input, ctx)
        case 'transfer':
          return startDeposit('transfer', input, ctx)
        case 'bridge':
          return startDeposit('bridge', input, ctx)
        default:
          throw new OrkException(orkError('NOT_FOUND', { message: `Unknown Relay leg ${input.leg.legId}` }), 404)
      }
    },

    async transition(input, ctx) {
      if (input.leg.legId !== 'wallet' || input.name !== 'submit_tx') {
        throw new OrkException(orkError('BAD_REQUEST', { message: `Transition ${input.name} is not supported.` }), 409)
      }
      const txHash = String(input.inputs?.txHash ?? input.inputs?.hash ?? '').trim()
      const rec = (await ctx.store.get<WalletRecord>(`w:${input.ref}`)) ?? { mode: 'relay' as const, requestId: input.ref }
      // EVM: a 32-byte hex hash. Solana: a base58 signature.
      const evmHash = /^0x[0-9a-fA-F]{64}$/.test(txHash)
      const ok = rec.chain ? (isSolana(rec.chain) ? isSolanaSignature(txHash) : evmHash) : evmHash || isSolanaSignature(txHash)
      if (!ok) throw new OrkException(orkError('BAD_REQUEST', { message: 'A transaction hash is required.' }))
      await ctx.store.put(`w:${input.ref}`, { ...rec, txHash } satisfies WalletRecord, RECORD_TTL_SEC)
      return { state: 'PROCESSING', transitions: [POLL_TRANSITION], status: 'processing', ref: input.ref, txHash }
    },

    async status(input, ctx) {
      const { legId } = input.leg
      if (legId === 'wallet') {
        const rec = await ctx.store.get<WalletRecord>(`w:${input.ref}`)
        if (rec?.mode === 'direct' && rec.settlement) return verifySettlementWallet(ctx, input.ref, rec)
        if (rec?.mode === 'direct') {
          // Same-chain transfer: the wallet's tx hash is checked on chain before the leg counts.
          if (!rec.txHash) return { state: 'PAYMENT', transitions: [SUBMIT_TX], status: 'awaiting_user', ref: input.ref }
          return verifyDirectWallet(ctx, input.ref, rec)
        }
        const s = await api<RelayIntentStatus>(ctx, `/intents/status/v3?requestId=${encodeURIComponent(input.ref)}`).catch((e) => {
          throw toOrk(e, ctx.log)
        })
        const txHash = s.txHashes?.[0] ?? rec?.txHash
        const extra = { ref: input.ref, ...(txHash ? { txHash } : {}) }
        const done = terminalStep(s.status, extra)
        if (done) return done
        if (!rec?.txHash && !s.inTxHashes?.length) {
          return { state: 'PAYMENT', transitions: [SUBMIT_TX], status: 'awaiting_user', ref: input.ref }
        }
        return { state: 'PROCESSING', sub: s.status, status: 'processing', transitions: [POLL_TRANSITION], ...extra }
      }

      // transfer / bridge: look for deposits into the address
      const rec = await ctx.store.get<DepositRecord>(`d:${addrKey(input.ref)}`)
      const waiting: LegStep =
        legId === 'bridge'
          ? { state: 'PROCESSING', sub: 'waiting_for_deposit', status: 'processing', transitions: [POLL_TRANSITION], ref: input.ref }
          : { state: 'PAYMENT', status: 'awaiting_user', transitions: [POLL_TRANSITION], ref: input.ref }
      // Same chain and token: the address is the destination itself; look for Transfer logs to it.
      if (rec?.mode === 'direct') return (await findDirectDeposit(ctx, input.ref, rec, waiting)) ?? waiting
      return findRelayDeposit(ctx, input.ref, rec, waiting).catch((e) => {
        throw toOrk(e, ctx.log)
      })
    },

    async health(ctx) {
      try {
        const res = await api<{ chains?: unknown[] }>(ctx, '/chains')
        return { ok: Array.isArray(res.chains) && res.chains.length > 0 }
      } catch (e) {
        return { ok: false, detail: String((e as Error)?.message ?? e).slice(0, 200) }
      }
    },
  })
}

