# @openrampkit/adapter-chain-watch

## 0.1.0

### Minor Changes

- bab3381: Standing deposit addresses for the same token on the same chain, with no bridge provider.

  - New `@openrampkit/adapter-chain-watch` (`chainWatch()`): the deposit address is the destination itself, and the adapter watches the chain (ERC-20 `Transfer` logs on EVM chains, SOL and SPL signatures on Solana). A transfer counts after `confirmations` blocks (default 12; Solana `finalized`). Each log or signature is claimed once, so it makes one session. `status()` reads the transaction again: a transfer that a re-org removed, or with another amount, fails the leg. Options: `rpcUrls`, `defaultRpcUrls`, `confirmations`, `solanaCommitment`, `logBlockRange`, `maxLogPages`, `requestsPerSecond`, `timeoutMs`, `minDeposit`. It has no session legs (it is never in a plan).
  - `@openrampkit/adapter`: new `createChainWatch()` (RPC URLs per chain, a rate limit per RPC URL, `Transfer` log pages with a block range cap, Solana reads), `txUsedKey`, `PUBLIC_RPC_URLS`, `solanaNetReceived` and `solanaMintDecimals`. New optional `Adapter.standingRoutes` (`'convert'` by default, or `'same'`).
  - `@openrampkit/adapter-relay`: the same-chain checks use `createChainWatch`. No behavior change. New option `rpcRequestsPerSecond`. `logBlockRange` is capped at 10000.
  - `@openrampkit/server`: `depositAddresses.get` accepts the same token on the same chain and picks an adapter that serves the route (`standingRoutes`). Such an adapter must return the destination address itself. The widget route picks the adapter by route too.

### Patch Changes

- 243bf9c: Chain watch and Stripe Link: make claims and stage changes atomic.

  - `@openrampkit/adapter`: new `claimTransferLog` and `TX_LOGS_OWNER`. A Transfer log first claims its transaction for logs (one key with a wallet payment of the same transaction), then the log. So a log and a wallet payment that run at the same time cannot both count one transfer.
  - `@openrampkit/adapter-chain-watch` and `@openrampkit/adapter-relay` (same-chain transfer legs): EVM logs are claimed with `claimTransferLog`.
  - `@openrampkit/server`: a watched destination and a converting standing address to it are bound with one atomic claim (`sdwatch:`), so exactly one wins when they are made at the same time, and the loser leaves no mark.
  - `@openrampkit/adapter-stripe-link`: each change of a leg takes a lease on the record version (one atomic claim). Two `link_authenticated` calls cannot both bind a client key, two `checkout` calls send one checkout, and a transition cannot run next to a new sign-in. Each checkout sends an idempotency key with the record version.

- d6e1063: Chain watch: fix deposit misattribution and address squatting.

  - `@openrampkit/server`: `depositAddresses.get` for the same token on the same chain now needs `dedicatedDestination: true` (else `400`). The server binds the watched destination (chain, token, address) to one user (`409` for another user). A deposit session or a converting standing address to a watched destination is refused (`409`), and a same-chain address for a destination that a converting address delivers to is refused, because the deliveries would count twice. The widget route `POST /sessions/:id/deposit-address` no longer gives same-chain addresses (`400`) and picks only adapters that convert.
  - `@openrampkit/server`: adapter keys that start with `txused:` (`txUsedKey`) are now one namespace for all adapters, so one transfer completes one payment only, whichever adapter sees it. Claims written under the adapter prefix before still count.
  - `@openrampkit/adapter-chain-watch`: `status()` uses the token's real decimals, not `destination.decimals` from the session input. A log from the RPC must be a `Transfer` of the watched token to the address in the asked block range. A log of a transaction that a wallet payment claimed is skipped, and a counted log marks its transaction for wallet payments.

- Updated dependencies [138dc35]
- Updated dependencies [243bf9c]
- Updated dependencies [131dc8a]
- Updated dependencies [d6e1063]
- Updated dependencies [901ea9a]
- Updated dependencies [25b1f98]
- Updated dependencies [9a88cec]
- Updated dependencies [9a88cec]
- Updated dependencies [51167ad]
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
- Updated dependencies [521c893]
- Updated dependencies [8d66ab9]
- Updated dependencies [b763cf0]
- Updated dependencies [0672f15]
- Updated dependencies [e2e8337]
- Updated dependencies [6e7899b]
- Updated dependencies [127b79a]
- Updated dependencies [8a2ec99]
- Updated dependencies [635d8f9]
- Updated dependencies [0dfd32e]
- Updated dependencies [f4a89d0]
- Updated dependencies [e74d5e3]
- Updated dependencies [fb978b8]
- Updated dependencies [5997e23]
- Updated dependencies [c24a0f7]
- Updated dependencies [a999c0c]
- Updated dependencies [63f3db5]
- Updated dependencies [d4523b2]
- Updated dependencies [bf08445]
- Updated dependencies [66c8f1d]
- Updated dependencies [3b8e567]
- Updated dependencies [8ad4bd2]
- Updated dependencies [aad31d5]
- Updated dependencies [bab3381]
- Updated dependencies [5c5019e]
- Updated dependencies [2c1daa4]
- Updated dependencies [609b907]
- Updated dependencies [29dbf05]
- Updated dependencies [18da157]
  - @openrampkit/adapter@0.1.0
  - @openrampkit/core@0.1.0
