---
"@openrampkit/adapter-flashnet": minor
"@openrampkit/core": minor
"@openrampkit/server": minor
---

New adapter (experimental): Flashnet Orchestra. A `cash_app` leg and a `lightning` leg: the user pays a USD-priced Lightning invoice (from Cash App or any Lightning wallet) and gets USDC at the destination, through `POST /v1/orchestration/onramp`, with a `QR` (or `DEEPLINK`) surface. A `transfer` leg for deposits from BTC on Bitcoin and USDT on Tron through an Orchestra deposit address. Status from `GET /v1/orchestration/status`, and webhooks verified with the timestamped HMAC. The adapter checks the invoice (network, amount, expiry), binds each payment hash, deposit address, order and deposit to one leg, and accepts a completed order only for the expected asset and recipient. Payouts to Cash App are not built yet. Built from the docs; no sandbox exists; some details TO VERIFY.

Core: Bitcoin (`BITCOIN_MAINNET`, `bip122:000000000019d6689c085ae165831e93`) and Tron (`TRON_MAINNET`, `tron:728126428`) in the chain table, and `TRON_USDT`. Server: Bitcoin and Tron address formats in `isValidAddress`, and the source picker adds a known chain outside the USDC list when an adapter lists a token on it.
