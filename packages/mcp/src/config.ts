import { cmp, isDecimal } from '@openrampkit/core'
import type { AllowedDestinations, Destination, WithdrawSource } from '@openrampkit/core'
import type { Connection } from './backend.js'
import { RampError } from './backend.js'
import type { Limits } from './limits.js'
import type { SessionRegistry } from './registry.js'

/** A deposit destination the agent may pick by name. */
export type NamedDestination = {
  /** Short name the agent uses, e.g. `treasury` */
  name: string
  /** Shown to the agent, e.g. "Team wallet on Base" */
  description?: string
  /** CAIP-2 chain id, e.g. `eip155:8453` */
  chain: string
  /** Token address, or `native` */
  token: string
  address: string
  symbol?: string
  decimals?: number
}

export type OpenRampMcpConfig = {
  connection: Connection
  /** `userId` on every session the agent creates. Default `agent`. */
  userId?: string
  /** Deposits ("fund a wallet"). Leave out to turn off `create_deposit_session`. */
  deposit?: {
    /** The only destinations the agent may fund. The agent picks one by name. */
    destinations: NamedDestination[]
    /**
     * Let the agent give its own address, but only on these chains and tokens. Off by default.
     * `tokens` maps a chain to the token addresses allowed there (default: any token of the destinations on that chain).
     */
    allowCustomAddress?: { chains: string[]; tokens?: Record<string, string[]> }
  }
  /** Payouts ("pay out to a human"). Leave out to turn off `create_withdraw_session`. */
  withdraw?: {
    /** The asset that leaves, and who holds it. Use `custody: 'app'` with a server `treasury` for agent payouts. */
    source: WithdrawSource
    /** Where the person may receive the funds on the pay link. Default: cash only (`{ fiat: {} }`). */
    allowedDestinations?: AllowedDestinations
    /**
     * Payout targets bound by the operator. The agent picks one by name. The MCP server sets the
     * target and starts the payout itself: no pay link is made, so nobody can send the funds elsewhere.
     * Needs `source.custody: 'app'` and a `treasury` on the OpenRampKit server.
     */
    targets?: NamedDestination[]
    /**
     * Refuse payouts without a named target (no pay link payouts). Default `false` in the API.
     * The CLI sets it to `true` unless the config file sets it to `false`.
     */
    requireBoundTarget?: boolean
  }
  /**
   * Limits across sessions: sessions per hour and total per day. Counters live in `registry`.
   * Strongly recommended for any agent that can create payouts.
   */
  limits?: Limits
  /**
   * Operator approval for payouts. Called before each payout session is created. Return `true` to
   * allow it. Any other value, or an error, refuses it (fail closed). For example, ask a person in
   * Slack, or check an allowlist of references.
   */
  approve?: (request: PayoutApproval) => boolean | Promise<boolean>
  /**
   * Required. Largest amount per session, by currency code (`VND`) or token symbol (`USDC`).
   * The agent can create sessions only in these currencies, and never above these amounts.
   */
  maxAmounts: Record<string, string>
  /** Only these methods are offered (e.g. `['vietqr', 'qris']`). Default: all. */
  allowedMethods?: string[]
  /** Session lifetime in minutes. Default 30. The agent can ask for less, never more. */
  sessionTtlMinutes?: number
  /** Longest wait of one `wait_for_completion` call, in seconds. Default 120, at most 600. */
  maxWaitSeconds?: number
  /** Poll interval for `wait_for_completion`, in ms. Default 3000. */
  pollIntervalMs?: number
  /** Keeps session client secrets away from the agent. Default: in memory. */
  registry?: SessionRegistry
  /** Name and version in the MCP handshake */
  serverInfo?: { name: string; version: string }
}

/** What `approve` gets for a payout that the agent asks for. */
export type PayoutApproval = {
  direction: 'withdraw'
  /** Country of the person who receives */
  country: string
  /** The largest amount that can leave, and the smallest when set */
  amount: { min?: string; max: string; currency: string }
  source: WithdrawSource
  /** The bound target, when the agent picked one. Absent: the person picks the target on the pay link. */
  target?: NamedDestination
  /** The agent's note or order id */
  reference?: string
}

const EVM = /^0x[0-9a-fA-F]{40}$/
const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

export function validAddress(chain: string, address: string): boolean {
  if (chain.startsWith('eip155:')) return EVM.test(address) && !/^0x0{40}$/.test(address)
  if (chain.startsWith('solana:')) return SOLANA.test(address)
  return /^[A-Za-z0-9]{20,100}$/.test(address)
}

/** Check the config at startup. Throws on a config that would give the agent more than intended. */
export function checkConfig(c: OpenRampMcpConfig): void {
  if (!c.maxAmounts || !Object.keys(c.maxAmounts).length) throw new Error('OpenRamp MCP: `maxAmounts` is required, e.g. { USDC: "100" }')
  for (const [cur, v] of Object.entries(c.maxAmounts)) {
    if (!isDecimal(v) || cmp(v, '0') <= 0) throw new Error(`OpenRamp MCP: maxAmounts.${cur} must be a positive decimal string`)
  }
  checkNamed(c.deposit?.destinations ?? [], 'destination')
  const w = c.withdraw
  if (w?.targets?.length) {
    checkNamed(w.targets, 'withdraw target')
    if (w.source.custody !== 'app') throw new Error('OpenRamp MCP: `withdraw.targets` needs `withdraw.source.custody: "app"`')
  }
  if (w?.requireBoundTarget && !w.targets?.length) throw new Error('OpenRamp MCP: `withdraw.requireBoundTarget` needs at least one entry in `withdraw.targets`')
  if (c.approve !== undefined && typeof c.approve !== 'function') throw new Error('OpenRamp MCP: `approve` must be a function')
  const perDay = c.limits?.maxTotalPerDay
  if (perDay) {
    for (const [cur, v] of Object.entries(perDay)) {
      if (!isDecimal(v) || cmp(v, '0') <= 0) throw new Error(`OpenRamp MCP: limits.maxTotalPerDay.${cur} must be a positive decimal string`)
    }
    const keys = Object.keys(perDay).map((k) => k.toUpperCase())
    const missing = Object.keys(c.maxAmounts).filter((k) => !keys.includes(k.toUpperCase()))
    if (missing.length) throw new Error(`OpenRamp MCP: limits.maxTotalPerDay must list every currency of maxAmounts. Missing: ${missing.join(', ')}`)
  }
  const perHour = c.limits?.maxSessionsPerHour
  if (perHour !== undefined && (!Number.isInteger(perHour) || perHour < 1)) throw new Error('OpenRamp MCP: limits.maxSessionsPerHour must be a positive integer')
  if (c.deposit && !c.deposit.destinations.length && !c.deposit.allowCustomAddress?.chains.length) {
    throw new Error('OpenRamp MCP: `deposit.destinations` is empty')
  }
}

function checkNamed(list: NamedDestination[], what: string): void {
  const names = new Set<string>()
  for (const d of list) {
    if (!d.name || names.has(d.name)) throw new Error(`OpenRamp MCP: ${what} names must be unique and not empty (${d.name})`)
    names.add(d.name)
    if (!validAddress(d.chain, d.address)) throw new Error(`OpenRamp MCP: ${what} ${d.name} has an address that is not valid for ${d.chain}`)
  }
}

/** Resolve the agent's payout target choice against the bound targets. */
export function resolveTarget(c: OpenRampMcpConfig, name: string | undefined): NamedDestination | undefined {
  const w = c.withdraw!
  if (name === undefined) {
    if (w.requireBoundTarget) {
      throw new RampError('TARGET_REQUIRED', `Payouts need a named target. Allowed: ${(w.targets ?? []).map((t) => t.name).join(', ')}.`, 403)
    }
    return undefined
  }
  const t = w.targets?.find((x) => x.name === name)
  if (!t) throw new RampError('DESTINATION_NOT_ALLOWED', `Unknown target "${name}". Allowed: ${(w.targets ?? []).map((x) => x.name).join(', ') || 'none'}.`, 403)
  return t
}

/** Resolve the agent's destination choice against the allowlist. */
export function resolveDestination(
  c: OpenRampMcpConfig,
  pick: { destination?: string | undefined; custom?: { chain: string; token: string; address: string; symbol?: string | undefined; decimals?: number | undefined } | undefined },
): Destination {
  const dep = c.deposit
  if (!dep) throw new RampError('NOT_ALLOWED', 'Deposits are turned off in this MCP server.', 403)
  if (pick.custom) {
    const allow = dep.allowCustomAddress
    const { chain, address } = pick.custom
    const token = pick.custom.token.toLowerCase()
    if (!allow?.chains.includes(chain)) throw new RampError('DESTINATION_NOT_ALLOWED', `Custom addresses are not allowed on ${chain}. Use a named destination.`, 403)
    const tokens = (allow.tokens?.[chain] ?? dep.destinations.filter((d) => d.chain === chain).map((d) => d.token)).map((t) => t.toLowerCase())
    if (!tokens.includes(token)) throw new RampError('DESTINATION_NOT_ALLOWED', `Token ${pick.custom.token} is not allowed on ${chain}.`, 403)
    if (!validAddress(chain, address)) throw new RampError('BAD_REQUEST', `The address is not valid for ${chain}.`, 400)
    const known = dep.destinations.find((d) => d.chain === chain && d.token.toLowerCase() === token)
    const symbol = pick.custom.symbol ?? known?.symbol
    const decimals = pick.custom.decimals ?? known?.decimals
    return { type: 'crypto', chain, token, address, ...(symbol ? { symbol } : {}), ...(decimals !== undefined ? { decimals } : {}) }
  }
  const name = pick.destination ?? (dep.destinations.length === 1 ? dep.destinations[0]!.name : undefined)
  const d = dep.destinations.find((x) => x.name === name)
  if (!d) {
    throw new RampError('DESTINATION_NOT_ALLOWED', `Unknown destination "${name ?? ''}". Allowed: ${dep.destinations.map((x) => x.name).join(', ') || 'none'}.`, 403)
  }
  return {
    type: 'crypto',
    chain: d.chain,
    token: d.token,
    address: d.address,
    ...(d.symbol ? { symbol: d.symbol } : {}),
    ...(d.decimals !== undefined ? { decimals: d.decimals } : {}),
  }
}

/** Amount bounds for a session: inside the configured cap for the currency. */
export function resolveBounds(
  c: OpenRampMcpConfig,
  a: { currency: string; min?: string | undefined; max?: string | undefined; exact?: string | undefined },
): { min?: string; max: string; currency: string } {
  const currency = a.currency.trim()
  const key = Object.keys(c.maxAmounts).find((k) => k.toUpperCase() === currency.toUpperCase())
  if (!key) throw new RampError('CURRENCY_NOT_ALLOWED', `Currency ${currency} is not allowed. Allowed: ${Object.keys(c.maxAmounts).join(', ')}.`, 403)
  const cap = c.maxAmounts[key]!
  for (const [label, v] of [['min_amount', a.min], ['max_amount', a.max], ['amount', a.exact]] as const) {
    if (v !== undefined && (!isDecimal(v) || cmp(v, '0') <= 0)) throw new RampError('BAD_REQUEST', `${label} must be a positive decimal string, e.g. "25" or "12.5".`, 400)
  }
  const max = a.exact ?? a.max ?? cap
  if (cmp(max, cap) > 0) throw new RampError('AMOUNT_TOO_HIGH', `The largest allowed amount is ${cap} ${key}.`, 403)
  const min = a.exact ?? a.min
  if (min !== undefined && cmp(min, max) > 0) throw new RampError('BAD_REQUEST', 'min_amount is larger than max_amount.', 400)
  return { ...(min !== undefined ? { min } : {}), max, currency: key }
}
