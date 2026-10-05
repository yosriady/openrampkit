# Chains and tokens

OpenRampKit names chains with CAIP-2 ids and tokens with their address (or `native`). `@openrampkit/core` exports the metadata below.

## Chain ids

| Chain | CAIP-2 id | Native token | Notes |
|---|---|---|---|
| Ethereum | `eip155:1` | ETH | |
| Base | `eip155:8453` | ETH | Default hop chain for two-leg pathways |
| Arbitrum | `eip155:42161` | ETH | |
| Optimism | `eip155:10` | ETH | |
| Polygon | `eip155:137` | POL | |
| BNB Chain | `eip155:56` | BNB | |
| Monad | `eip155:143` | MON | |
| HyperEVM | `eip155:999` | HYPE | |
| Tempo | `eip155:4217` | none (fees in USD stablecoins) | See [Tempo](#tempo) |
| Tempo Testnet (Moderato) | `eip155:42431` | none (fees in pathUSD) | `OpenRampSettlement` deployed. Playground testnet mode |
| Solana | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | SOL (9 decimals) | See [Solana](../guide/solana.md) |
| Solana Devnet | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` | SOL | Metadata and devnet USDC only |
| Robinhood Chain | `eip155:4663` | ETH | Arbitrum Orbit L2. No USDC in `USDC` yet. |
| Arbitrum Sepolia | `eip155:421614` | ETH | Testnet. Circle test USDC. Used by the [settlement](./settlement.md) contract tests. |
| Robinhood Chain Testnet | `eip155:46630` | ETH | Testnet |

`CHAINS[id]` gives `name`, `nativeSymbol`, `nativeDecimals`, `testnet`, `stablecoinFees` and `explorerUrl`. A chain that is not in the table still works when an adapter supports it. The UI then shows the CAIP-2 id as the name.

## Token ids

- EVM token addresses are not case-sensitive. OpenRampKit stores them in lowercase.
- Solana mints are base58 and case-sensitive. OpenRampKit keeps them as given.
- `normalizeToken(chain, token)` and `sameToken(chain, a, b)` apply these rules. Use them when you compare tokens.

`USDC[chain]` gives the well-known USDC on each chain: Ethereum, Base, Arbitrum, Optimism, Polygon, Tempo, Solana, and Circle's test USDC on Arbitrum Sepolia. `TESTNET_USDC` gives Solana devnet USDC. `isUsdc(chain, token)` checks both.

## Tempo

[Tempo](https://tempo.xyz) is a payments-first Layer 1 from Stripe and Paradigm. Its mainnet has been live since 18 March 2026.

| Item | Value |
|---|---|
| Chain id | `4217` (CAIP-2 `eip155:4217`, `TEMPO_MAINNET`) |
| Testnet | Moderato, chain id `42431` (`TEMPO_TESTNET`) |
| Public RPC | `https://rpc.tempo.xyz` (testnet `https://rpc.moderato.tempo.xyz`) |
| Explorer | `https://explore.tempo.xyz` |
| Token standard | TIP-20 (ERC-20 compatible, 6 decimals for USD stablecoins) |
| Fees | Paid in a USD stablecoin, not in a native gas token. pathUSD is the default fee token. |
| pathUSD | `0x20c0000000000000000000000000000000000000` (`TEMPO_PATH_USD`) |
| USDC (bridged, "USDC.e" in Tempo docs) | `0x20c000000000000000000000b9537d11c60e8b50` (`TEMPO_USDC`, also `USDC['eip155:4217']`) |

### What OpenRampKit supports on Tempo

- **Relay.** Relay supports Tempo with chain id `4217`. Its token list has USDC, pathUSD, USDT0 and OUSD on Tempo. So these pathways work with the Relay adapter and a Tempo destination:
  - Card or local QR, then the Relay `bridge` hop from USDC on Base to USDC on Tempo.
  - "Pay with wallet" from any EVM chain or Solana.
  - "Transfer crypto" to a Relay deposit address.
  - Withdraw to a Tempo address.
- **EVM wallet.** Tempo is an EVM chain, so `wagmiWallet` signs Tempo transactions. Add the Tempo chain to your wagmi config (viem has a `tempo` chain, or use `defineChain` with the values above).
- **Balances.** `eth_getBalance` on Tempo does not return a real balance (Tempo has no native token). `wagmiWallet` does not show a native balance on chains with `stablecoinFees: true`. It shows USDC.
- **Same-chain checks.** The Relay adapter has a default Tempo RPC (`https://rpc.tempo.xyz`) for same-chain, same-token checks.

```ts
import { TEMPO_MAINNET, TEMPO_USDC } from '@openrampkit/core'

await openramp.sessions.create({
  userId: user.id,
  destination: { type: 'crypto', chain: TEMPO_MAINNET, token: TEMPO_USDC, symbol: 'USDC', decimals: 6, address: user.tempoAddress },
})
```

### Gaps

- **Fee token.** A Tempo wallet pays fees in a USD stablecoin. The user needs a stablecoin balance on Tempo to send a transaction there (for example "Pay with wallet" from Tempo, or a withdraw from Tempo). Deposits **to** Tempo through Relay do not need a Tempo balance: Relay pays the destination side.
- **Tempo transaction features.** OpenRampKit sends standard EVM transactions. It does not use Tempo's own transaction type (fee token choice, batched calls, fee sponsorship).
- **Direct onramps.** MoonPay announced a Tempo onramp for USDC.e and pathUSD. The MoonPay adapter does not list a Tempo currency code yet, because we could not confirm the code. Until then, fiat reaches Tempo through the two-leg pathway (onramp to Base, then Relay).
- **Testnet.** The Moderato testnet has metadata only. Relay does not route it, and we do not list testnet token addresses.

Sources: [Tempo connection details](https://tempo.xyz/developers/docs/quickstart/connection-details), [Tempo FAQ](https://tempo.xyz/faq/), [Bridge stablecoins via Relay (Tempo docs)](https://tempo.xyz/developers/docs/guide/bridge-relay), Relay `GET /chains` (chain `4217`), [MoonPay adds Tempo onramp](https://thepaypers.com/crypto-web3-and-cbdc/news/moonpay-adds-usdce-and-pathusd-support-becomes-tempo-onramp-provider).
