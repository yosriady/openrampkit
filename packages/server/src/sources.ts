// GET /sessions/:id/sources?method=transfer: the tokens a deposit can pay with, for the source picker.

import { CHAINS, defaultSourceChains, defaultSourceTokens, mergeSourceTokens, openRampError } from '@openrampkit/core'
import type { SourceChain, SourceToken } from '@openrampkit/core'
import { errorResponse, json } from './http.js'
import { withTimeout } from './runtime.js'
import type { Runtime } from './runtime.js'
import { scopedKV } from './store.js'
import type { SessionRecord } from './store.js'

/** Methods with a source picker */
const SOURCE_METHODS = new Set(['transfer', 'exchange_transfer', 'wallet'])
/** How long the merged list stays cached (adapters cache their own lists for longer) */
const SOURCES_TTL_SEC = 60 * 60
/** Time for one adapter's list. A slow adapter is left out, and the answer is not cached. */
const SOURCES_TIMEOUT_MS = 5000

export async function sourcesRoute(rt: Runtime, req: Request, rec: SessionRecord): Promise<Response> {
  const method = new URL(req.url).searchParams.get('method') ?? 'transfer'
  if (!SOURCE_METHODS.has(method)) return errorResponse(openRampError('BAD_REQUEST', { message: '`method` must be transfer, exchange_transfer or wallet.' }), 400)
  if (rec.direction === 'withdraw') return errorResponse(openRampError('BAD_REQUEST', { message: 'A withdrawal has a fixed source.' }), 409)
  return json({ chains: await sourceChains(rt, method) })
}

/**
 * Source chains and tokens for a method: the default tokens of each chain (USDC and native), then the
 * tokens of each adapter that offers the method and has `sourceTokens`. A known chain (in `CHAINS`)
 * with no USDC joins the list only when an adapter lists a token on it. Cached for an hour when every
 * adapter answered.
 */
export async function sourceChains(rt: Runtime, method: string): Promise<SourceChain[]> {
  const chains = defaultSourceChains()
  const adapters = [...rt.adapters.values()].filter((a) => a.sourceTokens && a.legs.some((l) => l.methods?.includes(method)))
  const load = async (): Promise<{ lists: SourceToken[][]; complete: boolean }> => {
    const settled = await Promise.allSettled(
      adapters.map((a) => withTimeout(a.sourceTokens!({ chains, method }, { fetch: rt.fetch, log: rt.log, shared: scopedKV(rt.store, `a:${a.id}`) }), SOURCES_TIMEOUT_MS)),
    )
    settled.forEach((s, i) => {
      if (s.status === 'rejected') rt.log.warn('source tokens failed', { adapter: adapters[i]!.id, error: String(s.reason).slice(0, 200) })
    })
    return { lists: settled.map((s) => (s.status === 'fulfilled' && Array.isArray(s.value) ? s.value : [])), complete: settled.every((s) => s.status === 'fulfilled') }
  }
  let lists: SourceToken[][] = []
  if (adapters.length) {
    const kv = scopedKV(rt.store, 'sources')
    const key = `m:${method}`
    const hit = await kv.get<SourceToken[][]>(key)
    if (Array.isArray(hit)) lists = hit
    else {
      const fresh = await load()
      lists = fresh.lists
      if (fresh.complete) await kv.put(key, lists, SOURCES_TTL_SEC)
    }
  }
  // A chain outside the default list (for example Bitcoin or Tron) is added when an adapter lists a
  // token on it and the chain is in the trusted chain table, after the default chains.
  const extra = [...new Set(lists.flat().map((t) => t?.chain))].filter((c): c is string => typeof c === 'string' && !!CHAINS[c] && !chains.includes(c))
  return [...chains, ...extra].map((chain) => ({
    chain,
    name: CHAINS[chain]?.name ?? chain,
    tokens: lists.length ? mergeSourceTokens(chain, ...lists) : defaultSourceTokens(chain),
  }))
}
