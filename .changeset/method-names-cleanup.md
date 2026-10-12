---
"@openrampkit/core": patch
---

Method names: add `boost` (Boost, a Malaysian e-wallet) to `METHODS`, because the country table already listed it. A test now checks that every method in `METHOD_COUNTRIES` exists in `METHODS`. The spec no longer lists `wire`: a bank wire uses `bank_transfer`.
