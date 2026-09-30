# Solana

OpenRampKit supports Solana as a destination and as a source. This page tells you how to:

- Send deposits to USDC (or SOL) on Solana.
- Let users pay from a Solana wallet.
- Connect a Solana wallet in the browser with `@openrampkit/solana`.

## What works

| Flow | Provider | Surface | Notes |
|---|---|---|---|
| Card or local QR to USDC on Solana | Onramp to USDC on Base, then Relay `bridge` | `REDIRECT` or `QR`, then none | Two legs. Relay moves the USDC from Base to Solana. |
| EVM wallet to USDC on Solana | Relay `wallet` | `WALLET_TX` (EVM) | The user signs on the EVM chain. Relay delivers on Solana. |
| Deposit address to USDC on Solana | Relay `transfer` | `DEPOSIT_ADDRESS` | The user sends from any EVM wallet or exchange. |
| Solana wallet to any chain | Relay `wallet` | `WALLET_TX` (Solana) | The Solana wallet signs Relay's Solana transaction. |
| Solana wallet to USDC on Solana | Relay `wallet` (same chain) | `WALLET_TX` (Solana) | A plain SPL transfer. The server checks it on chain. |
| Withdraw to a Solana address | Relay `wallet` | `WALLET_TX` | The user types a Solana address on the "To wallet" tab. |
| Demo and tests | Mock adapter | all | No money moves. |

## Chain and token ids

Chains are CAIP-2 ids. Solana mints are base58 and case-sensitive. OpenRampKit keeps their case. It lowercases EVM addresses only.

| Name | Value | Export from `@openrampkit/core` |
|---|---|---|
| Solana mainnet | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | `SOLANA_MAINNET` |
| Solana devnet | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` | `SOLANA_DEVNET` |
| USDC mint (mainnet) | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | `SOLANA_USDC_MINT`, also `USDC[SOLANA_MAINNET]` |
| USDC mint (devnet) | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | `SOLANA_DEVNET_USDC_MINT`, also `TESTNET_USDC[SOLANA_DEVNET]` |
| Native SOL | `native` (9 decimals) | `SOLANA_NATIVE_DECIMALS` |

Relay uses its own chain id for Solana: `792703809`. The Relay adapter maps it for you.

## Send deposits to Solana

Create the session on your server with a Solana destination:

```ts
import { SOLANA_MAINNET, SOLANA_USDC_MINT } from '@openrampkit/core'

const { clientSecret } = await openramp.sessions.create({
  userId: user.id,
  country: 'ID',
  destination: {
    type: 'crypto',
    chain: SOLANA_MAINNET,
    token: SOLANA_USDC_MINT,
    symbol: 'USDC',
    decimals: 6,
    address: user.solanaAddress, // base58 owner address, not a token account
  },
})
```

The server checks the address format. The address is the **owner** address. Relay and the SPL transfer send to the associated token account of that owner.

The planner finds these pathways:

- Fiat methods (card, QRIS, VietQR, and more) go to USDC on Base first. Then the Relay `bridge` leg moves the USDC to Solana.
- "Pay with wallet" and "Transfer crypto" use Relay directly.

## Pay from a Solana wallet

Install the wallet adapter in your frontend:

```bash
pnpm add @openrampkit/solana
```

`solanaWallet()` finds wallets through [Wallet Standard](https://github.com/wallet-standard/wallet-standard). Phantom, Solflare, Backpack and most other Solana wallets register there.

```tsx
'use client'
import { useMemo, useState } from 'react'
import { useAccount } from 'wagmi'
import { combineWallets } from '@openrampkit/core'
import { OpenRampProvider, DepositButton } from '@openrampkit/react'
import { solanaWallet } from '@openrampkit/solana'
import { wagmiWallet } from '@openrampkit/wagmi'
import { wagmiConfig } from '@/lib/wagmi'

export function Deposit() {
  const { isConnected } = useAccount()
  const sol = useMemo(() => solanaWallet({ rpcUrl: process.env.NEXT_PUBLIC_SOLANA_RPC_URL }), [])
  const [solAddress, setSolAddress] = useState<string>()
  const wallet = useMemo(
    () => (isConnected ? combineWallets(wagmiWallet(wagmiConfig), sol) : sol),
    [isConnected, sol, solAddress],
  )
  return (
    <OpenRampProvider baseUrl="/api/openramp" wallet={wallet}>
      <button onClick={() => sol.connect().then(setSolAddress)}>Connect Solana wallet</button>
      <DepositButton getClientSecret={getClientSecret} />
    </OpenRampProvider>
  )
}
```

`combineWallets` joins an EVM wallet and a Solana wallet:

- It joins the accounts and the balances of both wallets.
- It sends each `WALLET_TX` to the wallet of that chain (`eip155` or `solana`).
- The modal sends the account of the chain that the user pays from. For example, it sends the Solana address when the user pays with Solana USDC.

The controller reads the wallet once, when it starts. Connect the wallet before you open the modal, or open the modal again after the user connects.

### Options

```ts
solanaWallet({
  wallet,                // a Wallet Standard wallet, or a function that returns it. Default: the first Solana wallet.
  walletName: 'Phantom', // pick a registered wallet by name
  chain: SOLANA_MAINNET, // or SOLANA_DEVNET
  rpcUrl: 'https://...', // default: the public RPC of the chain (rate-limited)
  waitBetweenTxs: true,  // wait for each confirmation before the next transaction. Default true.
  waitForLast: false,    // also wait for the last confirmation. Default false.
  commitment: 'confirmed',
  confirmTimeoutMs: 60_000,
  tokens: [{ mint: '...', symbol: 'PYUSD', decimals: 6 }], // extra SPL balances, besides USDC
})
```

Use your own RPC in production. The public Solana RPC has low rate limits. The adapter uses the RPC for blockhashes, lookup tables, balances and confirmations.

### Behavior

| Method | What it does |
|---|---|
| `connect()` | Calls `standard:connect` and returns the first account address |
| `getAccounts()` | The wallet accounts on the chosen chain, as `{ chain, address }`. `[]` when not connected or on the server. |
| `getBalances()` | SOL and USDC (and your `tokens`) from the RPC. One failing call does not hide the other balances. |
| `sendTransactions(chain, txs)` | Builds, signs and sends each Solana transaction in order. Returns the last signature (base58). |

The adapter signs with `solana:signAndSendTransaction`. When the wallet does not have it, the adapter signs with `solana:signTransaction` and sends through the RPC.

## Solana transactions in WALLET_TX

A `WALLET_TX` surface on Solana carries `SolanaTxRequest` items (`kind: 'solana'`). The wallet adds the fee payer and a recent blockhash.

| `type` | Fields | Who makes it |
|---|---|---|
| `instructions` | `instructions`, `addressLookupTableAddresses` | Relay, for a Solana origin. The adapter builds a v0 transaction and uses the lookup tables. |
| `transaction` | `transaction` (base64 wire format) | An adapter that builds the whole transaction |
| `transfer` | `to`, `mint` (or `native`), `amount` (base units), `decimals` | Same-chain moves. For an SPL token, the transaction creates the recipient token account when it is missing (idempotent), then sends `TransferChecked`. Token-2022 mints work. |

`TxRequest` is `EvmTxRequest | SolanaTxRequest`. Use `isSolanaTx(tx)` to tell them apart.

## Server-side checks

The Relay adapter checks same-chain Solana moves on chain. It does not trust the signature that the browser sends.

- `getSignatureStatuses`: the signature must be `confirmed` or `finalized`, with no error.
- `getTransaction` (`jsonParsed`): the recipient must get at least the quoted amount. For SPL tokens, the adapter adds the balance changes of the recipient's token accounts for the mint. For SOL, it uses the lamport change of the recipient.
- The block time must not be before the payment started (5 minutes of clock slack).
- One signature completes one payment only. A second session with the same signature fails.

For a "Transfer crypto" deposit to the destination itself, the adapter reads `getTokenAccountsByOwner` and `getSignaturesForAddress`. It counts each new signature for one session only.

Set a Solana RPC for these checks:

```ts
relay({ apiKey: process.env.RELAY_API_KEY, rpcUrls: { [SOLANA_MAINNET]: process.env.SOLANA_RPC_URL! } })
```

## Limits

- A Relay open deposit address **on Solana** (the user sends from Solana) needs a Relay API key. Without a key, Relay refuses the request. Deposit addresses on EVM chains that deliver to Solana work without a key.
- Relay's Solana route needs a Solana `user`. The quote uses a placeholder until the user connects a Solana wallet. The adapter quotes again with the real address when the payment starts.
- Solana devnet has metadata and a USDC mint, but Relay does not route devnet. Use the mock adapter for devnet demos.
- The mock offramp (withdraw to cash) takes EVM USDC only.

## Demo

The Next.js demo has a **USDC on Solana** destination. Pick it in the playground. With mock providers, the QRIS or card pathway goes to Base and then bridges to Solana. Set **Wallet** to "wagmi and Solana wallet" and click **Connect Solana wallet** to pay from Phantom or another wallet.
