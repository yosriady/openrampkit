---
"@openrampkit/adapter": minor
---

Settlement contract fix: `settleFromBalance` now needs a `BalanceSettlementIntent` that binds the exact amount. Before, its intent bound only a minimum amount, so a caller with a valid intent could take other funds that the contract held. New: `settlementBalanceIntentTypedData` and `SETTLEMENT_BALANCE_INTENT_TYPES`. `encodeSettle(..., { fromBalance: true })` throws when the intent `minAmount` is not equal to `amount`. The ABI has the new `BALANCE_INTENT_TYPEHASH`, `balanceIntentDigest` and `AmountMismatch`. `settle` and its intent did not change. The deployed testnet contracts predate this fix and need a redeploy before any flow uses `settleFromBalance`.
