// Leg specs, and quotes for the wallet leg and the deposit-address legs.

import type { AdapterContext, QuoteInput } from '@openrampkit/adapter'
import { OpenRampException, USDC, chainName, cmp, openRampError, toBaseUnits } from '@openrampkit/core'
import type { CryptoAsset, LegQuote, LegSpec } from '@openrampkit/core'
import type { RelayRuntime } from './client.js'
import { HOP_CHAINS, SOLANA_CAIP2, WALLET_QUOTE_TTL_MS } from './config.js'
import type { DepositAddresses } from './deposit-address.js'
import { cryptoAsset, destAsset, etaFrom, feesFrom, fmt, minOutputOf, quoteUser, recipientOf, requestIdOf, sameAsset, settlementOf, toOpenRamp, withMeta } from './helpers.js'
import type { RelayQuoteResponse } from './types.js'

/** The leg specs, new for each adapter instance */
export function relayLegs(): LegSpec[] {
  const usdcHops: Record<string, string[]> = Object.fromEntries(HOP_CHAINS.filter((c) => USDC[c]).map((c) => [c, [USDC[c]!]]))

  return [
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
      capabilities: ['settlement'],
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
    },
  ]
}

export function quotes(rt: RelayRuntime, deposits: Pick<DepositAddresses, 'depositQuote' | 'nominalAmount'>, legs: LegSpec[]) {
  const { api, decimalsOf, baseBody } = rt
  const { depositQuote, nominalAmount } = deposits

  async function quoteWallet(input: QuoteInput, ctx: AdapterContext): Promise<LegQuote> {
    const origin: CryptoAsset = input.source
      ? { kind: 'crypto', chain: input.source.chain, token: input.source.token }
      : cryptoAsset(input.amountIn ?? { value: '0', asset: input.leg.from.asset }, 'source')
    if (!origin.chain.startsWith('eip155:') && origin.chain !== SOLANA_CAIP2) {
      throw new OpenRampException(openRampError('BAD_REQUEST', { message: 'Wallet payments support EVM chains and Solana only. Use "Transfer crypto" instead.' }))
    }
    const dest = destAsset(ctx, input.leg.to.asset.kind === 'crypto' ? input.leg.to.asset : undefined)
    const recipient = recipientOf(ctx, input.deliverTo)
    const user = quoteUser(origin.chain, input.source?.address)
    const inDec = await decimalsOf(ctx, { ...origin, ...(input.amountIn?.asset.kind === 'crypto' && input.amountIn.asset.decimals !== undefined ? { decimals: input.amountIn.asset.decimals } : {}) })
    const originMeta = withMeta(origin, inDec)
    const legEta = legs[0]!.eta

    const settling = settlementOf(ctx, input.deliverTo)
    if (settling && !sameAsset(origin.chain, origin.token, dest.chain, dest.token)) {
      throw new OpenRampException(
        openRampError('BAD_REQUEST', { message: `This payment settles on ${chainName(dest.chain)}. Pay with ${dest.symbol ?? 'the destination token'} on ${chainName(dest.chain)}.`, recovery: 'choose_other' }),
      )
    }

    // Same chain and token: a plain transfer (or a settlement contract call), no Relay.
    if (sameAsset(origin.chain, origin.token, dest.chain, dest.token)) {
      const amount = input.amountIn?.value ?? input.amountOut?.value ?? '0'
      return {
        adapterId: 'relay',
        legId: 'wallet',
        input: { value: amount, asset: originMeta },
        output: { value: amount, asset: withMeta(dest, inDec) },
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
      amount: exactOut ? toBaseUnits(input.amountOut!.value, outDec) : toBaseUnits(input.amountIn?.value ?? '0', inDec),
      tradeType: exactOut ? 'EXACT_OUTPUT' : 'EXACT_INPUT',
    }
    const q = await api<RelayQuoteResponse>(ctx, '/quote/v2', body).catch((e) => {
      throw toOpenRamp(e, ctx.log)
    })
    const cin = q.details?.currencyIn
    const cout = q.details?.currencyOut
    if (!cin || !cout) throw new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message: 'Relay returned an incomplete quote.' }), 502)
    return {
      adapterId: 'relay',
      legId: 'wallet',
      input: { value: fmt(cin), asset: withMeta(origin, cin.currency.decimals, cin.currency.symbol) },
      output: { value: fmt(cout), asset: withMeta(dest, cout.currency.decimals, cout.currency.symbol) },
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
        : cryptoAsset(input.amountIn ?? { value: '0', asset: input.leg.from.asset }, 'source')
    const dest = destAsset(ctx, input.leg.to.asset.kind === 'crypto' ? input.leg.to.asset : undefined)
    const recipient = recipientOf(ctx, input.deliverTo)
    const inDec = await decimalsOf(ctx, { ...origin, ...(input.amountIn?.asset.kind === 'crypto' && input.amountIn.asset.decimals !== undefined ? { decimals: input.amountIn.asset.decimals } : {}) })
    const originMeta = withMeta(origin, inDec)
    const spec = legs.find((l) => l.id === legId)!
    const given = input.amountIn?.value ?? '0'
    const anyAmount = legId === 'transfer'

    if (sameAsset(origin.chain, origin.token, dest.chain, dest.token)) {
      return {
        adapterId: 'relay',
        legId,
        input: { value: given, asset: originMeta },
        output: { value: given, asset: withMeta(dest, inDec) },
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
    if (!cin || !cout) throw new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message: 'Relay returned an incomplete quote.' }), 502)
    return {
      adapterId: 'relay',
      legId,
      input: { value: fmt(cin), asset: withMeta(origin, cin.currency.decimals, cin.currency.symbol) },
      output: { value: fmt(cout), asset: withMeta(dest, cout.currency.decimals, cout.currency.symbol) },
      fees: feesFrom(q),
      eta: etaFrom(q, spec.eta),
      // Open deposit addresses accept any amount; the output is the rate-based estimate for `input`.
      data: { direct: false, depositAddress: address, requestId, anyAmount, nominal, recipient, ...(nominal ? {} : { amountBase: cin.amount, ...minOutputOf(q) }) },
    }
  }

  return { quoteWallet, quoteDeposit }
}
