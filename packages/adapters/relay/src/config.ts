// Relay adapter options, public RPC defaults, and constants.

import { DEFAULT_LOG_BLOCK_RANGE as WATCH_LOG_BLOCK_RANGE, DEFAULT_LOG_PAGES, POLL, PUBLIC_RPC_URLS } from '@openrampkit/adapter'
import type { SettlementIntentTypedData } from '@openrampkit/adapter'
import { SOLANA_MAINNET } from '@openrampkit/core'
import type { PollSpec } from '@openrampkit/core'

export type RelayOptions = {
  /** Relay API key (x-api-key). Needed for GET /requests/v3 and higher rate limits. */
  apiKey?: string
  /** Default https://api.relay.link. Testnets: https://api.testnets.relay.link */
  baseUrl?: string
  /** App fee in basis points, paid to `recipient` (accrues as a claimable balance at Relay) */
  appFee?: { bps: number; recipient: string }
  /** Relay `referrer` string, for attribution */
  referrer?: string
  /**
   * Where Relay refunds failed deposit-address requests.
   * 'origin' (default) sends the origin chain's native-currency address, which turns on
   * automatic refund to the original sender. 'recipient' refunds to the session's destination
   * address when it is an address of the origin chain's VM; use it only when that address is the
   * user's own wallet on every chain (an EOA). Or pass an explicit address.
   *
   * The `exchange_transfer` leg never refunds to the sender by choice: the sender is the exchange's
   * hot wallet, which may not credit the refund. It uses an explicit address, then the connected
   * wallet, then the recipient (with 'recipient'). With none of these, it refunds to the sender
   * and the deposit screen warns the user.
   */
  refundTo?: 'origin' | 'recipient' | string
  /**
   * Also offer the `transfer` leg as the `exchange_transfer` method ("From an exchange"). Default false.
   * The same Relay open deposit address, with exchange copy and a safe refund address (see `refundTo`).
   */
  exchangeTransfer?: boolean
  /**
   * JSON-RPC URLs per CAIP-2 chain, used to verify same-chain, same-token moves on chain
   * (Relay is not involved there). EVM chains use `eth_*` methods, Solana uses
   * `getSignatureStatuses` and `getTransaction`. Defaults to public RPCs for the main chains;
   * set your own for production. A chain without an RPC URL cannot use same-chain moves.
   */
  rpcUrls?: Record<string, string>
  /**
   * Signs the EIP-712 intent for a settlement contract that has an `intentSigner` (destination
   * `settlement`). Return the signature, e.g. from viem `signTypedData` or a KMS. Leave it out when
   * the contract has no intent signer.
   */
  signSettlementIntent?: (typedData: SettlementIntentTypedData) => Promise<string>
  /** Seconds a signed settlement intent stays valid. Default 1800. */
  settlementIntentTtlSec?: number
  /**
   * Relay `slippageTolerance` in basis points (0 to 10000), sent with every quote. Default: Relay
   * picks a value. A `wallet` quote carries Relay's `minimumAmount` as `minOutput` (guarantee
   * `min_output`), and this value as `slippageBps` when it is set.
   */
  slippageBps?: number
  /**
   * How far below the expected amount (in basis points) a deposit can be and still complete a
   * `transfer` leg. Default 50 (0.5%). A `bridge` leg uses at least 500 (5%), because the onramp
   * can deliver a little less than its quote.
   */
  amountToleranceBps?: number
  /** Most blocks in one `eth_getLogs` call (same-chain `transfer` checks). Default 2000, at most 10000. */
  logBlockRange?: number
  /**
   * Most JSON-RPC requests per second to one RPC URL, from this adapter instance (calls wait for their
   * turn). Default: no limit. Set it when you use public RPCs.
   */
  rpcRequestsPerSecond?: number
}

/** Public RPCs for on-chain verification (`PUBLIC_RPC_URLS` of `@openrampkit/adapter`). Rate-limited: use your own in production. */
export const DEFAULT_RPC_URLS: Readonly<Record<string, string>> = PUBLIC_RPC_URLS

/** Allowed difference between our clock and block timestamps when a direct payment checks its tx age */
export const DIRECT_TX_CLOCK_SKEW_MS = 5 * 60_000

export const RELAY_SOLANA_CHAIN_ID = 792703809
export const SOLANA_CAIP2 = SOLANA_MAINNET
export const EVM_NATIVE = '0x0000000000000000000000000000000000000000'
export const SOLANA_NATIVE = '11111111111111111111111111111111'
/**
 * Relay accepts any address of the origin chain's VM as `user` for quotes; used when no wallet
 * is connected yet. Relay rejects a `user` of another VM (an EVM address for a Solana origin).
 */
export const PLACEHOLDER_USER = '0x000000000000000000000000000000000000dEaD'
export const PLACEHOLDER_SOLANA_USER = SOLANA_NATIVE
export const DEPOSIT_ADDRESS_TTL_SEC = 24 * 60 * 60
/** A standing deposit address stays in `shared` this long after its last use (each call refreshes it) */
export const STANDING_ADDRESS_TTL_SEC = 400 * 24 * 60 * 60
/** An open deposit watch (see `Watcher`) counts as a rival for this long after its leg started */
export const WATCH_TTL_SEC = 24 * 60 * 60
/** How long a used transaction, log or Relay request stays recorded */
export const USED_TTL_SEC = 90 * 24 * 60 * 60
export const DEFAULT_TOLERANCE_BPS = 50
export const HOP_TOLERANCE_BPS = 500
export const DEFAULT_LOG_BLOCK_RANGE = WATCH_LOG_BLOCK_RANGE
/** Most `eth_getLogs` pages in one status check; the next check goes on from where this one stopped */
export const LOG_PAGES_PER_CHECK = DEFAULT_LOG_PAGES
export const WALLET_QUOTE_REUSE_MS = 20_000
/** Lifetime of a wallet quote, in minutes */
export const WALLET_QUOTE_TTL_MIN = 1

export const RELAY_POLL: PollSpec = POLL.onchain
export const RECORD_TTL_SEC = 7 * 24 * 60 * 60

export const HOP_CHAINS = ['eip155:8453', 'eip155:42161', 'eip155:10', 'eip155:137', 'eip155:1'] as const
