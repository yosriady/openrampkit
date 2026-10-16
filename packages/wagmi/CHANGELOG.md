# @openrampkit/wagmi

## 0.1.0

### Minor Changes

- 77f762d: First release on npm. All `@openrampkit/*` packages have the same version (0.1.0). The Release workflow publishes them from GitHub Actions with npm provenance. Read [Releases and versions](https://github.com/yosriady/openrampkit/blob/main/docs/guide/releases.md) for the 0.x stability rules.
- 230c5ad: First MVP release: deposit and withdraw modal, self-hosted server, pathway planner, and 12 provider adapters.
- bf08445: Solana and Tempo support.

  - New package `@openrampkit/solana`: a `WalletAdapter` for Solana wallets (Wallet Standard and `@solana/kit`). It signs Relay's Solana transactions (instructions and address lookup tables), serialized transactions, and SOL and SPL transfers (it creates the recipient token account when it is missing).
  - core: Solana devnet, Tempo (4217) and Tempo testnet (42431) metadata; USDC on Solana and Tempo; `normalizeToken` keeps the case of Solana mints; SPL amount helpers; `SolanaTxRequest` in `TxRequest`; `combineWallets` joins an EVM and a Solana wallet.
  - Relay: Solana as origin (wallet pay) and destination (wallet, deposit address, bridge hop), placeholder `user` per VM, and on-chain checks of same-chain Solana moves (`getSignatureStatuses`, `getTransaction`). One signature completes one payment only. Default RPCs for Solana and Tempo.
  - Mock: Solana destinations, Solana transfers and base58 test deposit addresses.
  - Client: pays with the account of the source chain when an EVM and a Solana wallet are both connected.
  - Server: Solana mints keep their case in sessions.
  - wagmi: no native balance on Tempo (fees are paid in stablecoins); refuses Solana transactions.

- 2c1daa4: Gas abstraction for wallet deposits. A user with USDC and no native gas can pay with the `wallet` method: the wallet signs Relay's permit (EIP-3009, EIP-712) and Relay's solver sends the origin transaction, with its gas taken from the token. New surface `WALLET_SIGN` (`{ chain, address, signatures: TypedDataRequest[] }`) with a SURFACE_RESULT transition that `expects: 'signatures'`. New optional `WalletAdapter.signTypedData(chain, data)` in `wagmiWallet`, `privyWallet` and `combineWallets`. The controller asks for it by `FlowOptions.gasless` (`'auto'` by default: only when the wallet reports a zero native balance) and signs with `signWalletMessages()`. `select` takes `gasless`, and `StartInput.gasless` passes it to the adapter. The Relay adapter (option `gasless`, default true) checks each message before the user sees it and recovers the signer of each signature before it posts it to `/execute/permits`. New `hashTypedData`, `recoverAddress` and `recoverTypedDataSigner` in `@openrampkit/adapter`. The mock adapter shows `WALLET_SIGN` in test mode, and `createMockWallet({ canSign: true })` signs.

### Patch Changes

- 569cd57: `sendTransactions` now stops when a receipt it waits for has status `reverted`, so a reverted approve never lets the next transaction go out.
- Updated dependencies [131dc8a]
- Updated dependencies [25b1f98]
- Updated dependencies [9a88cec]
- Updated dependencies [51167ad]
- Updated dependencies [b770da7]
- Updated dependencies [59811bd]
- Updated dependencies [977c386]
- Updated dependencies [77f762d]
- Updated dependencies [c7f849c]
- Updated dependencies [230c5ad]
- Updated dependencies [3453854]
- Updated dependencies [9c135aa]
- Updated dependencies [7512a8e]
- Updated dependencies [8d66ab9]
- Updated dependencies [b763cf0]
- Updated dependencies [e2e8337]
- Updated dependencies [6e7899b]
- Updated dependencies [127b79a]
- Updated dependencies [8a2ec99]
- Updated dependencies [0dfd32e]
- Updated dependencies [f4a89d0]
- Updated dependencies [fb978b8]
- Updated dependencies [5997e23]
- Updated dependencies [c24a0f7]
- Updated dependencies [63f3db5]
- Updated dependencies [bf08445]
- Updated dependencies [66c8f1d]
- Updated dependencies [3b8e567]
- Updated dependencies [8ad4bd2]
- Updated dependencies [aad31d5]
- Updated dependencies [5c5019e]
- Updated dependencies [2c1daa4]
- Updated dependencies [29dbf05]
  - @openrampkit/core@0.1.0
