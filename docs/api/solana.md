# @openrampkit/solana

A `WalletAdapter` for Solana wallets. It finds wallets through [Wallet Standard](https://github.com/wallet-standard/wallet-standard) and builds transactions with `@solana/kit`. It runs in the browser.

```ts
import {
  solanaWallet,
  getSolanaWallets,
  isSolanaWallet,
  walletStandardChain,
  associatedTokenAddress,
  DEFAULT_SOLANA_RPC_URLS,
} from '@openrampkit/solana'
import type { SolanaWalletOptions, SolanaCommitment } from '@openrampkit/solana'
```

For a walkthrough, read the [Solana guide](../guide/solana.md).

## Exports

| Export | Kind | Description |
|---|---|---|
| [`solanaWallet(options?)`](#solanawallet-options) | function | Makes the wallet adapter |
| [`getSolanaWallets()`](#getsolanawallets) | function | The registered wallets that can sign Solana transactions |
| [`isSolanaWallet(wallet)`](#issolanawallet-wallet) | function | True when a wallet can sign Solana transactions |
| [`walletStandardChain(chain)`](#walletstandardchain-chain) | function | A CAIP-2 chain id to a Wallet Standard chain id |
| [`associatedTokenAddress(owner, mint, tokenProgram?)`](#associatedtokenaddress-owner-mint-tokenprogram) | function | The associated token account of an owner for a mint |
| [`DEFAULT_SOLANA_RPC_URLS`](#default-solana-rpc-urls) | constant | The public RPC URL for each Solana chain |
| [`SolanaWalletOptions`](#solanawalletoptions) | type | The options of `solanaWallet()` |
| [`SolanaCommitment`](#solanacommitment) | type | `'confirmed' \| 'finalized'` |

## solanaWallet(options?)

```ts
function solanaWallet(opts?: SolanaWalletOptions): SolanaWalletAdapter
```

Makes a `WalletAdapter` for one Solana chain. Give it to the modal as `wallet`. To use it together with an EVM wallet, join them with `combineWallets` from `@openrampkit/core`.

```ts
import { SOLANA_MAINNET } from '@openrampkit/core'
import { solanaWallet } from '@openrampkit/solana'

const wallet = solanaWallet({ chain: SOLANA_MAINNET, rpcUrl: 'https://my-rpc.example.com', walletName: 'Phantom' })
const address = await wallet.connect()
```

The adapter has the `WalletAdapter` methods and some more. The package does not export the type of the result. Use `ReturnType<typeof solanaWallet>` when you need it.

| Member | Signature | Description |
|---|---|---|
| `id` | `'solana'` | The adapter id |
| `namespaces` | `['solana']` | The chain namespaces that the adapter handles |
| `getWallet()` | `() => Wallet \| undefined` | The Wallet Standard wallet in use. It reads `wallet` or `walletName` again at each call. |
| `connect(opts?)` | `(opts?: { silent?: boolean }) => Promise<string \| undefined>` | Calls `standard:connect` and returns the address of the first account on the chain. With `silent: true`, the wallet does not show a prompt. Throws when no Solana wallet is found. |
| `disconnect()` | `() => Promise<void>` | Calls `standard:disconnect` when the wallet has it |
| `getAccounts()` | `() => Promise<Array<{ chain, address }>>` | The accounts of the wallet on the chain. An account with no chain list counts for every chain. `[]` when there is no wallet or no account. |
| `getBalances(accounts)` | `(accounts) => Promise<WalletBalance[]>` | SOL, USDC of the chain, and your extra `tokens`, from the RPC. It skips accounts on other chains. One failing RPC call does not hide the other balances. |
| `switchChain(chain)` | `(chain: string) => Promise<void>` | Does nothing for the chain of the adapter. Throws for any other chain. |
| `sendTransactions(chain, txs)` | `(chain: string, txs: TxRequest[]) => Promise<{ hash: string }>` | Builds, signs and sends each Solana transaction in order. Returns the last signature (base58) as `hash`. Throws for an EVM transaction, another chain, an empty list, or no connected account. |
| `buildTransaction(tx, payer)` | `(tx: SolanaTxRequest, payer: string) => Promise<Uint8Array>` | The wire bytes of a transaction with no signature, for tests and previews. It uses the RPC for the blockhash, lookup tables and the token program. |

The adapter signs with `solana:signAndSendTransaction`. When the wallet does not have it, the adapter signs with `solana:signTransaction` and sends through the RPC. For the transaction types, read [Solana transactions in WALLET_TX](../guide/solana.md#solana-transactions-in-wallet-tx).

## getSolanaWallets()

```ts
function getSolanaWallets(): Wallet[]
```

Returns the registered Wallet Standard wallets that can sign Solana transactions. On the server it returns `[]`. Use it to show a wallet picker.

```ts
import { getSolanaWallets, solanaWallet } from '@openrampkit/solana'

const names = getSolanaWallets().map((w) => w.name) // for example ['Phantom', 'Solflare']
const wallet = solanaWallet({ walletName: names[0] })
```

## isSolanaWallet(wallet)

```ts
function isSolanaWallet(w: Wallet): boolean
```

Returns `true` when the wallet has the `solana:signAndSendTransaction` or the `solana:signTransaction` feature. `getSolanaWallets()` uses it as its filter.

```ts
import { getWallets } from '@wallet-standard/app'
import { isSolanaWallet } from '@openrampkit/solana'

const solanaOnly = getWallets().get().filter(isSolanaWallet)
```

## walletStandardChain(chain)

```ts
function walletStandardChain(chain: string): `solana:${string}`
```

Changes a CAIP-2 chain id to the chain id that Wallet Standard wallets use.

| Input | Output |
|---|---|
| `SOLANA_MAINNET` | `'solana:mainnet'` |
| `SOLANA_DEVNET` | `'solana:devnet'` |
| Another id that starts with `solana:` | The same id |
| Any other id | Throws `Not a Solana chain: <chain>` |

```ts
import { SOLANA_DEVNET } from '@openrampkit/core'
import { walletStandardChain } from '@openrampkit/solana'

walletStandardChain(SOLANA_DEVNET) // 'solana:devnet'
```

## associatedTokenAddress(owner, mint, tokenProgram?)

```ts
function associatedTokenAddress(owner: string, mint: string, tokenProgram?: string): Promise<string>
```

Returns the associated token account (a base58 address) of `owner` for `mint`. It calculates the address and does not call the RPC. The default `tokenProgram` is `SPL_TOKEN_PROGRAM`. For a Token-2022 mint, give `SPL_TOKEN_2022_PROGRAM`. Both constants come from `@openrampkit/core`.

```ts
import { SOLANA_USDC_MINT } from '@openrampkit/core'
import { associatedTokenAddress } from '@openrampkit/solana'

const usdcAccount = await associatedTokenAddress(userAddress, SOLANA_USDC_MINT)
```

## DEFAULT_SOLANA_RPC_URLS

```ts
const DEFAULT_SOLANA_RPC_URLS: Record<string, string>
```

The public RPC URL for each chain. The adapter uses it when you do not set `rpcUrl`. These RPCs have low rate limits. Set `rpcUrl` in production.

| Chain | URL |
|---|---|
| `SOLANA_MAINNET` | `https://api.mainnet-beta.solana.com` |
| `SOLANA_DEVNET` | `https://api.devnet.solana.com` |

```ts
import { SOLANA_DEVNET } from '@openrampkit/core'
import { DEFAULT_SOLANA_RPC_URLS } from '@openrampkit/solana'

const rpcUrl = process.env.SOLANA_RPC_URL ?? DEFAULT_SOLANA_RPC_URLS[SOLANA_DEVNET]
```

## SolanaWalletOptions

The options of `solanaWallet()`. All options are optional.

| Option | Type | Default | Description |
|---|---|---|---|
| `wallet` | `Wallet \| () => Wallet \| undefined` | none | The Wallet Standard wallet, or a function that returns it. The adapter calls the function at each use. |
| `walletName` | `string` | none | Pick a registered wallet by name, for example `Phantom`. Used when `wallet` is not set. |
| `chain` | `string` | `SOLANA_MAINNET` | CAIP-2 chain id |
| `rpcUrl` | `string` | `DEFAULT_SOLANA_RPC_URLS[chain]` | JSON-RPC URL for blockhashes, lookup tables, balances and confirmations |
| `fetch` | `typeof fetch` | global `fetch` | Custom fetch, for tests or proxies |
| `waitBetweenTxs` | `boolean` | `true` | Wait for each transaction to confirm before the next one |
| `waitForLast` | `boolean` | `false` | Also wait for the last transaction to confirm before `sendTransactions` returns |
| `commitment` | `SolanaCommitment` | `'confirmed'` | Commitment for blockhashes and confirmations |
| `confirmTimeoutMs` | `number` | `60000` | How long to wait for one confirmation, in milliseconds |
| `tokens` | `Array<{ mint, symbol, decimals }>` | none | Extra SPL tokens to show in the balances, besides USDC |

Without `wallet` and `walletName`, the adapter uses the first registered wallet that can sign Solana transactions.

```ts
const options: SolanaWalletOptions = {
  chain: SOLANA_DEVNET,
  waitForLast: true,
  tokens: [{ mint: 'PYUSD_MINT_ADDRESS', symbol: 'PYUSD', decimals: 6 }],
}
```

## SolanaCommitment

```ts
type SolanaCommitment = 'confirmed' | 'finalized'
```

The commitment level for blockhashes and confirmations. `confirmed` is faster. `finalized` is safer, and it takes longer.

```ts
solanaWallet({ commitment: 'finalized' })
```
