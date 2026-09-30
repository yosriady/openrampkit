---
"@openrampkit/adapter": minor
"@openrampkit/adapter-mock": minor
"@openrampkit/adapter-relay": patch
---

Add EVM helpers to `@openrampkit/adapter` (`evmRpc`, `erc20PaidTo`, `erc20TransferData`, `topicAddress`, `ERC20_TRANSFER_TOPIC`). The Relay adapter uses them for its on-chain checks.

Add the test-only `localChain` option to the mock adapter. It adds an `onchain` leg that pays with a real ERC-20 transfer on a local chain (for example Anvil) and checks the receipt over JSON-RPC.
