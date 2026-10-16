---
"@openrampkit/core": minor
"@openrampkit/server": minor
"@openrampkit/client": minor
"@openrampkit/web": minor
"@openrampkit/adapter-flashnet": minor
---

Withdraw to a Cash App `$cashtag` or a Lightning address.

- Core: a `lightning` withdraw target (`{ type: 'lightning', address, cashtag? }`), `parseLightningTarget` (strict format; invoices, LNURLs, URLs and IP addresses are refused), `sameLightningAddress`, `LIGHTNING` and `LIGHTNING_BTC`, the endpoint locations `cash_app` and `lightning_address`, and `allowedDestinations.lightning.domains`.
- Server: `POST /sessions/:id/target` and `sessions.create` take `{ type: 'lightning', address }`. The server parses the address, checks `allowedDestinations.lightning`, and runs the new `screenLightningAddress` hook (fail closed). With `screenAddress` set and no Lightning hook, every Lightning target is refused. A deposit cannot go to a Lightning address.
- Client and web: a "To Cash App" withdraw tab when `allowedDestinations.lightning` is set, with a `$cashtag` input, format checks, and a hint about Cash App dollars, in all six locales.
- Flashnet: payout legs `cash_app_payout` and `lightning_payout` through `POST /v1/orchestration/offramp`, from USDC on Base, Ethereum, Arbitrum, Optimism and Polygon. The adapter builds the ERC-20 transfer, checks the answer against the quote and the session target, and binds each quote, deposit address and funding transaction to one payout.
