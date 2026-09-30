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

export type ChainInfo = { id: string; chainId?: number; name: string; nativeSymbol: string; /** True for test networks */ testnet?: boolean }

export const CHAINS: Record<string, ChainInfo> = {
  'eip155:1': { id: 'eip155:1', chainId: 1, name: 'Ethereum', nativeSymbol: 'ETH' },
  'eip155:8453': { id: 'eip155:8453', chainId: 8453, name: 'Base', nativeSymbol: 'ETH' },
  'eip155:42161': { id: 'eip155:42161', chainId: 42161, name: 'Arbitrum', nativeSymbol: 'ETH' },
  'eip155:10': { id: 'eip155:10', chainId: 10, name: 'Optimism', nativeSymbol: 'ETH' },
  'eip155:137': { id: 'eip155:137', chainId: 137, name: 'Polygon', nativeSymbol: 'POL' },
  'eip155:56': { id: 'eip155:56', chainId: 56, name: 'BNB Chain', nativeSymbol: 'BNB' },
  'eip155:143': { id: 'eip155:143', chainId: 143, name: 'Monad', nativeSymbol: 'MON' },
  'eip155:999': { id: 'eip155:999', chainId: 999, name: 'HyperEVM', nativeSymbol: 'HYPE' },
  // Robinhood Chain (Arbitrum Orbit L2). Source: docs.robinhood.com/chain/connecting
  'eip155:4663': { id: 'eip155:4663', chainId: 4663, name: 'Robinhood Chain', nativeSymbol: 'ETH' },
  // Test networks
  'eip155:421614': { id: 'eip155:421614', chainId: 421614, name: 'Arbitrum Sepolia', nativeSymbol: 'ETH', testnet: true },
  'eip155:46630': { id: 'eip155:46630', chainId: 46630, name: 'Robinhood Chain Testnet', nativeSymbol: 'ETH', testnet: true },
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': { id: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', name: 'Solana', nativeSymbol: 'SOL' },
}

export function chainName(chain: string): string {
  return CHAINS[chain]?.name ?? chain
}

export function evmChainId(chain: string): number | undefined {
  if (!chain.startsWith('eip155:')) return undefined
  const n = Number(chain.slice(7))
  return Number.isFinite(n) ? n : undefined
}

/** Well-known USDC deployments (lowercase addresses). */
export const USDC: Record<string, string> = {
  'eip155:1': '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  'eip155:8453': '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  'eip155:42161': '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
  'eip155:10': '0x0b2c639c533813f4aa9d7837caf62653d097ff85',
  'eip155:137': '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
  // Circle testnet USDC on Arbitrum Sepolia (developers.circle.com/stablecoins/usdc-contract-addresses)
  'eip155:421614': '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d',
  // TODO: Robinhood Chain (4663) and its testnet (46630): Circle lists no USDC deployment yet.
}
