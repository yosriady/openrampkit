# @openrampkit/privy

## 0.1.0

### Minor Changes

- 37c06b2: New `@openrampkit/privy`: a wallet adapter for Privy embedded wallets. `privyWallet({ wallet })` returns a `WalletAdapter` that reads USDC and native balances and signs `WALLET_TX` surfaces on EVM chains. It calls the wallet's EIP-1193 provider, so it does not depend on a Privy SDK version. `getAccounts()` returns `[]` on the server, so it is safe during SSR. A reverted receipt stops the batch, so a failed approve never lets the next transaction go out.

### Patch Changes

- Updated dependencies [25b1f98]
- Updated dependencies [9a88cec]
- Updated dependencies [51167ad]
- Updated dependencies [77f762d]
- Updated dependencies [230c5ad]
- Updated dependencies [3453854]
- Updated dependencies [9c135aa]
- Updated dependencies [7512a8e]
- Updated dependencies [8d66ab9]
- Updated dependencies [e2e8337]
- Updated dependencies [6e7899b]
- Updated dependencies [127b79a]
- Updated dependencies [8a2ec99]
- Updated dependencies [f4a89d0]
- Updated dependencies [fb978b8]
- Updated dependencies [5997e23]
- Updated dependencies [c24a0f7]
- Updated dependencies [63f3db5]
- Updated dependencies [bf08445]
- Updated dependencies [3b8e567]
- Updated dependencies [5c5019e]
  - @openrampkit/core@0.1.0
