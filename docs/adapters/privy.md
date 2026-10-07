# Wallets (Privy)

Provider adapters run on the server. **Wallet adapters** run in the browser. They let the modal read the user's balances and sign `WALLET_TX` surfaces ("Pay with wallet").

For Solana wallets, use `@openrampkit/solana`. To use a Privy wallet and a Solana wallet together, join them with `combineWallets(privyWallet(...), solanaWallet())` from `@openrampkit/core`.

## privyWallet

`@openrampkit/privy` wraps a Privy embedded wallet.

```bash
pnpm add @openrampkit/privy
```

The adapter calls the wallet's EIP-1193 provider. It does not import a Privy SDK, so any Privy SDK version works, and so does any other embedded wallet that exposes a provider.

Pass the wallet from `useWallets()`. Pass a function so a wallet that connects after the modal opens is picked up:

```tsx
'use client'
import { useWallets } from '@privy-io/react-auth'
import { useMemo } from 'react'
import { OpenRampProvider, DepositButton } from '@openrampkit/react'
import { privyWallet } from '@openrampkit/privy'

export function Deposit() {
  const { wallets } = useWallets()
  const wallet = useMemo(() => privyWallet({ wallet: () => wallets.find((w) => w.chainType === 'ethereum') }), [wallets])
  return (
    <OpenRampProvider baseUrl="/api/openramp" wallet={wallet}>
      <DepositButton getClientSecret={getClientSecret} />
    </OpenRampProvider>
  )
}
```

### Options

| Option | Default | What it does |
|---|---|---|
| `wallet` | none | The Privy wallet, or a function that returns it. Read at each call. |
| `chains` | `DEFAULT_PRIVY_CHAINS` | CAIP-2 chains that report the one EVM address. |
| `tokens` | none | Extra ERC-20 tokens to report per CAIP-2 chain, besides USDC. |
| `waitBetweenTxs` | `true` | Wait for each receipt before the next tx, so an approve lands before the deposit. |
| `waitForLast` | `false` | Also wait for the last receipt before returning. |
| `confirmTimeoutMs` | `60000` | How long to wait for a receipt. |
| `confirmIntervalMs` | `1000` | How often to check for a receipt. |

`DEFAULT_PRIVY_CHAINS` is built from the `@openrampkit/core` chain table: the EVM mainnets that have a USDC address. Pass `chains` to report a shorter or longer list.

### Behavior

| Method | What it does |
|---|---|
| `getAccounts()` | The one EVM address on every chain in `chains`, or `[]` when there is no wallet. Returns `[]` on the server, so it is safe during SSR. |
| `getBalances()` | Native balance plus USDC (and your `tokens`) per configured chain. One failing RPC does not hide the other balances. USDC also fills `usd`. |
| `switchChain(chain)` | Calls `wallet_switchEthereumChain` when the wallet is on another chain. |
| `sendTransactions(chain, txs)` | For each tx: switch to `tx.chainId`, send, and wait for the receipt between txs. Returns the last hash. |

Only EVM chains are supported. `privyWallet` refuses Solana transactions, and it reports no accounts for a Solana embedded wallet (`chainType: 'solana'`). Use `@openrampkit/solana` for those.

The adapter reads `eth_accounts` state from the wallet itself, so it never holds a key or an address of its own.
