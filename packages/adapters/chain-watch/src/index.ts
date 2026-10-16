// Chain-watch adapter: standing deposit addresses for the same token on the same chain, with no
// provider. The user sends the destination token on the destination chain, so no bridge is needed:
// the deposit address is the destination address itself. The adapter watches the chain and reports
// each transfer in as one deposit (`standingDeposits`); the server makes one session per deposit.
//
// - EVM: ERC-20 Transfer logs to the address (`eth_getLogs`, page by page). Native ETH transfers
//   have no log, so a native EVM route is refused.
// - Solana: signatures of the address (SOL) or of its token accounts (SPL), read at `finalized`.
//
// Money safety:
// - Confirmations: a log counts only when its block has `confirmations` blocks on top (default 12).
//   `status()` reads the receipt again before the leg succeeds: a log that a re-org took away fails
//   the leg, and a log that moved to a new block waits for its confirmations again.
// - No double counting: each log (chain, tx hash, log index) or Solana signature is claimed once
//   (`claimOnce`), and the deposit id is the same on every poll, so the server makes one session.
// - One owner per address: a destination address (with its chain and token) belongs to the first user
//   that gets a standing address for it. Another user gets a 409.
// - Amounts: a transfer below `minDeposit` (default: any amount above 0) is not a deposit, and
//   `status()` checks that the chain still shows the same amount.
//
// Server-side only. Web-standard APIs only (fetch), so it runs on Cloudflare Workers.

import { claimOnce, createAdapter, createChainWatch, ERC20_TRANSFER_TOPIC, solanaMintDecimals, solanaNetReceived, topicAddress, txUsedKey } from '@openrampkit/adapter'
import type { AdapterContext, ChainWatchOptions, ScopedKV, SolanaBalanceTx, StandingAddressInput, StandingDeposit, StandingDepositsInput } from '@openrampkit/adapter'
import { OpenRampException, fromBaseUnits, isEvmChain, isSolanaChain, isUsdc, nativeDecimals, normalizeToken, openRampError, toBaseUnits } from '@openrampkit/core'
import type { CryptoAsset, LegSpec, LegStep } from '@openrampkit/core'

export type ChainWatchAdapterOptions = ChainWatchOptions & {
  /**
   * The smallest transfer that counts as a deposit, in token units (for example `'1'` for 1 USDC), per
   * `{chain}:{token}` (CAIP-2 chain, then the token address, lower case on EVM chains, or `native`).
   * Smaller transfers are ignored. Default: any amount above 0.
   */
  minDeposit?: Record<string, string>
}

/** The `transfer` leg of a deposit session. The planner never sees it (`catalog` returns no legs). */
const TRANSFER_LEG: LegSpec = {
  id: 'transfer',
  kind: 'wallet_transfer',
  methods: ['transfer'],
  from: { asset: { kind: 'crypto', chains: '*' }, location: ['user_wallet'] },
  to: { asset: { kind: 'crypto', chains: '*' }, location: ['address'] },
  regions: { allow: ['*'], deny: [] },
  eta: { min: 30, max: 900 },
  surfaces: ['DEPOSIT_ADDRESS'],
}

/** A deposit that `status()` cannot find on chain this long after it was seen was dropped (a re-org) */
const DROPPED_AFTER_MS = 60 * 60_000
/** How long a claimed log or signature stays recorded (longer than any poll window of the server) */
const USED_TTL_SEC = 400 * 24 * 60 * 60
/** Deposits that `standingDeposits` lists again, so the server sees a deposit it could not save */
const RECENT_MAX = 200
const RECENT_MS = 7 * 24 * 60 * 60_000
/** Solana: signatures per `getSignaturesForAddress` page */
const SOLANA_PAGE = 100
const EVM_NATIVE = '0x0000000000000000000000000000000000000000'

/** The ref of a standing address: `cw1|{chain}|{token}|{address}|{start block (EVM)}|{start ms}` */
type AddressRef = { chain: string; token: string; address: string; startBlock?: bigint; startMs: number }
/** The leg ref of one deposit: `cwd|{chain}|{token}|{address}|{tx}|{log index}|{amount}|{seen ms}` */
type DepositRef = { chain: string; token: string; address: string; tx: string; logIndex?: bigint; amount: bigint; seenAt: number }

/** What the adapter keeps for one address between polls */
type ScanState = {
  /** EVM: the next block to read */
  next?: string
  /** Solana: the newest signature read, per watched account */
  last?: Record<string, string>
  /** Deposits listed lately (listed again while `at >= since`) */
  recent: StandingDeposit[]
}

const bad = (message: string, status = 400) => new OpenRampException(openRampError(status === 409 ? 'CONFLICT' : 'BAD_REQUEST', { message }), status)
const addrKey = (a: string) => (a.startsWith('0x') ? a.toLowerCase() : a)
const isNativeToken = (chain: string, token: string) => token === 'native' || (isEvmChain(chain) && token.toLowerCase() === EVM_NATIVE)

function parseAddressRef(ref: string): AddressRef {
  const [tag, chain, token, address, block, ms] = ref.split('|')
  if (tag !== 'cw1' || !chain || !token || !address) throw bad('This is not a chain-watch standing address.')
  return { chain, token, address, ...(block ? { startBlock: BigInt(block) } : {}), startMs: Number(ms) || 0 }
}

function depositRef(d: DepositRef): string {
  return ['cwd', d.chain, d.token, d.address, d.tx, d.logIndex === undefined ? '' : d.logIndex.toString(), d.amount.toString(), String(d.seenAt)].join('|')
}

function parseDepositRef(ref: string): DepositRef | undefined {
  const [tag, chain, token, address, tx, logIndex, amount, seenAt] = ref.split('|')
  if (tag !== 'cwd' || !chain || !token || !address || !tx || !amount || !/^[0-9]+$/.test(amount)) return undefined
  return { chain, token, address, tx, ...(logIndex ? { logIndex: BigInt(logIndex) } : {}), amount: BigInt(amount), seenAt: Number(seenAt) || 0 }
}

type Ctx = Pick<AdapterContext, 'fetch' | 'log' | 'shared'>
type EvmLogReceipt = { status?: string; blockNumber?: string; logs?: Array<{ address: string; topics: string[]; data: string; logIndex?: string; removed?: boolean }> }

export function chainWatch(opts: ChainWatchAdapterOptions = {}) {
  const watch = createChainWatch(opts)

  /** The smallest deposit (base units) of a token */
  function minBase(chain: string, token: string, decimals: number): bigint {
    const v = opts.minDeposit?.[`${chain}:${normalizeToken(chain, token)}`]
    if (v === undefined) return 1n
    const base = BigInt(toBaseUnits(v, decimals))
    return base > 0n ? base : 1n
  }

  /** The decimals of a token: known ones, else ERC-20 `decimals()` (cached), else Solana token balances */
  async function decimalsOf(ctx: Pick<Ctx, 'fetch' | 'log'> & { shared: ScopedKV }, chain: string, token: string, hint?: { decimals?: number; tx?: SolanaBalanceTx }): Promise<number> {
    if (typeof hint?.decimals === 'number') return hint.decimals
    if (isNativeToken(chain, token)) return nativeDecimals(chain)
    if (isUsdc(chain, token)) return 6
    if (isSolanaChain(chain)) {
      const d = hint?.tx ? solanaMintDecimals(hint.tx, token) : undefined
      if (d !== undefined) return d
      const info = await watch.rpc<{ value?: { decimals?: number } } | null>(ctx, chain, 'getTokenSupply', [token])
      if (typeof info?.value?.decimals !== 'number') throw new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message: 'Could not read the token decimals.' }), 502)
      return info.value.decimals
    }
    const key = `dec:${chain}:${token.toLowerCase()}`
    const cached = await ctx.shared.get<number>(key)
    if (typeof cached === 'number') return cached
    const hex = await watch.rpc<string>(ctx, chain, 'eth_call', [{ to: token, data: '0x313ce567' }, 'latest'])
    const d = Number(BigInt(hex && hex !== '0x' ? hex : '0x0'))
    if (!Number.isInteger(d) || d < 0 || d > 36 || hex === '0x') throw new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message: 'Could not read the token decimals.' }), 502)
    await ctx.shared.put(key, d, 30 * 24 * 60 * 60)
    return d
  }

  // ---------- the address ----------

  async function standingAddress(input: StandingAddressInput, ctx: Ctx): Promise<{ address: string; ref: string }> {
    const { origin, destination: d } = input
    if (origin.chain !== d.chain || normalizeToken(origin.chain, origin.token) !== normalizeToken(d.chain, d.token)) {
      throw bad('chain-watch gives standing addresses only for the same token on the same chain (the address is the destination itself).')
    }
    const chain = d.chain
    const token = normalizeToken(chain, d.token)
    if (!isEvmChain(chain) && !isSolanaChain(chain)) throw bad(`chain-watch does not watch ${chain}.`)
    if (isEvmChain(chain) && isNativeToken(chain, token)) throw bad('chain-watch cannot watch native transfers on EVM chains (they have no log). Use a token such as USDC.')
    if (!watch.rpcUrl(chain)) throw bad(`chain-watch has no RPC URL for ${chain}. Set chainWatch({ rpcUrls }).`)
    // One user per address: the first user that asks owns the deposits to it.
    const owner = `owner:${chain}:${token}:${addrKey(d.address)}`
    if (!(await claimOnce(ctx.shared, owner, input.userId, 0))) {
      throw bad('This destination address already has a standing address for another user.', 409)
    }
    // The start of the watch: kept, so the same route always gets the same ref.
    const startKey = `start:${chain}:${token}:${addrKey(d.address)}`
    let ref = await ctx.shared.get<string>(startKey)
    if (!ref) {
      // EVM: from the next block, so a transfer mined before the address existed is not a deposit.
      const startBlock = isEvmChain(chain) ? ((await watch.latestBlock(ctx, chain)) + 1n).toString() : ''
      const fresh = ['cw1', chain, token, d.address, startBlock, String(Date.now())].join('|')
      if (ctx.shared.putIfAbsent) {
        if (!(await ctx.shared.putIfAbsent(startKey, fresh, 0))) ref = await ctx.shared.get<string>(startKey)
      } else await ctx.shared.put(startKey, fresh)
      ref ??= fresh
    }
    return { address: d.address, ref }
  }

  // ---------- the deposits ----------

  /** The claim owner of the deposits to one address */
  const ownerOf = (r: AddressRef) => `standing:${r.chain}:${r.token}:${addrKey(r.address)}`

  async function evmDeposits(ctx: Ctx, r: AddressRef, state: ScanState): Promise<StandingDeposit[]> {
    const latest = await watch.latestBlock(ctx, r.chain)
    const safe = latest - BigInt(watch.confirmationsFor(r.chain))
    let from = state.next ? BigInt(state.next) : (r.startBlock ?? safe)
    if (from > safe) return []
    const decimals = await decimalsOf(ctx, r.chain, r.token)
    const min = minBase(r.chain, r.token, decimals)
    const owner = ownerOf(r)
    const out: StandingDeposit[] = []
    for await (const page of watch.transferLogPages(ctx, { chain: r.chain, token: r.token, to: r.address, from, latest: safe })) {
      for (const l of page.logs) {
        const amount = BigInt(l.data)
        if (amount < min) continue // dust, or below `minDeposit`
        const logIndex = l.logIndex ? BigInt(l.logIndex) : 0n
        // One log, one deposit: a log that another owner took is not ours.
        if (!(await claimOnce(ctx.shared, `${txUsedKey(r.chain, l.transactionHash)}:${logIndex}`, owner, USED_TTL_SEC))) continue
        const now = Date.now()
        out.push({
          id: `${r.chain}:${l.transactionHash.toLowerCase()}:${logIndex}`,
          legRef: depositRef({ chain: r.chain, token: r.token, address: r.address, tx: l.transactionHash.toLowerCase(), logIndex, amount, seenAt: now }),
          at: now,
          input: { value: fromBaseUnits(amount.toString(), decimals), asset: { kind: 'crypto', chain: r.chain, token: r.token, decimals } },
        })
      }
      from = page.to + 1n
    }
    state.next = from.toString()
    return out
  }

  async function solanaDeposits(ctx: Ctx, r: AddressRef, state: ScanState): Promise<StandingDeposit[]> {
    const native = isNativeToken(r.chain, r.token)
    const mint = native ? 'native' : r.token
    const accounts = native ? [r.address] : await watch.solanaTokenAccounts(ctx, r.chain, r.address, r.token)
    const sinceSec = Math.floor(r.startMs / 1000) - 60
    const last: Record<string, string> = { ...state.last }
    const found = new Map<string, number>()
    for (const account of accounts) {
      let before: string | undefined
      let newest: string | undefined
      for (let page = 0; page < watch.maxLogPages; page++) {
        const sigs = await watch.solanaSignatures(ctx, r.chain, account, { limit: SOLANA_PAGE, ...(before ? { before } : {}), ...(last[account] ? { until: last[account] } : {}) })
        newest ??= sigs[0]?.signature
        let older = false
        for (const s of sigs) {
          if (typeof s.blockTime === 'number' && s.blockTime < sinceSec) {
            older = true
            break
          }
          if (!s.err) found.set(s.signature, s.blockTime ?? 0)
        }
        if (older || sigs.length < SOLANA_PAGE) break
        before = sigs[sigs.length - 1]!.signature
        if (page === watch.maxLogPages - 1) ctx.log.warn('chain-watch: more signatures at a standing address than one poll reads; older ones are skipped', { address: r.address })
      }
      if (newest) last[account] = newest
    }
    const owner = ownerOf(r)
    const out: StandingDeposit[] = []
    // Oldest first, so the order is the same on every poll.
    for (const [sig] of [...found].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))) {
      const tx = await watch.solanaTx<SolanaBalanceTx>(ctx, r.chain, sig)
      if (!tx?.meta || tx.meta.err) continue
      const amount = solanaNetReceived(tx, r.address, mint)
      const decimals = await decimalsOf(ctx, r.chain, r.token, { tx })
      if (amount < minBase(r.chain, r.token, decimals)) continue // the owner sent, dust, or below `minDeposit`
      if (!(await claimOnce(ctx.shared, txUsedKey(r.chain, sig), owner, USED_TTL_SEC))) continue
      const now = Date.now()
      out.push({
        id: `${r.chain}:${sig}`,
        legRef: depositRef({ chain: r.chain, token: r.token, address: r.address, tx: sig, amount, seenAt: now }),
        at: now,
        input: { value: fromBaseUnits(amount.toString(), decimals), asset: { kind: 'crypto', chain: r.chain, token: r.token, decimals } },
      })
    }
    state.last = last
    return out
  }

  /**
   * The new deposits at a standing address, plus the ones listed since `since` (so a deposit that the
   * server could not save is listed again). The scan goes on from where the last poll stopped.
   */
  async function standingDeposits(input: StandingDepositsInput, ctx: Ctx): Promise<StandingDeposit[]> {
    const r = parseAddressRef(input.ref)
    const key = `scan:${r.chain}:${r.token}:${addrKey(r.address)}`
    const state: ScanState = (await ctx.shared.get<ScanState>(key)) ?? { recent: [] }
    const fresh = isSolanaChain(r.chain) ? await solanaDeposits(ctx, r, state) : await evmDeposits(ctx, r, state)
    const now = Date.now()
    const known = new Set(state.recent.map((d) => d.id))
    state.recent = [...state.recent, ...fresh.filter((d) => !known.has(d.id))].filter((d) => now - d.at < RECENT_MS).slice(-RECENT_MAX)
    await ctx.shared.put(key, state, 0)
    return state.recent.filter((d) => d.at >= input.since)
  }

  // ---------- the status of one deposit ----------

  function outputAsset(ctx: AdapterContext, d: DepositRef, decimals: number): CryptoAsset {
    const dest = ctx.destination
    if (dest.type === 'crypto' && dest.chain === d.chain && normalizeToken(d.chain, dest.token) === d.token) {
      return { kind: 'crypto', chain: dest.chain, token: dest.token, ...(dest.symbol ? { symbol: dest.symbol } : {}), decimals }
    }
    return { kind: 'crypto', chain: d.chain, token: d.token, decimals }
  }

  function done(ctx: AdapterContext, ref: string, d: DepositRef, decimals: number): LegStep {
    return {
      status: 'succeeded',
      ref,
      transactions: [
        { role: 'source', hash: d.tx, chain: d.chain },
        { role: 'destination', hash: d.tx, chain: d.chain },
      ],
      output: { value: fromBaseUnits(d.amount.toString(), decimals), asset: outputAsset(ctx, d, decimals) },
    }
  }

  function confirming(ref: string, d: DepositRef): LegStep {
    return { status: 'processing', detail: { code: 'confirming' }, ref, transactions: [{ role: 'source', hash: d.tx, chain: d.chain }] }
  }

  /** Not found on chain: wait a while (a node that lags), then fail (a re-org dropped it) */
  function missing(ref: string, d: DepositRef, why: string): LegStep {
    if (Date.now() - d.seenAt < DROPPED_AFTER_MS) return confirming(ref, d)
    return failed(ref, d, why)
  }

  function failed(ref: string, d: DepositRef, message: string): LegStep {
    return { status: 'failed', ref, error: openRampError('DELIVERY_FAILED', { message, recovery: 'contact_support' }), transactions: [{ role: 'source', hash: d.tx, chain: d.chain }] }
  }

  async function status(ctx: AdapterContext, ref: string): Promise<LegStep> {
    const d = parseDepositRef(ref)
    if (!d) throw new OpenRampException(openRampError('NOT_FOUND', { message: 'Unknown chain-watch deposit.' }), 404)
    if (isSolanaChain(d.chain)) {
      const tx = await watch.solanaTx<SolanaBalanceTx>(ctx, d.chain, d.tx)
      if (!tx?.meta) return missing(ref, d, 'The transfer is no longer on chain.')
      if (tx.meta.err) return failed(ref, d, 'The transfer failed on chain.')
      const amount = solanaNetReceived(tx, d.address, isNativeToken(d.chain, d.token) ? 'native' : d.token)
      if (amount !== d.amount) return failed(ref, d, 'The transfer on chain does not match the deposit.')
      return done(ctx, ref, d, await decimalsOf(ctx, d.chain, d.token, { tx }))
    }
    // EVM: the receipt must still have the same log (a re-org can drop it or move it to another block).
    const receipt = await watch.rpc<EvmLogReceipt | null>(ctx, d.chain, 'eth_getTransactionReceipt', [d.tx])
    if (!receipt?.blockNumber) return missing(ref, d, 'The transfer is no longer on chain (a re-org dropped it).')
    if (receipt.status !== undefined && BigInt(receipt.status) !== 1n) return failed(ref, d, 'The transfer failed on chain.')
    // The same transfer: token, recipient and amount. Its log index can change when a re-org puts the
    // transaction in another block, so the index is not part of the check.
    const to = topicAddress(d.address)
    const same = (receipt.logs ?? []).some(
      (l) => !l.removed && l.address.toLowerCase() === d.token && l.topics[0] === ERC20_TRANSFER_TOPIC && l.topics[2]?.toLowerCase() === to && BigInt(l.data) === d.amount,
    )
    if (!same) return failed(ref, d, 'The transfer on chain does not match the deposit.')
    const latest = await watch.latestBlock(ctx, d.chain)
    if (latest - BigInt(receipt.blockNumber) < BigInt(watch.confirmationsFor(d.chain))) return confirming(ref, d)
    return done(ctx, ref, d, await decimalsOf(ctx, d.chain, d.token, { ...(ctx.destination.type === 'crypto' && ctx.destination.decimals !== undefined ? { decimals: ctx.destination.decimals } : {}) }))
  }

  const noLegs = () => new OpenRampException(openRampError('NOT_FOUND', { message: 'chain-watch has no session legs: it only watches standing deposit addresses.' }), 404)

  return createAdapter({
    id: 'chain-watch',
    name: 'On-chain transfer',
    legs: [TRANSFER_LEG],
    // No legs for the planner: the `transfer` leg is only for deposit sessions of standing addresses.
    async catalog() {
      return []
    },
    standingRoutes: ['same'],
    standingAddress,
    standingDeposits,
    async quote() {
      throw noLegs()
    },
    async start() {
      throw noLegs()
    },
    async status(input, ctx) {
      return status(ctx, input.ref)
    },
  })
}
