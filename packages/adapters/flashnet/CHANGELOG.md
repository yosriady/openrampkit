# @openrampkit/adapter-flashnet

## 0.1.0

### Minor Changes

- 131dc8a: Withdraw to a Cash App `$cashtag` or a Lightning address.

  - Core: a `lightning` withdraw target (`{ type: 'lightning', address, cashtag? }`), `parseLightningTarget` (strict format; invoices, LNURLs, URLs and IP addresses are refused), `sameLightningAddress`, `LIGHTNING` and `LIGHTNING_BTC`, the endpoint locations `cash_app` and `lightning_address`, and `allowedDestinations.lightning.domains`.
  - Server: `POST /sessions/:id/target` and `sessions.create` take `{ type: 'lightning', address }`. The server parses the address, checks `allowedDestinations.lightning`, and runs the new `screenLightningAddress` hook (fail closed). With `screenAddress` set and no Lightning hook, every Lightning target is refused. A deposit cannot go to a Lightning address.
  - Client and web: a "To Cash App" withdraw tab when `allowedDestinations.lightning` is set, with a `$cashtag` input, format checks, and a hint about Cash App dollars, in all six locales.
  - Flashnet: payout legs `cash_app_payout` and `lightning_payout` through `POST /v1/orchestration/offramp`, from USDC on Base, Ethereum, Arbitrum, Optimism and Polygon. The adapter builds the ERC-20 transfer, checks the answer against the quote and the session target, and binds each quote, deposit address and funding transaction to one payout.

- c7f849c: New adapter (experimental): Flashnet Orchestra. A `cash_app` leg and a `lightning` leg: the user pays a USD-priced Lightning invoice (from Cash App or any Lightning wallet) and gets USDC at the destination, through `POST /v1/orchestration/onramp`, with a `QR` (or `DEEPLINK`) surface. A `transfer` leg for deposits from BTC on Bitcoin and USDT on Tron through an Orchestra deposit address. Status from `GET /v1/orchestration/status`, and webhooks verified with the timestamped HMAC. The adapter checks the invoice (network, amount, expiry), binds each payment hash, deposit address, order and deposit to one leg, and accepts a completed order only for the expected asset and recipient. Payouts to Cash App are not built yet. Built from the docs; no sandbox exists; some details TO VERIFY.

  Core: Bitcoin (`BITCOIN_MAINNET`, `bip122:000000000019d6689c085ae165831e93`) and Tron (`TRON_MAINNET`, `tron:728126428`) in the chain table, and `TRON_USDT`. Server: Bitcoin and Tron address formats in `isValidAddress`, and the source picker adds a known chain outside the USDC list when an adapter lists a token on it.

### Patch Changes

- Updated dependencies [138dc35]
- Updated dependencies [243bf9c]
- Updated dependencies [131dc8a]
- Updated dependencies [d6e1063]
- Updated dependencies [901ea9a]
- Updated dependencies [25b1f98]
- Updated dependencies [9a88cec]
- Updated dependencies [9a88cec]
- Updated dependencies [51167ad]
- Updated dependencies [51167ad]
- Updated dependencies [b770da7]
- Updated dependencies [59811bd]
- Updated dependencies [977c386]
- Updated dependencies [77f762d]
- Updated dependencies [c7f849c]
- Updated dependencies [230c5ad]
- Updated dependencies [3453854]
- Updated dependencies [9c135aa]
- Updated dependencies [7512a8e]
- Updated dependencies [521c893]
- Updated dependencies [8d66ab9]
- Updated dependencies [b763cf0]
- Updated dependencies [0672f15]
- Updated dependencies [e2e8337]
- Updated dependencies [6e7899b]
- Updated dependencies [127b79a]
- Updated dependencies [8a2ec99]
- Updated dependencies [635d8f9]
- Updated dependencies [0dfd32e]
- Updated dependencies [f4a89d0]
- Updated dependencies [e74d5e3]
- Updated dependencies [fb978b8]
- Updated dependencies [5997e23]
- Updated dependencies [c24a0f7]
- Updated dependencies [a999c0c]
- Updated dependencies [63f3db5]
- Updated dependencies [d4523b2]
- Updated dependencies [bf08445]
- Updated dependencies [66c8f1d]
- Updated dependencies [3b8e567]
- Updated dependencies [8ad4bd2]
- Updated dependencies [aad31d5]
- Updated dependencies [bab3381]
- Updated dependencies [5c5019e]
- Updated dependencies [2c1daa4]
- Updated dependencies [609b907]
- Updated dependencies [29dbf05]
- Updated dependencies [18da157]
  - @openrampkit/adapter@0.1.0
  - @openrampkit/core@0.1.0
