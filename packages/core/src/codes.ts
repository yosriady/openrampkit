// Country, currency, chain and payment method vocabularies.

export const CURRENCY_MINOR_UNITS: Record<string, number> = {
  USD: 2, EUR: 2, GBP: 2, SGD: 2, MYR: 2, PHP: 2, THB: 2, IDR: 0, VND: 0, INR: 2, BRL: 2,
  AUD: 2, CAD: 2, JPY: 0, KRW: 0, HKD: 2, TWD: 2, CHF: 2, MXN: 2, NGN: 2, KES: 2, TRY: 2,
}

export function minorUnits(currency: string): number {
  return CURRENCY_MINOR_UNITS[currency.toUpperCase()] ?? 2
}

export const COUNTRY_CURRENCY: Record<string, string> = {
  US: 'USD', GB: 'GBP', SG: 'SGD', MY: 'MYR', PH: 'PHP', TH: 'THB', ID: 'IDR', VN: 'VND',
  IN: 'INR', BR: 'BRL', AU: 'AUD', CA: 'CAD', JP: 'JPY', KR: 'KRW', HK: 'HKD', TW: 'TWD',
  CH: 'CHF', MX: 'MXN', NG: 'NGN', KE: 'KES', TR: 'TRY',
  DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', IE: 'EUR', PT: 'EUR', AT: 'EUR', BE: 'EUR', FI: 'EUR',
}

export function currencyForCountry(country: string | undefined): string {
  return (country && COUNTRY_CURRENCY[country.toUpperCase()]) || 'USD'
}

export type MethodInfo = { id: string; name: string; kind: 'card' | 'wallet_pay' | 'bank' | 'qr' | 'ewallet' | 'crypto' | 'exchange' }

/** Built-in method vocabulary. Adapters may add more ids. */
export const METHODS: Record<string, MethodInfo> = {
  wallet: { id: 'wallet', name: 'Pay with wallet', kind: 'crypto' },
  transfer: { id: 'transfer', name: 'Transfer crypto', kind: 'crypto' },
  exchange: { id: 'exchange', name: 'Connect exchange', kind: 'exchange' },
  card: { id: 'card', name: 'Card', kind: 'card' },
  apple_pay: { id: 'apple_pay', name: 'Apple Pay', kind: 'wallet_pay' },
  google_pay: { id: 'google_pay', name: 'Google Pay', kind: 'wallet_pay' },
  bank_transfer: { id: 'bank_transfer', name: 'Bank transfer', kind: 'bank' },
  sepa: { id: 'sepa', name: 'SEPA', kind: 'bank' },
  ach: { id: 'ach', name: 'ACH', kind: 'bank' },
  pix: { id: 'pix', name: 'PIX', kind: 'qr' },
  upi: { id: 'upi', name: 'UPI', kind: 'qr' },
  qris: { id: 'qris', name: 'QRIS', kind: 'qr' },
  promptpay: { id: 'promptpay', name: 'PromptPay', kind: 'qr' },
  qrph: { id: 'qrph', name: 'QR Ph', kind: 'qr' },
  duitnow: { id: 'duitnow', name: 'DuitNow QR', kind: 'qr' },
  vietqr: { id: 'vietqr', name: 'VietQR', kind: 'qr' },
  paynow: { id: 'paynow', name: 'PayNow', kind: 'qr' },
  fpx: { id: 'fpx', name: 'FPX', kind: 'bank' },
  instapay: { id: 'instapay', name: 'InstaPay', kind: 'bank' },
  gcash: { id: 'gcash', name: 'GCash', kind: 'ewallet' },
  maya: { id: 'maya', name: 'Maya', kind: 'ewallet' },
  momo: { id: 'momo', name: 'MoMo', kind: 'ewallet' },
  zalopay: { id: 'zalopay', name: 'ZaloPay', kind: 'ewallet' },
  gopay: { id: 'gopay', name: 'GoPay', kind: 'ewallet' },
  dana: { id: 'dana', name: 'DANA', kind: 'ewallet' },
  ovo: { id: 'ovo', name: 'OVO', kind: 'ewallet' },
  shopeepay: { id: 'shopeepay', name: 'ShopeePay', kind: 'ewallet' },
  touchngo: { id: 'touchngo', name: "Touch 'n Go", kind: 'ewallet' },
  grabpay: { id: 'grabpay', name: 'GrabPay', kind: 'ewallet' },
  revolut_pay: { id: 'revolut_pay', name: 'Revolut Pay', kind: 'wallet_pay' },
  venmo: { id: 'venmo', name: 'Venmo', kind: 'wallet_pay' },
  interac: { id: 'interac', name: 'Interac', kind: 'bank' },
  truemoney: { id: 'truemoney', name: 'TrueMoney', kind: 'ewallet' },
  linkaja: { id: 'linkaja', name: 'LinkAja', kind: 'ewallet' },
  // P2P payment apps (Peer) and more wallets (Meld, Onramper)
  cash_app: { id: 'cash_app', name: 'Cash App', kind: 'wallet_pay' },
  zelle: { id: 'zelle', name: 'Zelle', kind: 'bank' },
  chime: { id: 'chime', name: 'Chime', kind: 'bank' },
  paypal: { id: 'paypal', name: 'PayPal', kind: 'ewallet' },
  wise: { id: 'wise', name: 'Wise', kind: 'bank' },
  revolut: { id: 'revolut', name: 'Revolut', kind: 'ewallet' },
  binance_pay: { id: 'binance_pay', name: 'Binance Pay', kind: 'ewallet' },
  mercadopago: { id: 'mercadopago', name: 'Mercado Pago', kind: 'ewallet' },
}

const EU = ['AT', 'BE', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK']

/** Countries where a local method exists. Methods not listed are available everywhere. */
export const METHOD_COUNTRIES: Record<string, string[]> = {
  vietqr: ['VN'], momo: ['VN'], zalopay: ['VN'],
  qris: ['ID'], gopay: ['ID'], dana: ['ID'], ovo: ['ID'], shopeepay: ['ID', 'MY', 'PH', 'TH', 'VN', 'SG'],
  qrph: ['PH'], gcash: ['PH'], maya: ['PH'], instapay: ['PH'],
  promptpay: ['TH'], truemoney: ['TH'], linkaja: ['ID'],
  duitnow: ['MY'], touchngo: ['MY'], fpx: ['MY'], boost: ['MY'], grabpay: ['MY', 'SG', 'PH'],
  paynow: ['SG'],
  upi: ['IN'], pix: ['BR'], interac: ['CA'], ach: ['US'], venmo: ['US'],
  cash_app: ['US'], zelle: ['US'], chime: ['US'],
  mercadopago: ['AR', 'BR', 'CL', 'CO', 'MX', 'PE', 'UY'],
  sepa: [...EU, 'NO', 'IS', 'LI', 'CH'],
}

/** True when `method` can be offered to a user in `country` (unknown country: allow). */
export function methodAvailableIn(method: string, country: string | undefined): boolean {
  const list = METHOD_COUNTRIES[method]
  return !list || !country || list.includes(country.toUpperCase())
}

export function methodName(id: string): string {
  return METHODS[id]?.name ?? id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Default "most popular first" order per country. Apps can override it. */
export const DEFAULT_METHOD_PRIORITY: Record<string, string[]> = {
  ID: ['qris', 'gopay', 'dana', 'ovo', 'shopeepay', 'bank_transfer', 'card'],
  VN: ['vietqr', 'momo', 'zalopay', 'bank_transfer', 'card'],
  TH: ['promptpay', 'truemoney', 'bank_transfer', 'card'],
  MY: ['duitnow', 'touchngo', 'fpx', 'grabpay', 'card'],
  PH: ['qrph', 'gcash', 'maya', 'instapay', 'card'],
  SG: ['paynow', 'card', 'apple_pay', 'google_pay'],
  IN: ['upi', 'card'],
  BR: ['pix', 'card', 'mercadopago'],
  CA: ['interac', 'card', 'apple_pay'],
  US: ['apple_pay', 'card', 'google_pay', 'ach', 'venmo', 'cash_app', 'zelle', 'paypal', 'chime'],
  '*': ['apple_pay', 'card', 'google_pay', 'sepa', 'bank_transfer'],
}

export type ChainInfo = {
  /** CAIP-2 chain id */
  id: string
  /** EVM chain id (eip155 chains only) */
  chainId?: number
  name: string
  /** Symbol of the gas token. Tempo has no gas token: it shows `USD`. */
  nativeSymbol: string
  /** Decimals of the native token (EVM 18, Solana 9) */
  nativeDecimals?: number
  /** True for a test network */
  testnet?: boolean
  /**
   * True when the chain has no native gas token and fees are paid in stablecoins (Tempo).
   * On such chains `eth_getBalance` does not return a real balance, so do not show it.
   */
  stablecoinFees?: boolean
  /** Public block explorer */
  explorerUrl?: string
}

/** CAIP-2 id of Solana mainnet (genesis hash prefix) */
export const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
/** CAIP-2 id of Solana devnet (genesis hash prefix) */
export const SOLANA_DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
/** CAIP-2 id of Tempo mainnet (chain id 4217) */
export const TEMPO_MAINNET = 'eip155:4217'
/** CAIP-2 id of the Tempo Moderato testnet (chain id 42431) */
export const TEMPO_TESTNET = 'eip155:42431'

export const CHAINS: Record<string, ChainInfo> = {
  'eip155:1': { id: 'eip155:1', chainId: 1, name: 'Ethereum', nativeSymbol: 'ETH', nativeDecimals: 18 },
  'eip155:8453': { id: 'eip155:8453', chainId: 8453, name: 'Base', nativeSymbol: 'ETH', nativeDecimals: 18 },
  'eip155:42161': { id: 'eip155:42161', chainId: 42161, name: 'Arbitrum', nativeSymbol: 'ETH', nativeDecimals: 18 },
  'eip155:10': { id: 'eip155:10', chainId: 10, name: 'Optimism', nativeSymbol: 'ETH', nativeDecimals: 18 },
  'eip155:137': { id: 'eip155:137', chainId: 137, name: 'Polygon', nativeSymbol: 'POL', nativeDecimals: 18 },
  'eip155:56': { id: 'eip155:56', chainId: 56, name: 'BNB Chain', nativeSymbol: 'BNB', nativeDecimals: 18 },
  'eip155:143': { id: 'eip155:143', chainId: 143, name: 'Monad', nativeSymbol: 'MON', nativeDecimals: 18 },
  'eip155:999': { id: 'eip155:999', chainId: 999, name: 'HyperEVM', nativeSymbol: 'HYPE', nativeDecimals: 18 },
  [TEMPO_MAINNET]: { id: TEMPO_MAINNET, chainId: 4217, name: 'Tempo', nativeSymbol: 'USD', nativeDecimals: 18, stablecoinFees: true, explorerUrl: 'https://explore.tempo.xyz' },
  [TEMPO_TESTNET]: { id: TEMPO_TESTNET, chainId: 42431, name: 'Tempo Testnet', nativeSymbol: 'USD', nativeDecimals: 18, stablecoinFees: true, testnet: true, explorerUrl: 'https://explore.testnet.tempo.xyz' },
  [SOLANA_MAINNET]: { id: SOLANA_MAINNET, name: 'Solana', nativeSymbol: 'SOL', nativeDecimals: 9, explorerUrl: 'https://explorer.solana.com' },
  [SOLANA_DEVNET]: { id: SOLANA_DEVNET, name: 'Solana Devnet', nativeSymbol: 'SOL', nativeDecimals: 9, testnet: true, explorerUrl: 'https://explorer.solana.com/?cluster=devnet' },
  // Robinhood Chain (Arbitrum Orbit L2). Source: docs.robinhood.com/chain/connecting
  'eip155:4663': { id: 'eip155:4663', chainId: 4663, name: 'Robinhood Chain', nativeSymbol: 'ETH', nativeDecimals: 18 },
  // Test networks
  'eip155:421614': { id: 'eip155:421614', chainId: 421614, name: 'Arbitrum Sepolia', nativeSymbol: 'ETH', nativeDecimals: 18, testnet: true },
  'eip155:46630': { id: 'eip155:46630', chainId: 46630, name: 'Robinhood Chain Testnet', nativeSymbol: 'ETH', nativeDecimals: 18, testnet: true },
}

export function chainName(chain: string): string {
  return CHAINS[chain]?.name ?? chain
}

export function evmChainId(chain: string): number | undefined {
  if (!chain.startsWith('eip155:')) return undefined
  const n = Number(chain.slice(7))
  return Number.isFinite(n) ? n : undefined
}

export function isEvmChain(chain: string): boolean {
  return chain.startsWith('eip155:')
}

export function isSolanaChain(chain: string): boolean {
  return chain.startsWith('solana:')
}

/** Decimals of the chain's native token: 9 on Solana, else 18 */
export function nativeDecimals(chain: string): number {
  return CHAINS[chain]?.nativeDecimals ?? (isSolanaChain(chain) ? 9 : 18)
}

/**
 * Canonical form of a token id on a chain. EVM addresses are not case-sensitive, so they are
 * lowercased. Solana mints (base58) and tokens on other chains are case-sensitive: they stay as given.
 */
export function normalizeToken(chain: string, token: string): string {
  if (token.toLowerCase() === 'native') return 'native'
  return isEvmChain(chain) ? token.toLowerCase() : token
}

/** True when two token ids name the same token on `chain` */
export function sameToken(chain: string, a: string, b: string): boolean {
  return normalizeToken(chain, a) === normalizeToken(chain, b)
}

/** USDC mint (Circle) on Solana mainnet */
export const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
/** USDC mint (Circle) on Solana devnet */
export const SOLANA_DEVNET_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
/** USDC on Tempo mainnet: bridged USDC (Tempo docs call it USDC.e), a TIP-20 token with 6 decimals */
export const TEMPO_USDC = '0x20c000000000000000000000b9537d11c60e8b50'
/** pathUSD on Tempo mainnet: the default fee token (TIP-20, 6 decimals) */
export const TEMPO_PATH_USD = '0x20c0000000000000000000000000000000000000'

/**
 * Well-known USDC deployments per CAIP-2 chain, in canonical form (see `normalizeToken`):
 * lowercase EVM addresses, Solana mints as given. All have 6 decimals.
 */
export const USDC: Record<string, string> = {
  'eip155:1': '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  'eip155:8453': '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  'eip155:42161': '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
  'eip155:10': '0x0b2c639c533813f4aa9d7837caf62653d097ff85',
  'eip155:137': '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
  [TEMPO_MAINNET]: TEMPO_USDC,
  [SOLANA_MAINNET]: SOLANA_USDC_MINT,
  // Circle testnet USDC on Arbitrum Sepolia (developers.circle.com/stablecoins/usdc-contract-addresses)
  'eip155:421614': '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d',
  // TODO: Robinhood Chain (4663) and its testnet (46630): Circle lists no USDC deployment yet.
}

/**
 * More testnet USDC, kept out of `USDC` (Solana devnet). `USDC` lists the withdraw networks and
 * wallet balances, and no Relay route reaches Solana devnet.
 */
export const TESTNET_USDC: Record<string, string> = {
  [SOLANA_DEVNET]: SOLANA_DEVNET_USDC_MINT,
}

/** True when `token` is the well-known USDC on `chain` (in `USDC` or `TESTNET_USDC`) */
export function isUsdc(chain: string, token: string): boolean {
  const u = USDC[chain] ?? TESTNET_USDC[chain]
  return !!u && sameToken(chain, u, token)
}
