// The Relay HTTP API and the JSON-RPC calls, with the options of one adapter instance.

import { evmRpc, fetchJson } from '@openrampkit/adapter'
import type { AdapterContext, Logger } from '@openrampkit/adapter'
import { OrkException, chainName, orkError } from '@openrampkit/core'
import type { CryptoAsset } from '@openrampkit/core'
import { DEFAULT_LOG_BLOCK_RANGE, DEFAULT_RPC_URLS, DEFAULT_TOLERANCE_BPS, EVM_NATIVE, SOLANA_NATIVE } from './config.js'
import type { RelayOptions } from './config.js'
import { isSolana, knownDecimals, relayChainId, relayCurrency, toOrk } from './helpers.js'
import type { SolTx } from './solana.js'

/** What the parts of one adapter instance share: its options and its API and RPC calls */
export type RelayRuntime = ReturnType<typeof createRuntime>

export function createRuntime(opts: RelayOptions) {
  const baseUrl = (opts.baseUrl ?? 'https://api.relay.link').replace(/\/+$/, '')
  let warnedV2 = false
  const toleranceBps = Math.max(0, Math.min(10_000, Math.round(opts.amountToleranceBps ?? DEFAULT_TOLERANCE_BPS)))
  const logBlockRange = BigInt(Math.max(1, Math.floor(opts.logBlockRange ?? DEFAULT_LOG_BLOCK_RANGE)))

  /**
   * Warn once, on the first adapter call, when no API key is set. Since 2026-10-02, Relay quotes
   * (`POST /quote/v2`) need an API key. Status then also uses /requests/v2, which retires on 2026-11-24.
   */
  function warnNoKey(log: Pick<Logger, 'warn'>) {
    if (opts.apiKey || warnedV2) return
    warnedV2 = true
    log.warn(
      'relay: no apiKey. Relay quotes (POST /quote/v2, used for quotes and deposit addresses) need an API key since 2026-10-02: live quotes fail without one. Status also uses deprecated GET /requests/v2 (Relay retires it on 2026-11-24). Set relay({ apiKey }), for example from RELAY_API_KEY.',
    )
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

  async function rpc<T>(ctx: Pick<AdapterContext, 'fetch' | 'log'>, chain: string, method: string, params: unknown[]): Promise<T> {
    const url = (opts.rpcUrls ?? {})[chain] ?? DEFAULT_RPC_URLS[chain]
    if (!url) throw new OrkException(orkError('PROVIDER_UNAVAILABLE', { message: `No RPC is configured to verify transfers on ${chainName(chain)}.` }), 502)
    return evmRpc<T>(ctx.fetch, url, method, params, { log: ctx.log })
  }

  function solanaTx(ctx: Pick<AdapterContext, 'fetch' | 'log'>, chain: string, signature: string) {
    return rpc<SolTx | null>(ctx, chain, 'getTransaction', [signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }])
  }

  return { opts, toleranceBps, logBlockRange, warnNoKey, api, decimalsOf, refundTo, baseBody, rpc, solanaTx }
}
