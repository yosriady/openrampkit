// Pathway planner. A pure function: no network, no clock. The server feeds it leg specs and user context.

import { DEFAULT_METHOD_PRIORITY, METHODS, currencyForCountry, methodAvailableIn, methodName } from './codes.js'
import { orkError } from './errors.js'
import { isRegionAllowed } from './region.js'
import type {
  Asset,
  CryptoAsset,
  Destination,
  Direction,
  Endpoint,
  EndpointMatcher,
  LegSpec,
  OrkError,
  Pathway,
  PathwayGroup,
  PathwayLeg,
  RegionPolicy,
  SurfaceKind,
} from './types.js'

export type PlannerLeg = { adapterId: string; provider: string; spec: LegSpec }

export type PlannerInput = {
  direction: Direction
  destination: Destination
  user: { country?: string; region?: string; walletConnected?: boolean }
  legs: PlannerLeg[]
  policy?: {
    maxLegs?: 1 | 2
    regions?: RegionPolicy
    methodPriority?: Record<string, string[]>
    disabledMethods?: string[]
    /** Surfaces the client can render; legs needing others are unavailable */
    clientSurfaces?: SurfaceKind[]
    /** Preferred hop assets for two-leg pathways, most preferred first */
    hopPreference?: CryptoAsset[]
  }
}

export type MethodOption = {
  method: string
  name: string
  kind: string
  group: PathwayGroup
  reason?: OrkError
  providers: string[]
  pathwayIds: string[]
  eta: { min: number; max: number }
  limits?: { min?: string; max?: string; currency: string }
}

export type PlanResult = { pathways: Pathway[]; methods: MethodOption[]; currency: string }

// ---------- matching ----------

export function assetMatches(m: EndpointMatcher['asset'], a: Asset): boolean {
  if (m.kind !== a.kind) return false
  if (m.kind === 'fiat' && a.kind === 'fiat') {
    return m.currencies === '*' || m.currencies.includes(a.currency.toUpperCase())
  }
  if (m.kind === 'crypto' && a.kind === 'crypto') {
    if (m.chains === '*') return true
    const tokens = m.chains[a.chain]
    if (!tokens) return false
    return tokens === '*' || tokens.includes(a.token.toLowerCase())
  }
  return false
}

export function endpointMatches(m: EndpointMatcher, e: Endpoint): boolean {
  return m.location.includes(e.location.kind) && assetMatches(m.asset, e.asset)
}

/** Concrete crypto assets a matcher can produce, or null when it is open-ended ('*'). */
function enumerateCrypto(m: EndpointMatcher['asset']): CryptoAsset[] | null {
  if (m.kind !== 'crypto' || m.chains === '*') return null
  const out: CryptoAsset[] = []
  for (const [chain, tokens] of Object.entries(m.chains)) {
    if (tokens === '*') continue
    for (const token of tokens) out.push({ kind: 'crypto', chain, token })
  }
  return out
}

export function destinationEndpoint(d: Destination): Endpoint {
  if (d.type === 'crypto') {
    return {
      asset: { kind: 'crypto', chain: d.chain, token: d.token.toLowerCase(), ...(d.symbol ? { symbol: d.symbol } : {}), ...(d.decimals !== undefined ? { decimals: d.decimals } : {}) },
      location: { kind: 'address', address: d.address },
    }
  }
  return { asset: { kind: 'fiat', currency: d.currency }, location: { kind: 'merchant_account', ...(d.accountRef ? { accountRef: d.accountRef } : {}) } }
}

function sourceEndpoints(currency: string): Endpoint[] {
  return [
    { asset: { kind: 'fiat', currency }, location: { kind: 'user_account' } },
    // any crypto held in a wallet (the wallet/transfer legs match '*')
    { asset: { kind: 'crypto', chain: '*', token: '*' }, location: { kind: 'user_wallet' } },
  ]
}

function sourceMatches(m: EndpointMatcher, source: Endpoint): boolean {
  if (!m.location.includes(source.location.kind)) return false
  if (source.asset.kind === 'crypto' && source.asset.chain === '*') return m.asset.kind === 'crypto'
  return assetMatches(m.asset, source.asset)
}

function pathwayId(legs: PathwayLeg[], method: string): string {
  const hop = legs.length > 1 && legs[0]!.to.asset.kind === 'crypto' ? `@${legs[0]!.to.asset.chain}` : ''
  return `${method}:${legs.map((l) => `${l.adapterId}.${l.legId}`).join('>')}${hop}`
}

function sumEta(legs: LegSpec[]): { min: number; max: number } {
  return legs.reduce((acc, l) => ({ min: acc.min + l.eta.min, max: acc.max + l.eta.max }), { min: 0, max: 0 })
}

const DEFAULT_HOPS: CryptoAsset[] = [
  { kind: 'crypto', chain: 'eip155:8453', token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
  { kind: 'crypto', chain: 'eip155:42161', token: '0xaf88d065e77c8cc2239327c5edb3a432268e5831' },
  { kind: 'crypto', chain: 'eip155:137', token: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359' },
  { kind: 'crypto', chain: 'eip155:10', token: '0x0b2c639c533813f4aa9d7837caf62653d097ff85' },
  { kind: 'crypto', chain: 'eip155:1', token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
]

// ---------- plan ----------

export function planPathways(input: PlannerInput): PlanResult {
  const { destination, user, policy = {} } = input
  const currency = destination.type === 'merchant' ? destination.currency : currencyForCountry(user.country)
  const target = destinationEndpoint(destination)
  const sources = sourceEndpoints(currency)
  const maxLegs = policy.maxLegs ?? 2
  const disabled = new Set(policy.disabledMethods ?? [])
  const surfaces = policy.clientSurfaces ? new Set(policy.clientSurfaces) : undefined
  const hops = policy.hopPreference ?? DEFAULT_HOPS
  const appAllowed = (c?: string, r?: string) => (policy.regions ? isRegionAllowed(policy.regions, c, r) : true)

  type Candidate = { method: string; provider: string; legs: PathwayLeg[]; specs: LegSpec[]; reason?: OrkError }
  const candidates: Candidate[] = []

  const legProblem = (l: PlannerLeg): OrkError | undefined => {
    if (!appAllowed(user.country, user.region) || !isRegionAllowed(l.spec.regions, user.country, user.region)) {
      return orkError('REGION_UNSUPPORTED')
    }
    if (surfaces && !l.spec.surfaces.some((s) => surfaces.has(s))) return orkError('CLIENT_UPGRADE_REQUIRED')
    if (l.spec.requires?.includes('wallet') && !user.walletConnected) {
      return orkError('BAD_REQUEST', { message: 'Connect a wallet to use this method.', recovery: 'choose_other' })
    }
    return undefined
  }

  const methodsOf = (l: PlannerLeg) =>
    (l.spec.methods?.length ? l.spec.methods : [l.spec.kind]).filter((m) => methodAvailableIn(m, user.country))

  const firstLegs = input.legs.filter((l) => sources.some((s) => sourceMatches(l.spec.from, s)))

  for (const first of firstLegs) {
    const problem = legProblem(first)
    const fromEndpoint = sources.find((s) => sourceMatches(first.spec.from, s))!

    // one leg: delivers straight to the destination
    if (endpointMatches(first.spec.to, target)) {
      for (const method of methodsOf(first)) {
        candidates.push({
          method,
          provider: first.provider,
          legs: [{ adapterId: first.adapterId, legId: first.spec.id, from: fromEndpoint, to: target }],
          specs: [first.spec],
          ...(problem ? { reason: problem } : {}),
        })
      }
      continue
    }

    if (maxLegs < 2 || target.asset.kind !== 'crypto') continue

    // two legs: first leg lands on a hop asset, a bridge leg moves it to the destination
    const produced = enumerateCrypto(first.spec.to.asset)
    if (!produced?.length) continue
    const ordered = [...produced].sort((a, b) => rank(a) - rank(b))
    function rank(a: CryptoAsset) {
      const i = hops.findIndex((h) => h.chain === a.chain && h.token.toLowerCase() === a.token.toLowerCase())
      return i === -1 ? hops.length : i
    }
    let found = false
    for (const hopAsset of ordered) {
      const hopEndpoint: Endpoint = { asset: hopAsset, location: { kind: 'address', address: 'deposit' } }
      if (!endpointMatches({ ...first.spec.to, location: first.spec.to.location }, hopEndpoint)) continue
      for (const second of input.legs) {
        if (second.spec.kind !== 'bridge_swap') continue
        if (!second.spec.from.location.includes('address')) continue
        if (!assetMatches(second.spec.from.asset, hopAsset) || !endpointMatches(second.spec.to, target)) continue
        const problem2 = problem ?? legProblem(second)
        for (const method of methodsOf(first)) {
          candidates.push({
            method,
            provider: first.provider,
            legs: [
              { adapterId: first.adapterId, legId: first.spec.id, from: fromEndpoint, to: hopEndpoint },
              { adapterId: second.adapterId, legId: second.spec.id, from: hopEndpoint, to: target },
            ],
            specs: [first.spec, second.spec],
            ...(problem2 ? { reason: problem2 } : {}),
          })
        }
        found = true
        break
      }
      if (found) break
    }
  }

  // ---------- build pathways and group by method ----------
  const priority = (policy.methodPriority ?? {})[user.country ?? ''] ??
    DEFAULT_METHOD_PRIORITY[user.country ?? ''] ?? DEFAULT_METHOD_PRIORITY['*']!

  const pathways: Pathway[] = []
  const byMethod = new Map<string, Pathway[]>()
  for (const c of candidates) {
    if (disabled.has(c.method)) continue
    const p: Pathway = {
      id: pathwayId(c.legs, c.method),
      legs: c.legs,
      method: c.method,
      group: c.reason ? 'unavailable' : 'more',
      ...(c.reason ? { reason: c.reason } : {}),
      eta: sumEta(c.specs),
      ...(c.specs[0]!.limits ? { limits: c.specs[0]!.limits } : {}),
      provider: c.provider,
    }
    if (pathways.some((x) => x.id === p.id)) continue
    pathways.push(p)
    const list = byMethod.get(p.method) ?? []
    list.push(p)
    byMethod.set(p.method, list)
  }

  const fiatMethods = [...byMethod.keys()].filter((m) => METHODS[m]?.kind !== 'crypto' && METHODS[m]?.kind !== 'exchange')
  const recommendedFiat = priority.find((m) => fiatMethods.includes(m) && byMethod.get(m)!.some((p) => !p.reason)) ??
    fiatMethods.find((m) => byMethod.get(m)!.some((p) => !p.reason))

  const methods: MethodOption[] = []
  for (const [method, list] of byMethod) {
    const available = list.filter((p) => !p.reason)
    let group: PathwayGroup = available.length ? 'more' : 'unavailable'
    if (available.length && method === 'wallet' && user.walletConnected) group = 'connected'
    else if (available.length && (method === recommendedFiat || (method === 'transfer' && !user.walletConnected))) group = 'recommended'
    for (const p of list) if (!p.reason) p.group = group
    const best = available[0] ?? list[0]!
    methods.push({
      method,
      name: methodName(method),
      kind: METHODS[method]?.kind ?? 'other',
      group,
      ...(available.length ? {} : { reason: list[0]!.reason! }),
      providers: [...new Set(available.map((p) => p.provider))],
      pathwayIds: available.map((p) => p.id),
      eta: {
        min: Math.min(...(available.length ? available : list).map((p) => p.eta.min)),
        max: Math.max(...(available.length ? available : list).map((p) => p.eta.max)),
      },
      ...(best.limits ? { limits: best.limits } : {}),
    })
  }

  const groupOrder: Record<PathwayGroup, number> = { connected: 0, recommended: 1, more: 2, unavailable: 3 }
  const prio = (m: string) => {
    const i = priority.indexOf(m)
    return i === -1 ? 999 : i
  }
  methods.sort((a, b) => groupOrder[a.group] - groupOrder[b.group] || prio(a.method) - prio(b.method) || a.name.localeCompare(b.name))

  return { pathways, methods, currency }
}
