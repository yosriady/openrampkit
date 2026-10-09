// The `wallet` leg: Relay's transaction steps, or (same chain and token) a plain transfer or a
// settlement contract call, checked on chain (EVM receipts and Solana transactions).

import { buildSettlementTxs, claimOnce, erc20PaidTo, erc20TransferData, hashSettlementCalls, randomHex, settlementCallsFrom, settlementIntentTypedData, verifySettlement } from '@openrampkit/adapter'
import type { AdapterContext, EvmReceipt, SettlementIntent, StartInput } from '@openrampkit/adapter'
import { OpenRampException, chainName, evmChainId, isSolanaTx, openRampError } from '@openrampkit/core'
import type { LegStep, TxRequest } from '@openrampkit/core'
import type { RelayRuntime } from './client.js'
import { DEFAULT_RPC_URLS, DIRECT_TX_CLOCK_SKEW_MS, RECORD_TTL_SEC, USED_TTL_SEC, WALLET_QUOTE_REUSE_MS } from './config.js'
import { SUBMIT_TX, awaitingTx, caip2FromRelay, cryptoAsset, fitsChain, isNative, isSolana, knownDecimals, requestIdOf, sameChainTransactions, sameUser, settlementOf, toOpenRamp, usedKey } from './helpers.js'
import { solanaReceived } from './solana.js'
import type { SolStatus } from './solana.js'
import type { RelayQuoteResponse, RelayStep, WalletRecord } from './types.js'

export function walletLeg(rt: RelayRuntime) {
  const { opts, api, rpc, solanaTx } = rt

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

  function payStep(chain: string, txs: TxRequest[], ref: string, providerRef?: string): LegStep {
    return {
      status: 'requires_action',
      action: { kind: 'payment', surface: { kind: 'WALLET_TX', chain, txs }, transitions: [SUBMIT_TX] },
      ref,
      ...(providerRef ? { providerRef } : {}),
    }
  }

  /** A same-chain wallet transaction that is sent but not confirmed yet (the source only) */
  function confirming(ref: string, rec: WalletRecord, hash: string): LegStep {
    return { status: 'processing', detail: { code: 'confirming' }, ref, transactions: sameChainTransactions(hash, rec.chain) }
  }

  /** A same-chain wallet payment that failed. `hash` is the wallet's transaction, when there is one (the source only). */
  function failed(ref: string, rec: WalletRecord, message: string, hash?: string): LegStep {
    return { status: 'failed', error: openRampError('DELIVERY_FAILED', { message }), ref, ...(hash ? { transactions: sameChainTransactions(hash, rec.chain) } : {}) }
  }

  /** A same-chain wallet payment counts only when the receipt shows it paid the recipient at least the amount. */
  async function verifyDirectWallet(ctx: AdapterContext, ref: string, rec: WalletRecord): Promise<LegStep> {
    const chain = rec.chain!
    if (isSolana(chain)) return verifySolanaWallet(ctx, ref, rec)
    const receipt = await rpc<EvmReceipt | null>(ctx, chain, 'eth_getTransactionReceipt', [rec.txHash])
    if (!receipt) return confirming(ref, rec, rec.txHash!)
    const fail = (message: string): LegStep => failed(ref, rec, message, rec.txHash)
    if (receipt.status !== '0x1') return fail('The transaction failed on chain.')
    // The transaction must be newer than this payment: an older transfer to the same recipient (for
    // example a shared merchant address) must not complete a new session.
    if (rec.since !== undefined) {
      const block = receipt.blockNumber ? await rpc<{ timestamp?: string } | null>(ctx, chain, 'eth_getBlockByNumber', [receipt.blockNumber, false]) : null
      if (!block?.timestamp) return confirming(ref, rec, rec.txHash!)
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

  /** Common end of a same-chain wallet check: the amount, then one transaction for one payment only. */
  async function settleDirect(ctx: AdapterContext, ref: string, rec: WalletRecord, paid: bigint): Promise<LegStep> {
    const fail = (message: string): LegStep => failed(ref, rec, message, rec.txHash)
    if (paid < BigInt(rec.amountBase ?? '0')) return fail('The transaction does not pay the destination the quoted amount.')
    // One transaction can complete one payment only: an old hash must not be reused for a new session.
    const key = usedKey(rec.chain!, rec.txHash!)
    // A transfer leg on the same address may have taken a log of this transaction already.
    if (await ctx.shared.get<string>(`${key}:log`)) return fail('This transaction was already used for another payment.')
    if (!(await claimOnce(ctx.shared, key, ref, USED_TTL_SEC))) return fail('This transaction was already used for another payment.')
    // Confirmed: the one transaction paid into the leg and delivered it.
    return { status: 'succeeded', ref, transactions: sameChainTransactions(rec.txHash!, rec.chain, 'destination'), ...(rec.output ? { output: rec.output } : {}) }
  }

  /**
   * A same-chain Solana payment counts only when the signature is confirmed without error, the
   * transaction is not older than the leg, and it moved at least the amount to the recipient.
   */
  async function verifySolanaWallet(ctx: AdapterContext, ref: string, rec: WalletRecord): Promise<LegStep> {
    const chain = rec.chain!
    const sig = rec.txHash!
    const waiting = confirming(ref, rec, sig)
    const fail = (message: string): LegStep => failed(ref, rec, message, sig)
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
    if (!url) throw new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message: `No RPC is configured to verify transfers on ${chainName(chain)}.` }), 502)
    const r = await verifySettlement({
      rpcUrl: url,
      contract: s.contract,
      sessionId: ctx.session.id,
      fetch: ctx.fetch,
      log: ctx.log,
      fromBlock: s.fromBlock,
      expect: { token: rec.token!, recipient: rec.recipient!, minAmount: BigInt(rec.amountBase ?? '0'), callsHash: s.callsHash },
    })
    const fail = (message: string, txHash?: string): LegStep => failed(ref, rec, message, txHash)
    if (r.settled) {
      if (!r.ok) return fail(r.problem!, r.record.txHash)
      // The settle call paid into the leg and delivered it through the settlement contract.
      return { status: 'succeeded', ref, transactions: sameChainTransactions(r.record.txHash, chain, 'settlement'), ...(rec.output ? { output: rec.output } : {}) }
    }
    if (!rec.txHash) return awaitingTx(ref)
    const receipt = await rpc<EvmReceipt | null>(ctx, chain, 'eth_getTransactionReceipt', [rec.txHash])
    if (!receipt) return confirming(ref, rec, rec.txHash)
    if (receipt.status !== '0x1') return fail('The transaction failed on chain.', rec.txHash)
    return fail('The transaction did not settle this session.', rec.txHash)
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
      throw new OpenRampException(openRampError('BAD_REQUEST', { message: 'Connect a Solana wallet to pay from Solana.', recovery: 'choose_other' }))
    }
    const fresh = typeof data.quotedAt === 'number' && Date.now() - data.quotedAt < WALLET_QUOTE_REUSE_MS
    if (!steps || !fresh || (user && !sameUser(origin.chain, data.user, user))) {
      if (!data.body) throw new OpenRampException(openRampError('QUOTE_EXPIRED'), 410)
      const body = { ...(data.body as Record<string, unknown>), ...(user ? { user } : {}) }
      const q = await api<RelayQuoteResponse>(ctx, '/quote/v2', body).catch((e) => {
        throw toOpenRamp(e, ctx.log)
      })
      steps = q.steps ?? []
      requestId = requestIdOf(q)
    }
    const { txs, unsupported } = walletTxsFrom(steps)
    const ref = requestId ?? `relay:${ctx.session.id}:${randomHex()}`
    if (unsupported || !txs.length) {
      return {
        status: 'failed',
        ref,
        ...(requestId ? { providerRef: requestId } : {}),
        error: openRampError('PROVIDER_DECLINED', {
          message: unsupported
            ? `This route needs a ${unsupported} step, which is not supported yet. Try another token or "Transfer crypto".`
            : 'Relay returned no transactions for this route.',
          recovery: 'choose_other',
        }),
      }
    }
    await ctx.store.put(`w:${ref}`, { mode: 'relay', ...(requestId ? { requestId } : {}), chain: origin.chain, output: input.quote.output } satisfies WalletRecord, RECORD_TTL_SEC)
    const first = txs[0]!
    return payStep(isSolanaTx(first) ? origin.chain : caip2FromRelay(first.chainId), txs, ref, requestId)
  }

  return { startWallet, verifyDirectWallet, verifySettlementWallet }
}
