---
'@openrampkit/adapter-relay': patch
---

Solana transfer to the destination itself now follows the same rules as EVM `Transfer` logs. Behavior change: the adapter no longer adds signatures together. One signature must pay at least the expected amount minus the tolerance on its own, so small transfers and transfers by other people to a shared address no longer complete a session. When another open leg on the same address could also claim the signature, no leg takes it, and the leg shows the sub-state `ambiguous_deposit`. Without an amount up front, a signature completes the leg only when no other open leg could claim it. The chosen signature is claimed with `claimOnce`: on a store with `putIfAbsent`, two sessions that check at the same time can no longer both take it. A finished Solana leg now removes its watch. The stored keys (`txused:<chain>:<signature>`), values and TTL do not change.
