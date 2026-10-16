---
"@openrampkit/core": minor
"@openrampkit/adapter": minor
"@openrampkit/adapter-relay": minor
"@openrampkit/adapter-mock": minor
"@openrampkit/client": minor
"@openrampkit/server": minor
"@openrampkit/web": minor
"@openrampkit/wagmi": minor
"@openrampkit/privy": minor
---

Gas abstraction for wallet deposits. A user with USDC and no native gas can pay with the `wallet` method: the wallet signs Relay's permit (EIP-3009, EIP-712) and Relay's solver sends the origin transaction, with its gas taken from the token. New surface `WALLET_SIGN` (`{ chain, address, signatures: TypedDataRequest[] }`) with a SURFACE_RESULT transition that `expects: 'signatures'`. New optional `WalletAdapter.signTypedData(chain, data)` in `wagmiWallet`, `privyWallet` and `combineWallets`. The controller asks for it by `FlowOptions.gasless` (`'auto'` by default: only when the wallet reports a zero native balance) and signs with `signWalletMessages()`. `select` takes `gasless`, and `StartInput.gasless` passes it to the adapter. The Relay adapter (option `gasless`, default true) checks each message before the user sees it and recovers the signer of each signature before it posts it to `/execute/permits`. New `hashTypedData`, `recoverAddress` and `recoverTypedDataSigner` in `@openrampkit/adapter`. The mock adapter shows `WALLET_SIGN` in test mode, and `createMockWallet({ canSign: true })` signs.
