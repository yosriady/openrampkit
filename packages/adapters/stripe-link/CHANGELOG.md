# @openrampkit/adapter-stripe-link

## 0.1.0

### Minor Changes

- a789542: New adapter `@openrampkit/adapter-stripe-link` for the Stripe Link headless crypto onramp (Embedded Components). The user signs in to Link, and the purchase runs in the app's own screens. The Link access token stays on the server, sealed with AES-256-GCM, for at most one hour. It is bound to the session, the app user, the checked crypto customer and the client that signed in (a `clientKey` input). The adapter keeps no refresh token. Unverified: built from Stripe's docs, and Stripe must onboard the account (private preview).

### Patch Changes

- 243bf9c: Chain watch and Stripe Link: make claims and stage changes atomic.

  - `@openrampkit/adapter`: new `claimTransferLog` and `TX_LOGS_OWNER`. A Transfer log first claims its transaction for logs (one key with a wallet payment of the same transaction), then the log. So a log and a wallet payment that run at the same time cannot both count one transfer.
  - `@openrampkit/adapter-chain-watch` and `@openrampkit/adapter-relay` (same-chain transfer legs): EVM logs are claimed with `claimTransferLog`.
  - `@openrampkit/server`: a watched destination and a converting standing address to it are bound with one atomic claim (`sdwatch:`), so exactly one wins when they are made at the same time, and the loser leaves no mark.
  - `@openrampkit/adapter-stripe-link`: each change of a leg takes a lease on the record version (one atomic claim). Two `link_authenticated` calls cannot both bind a client key, two `checkout` calls send one checkout, and a transition cannot run next to a new sign-in. Each checkout sends an idempotency key with the record version.

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
