---
"@openrampkit/privy": minor
---

New `@openrampkit/privy`: a wallet adapter for Privy embedded wallets. `privyWallet({ wallet })` returns a `WalletAdapter` that reads USDC and native balances and signs `WALLET_TX` surfaces on EVM chains. It calls the wallet's EIP-1193 provider, so it does not depend on a Privy SDK version. `getAccounts()` returns `[]` on the server, so it is safe during SSR.
