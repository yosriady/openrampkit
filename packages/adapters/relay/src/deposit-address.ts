// Relay open deposit addresses: one address per session and route, the quote for it, the start of a
// `transfer` or `bridge` leg, and its status from Relay's requests.

import { claimOnce } from '@openrampkit/adapter'
import type { AdapterContext, StartInput } from '@openrampkit/adapter'
import { OpenRampException, chainName, cmp, openRampError, toBaseUnits } from '@openrampkit/core'
import type { Amount, CryptoAsset, LegQuote, LegStep } from '@openrampkit/core'
import type { RelayRuntime } from './client.js'
import { DEPOSIT_ADDRESS_TTL_SEC, RECORD_TTL_SEC, USED_TTL_SEC } from './config.js'
import type { DirectTransfer } from './direct-transfer.js'
import { POLL_TRANSITION, addrKey, cryptoAsset, isSolana, knownDecimals, knownSymbol, quoteUser, recipientOf, relayOutput, relayStep, relayTransactions, requestIdOf, sameAsset, toOpenRamp } from './helpers.js'
import type { DepositRecord, RelayQuoteResponse, RelayRequest } from './types.js'

export type DepositAddresses = ReturnType<typeof depositAddresses>

export function depositAddresses(rt: RelayRuntime, direct: DirectTransfer) {
  const { api, listRequests, decimalsOf, refundTo, baseBody, rpc } = rt
  const { ownerOf, minFor, addWatcher, contested, finish, ambiguousStep } = direct

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
    ctx: Pick<AdapterContext, 'fetch' | 'store'> & Partial<Pick<AdapterContext, 'log'>>,
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
      throw toOpenRamp(e, ctx.log)
    })
    const key = depositKey(p.recipient, p.origin, p.dest)
    const cached = await ctx.store.get<string>(key)
    const fresh = q.steps?.find((s) => s.depositAddress)?.depositAddress
    const address = cached ?? fresh
    if (!address) throw new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message: 'Relay did not return a deposit address.' }), 502)
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
      // The bound request is missing from the list for now: the deposit was made, so the leg is processing.
      return r ? finish(ctx, ref, rec, mapRequest(ctx, r, ref, rec?.output)) : { status: 'processing', detail: { code: 'processing' }, ref, providerRef: bound.id }
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
      return finish(ctx, ref, rec, mapRequest(ctx, r, ref, rec?.output))
    }
    if (ambiguous) return ambiguousStep(ctx, ref, address, waiting)
    return waiting
  }

  /** The request's output. Same asset as the quote: the quoted asset (see `relayOutput`). */
  function requestOutput(r: RelayRequest, expected?: Amount): Amount | undefined {
    const out = r.data?.route?.actual?.destination?.outputCurrency ?? r.data?.route?.quoted?.destination?.outputCurrency ?? r.data?.metadata?.currencyOut
    return relayOutput(out, expected)
  }

  function requestTxHash(r: RelayRequest): string | undefined {
    const t = r.data?.outTxs?.[0]
    return t?.txHash ?? t?.hash
  }

  /** The transfer into the deposit address */
  function requestSourceTxHash(r: RelayRequest): string | undefined {
    const t = r.data?.inTxs?.[0]
    return r.depositAddress?.depositTxHash ?? t?.txHash ?? t?.hash
  }

  /**
   * The step of the Relay request bound to a deposit leg. `source` is the transfer into the address and
   * `destination` is Relay's fill (a refund's `outTxs` is the refund). A status that Relay added after
   * this adapter is logged once: the deposit is made, so the last known status is `processing`.
   */
  function mapRequest(ctx: Pick<AdapterContext, 'log'>, r: RelayRequest, ref: string, expected?: Amount): LegStep {
    const output = requestOutput(r, expected)
    const transactions = relayTransactions(requestSourceTxHash(r), requestTxHash(r), { status: r.status })
    const extra = { ref, ...(typeof r.id === 'string' && r.id ? { providerRef: r.id } : {}), ...(transactions.length ? { transactions } : {}), ...(output ? { output } : {}) }
    return relayStep(r.status, extra, ctx.log) ?? { status: 'processing', ...extra }
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
      return { status: 'processing', detail: { code: 'waiting_for_deposit' }, ref }
    }
    const symbol = origin.symbol ?? knownSymbol(origin.chain, origin.token) ?? 'the token'
    const name = chainName(origin.chain)
    return {
      status: 'requires_action',
      action: {
        kind: 'payment',
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
      },
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
    if (decimals === undefined || cmp(quote.input.value, '0') <= 0) return undefined
    return toBaseUnits(quote.input.value, decimals)
  }

  return { depositQuote, openDepositAddress, nominalAmount, findRelayDeposit, startDeposit, depositRef }
}
