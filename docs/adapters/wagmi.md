# Wallets (wagmi)

Provider adapters run on the server. **Wallet adapters** run in the browser. They let the modal read the user's balances and sign `WALLET_TX` surfaces ("Pay with wallet").

## The WalletAdapter interface

```ts
// from @openrampkit/core
interface WalletAdapter {
  id: string
  getAccounts(): Promise<Array<{ chain: string; address: string }>>
  getBalances?(accounts: Array<{ chain: string; address: string }>): Promise<WalletBalance[]>
  /** Sends the transactions in order and returns the hash of the last one */
  sendTransactions(chain: string, txs: TxRequest[]): Promise<{ hash: string }>
  switchChain?(chain: string): Promise<void>
  /** CAIP-2 namespaces this wallet sends on, e.g. ['eip155'] or ['solana']. Absent: any. */
  namespaces?: string[]
}

type WalletBalance = { chain: string; token: string; symbol: string; decimals: number; amount: string; usd?: string }
type TxRequest = EvmTxRequest | SolanaTxRequest
type EvmTxRequest = { kind?: 'evm'; to: string; data?: string; value?: string; chainId: number; gas?: string }
// SolanaTxRequest has kind: 'solana'. See the Solana guide.
```

For Solana wallets, use `@openrampkit/solana`. See [Solana](../guide/solana.md#pay-from-a-solana-wallet). To use an EVM wallet and a Solana wallet together, join them with `combineWallets(wagmiWallet(config), solanaWallet())` from `@openrampkit/core`.

How the controller uses it:

- On start, it calls `getAccounts()`. The first account's address counts as "connected". It is sent to the server with the plan and the quotes, so the `wallet` method shows as "Connected" and Relay can quote for that address.
- It calls `getBalances()` and keeps balances above zero. The largest one (by `usd`, else by amount) is the default "Pay with" token.
- On **Confirm in wallet**, it calls `sendTransactions(surface.chain, surface.txs)` and reports the hash.

The controller reads the wallet once, when it starts. If the user connects a wallet later, open the modal again (or remount `OpenRampEmbedded`).

## wagmiWallet

`@openrampkit/wagmi` wraps your existing wagmi config.

```bash
pnpm add @openrampkit/wagmi
# peers: @wagmi/core ^2, viem ^2 (already in any wagmi app)
```

The packages are not on npm yet. See [Try it before the npm release](../guide/installation.md#try-it-before-the-npm-release).

```tsx
'use client'
import { useAccount } from 'wagmi'
import { useMemo } from 'react'
import { OpenRampProvider, DepositButton } from '@openrampkit/react'
import { wagmiWallet } from '@openrampkit/wagmi'
import { wagmiConfig } from '@/lib/wagmi'

export function Deposit() {
  const { isConnected } = useAccount()
  const wallet = useMemo(() => (isConnected ? wagmiWallet(wagmiConfig) : undefined), [isConnected])
  return (
    <OpenRampProvider baseUrl="/api/openramp" wallet={wallet}>
      <DepositButton getClientSecret={getClientSecret} />
    </OpenRampProvider>
  )
}
```

### Options

```ts
wagmiWallet(config, {
  waitBetweenTxs: true,  // wait for each receipt before the next tx (so an approve lands first). Default true.
  waitForLast: false,    // also wait for the last receipt before returning. Default false.
  tokens: {              // extra ERC-20 tokens to report per CAIP-2 chain, besides USDC
    'eip155:8453': [{ address: '0x...', symbol: 'DEGEN', decimals: 18 }],
  },
})
```

### Behavior

| Method | What it does |
|---|---|
| `getAccounts()` | The connected address on every chain in the wagmi config (`eip155:{id}`), or `[]` when not connected |
| `getBalances()` | Native balance plus USDC (and your `tokens`) per configured chain. One failing RPC does not hide the other balances. USDC also fills `usd`. On Tempo (no native token) it shows USDC only. |
| `switchChain(chain)` | Switches when the wallet is on another chain. Throws for chains not in the wagmi config. |
| `sendTransactions(chain, txs)` | For each tx: switch to `tx.chainId`, send, and wait for the receipt between txs. Returns the last hash. |

Only EVM chains are supported. Chains must be in your wagmi config. `wagmiWallet` refuses Solana transactions. Tempo works like any EVM chain (see [Chains and tokens](../concepts/chains.md#tempo)).

## createMockWallet

For tests and demos, `createMockWallet()` from `@openrampkit/client` implements the same interface without a chain. See [Testing with mocks](../guide/testing.md#the-mock-wallet).

## Write your own

Any object with `id`, `getAccounts()` and `sendTransactions()` works. For example, a wallet adapter for a Privy embedded wallet or a Solana wallet only needs to map these calls. `chain` values are CAIP-2 ids; `amount` values are decimal strings.
