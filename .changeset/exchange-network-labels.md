---
"@openrampkit/core": minor
"@openrampkit/web": minor
---

Verified network names per exchange. `EXCHANGES[].networks` maps a CAIP-2 chain id to `{ label, source, read }`: the name that the exchange shows in its withdraw screen (for example `Arbitrum One` or `BNB Smart Chain (BEP20)`), the official page where we read it, and the date of the read. New `exchangeNetworkLabel(exchange, chain)`. The widget's deposit hint for a picked exchange uses this name, else the generic chain name. A missing name never hides an exchange.
