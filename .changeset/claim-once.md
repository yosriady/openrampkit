---
'@openrampkit/adapter': minor
'@openrampkit/adapter-relay': patch
'@openrampkit/adapter-lifi': patch
'@openrampkit/adapter-bridge': patch
'@openrampkit/adapter-mock': patch
'@openrampkit/server': patch
---

New `claimOnce(shared, key, owner, ttlSec)` in `@openrampkit/adapter`: it records a transaction, log or deposit as used by one owner. `ScopedKV` has a new optional `putIfAbsent(key, value, ttlSec)`. The server gives it to adapters when the store has an atomic operation: `memoryStore`, `redisStore` (`SET NX EX` in a Lua script) and `durableObjectStore` have one, `cloudflareKvStore` does not. The Relay, LI.FI, Bridge and mock adapters now use `claimOnce`. On a store with `putIfAbsent`, two requests at the same time can no longer both take the same transaction. The stored keys and values do not change.
