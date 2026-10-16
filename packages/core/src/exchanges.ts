// Exchanges in the "From an exchange" picker. An exchange either has a connect method (the user pays from
// their exchange balance on the exchange's own page, for example Binance Pay or the Coinbase account), or
// the user withdraws from the exchange to a deposit address (`exchange_transfer`). The plan decides which
// methods exist for this user (adapters, regions), so the picker follows the plan and never adds a method.

import { SOLANA_MAINNET, TEMPO_MAINNET } from './codes.js'
import type { MethodOption } from './planner.js'

/**
 * The name an exchange shows for a network in its withdraw screen, for example "Arbitrum One" or
 * "BNB Smart Chain (BEP20)". Each value has the official page where we read it (`source`) and the date of
 * that read (`read`, YYYY-MM-DD). Exchanges rename networks: read the source again before a change.
 */
export type NetworkLabel = { label: string; source: string; read: string }

export type ExchangeInfo = {
  id: string
  name: string
  /**
   * Methods that pay from the user's account at this exchange, best first. `provider` (the adapter name)
   * is set when the method id alone does not name the exchange, for example the generic `exchange`.
   */
  connect: Array<{ method: string; provider?: string }>
  /**
   * Verified withdraw network names, by CAIP-2 chain id. Only values read on an official source of the
   * exchange. A chain with no value uses the generic chain name. Missing data never hides the exchange.
   */
  networks?: Record<string, NetworkLabel>
}

const READ = '2026-10-16'
const ETHEREUM = 'eip155:1'
const BASE = 'eip155:8453'
const ARBITRUM = 'eip155:42161'
const OPTIMISM = 'eip155:10'
const POLYGON = 'eip155:137'
const BNB = 'eip155:56'
const MONAD = 'eip155:143'
const HYPEREVM = 'eip155:999'

/** The same source for many labels */
function labels(source: string, names: Record<string, string>): Record<string, NetworkLabel> {
  return Object.fromEntries(Object.entries(names).map(([chain, label]) => [chain, { label, source, read: READ }]))
}

// Binance: the network list of its public capital API (field `name`), which the withdraw screen shows
const BINANCE_NETWORKS = labels('https://www.binance.com/bapi/capital/v1/public/capital/getNetworkCoinAll', {
  [ETHEREUM]: 'Ethereum (ERC20)',
  [BASE]: 'Base',
  [ARBITRUM]: 'Arbitrum One',
  [OPTIMISM]: 'Optimism',
  [POLYGON]: 'Polygon POS',
  [BNB]: 'BNB Smart Chain (BEP20)',
  [SOLANA_MAINNET]: 'Solana',
})

// Coinbase: `supported_networks[].name` of USDC in the Coinbase Exchange public API
const COINBASE_NETWORKS = labels('https://api.exchange.coinbase.com/currencies/USDC', {
  [ETHEREUM]: 'Ethereum',
  [BASE]: 'Base',
  [ARBITRUM]: 'Arbitrum',
  [OPTIMISM]: 'Optimism',
  [POLYGON]: 'Polygon',
  [SOLANA_MAINNET]: 'Solana',
  [MONAD]: 'Monad',
  [HYPEREVM]: 'HyperEVM',
  [TEMPO_MAINNET]: 'Tempo',
})

// OKX: network names in OKX help articles ("USDC-Base", "USDC-Arbitrum One", "USDG-ERC20", "BNB Smart Chain")
const OKX_NETWORKS: Record<string, NetworkLabel> = {
  ...labels('https://www.okx.com/en-us/help/okx-to-support-usdc-base', { [BASE]: 'Base' }),
  ...labels('https://www.okx.com/en-sg/help/okx-to-support-usdc-on-the-arbitrum-network', { [ARBITRUM]: 'Arbitrum One' }),
  ...labels('https://www.okx.com/en-us/help/how-do-i-select-the-correct-network-for-my-crypto-withdrawals-and-deposits', {
    [ETHEREUM]: 'ERC20',
    [BNB]: 'BNB Smart Chain',
  }),
}

// Bybit: the network name in its USDC integration announcement
const BYBIT_NETWORKS = labels('https://announcements.bybit.com/article/bybit-completes-integration-of-usdc-on-the-arbitrum-one-network-blt4f61e4fe61d10b57/', {
  [ARBITRUM]: 'Arbitrum One',
})

// Kraken: the network of each USDC funding method ("USDC (Base, USDC - Base)") in its fees and minimums article
const KRAKEN_NETWORKS = labels('https://support.kraken.com/articles/360000767986-cryptocurrency-withdrawal-fees-and-minimums', {
  [ETHEREUM]: 'Ethereum',
  [BASE]: 'Base',
  [ARBITRUM]: 'Arbitrum One',
  [OPTIMISM]: 'Optimism',
  [POLYGON]: 'Polygon',
  [SOLANA_MAINNET]: 'Solana',
})

export const EXCHANGES: ExchangeInfo[] = [
  { id: 'binance', name: 'Binance', connect: [{ method: 'exchange', provider: 'Binance' }, { method: 'binance_pay' }], networks: BINANCE_NETWORKS },
  { id: 'coinbase', name: 'Coinbase', connect: [{ method: 'coinbase_account' }], networks: COINBASE_NETWORKS },
  { id: 'okx', name: 'OKX', connect: [], networks: OKX_NETWORKS },
  { id: 'bybit', name: 'Bybit', connect: [], networks: BYBIT_NETWORKS },
  { id: 'kraken', name: 'Kraken', connect: [], networks: KRAKEN_NETWORKS },
]

/**
 * The name that the exchange shows for the chain in its withdraw screen, when we verified it. Undefined
 * for an unknown exchange, "Other exchange", or a chain with no verified value: then use the chain name.
 */
export function exchangeNetworkLabel(exchange: string | undefined, chain: string): string | undefined {
  if (!exchange) return undefined
  return EXCHANGES.find((x) => x.id === exchange)?.networks?.[chain]?.label
}

/** Id of the "Other exchange" row */
export const OTHER_EXCHANGE = 'other'

export type ExchangeOption = {
  id: string
  name: string
  /** `connect`: pay on the exchange's page. `deposit`: withdraw from the exchange to a deposit address. */
  mode: 'connect' | 'deposit'
  /** The method to start */
  method: string
  /** For `connect`: the deposit method to offer when the connect payment fails */
  fallback?: string
}

/**
 * The picker rows for a plan: each known exchange with its first available connect method, else with
 * `exchange_transfer`, then "Other exchange" (deposit). Empty when the plan has no connect method: then
 * the plain "From an exchange" method row is enough.
 */
export function exchangeOptions(methods: MethodOption[]): ExchangeOption[] {
  const ok = methods.filter((m) => m.group !== 'unavailable')
  const has = (method: string, provider?: string) => ok.some((m) => m.method === method && (!provider || m.providers.includes(provider)))
  const deposit = has('exchange_transfer') ? 'exchange_transfer' : undefined
  const rows: ExchangeOption[] = []
  for (const x of EXCHANGES) {
    const c = x.connect.find((c) => has(c.method, c.provider))
    if (c) rows.push({ id: x.id, name: x.name, mode: 'connect', method: c.method, ...(deposit ? { fallback: deposit } : {}) })
    else if (deposit) rows.push({ id: x.id, name: x.name, mode: 'deposit', method: deposit })
  }
  if (!rows.some((r) => r.mode === 'connect')) return []
  if (deposit) rows.push({ id: OTHER_EXCHANGE, name: 'Other exchange', mode: 'deposit', method: deposit })
  return rows
}

/** Methods that the picker row stands for: every method of kind `exchange`, and the connect methods of the list */
export function isExchangeMethod(m: Pick<MethodOption, 'method' | 'kind'>): boolean {
  return m.kind === 'exchange' || EXCHANGES.some((x) => x.connect.some((c) => c.method === m.method))
}
