// Pure view logic for <openramp-modal>. No Lit and no DOM here, so it is easy to test.

import type { Snapshot } from '@openrampkit/client'
import { CHAINS, USDC, mulRatio } from '@openrampkit/core'
import type { IframeMessages, MethodOption, OrkError, PathwayGroup, Quote, Step, Surface, WalletBalance } from '@openrampkit/core'
import { currencySymbol, formatAmount, formatFees, formatFiat, formatLimit, presetAmounts, shortAddress, titleCase } from './format.js'
import type { Messages } from './messages.js'
import type { Appearance, Theme } from './theme.js'

export const GROUP_ORDER: PathwayGroup[] = ['connected', 'recommended', 'more', 'unavailable']

/** Concrete color mode for a theme. `auto` follows the system setting. */
export function resolveMode(theme: Theme | undefined, systemDark: boolean): 'light' | 'dark' {
  if (theme?.mode === 'dark') return 'dark'
  if (theme?.mode === 'auto') return systemDark ? 'dark' : 'light'
  return 'light'
}

/** Identifies one step screen. Form inputs reset when it changes. */
export function stepKey(step: Step | undefined): string {
  return step ? `${step.state}|${step.sub ?? ''}|${step.legIndex ?? ''}|${step.surface?.kind ?? ''}` : ''
}

/** Screen shown for a snapshot, or for an element that has no controller yet. */
export function screenOf(s: Snapshot | undefined, error: OrkError | undefined): string {
  if (s) return s.screen
  return error ? 'error' : 'loading'
}

export function screenTitle(s: Snapshot | undefined, m: Messages, appearance?: Appearance): string {
  const withdraw = s?.direction === 'withdraw'
  const base = appearance?.title ?? (withdraw ? m.withdrawTitle : m.title)
  if (!s) return base
  switch (s.screen) {
    case 'amount':
      if (withdraw && s.tab === 'crypto') return m.withdrawAmountTitle
      return s.method?.name ?? base
    case 'quotes':
      return s.method?.method === 'exchange_transfer' ? m.exchangeTitle : s.method?.method === 'transfer' ? m.transferTitle : m.quotesTitle
    case 'step': {
      const step = s.session?.step
      if (withdraw && step) {
        if (step.state === 'PAYMENT' && step.surface?.kind === 'FORM') return m.payoutDetailsTitle
        if (step.state === 'PAYMENT' && step.surface?.kind === 'WALLET_TX') return m.confirmWithdrawalTitle
        if (step.state === 'PROCESSING') return m.sending
      }
      return (step && m.stepTitle[step.state]) || base
    }
    default:
      return base
  }
}

/** Text for the polite live region, so screen readers hear loading, errors and step progress. */
export function liveText(s: Snapshot | undefined, error: OrkError | undefined, m: Messages): string {
  if (!s) return error ? error.message : m.loading
  if (s.quotesLoading) return m.gettingQuotes
  if (s.error) return s.error.message
  if (s.screen === 'step' && s.session) {
    const step = s.session.step
    const legs = step.progress?.legs.map((l, i) => `${i + 1}. ${l.provider ?? titleCase(l.adapterId)}: ${m.legStatus[l.status] ?? l.status}`) ?? []
    return [m.stepTitle[step.state] ?? '', ...legs].join('. ')
  }
  if (s.screen === 'result' && s.session) {
    const state = s.session.step.state
    const withdraw = s.direction === 'withdraw'
    if (state === 'COMPLETED') return withdraw ? m.withdrawSuccessTitle : m.successTitle
    return withdraw && state === 'FAILED' ? m.withdrawFailedTitle : m.failedTitle[state] ?? m.failedBody
  }
  return ''
}

/** Which tab to show and its methods. Tabs show only when both tabs have methods. */
export function methodTabs(crypto: MethodOption[], cash: MethodOption[], tab: 'crypto' | 'cash') {
  const showTabs = crypto.length > 0 && cash.length > 0
  const active: 'crypto' | 'cash' = showTabs ? tab : crypto.length ? 'crypto' : 'cash'
  return { showTabs, tab: active, list: active === 'crypto' ? crypto : cash }
}

/** Methods grouped in display order. Empty groups are left out. */
export function groupMethods(list: MethodOption[]): Array<{ group: PathwayGroup; items: MethodOption[] }> {
  return GROUP_ORDER.map((group) => ({ group, items: list.filter((x) => x.group === group) })).filter((g) => g.items.length > 0)
}

export function groupLabel(g: PathwayGroup, m: Messages): string {
  return { connected: m.groupConnected, recommended: m.groupRecommended, more: m.groupMore, unavailable: m.groupUnavailable }[g]
}

/** Second line of a method row: the reason when unavailable, else wallet, providers and limit. */
export function methodSubtitle(x: MethodOption, walletAddress: string | undefined, m: Messages): string {
  if (x.group === 'unavailable') return x.reason?.message ?? ''
  const parts: string[] = []
  if (x.method === 'wallet' && walletAddress) parts.push(shortAddress(walletAddress))
  if (x.providers.length) parts.push(m.via(x.providers.join(', ')))
  const limit = formatLimit(x.limits, m)
  if (limit) parts.push(limit)
  return parts.join(' · ')
}

export type AmountModel = {
  /** Deposit from a wallet: show the pay-with balance picker */
  isWallet: boolean
  /** Withdraw: the amount is in the source token */
  isWithdraw: boolean
  /** Withdraw: the amount is above the wallet balance */
  overBalance: boolean
  currency: string
  /** Currency symbol shown before the input, or '' */
  prefix: string
  boundsText: string
  balance: WalletBalance | undefined
  chips: Array<{ label: string; value: string }>
  valid: boolean
  /** Input width in `ch` */
  width: number
}

/** Everything the amount screen shows, derived from the snapshot. */
export function amountModel(s: Snapshot, m: Messages): AmountModel {
  const method = s.method
  const isWithdraw = s.direction === 'withdraw'
  const isWallet = !isWithdraw && method?.method === 'wallet'
  const src = s.session?.source
  const tokenMode = isWallet || isWithdraw
  const currency = isWithdraw ? src?.symbol ?? 'USDC' : isWallet ? s.source?.symbol ?? 'USDC' : s.plan?.currency ?? s.session?.currency ?? 'USD'
  const symbol = tokenMode ? '' : currencySymbol(currency, m.locale)
  const prefix = !!symbol && symbol !== currency.toUpperCase() ? symbol : ''
  const bounds = isWallet ? undefined : isWithdraw ? s.session?.amountBounds : s.session?.amountBounds ?? method?.limits
  const fmtBound = (v?: string) => (v && bounds ? formatFiat(v, bounds.currency, { compact: true, locale: m.locale }) : undefined)
  const boundsText = bounds ? m.minMax(fmtBound(bounds.min), fmtBound(bounds.max)) : ''
  const balance = isWithdraw
    ? src && s.balances.find((b) => b.chain === src.chain && b.token.toLowerCase() === src.token.toLowerCase())
    : isWallet
      ? s.balances.find((b) => b.chain === s.source?.chain && b.token === s.source?.token)
      : undefined
  const overBalance = isWithdraw && !!balance && !!s.amount && Number(s.amount) > Number(balance.amount)
  const chips = tokenMode
    ? balance
      ? [
          { label: '25%', value: mulRatio(balance.amount, '0.25') },
          { label: '50%', value: mulRatio(balance.amount, '0.5') },
          { label: m.max, value: balance.amount },
        ]
      : []
    : presetAmounts(currency).map((n) => ({ label: formatFiat(String(n), currency, { compact: true, locale: m.locale }), value: String(n) }))
  return {
    isWallet,
    isWithdraw,
    overBalance,
    currency,
    prefix,
    boundsText,
    balance,
    chips,
    valid: !!s.amount && Number(s.amount) > 0 && !overBalance,
    width: Math.max(1, s.amount.length || 1) + 0.3,
  }
}

/** Second line of a quote row: what the user pays and the fees. */
export function quoteSubtitle(q: Quote, m: Messages, direction: 'deposit' | 'withdraw' = 'deposit'): string {
  const fees = formatFees(q.fees, m.locale)
  const sub: string[] = []
  if (Number(q.input.amount) > 0) sub.push((direction === 'withdraw' ? m.youSend : m.youPay)(formatAmount(q.input, m.locale)))
  // A fee in the rate with no known amount: say nothing rather than "No fees".
  if (fees) sub.push(m.fees(fees))
  else if (!q.fees.some((f) => f.inRate)) sub.push(m.noFees)
  return sub.join(' · ')
}

/** The quote after (dir 1) or before (dir -1) the selected one, wrapping around. */
export function nextQuoteId(quotes: Quote[], selectedId: string | undefined, dir: 1 | -1): string | undefined {
  if (!quotes.length) return undefined
  const i = quotes.findIndex((q) => q.id === selectedId)
  return quotes[(i + dir + quotes.length) % quotes.length]?.id
}

export type TokenOption = { token: string; symbol: string; decimals: number }

/** Networks for the transfer source picker: every chain with USDC, plus the current source chain. */
export function transferChains(sourceChain: string | undefined): string[] {
  const chains = Object.keys(USDC)
  if (sourceChain && !chains.includes(sourceChain)) chains.push(sourceChain)
  return chains
}

/** Tokens for the transfer source picker on one chain: USDC when known, and the native token. */
export function transferTokens(chain: string): TokenOption[] {
  return [
    ...(USDC[chain] ? [{ token: USDC[chain]!, symbol: 'USDC', decimals: 6 }] : []),
    { token: 'native', symbol: CHAINS[chain]?.nativeSymbol ?? 'ETH', decimals: 18 },
  ]
}

/** Source after a network change: keep "native" when it was native, else the first token. */
export function sourceForChain(chain: string, wasNative: boolean): TokenOption & { chain: string } {
  const opts = transferTokens(chain)
  const next = (wasNative ? opts.find((o) => o.token === 'native') : opts[0]) ?? opts[0]!
  return { chain, ...next }
}

// ---------- provider iframe messages ----------

export type IframeSignal = 'completed' | 'failed' | 'closed'

/** `source` of the generic OpenRampKit embed protocol (the same shape D0 uses). */
export const EMBED_SOURCE = 'openramp-embed'
const EMBED_TYPES: Record<string, IframeSignal> = { 'payment.completed': 'completed', 'payment.failed': 'failed', closed: 'closed' }

/** Exact origin (scheme, host and port) that may post messages for an IFRAME surface, or undefined when it is not valid. */
export function iframeOrigin(surface: Extract<Surface, { kind: 'IFRAME' }>): string | undefined {
  const raw = surface.messages?.origin ?? surface.origin
  try {
    const o = new URL(raw).origin
    return o && o !== 'null' ? o : undefined
  } catch {
    return undefined
  }
}

/**
 * Map a provider `postMessage` payload to a signal, or undefined to ignore it.
 * Reads `data[typeField]` against the surface's `completed`, `failed` and `closed` lists, and also
 * accepts the generic `{ source: 'openramp-embed', type: 'payment.completed' | 'payment.failed' | 'closed' }`.
 * A JSON string payload is parsed first. The caller must check the origin and the source window.
 */
export function classifyIframeMessage(data: unknown, cfg: IframeMessages | undefined): IframeSignal | undefined {
  let d = data
  if (typeof d === 'string' && d.startsWith('{')) {
    try {
      d = JSON.parse(d)
    } catch {
      return undefined
    }
  }
  if (!d || typeof d !== 'object') return undefined
  const rec = d as Record<string, unknown>
  if (rec.source === EMBED_SOURCE && typeof rec.type === 'string' && EMBED_TYPES[rec.type]) return EMBED_TYPES[rec.type]
  if (!cfg) return undefined
  const type = rec[cfg.typeField ?? 'type']
  if (typeof type !== 'string') return undefined
  if (cfg.completed?.includes(type)) return 'completed'
  if (cfg.failed?.includes(type)) return 'failed'
  if (cfg.closed?.includes(type)) return 'closed'
  return undefined
}
