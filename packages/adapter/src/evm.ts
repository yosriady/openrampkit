// EVM helpers for adapters that build ERC-20 transfers or check them on chain over JSON-RPC.
// Web-standard APIs only (fetch), no viem.

import { OrkException, orkError } from '@openrampkit/core'
import { fetchJson, httpErrorToOrk } from './http.js'
import type { Logger } from './index.js'

/** keccak256("Transfer(address,address,uint256)") */
export const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/** An address as a 32-byte log topic (lower case) */
export const topicAddress = (a: string) => `0x${a.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`

/** ERC-20 transfer(address,uint256) calldata */
export function erc20TransferData(to: string, amountBase: string): string {
  const addr = to.toLowerCase().replace(/^0x/, '').padStart(64, '0')
  const amt = BigInt(amountBase).toString(16).padStart(64, '0')
  return `0xa9059cbb${addr}${amt}`
}

/** The fields of `eth_getTransactionReceipt` that the checks read */
export type EvmReceipt = { status?: string; logs?: Array<{ address: string; topics: string[]; data: string }> }

/**
 * One JSON-RPC call. Network and HTTP errors become PROVIDER_UNAVAILABLE (502, or 504 on a timeout),
 * and so does an RPC error in the response.
 */
export async function evmRpc<T>(f: typeof fetch, url: string, method: string, params: unknown[], opts: { log?: Logger } = {}): Promise<T> {
  let res: { result?: T; error?: { message?: string } }
  try {
    res = await fetchJson(f, url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  } catch (e) {
    throw httpErrorToOrk(e, 'The chain RPC', { what: 'check this transfer', ...(opts.log ? { log: opts.log } : {}) })
  }
  if (res.error) throw new OrkException(orkError('PROVIDER_UNAVAILABLE', { message: `RPC error: ${String(res.error.message ?? '').slice(0, 120)}` }), 502)
  return res.result as T
}

/** Sum of the ERC-20 `token` Transfer logs to `recipient` in a receipt, in base units */
export function erc20PaidTo(receipt: EvmReceipt, token: string, recipient: string): bigint {
  const t = token.toLowerCase()
  const to = topicAddress(recipient)
  let paid = 0n
  for (const log of receipt.logs ?? []) {
    if (log.address.toLowerCase() === t && log.topics[0] === ERC20_TRANSFER_TOPIC && log.topics[2]?.toLowerCase() === to) paid += BigInt(log.data)
  }
  return paid
}
