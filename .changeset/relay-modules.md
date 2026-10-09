---
'@openrampkit/adapter': minor
'@openrampkit/adapter-relay': patch
---

New `minWithToleranceBps(expectedBase, bps)` in `@openrampkit/adapter`: the smallest amount that still counts as an expected amount with a tolerance in basis points (bigint math). The Relay adapter uses it, and its source is now split into modules (options, API client, quotes, deposit addresses, direct transfers, wallet). Its behavior and its exports do not change.
