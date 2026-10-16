---
'@openrampkit/adapter-chain-watch': patch
'@openrampkit/adapter': patch
'@openrampkit/server': patch
---

Chain watch: fix deposit misattribution and address squatting.

- `@openrampkit/server`: `depositAddresses.get` for the same token on the same chain now needs `dedicatedDestination: true` (else `400`). The server binds the watched destination (chain, token, address) to one user (`409` for another user). A deposit session or a converting standing address to a watched destination is refused (`409`), and a same-chain address for a destination that a converting address delivers to is refused, because the deliveries would count twice. The widget route `POST /sessions/:id/deposit-address` no longer gives same-chain addresses (`400`) and picks only adapters that convert.
- `@openrampkit/server`: adapter keys that start with `txused:` (`txUsedKey`) are now one namespace for all adapters, so one transfer completes one payment only, whichever adapter sees it. Claims written under the adapter prefix before still count.
- `@openrampkit/adapter-chain-watch`: `status()` uses the token's real decimals, not `destination.decimals` from the session input. A log from the RPC must be a `Transfer` of the watched token to the address in the asked block range. A log of a transaction that a wallet payment claimed is skipped, and a counted log marks its transaction for wallet payments.
