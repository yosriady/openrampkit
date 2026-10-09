// Relay adapter: crypto bridge and swap legs (https://docs.relay.link).
//
// Legs:
// - `wallet`   The user's connected wallet signs Relay's transaction steps (WALLET_TX).
// - `transfer` The user sends any amount to a Relay open deposit address (DEPOSIT_ADDRESS).
// - `bridge`   Hop leg after an onramp: the onramp delivers USDC into a Relay open deposit
//              address, and Relay moves it to the destination chain and token.
//
// Server-side only. Web-standard APIs only (fetch, WebCrypto), so it runs on Cloudflare Workers.
//
// Files: `config.ts` (options, RPC defaults), `client.ts` (Relay API and RPC calls), `quotes.ts`,
// `deposit-address.ts` (Relay open deposit addresses), `direct-transfer.ts` (one deposit for one leg,
// log scanning), `wallet.ts` (wallet leg, EVM and Solana checks). This file wires them together.

import { createAdapter, erc20TransferData } from '@openrampkit/adapter'
import type { AdapterContext } from '@openrampkit/adapter'
import { OpenRampException, isSolanaSignature, openRampError } from '@openrampkit/core'
import type { Amount, LegStep } from '@openrampkit/core'
import { createRuntime } from './client.js'
import { RECORD_TTL_SEC } from './config.js'
import type { RelayOptions } from './config.js'
import { depositAddresses } from './deposit-address.js'
import { directTransfer } from './direct-transfer.js'
import { POLL_TRANSITION, SUBMIT_TX, addrKey, cryptoAsset, deliveredOutput, destAsset, isSolana, recipientOf, relaySub, terminalStep, toOpenRamp } from './helpers.js'
import { quotes, relayLegs } from './quotes.js'
import type { DepositRecord, RelayIntentStatus, WalletRecord } from './types.js'
import { walletLeg } from './wallet.js'

export { DEFAULT_RPC_URLS, RELAY_POLL, RELAY_SOLANA_CHAIN_ID } from './config.js'
export type { RelayOptions } from './config.js'
export { caip2FromRelay, relayChainId, relayCurrency } from './helpers.js'
export type { RelayQuoteResponse } from './types.js'

/** ERC-20 transfer(address,uint256) calldata (from `@openrampkit/adapter`) */
export { erc20TransferData }

export function relay(opts: RelayOptions = {}) {
  const rt = createRuntime(opts)
  const { warnNoKey, api, listRequests } = rt
  const legs = relayLegs()
  const direct = directTransfer(rt)
  const deposits = depositAddresses(rt, direct)
  const { quoteWallet, quoteDeposit } = quotes(rt, deposits, legs)
  const { startWallet, verifyDirectWallet, verifySettlementWallet } = walletLeg(rt)
  const { findDirectDeposit } = direct
  const { openDepositAddress, depositRef, startDeposit, findRelayDeposit } = deposits

  /**
   * What a completed wallet request delivered, from Relay's request (`GET /requests/v3?id=`). The
   * intent status has no amount. Best effort: when the lookup fails, the leg completes without an
   * output, and the session shows the quote (`outputConfirmed: false`).
   */
  async function walletOutput(ctx: AdapterContext, requestId: string, expected?: Amount): Promise<Amount | undefined> {
    try {
      const list = await listRequests(ctx, `id=${encodeURIComponent(requestId)}`)
      return deliveredOutput(list.find((r) => typeof r.id === 'string' && r.id.toLowerCase() === requestId.toLowerCase()), expected)
    } catch (e) {
      ctx.log.warn('relay: could not read the delivered amount of a completed request', { requestId, error: String((e as Error)?.message ?? e).slice(0, 200) })
      return undefined
    }
  }

  return createAdapter({
    id: 'relay',
    name: 'Relay',
    // Relay has no sandbox: the testnets API (api.testnets.relay.link) is the test environment.
    env: /testnets/.test(opts.baseUrl ?? '') ? 'sandbox' : 'production',
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
          throw new OpenRampException(openRampError('NOT_FOUND', { message: `Unknown Relay leg ${input.leg.legId}` }), 404)
      }
    },

    async prepareDeposit(input, ctx) {
      const origin = cryptoAsset({ value: '0', asset: input.leg.from.asset }, 'hop asset')
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
          throw new OpenRampException(openRampError('NOT_FOUND', { message: `Unknown Relay leg ${input.leg.legId}` }), 404)
      }
    },

    async transition(input, ctx) {
      if (input.leg.legId !== 'wallet' || input.name !== 'submit_tx') {
        throw new OpenRampException(openRampError('BAD_REQUEST', { message: `Transition ${input.name} is not supported.` }), 409)
      }
      const txHash = String(input.inputs?.txHash ?? input.inputs?.hash ?? '').trim()
      const rec = (await ctx.store.get<WalletRecord>(`w:${input.ref}`)) ?? { mode: 'relay' as const, requestId: input.ref }
      // EVM: a 32-byte hex hash. Solana: a base58 signature.
      const evmHash = /^0x[0-9a-fA-F]{64}$/.test(txHash)
      const ok = rec.chain ? (isSolana(rec.chain) ? isSolanaSignature(txHash) : evmHash) : evmHash || isSolanaSignature(txHash)
      if (!ok) throw new OpenRampException(openRampError('BAD_REQUEST', { message: 'A transaction hash is required.' }))
      await ctx.store.put(`w:${input.ref}`, { ...rec, txHash } satisfies WalletRecord, RECORD_TTL_SEC)
      return { state: 'PROCESSING', transitions: [POLL_TRANSITION], status: 'processing', ref: input.ref, txHash, sourceTxHash: txHash }
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
          throw toOpenRamp(e, ctx.log)
        })
        // `txHash` is the fill on the destination chain once Relay reports it; `sourceTxHash` is the
        // origin transaction that the user's wallet sent (`submit_tx`), else the one Relay saw.
        const sourceTxHash = rec?.txHash ?? s.inTxHashes?.[0]
        const txHash = s.txHashes?.[0] ?? sourceTxHash
        const extra = { ref: input.ref, ...(txHash ? { txHash } : {}), ...(sourceTxHash ? { sourceTxHash } : {}) }
        if (s.status === 'success') {
          // Relay filled: report what arrived, so the server checks it against the quote.
          const output = await walletOutput(ctx, input.ref, rec?.output)
          return terminalStep(s.status, { ...extra, ...(output ? { output } : {}) })!
        }
        const done = terminalStep(s.status, extra)
        if (done) return done
        if (!rec?.txHash && !s.inTxHashes?.length) {
          return { state: 'PAYMENT', transitions: [SUBMIT_TX], status: 'awaiting_user', ref: input.ref }
        }
        return { state: 'PROCESSING', sub: relaySub(s.status), providerStatus: s.status, status: 'processing', transitions: [POLL_TRANSITION], ...extra }
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
        throw toOpenRamp(e, ctx.log)
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
