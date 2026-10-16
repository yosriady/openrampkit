---
'@openrampkit/adapter': patch
'@openrampkit/adapter-chain-watch': patch
'@openrampkit/adapter-relay': patch
'@openrampkit/adapter-stripe-link': patch
'@openrampkit/server': patch
---

Chain watch and Stripe Link: make claims and stage changes atomic.

- `@openrampkit/adapter`: new `claimTransferLog` and `TX_LOGS_OWNER`. A Transfer log first claims its transaction for logs (one key with a wallet payment of the same transaction), then the log. So a log and a wallet payment that run at the same time cannot both count one transfer.
- `@openrampkit/adapter-chain-watch` and `@openrampkit/adapter-relay` (same-chain transfer legs): EVM logs are claimed with `claimTransferLog`.
- `@openrampkit/server`: a watched destination and a converting standing address to it are bound with one atomic claim (`sdwatch:`), so exactly one wins when they are made at the same time, and the loser leaves no mark.
- `@openrampkit/adapter-stripe-link`: each change of a leg takes a lease on the record version (one atomic claim). Two `link_authenticated` calls cannot both bind a client key, two `checkout` calls send one checkout, and a transition cannot run next to a new sign-in. Each checkout sends an idempotency key with the record version.
