---
"@openrampkit/solana": minor
"@openrampkit/core": minor
"@openrampkit/adapter-relay": minor
"@openrampkit/adapter-mock": minor
"@openrampkit/client": minor
"@openrampkit/server": minor
"@openrampkit/wagmi": minor
---

Solana and Tempo support.

- New package `@openrampkit/solana`: a `WalletAdapter` for Solana wallets (Wallet Standard and `@solana/kit`). It signs Relay's Solana transactions (instructions and address lookup tables), serialized transactions, and SOL and SPL transfers (it creates the recipient token account when it is missing).
- core: Solana devnet, Tempo (4217) and Tempo testnet (42431) metadata; USDC on Solana and Tempo; `normalizeToken` keeps the case of Solana mints; SPL amount helpers; `SolanaTxRequest` in `TxRequest`; `combineWallets` joins an EVM and a Solana wallet.
- Relay: Solana as origin (wallet pay) and destination (wallet, deposit address, bridge hop), placeholder `user` per VM, and on-chain checks of same-chain Solana moves (`getSignatureStatuses`, `getTransaction`). One signature completes one payment only. Default RPCs for Solana and Tempo.
- Mock: Solana destinations, Solana transfers and base58 test deposit addresses.
- Client: pays with the account of the source chain when an EVM and a Solana wallet are both connected.
- Server: Solana mints keep their case in sessions.
- wagmi: no native balance on Tempo (fees are paid in stablecoins); refuses Solana transactions.
