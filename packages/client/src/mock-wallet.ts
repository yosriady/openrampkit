import type { TxRequest, TypedDataRequest, WalletAdapter, WalletBalance } from '@openrampkit/core'

/**
 * A fake wallet for local development and tests. It never touches a chain:
 * `sendTransactions` records the txs and returns a random hash after a short delay.
 * With `canSign`, it also has `signTypedData` (gas abstraction), which records the message and
 * returns a random 65-byte signature (a real server refuses it: it is not from the address).
 */
export function createMockWallet(opts: {
  address?: string
  balances?: WalletBalance[]
  delayMs?: number
  /** Called for every send, for assertions in tests */
  onSend?: (chain: string, txs: TxRequest[]) => void
  /** Add `signTypedData`. Default false. */
  canSign?: boolean
} = {}): WalletAdapter & { sent: Array<{ chain: string; txs: TxRequest[]; hash: string }>; signed: Array<{ chain: string; data: TypedDataRequest; signature: string }> } {
  const address = opts.address ?? '0x1111111111111111111111111111111111111111'
  const sent: Array<{ chain: string; txs: TxRequest[]; hash: string }> = []
  const signed: Array<{ chain: string; data: TypedDataRequest; signature: string }> = []
  const randomHex = (n: number) => {
    const b = new Uint8Array(n)
    crypto.getRandomValues(b)
    return `0x${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`
  }
  return {
    id: 'mock',
    sent,
    signed,
    async getAccounts() {
      return [{ chain: 'eip155:8453', address }]
    },
    async getBalances() {
      return opts.balances ?? [
        { chain: 'eip155:42161', token: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', symbol: 'USDC', decimals: 6, amount: '250', usd: '250' },
        { chain: 'eip155:8453', token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', decimals: 6, amount: '40', usd: '40' },
      ]
    },
    async sendTransactions(chain, txs) {
      opts.onSend?.(chain, txs)
      await new Promise((r) => setTimeout(r, opts.delayMs ?? 600))
      const hash = randomHex(32)
      sent.push({ chain, txs, hash })
      return { hash }
    },
    ...(opts.canSign
      ? {
          async signTypedData(chain: string, data: TypedDataRequest) {
            await new Promise((r) => setTimeout(r, opts.delayMs ?? 600))
            const signature = `${randomHex(64)}1b`
            signed.push({ chain, data, signature })
            return signature
          },
        }
      : {}),
  }
}
