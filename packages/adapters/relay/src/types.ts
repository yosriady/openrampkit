// Relay API response shapes (only the fields the adapter reads) and the records the adapter stores.

import type { Amount, SolanaInstruction } from '@openrampkit/core'

// ---------------- Relay API types (only the fields we read) ----------------

export type RelayCurrency = { chainId: number; address: string; symbol: string; decimals: number }
export type RelayAmount = { currency: RelayCurrency; amount: string; amountFormatted?: string }
/** EVM items carry `to`/`data`/`chainId`; Solana items carry `instructions` and lookup tables. */
export type RelayStepItem = {
  status?: string
  data?: {
    from?: string
    to?: string
    data?: string
    value?: string
    chainId?: number
    gas?: string
    instructions?: SolanaInstruction[]
    addressLookupTableAddresses?: string[]
  }
}
export type RelayStep = { id: string; kind: 'transaction' | 'signature' | string; items?: RelayStepItem[]; requestId?: string; depositAddress?: string }
export type RelayQuoteResponse = {
  requestId?: string
  steps: RelayStep[]
  fees?: Partial<Record<'gas' | 'relayer' | 'app', RelayAmount>>
  details?: { currencyIn?: RelayAmount; currencyOut?: RelayAmount & { minimumAmount?: string }; timeEstimate?: number }
}
export type RelayIntentStatus = { status: string; details?: string; inTxHashes?: string[]; txHashes?: string[] }
export type RelayTx = { hash?: string; txHash?: string; chainId?: number }
export type RelayRequest = {
  id: string
  status: string
  createdAt: string
  /** Set for deposit-address requests. `depositTxHash` is the transfer into the address. */
  depositAddress?: { address?: string; depositTxHash?: string; depositor?: string } | null
  data?: {
    outTxs?: RelayTx[]
    inTxs?: RelayTx[]
    failReason?: string | null
    metadata?: { currencyIn?: RelayAmount; currencyOut?: RelayAmount }
    route?: { actual?: { destination?: { outputCurrency?: RelayAmount } }; quoted?: { destination?: { outputCurrency?: RelayAmount } } }
  }
}

// ---------------- stored state ----------------

export type WalletRecord = {
  mode: 'relay' | 'direct'
  requestId?: string
  txHash?: string
  output?: Amount
  /** Origin chain: tells how to read `txHash` (EVM hash or Solana signature) */
  chain?: string
  token?: string
  recipient?: string
  amountBase?: string
  /** When the direct payment started (ms). A transaction mined before it cannot pay this session. */
  since?: number
  /** Direct payment through an OpenRampSettlement contract: its address, the calls hash and the start block */
  settlement?: { contract: string; callsHash: string; fromBlock: string }
}
export type DepositRecord = {
  address: string
  since: number
  mode: 'relay' | 'direct'
  output?: Amount
  chain?: string
  token?: string
  fromBlock?: string
  /** Expected deposit (base units of the origin token), when the user gave an amount */
  expectedBase?: string
  /** Smallest deposit that completes the leg: `expectedBase` minus the tolerance */
  minBase?: string
  /** EVM direct: the next block to scan for Transfer logs */
  scanFrom?: string
  /** Relay: the key (deposit tx hash, else request id) and id of the request bound to this leg */
  bound?: { key: string; id: string }
}
/**
 * An open deposit leg on an address, kept in `shared` so that legs of other sessions on the same
 * address can see it. A deposit that two open legs could both claim is ambiguous: neither leg takes it.
 */
export type Watcher = { owner: string; since: number; fromBlock?: string; expectedBase?: string; minBase?: string; until: number }
