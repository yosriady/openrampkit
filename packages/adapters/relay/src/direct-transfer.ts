// Deposits to an address that several legs can watch: one deposit completes one leg only.
// - Watchers: each open deposit leg on an address, so a deposit that two legs could claim is ambiguous.
// - The smallest deposit that completes a leg (the expected amount minus the tolerance).
// - Same chain and token, to the destination itself: Transfer logs (EVM) and signatures (Solana).

import { ERC20_TRANSFER_TOPIC, claimOnce, minWithToleranceBps, topicAddress } from '@openrampkit/adapter'
import type { AdapterContext } from '@openrampkit/adapter'
import { fromBaseUnits } from '@openrampkit/core'
import type { LegStep } from '@openrampkit/core'
import type { RelayRuntime } from './client.js'
import { HOP_TOLERANCE_BPS, LOG_PAGES_PER_CHECK, RECORD_TTL_SEC, USED_TTL_SEC, WATCH_TTL_SEC } from './config.js'
import { addrKey, cmpBig, hexOr, isNative, isSolana, toHex, usedKey } from './helpers.js'
import { solanaReceived } from './solana.js'
import type { DepositRecord, Watcher } from './types.js'

export type DirectTransfer = ReturnType<typeof directTransfer>

export function directTransfer(rt: RelayRuntime) {
  const { toleranceBps, logBlockRange, rpc, solanaTx } = rt

  // ---------- one deposit for one leg ----------

  /** Who claims a deposit: the session and the leg ref */
  function ownerOf(ctx: AdapterContext, ref: string): string {
    return `${ctx.session.id}:${ref}`
  }

  /** Smallest deposit that completes a leg: the expected amount minus the tolerance (bigint math) */
  function minFor(expectedBase: string | undefined, legId: 'transfer' | 'bridge'): string | undefined {
    if (!expectedBase) return undefined
    if (BigInt(expectedBase) <= 0n) return undefined
    return minWithToleranceBps(expectedBase, legId === 'bridge' ? Math.max(toleranceBps, HOP_TOLERANCE_BPS) : toleranceBps)
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

  /**
   * Transfer to the destination itself on Solana: look at recent signatures of the recipient's
   * token accounts (or of the recipient, for SOL) since the leg started. The same rules as Transfer
   * logs on EVM: one signature completes the leg when it pays at least `minBase` on its own (no sum
   * of small transfers), no other leg has it, and no other open leg on the address could also claim
   * it. The signature is then claimed with `claimOnce` (`txused:<chain>:<signature>`), so it never
   * completes a second session or a same-chain wallet payment.
   */
  async function findSolanaDeposit(ctx: AdapterContext, ref: string, rec: DepositRecord, waiting: LegStep): Promise<LegStep | undefined> {
    const chain = rec.chain!
    const token = rec.token!
    let watch: string[] = [rec.address]
    if (!isNative(chain, token)) {
      const res = await rpc<{ value?: Array<{ pubkey: string }> } | null>(ctx, chain, 'getTokenAccountsByOwner', [rec.address, { mint: token }, { encoding: 'jsonParsed', commitment: 'confirmed' }])
      watch = (res?.value ?? []).map((v) => v.pubkey)
      if (!watch.length) return undefined
    }
    const since = Math.floor(rec.since / 1000) - 60
    const owner = ownerOf(ctx, ref)
    const min = rec.minBase ? BigInt(rec.minBase) : 1n
    // New, successful signatures on the watched accounts, oldest first (block time, then signature),
    // so that all sessions on the address look at them in the same order.
    const seen = new Set<string>()
    const sigs: Array<{ signature: string; time: number }> = []
    for (const account of watch) {
      const page = await rpc<Array<{ signature: string; err: unknown; blockTime?: number | null }> | null>(ctx, chain, 'getSignaturesForAddress', [account, { limit: 20, commitment: 'confirmed' }])
      for (const s of page ?? []) {
        if (s.err || seen.has(s.signature) || typeof s.blockTime !== 'number' || s.blockTime < since) continue
        seen.add(s.signature)
        sigs.push({ signature: s.signature, time: s.blockTime })
      }
    }
    sigs.sort((x, y) => x.time - y.time || (x.signature < y.signature ? -1 : x.signature > y.signature ? 1 : 0))
    const owners = await Promise.all(sigs.map((s) => ctx.shared.get<string>(usedKey(chain, s.signature))))
    // A signature this leg claimed before: the same answer again (a retry, or a check after completion).
    const mine = sigs.findIndex((_, i) => owners[i] === owner)
    const candidates = mine >= 0 ? [sigs[mine]!] : sigs.filter((_, i) => !owners[i])
    let ambiguous = false
    for (const s of candidates) {
      const tx = await solanaTx(ctx, chain, s.signature)
      if (!tx?.meta || tx.meta.err) continue
      const amount = solanaReceived(tx, chain, rec.address, token)
      if (mine < 0) {
        if (amount < min) continue // dust, a third-party transfer, or less than the user said
        // Another open leg on the address could also claim it: no leg takes it.
        if (await contested(ctx, rec, owner, { amount, time: s.time * 1000 })) {
          ambiguous = true
          continue
        }
        // Race: with `putIfAbsent`, when two sessions pick the same signature at the same time,
        // exactly one claim wins. The loser goes on to the next signature. Without `putIfAbsent`,
        // `claimOnce` writes, then reads back: this catches most races, not all.
        if (!(await claimOnce(ctx.shared, usedKey(chain, s.signature), owner, USED_TTL_SEC))) continue
      }
      const decimals = rec.output?.asset.kind === 'crypto' ? (rec.output.asset.decimals ?? 6) : 6
      return finish(ctx, ref, rec, {
        state: 'COMPLETED',
        status: 'succeeded',
        transitions: [],
        ref,
        txHash: s.signature,
        sourceTxHash: s.signature,
        ...(rec.output ? { output: { ...rec.output, value: fromBaseUnits(amount.toString(), decimals) } } : {}),
      })
    }
    return ambiguous ? ambiguousStep(ctx, ref, rec.address, waiting) : undefined
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
    if (rec.chain && rec.token && isSolana(rec.chain)) return findSolanaDeposit(ctx, ref, rec, waiting)
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
        sourceTxHash: l.transactionHash,
          ...(rec.output ? { output: { ...rec.output, value: fromBaseUnits(amount.toString(), decimals) } } : {}),
        })
      }
      from = to + 1n
    }
    // Go on from here next time. Keep an ambiguous log in range: a rival leg can end and free it.
    const next = holdAt ?? from
    if (next !== start) await ctx.store.put(`d:${addrKey(ref)}`, { ...rec, scanFrom: toHex(next) } satisfies DepositRecord, RECORD_TTL_SEC)
    return holdAt !== undefined ? ambiguousStep(ctx, ref, rec.address, waiting) : undefined
  }

  return { ownerOf, minFor, addWatcher, contested, finish, ambiguousStep, findDirectDeposit }
}
