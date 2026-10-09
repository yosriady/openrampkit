---
'@openrampkit/wagmi': patch
---

`sendTransactions` now stops when a receipt it waits for has status `reverted`, so a reverted approve never lets the next transaction go out.
