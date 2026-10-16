// The Relay HTTP API and the JSON-RPC calls, with the options of one adapter instance.

import { cachedJson, createChainWatch, fetchJson } from '@openrampkit/adapter'
import type { AdapterContext, Logger } from '@openrampkit/adapter'
import { OpenRampException, openRampError } from '@openrampkit/core'
import type { CryptoAsset } from '@openrampkit/core'
import { DEFAULT_RPC_URLS, DEFAULT_TOLERANCE_BPS, EVM_NATIVE, SOLANA_NATIVE } from './config.js'
import type { RelayOptions } from './config.js'
import { fitsChain, isSolana, knownDecimals, relayChainId, relayCurrency, toOpenRamp } from './helpers.js'
import type { SolTx } from './solana.js'
import type { RelayRequest } from './types.js'

/** What the parts of one adapter instance share: its options and its API and RPC calls */
export type RelayRuntime = ReturnType<typeof createRuntime>

export function createRuntime(opts: RelayOptions) {
  const baseUrl = (opts.baseUrl ?? 'https://api.relay.link').replace(/\/+$/, '')
  let warnedV2 = false
  const toleranceBps = Math.max(0, Math.min(10_000, Math.round(opts.amountToleranceBps ?? DEFAULT_TOLERANCE_BPS)))
  // The chain watcher (`@openrampkit/adapter`): RPC URLs, the `eth_getLogs` block range and the rate limit.
  // Relay reads Solana at `confirmed` and counts an EVM log as soon as it is in a block (no confirmations).
  const watch = createChainWatch({
    ...(opts.rpcUrls ? { rpcUrls: opts.rpcUrls } : {}),
    defaultRpcUrls: DEFAULT_RPC_URLS,
    ...(opts.logBlockRange !== undefined ? { logBlockRange: opts.logBlockRange } : {}),
    ...(opts.rpcRequestsPerSecond !== undefined ? { requestsPerSecond: opts.rpcRequestsPerSecond } : {}),
    confirmations: 0,
    solanaCommitment: 'confirmed',
  })
  const logBlockRange = watch.logBlockRange
  /** The `slippageTolerance` (bps) sent with every quote, or undefined when Relay picks it */
  const slippageBps = opts.slippageBps !== undefined ? Math.max(0, Math.min(10_000, Math.round(opts.slippageBps))) : undefined

  /**
   * Warn once, on the first adapter call, when no API key is set. Relay's announced policy: from
   * 2026-10-02, every `POST /quote/v2` needs a valid API key (https://docs.relay.link/references/api/api-keys).
   * Some keyless quotes still worked on 2026-10-09, but Relay can refuse them at any time. A quote with a
   * `referrer` and no key is refused now (401 UNAUTHORIZED_QUOTE). Status then also uses /requests/v2,
   * which retires on 2026-11-24.
   */
  function warnNoKey(log: Pick<Logger, 'warn'>) {
    if (opts.apiKey || warnedV2) return
    warnedV2 = true
    log.warn(
      'relay: no apiKey. Relay requires an API key for quotes (POST /quote/v2, used for quotes and deposit addresses) under its announced policy from 2026-10-02. Some keyless quotes may still work today, but Relay can refuse them at any time (401 UNAUTHORIZED_QUOTE). Status also uses deprecated GET /requests/v2 (Relay retires it on 2026-11-24). Always set relay({ apiKey }), for example from RELAY_API_KEY.',
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

  /** Relay requests (`GET /requests/v3` with a key, else the deprecated `/requests/v2`) */
  async function listRequests(ctx: Pick<AdapterContext, 'fetch' | 'log'>, query: string): Promise<RelayRequest[]> {
    return (await listRequestsPage(ctx, query)).requests
  }

  /** One page of Relay requests, with the `continuation` token of the next page when there is one */
  async function listRequestsPage(ctx: Pick<AdapterContext, 'fetch' | 'log'>, query: string): Promise<{ requests: RelayRequest[]; continuation?: string }> {
    warnNoKey(ctx.log)
    const path = opts.apiKey ? '/requests/v3' : '/requests/v2'
    const res = await api<{ requests?: RelayRequest[]; continuation?: string }>(ctx, `${path}?${query}`)
    return { requests: res.requests ?? [], ...(typeof res.continuation === 'string' && res.continuation ? { continuation: res.continuation } : {}) }
  }

  async function decimalsOf(ctx: Pick<AdapterContext, 'fetch' | 'shared'> & Partial<Pick<AdapterContext, 'log'>>, asset: CryptoAsset): Promise<number> {
    if (typeof asset.decimals === 'number') return asset.decimals
    const known = knownDecimals(asset.chain, asset.token)
    if (known !== undefined) return known
    return cachedJson(
      ctx.shared,
      `dec:${asset.chain}:${isSolana(asset.chain) ? asset.token : asset.token.toLowerCase()}`,
      7 * 24 * 60 * 60,
      async () => {
        const list = await api<Array<{ decimals: number }>>(ctx, '/currencies/v2', {
          chainIds: [relayChainId(asset.chain)],
          address: relayCurrency(asset.chain, asset.token),
          limit: 1,
        }).catch((e) => {
          throw toOpenRamp(e, ctx.log)
        })
        const d = list?.[0]?.decimals
        if (typeof d !== 'number') throw new OpenRampException(openRampError('BAD_REQUEST', { message: 'Relay does not know this token.' }))
        return d
      },
      { valid: (d) => typeof d === 'number' },
    )
  }

  /**
   * The `refundTo` of a deposit-address quote (see `RelayOptions.refundTo`). `exchange`: the sender is an
   * exchange, so the connected wallet (`user`) comes before the sender. `recipient`: the session's
   * destination address. The native-currency address means "the sender" (see `refundsToSender`).
   */
  function refundTo(originChain: string, p: { exchange?: boolean; user?: string; recipient?: string } = {}): string {
    const r = opts.refundTo
    if (r && r !== 'origin' && r !== 'recipient') return r
    if (p.exchange && fitsChain(originChain, p.user)) return p.user
    if (r === 'recipient' && fitsChain(originChain, p.recipient)) return p.recipient
    return isSolana(originChain) ? SOLANA_NATIVE : EVM_NATIVE
  }

  function baseBody(origin: CryptoAsset, dest: CryptoAsset) {
    return {
      originChainId: relayChainId(origin.chain),
      originCurrency: relayCurrency(origin.chain, origin.token),
      destinationChainId: relayChainId(dest.chain),
      destinationCurrency: relayCurrency(dest.chain, dest.token),
      ...(opts.referrer ? { referrer: opts.referrer } : {}),
      ...(slippageBps !== undefined ? { slippageTolerance: String(slippageBps) } : {}),
      ...(opts.appFee && opts.appFee.bps > 0 ? { appFees: [{ recipient: opts.appFee.recipient, fee: String(Math.round(opts.appFee.bps)) }] } : {}),
    }
  }

  const { rpc, rpcUrl } = watch

  function solanaTx(ctx: Pick<AdapterContext, 'fetch' | 'log'>, chain: string, signature: string) {
    return watch.solanaTx<SolTx>(ctx, chain, signature, 'confirmed')
  }

  return { opts, toleranceBps, slippageBps, logBlockRange, watch, warnNoKey, api, listRequests, listRequestsPage, decimalsOf, refundTo, baseBody, rpc, rpcUrl, solanaTx }
}
