---
"@openrampkit/adapter-binance": minor
---

New `@openrampkit/adapter-binance`: the user deposits from their Binance account. It uses the Binance Pay Onchain on-ramp APIs (earlier name: Binance Connect). The user pays from the Binance balance on a Binance page (`REDIRECT`), and Binance sends USDC to the destination address. Requests are signed with SHA256withRSA, and webhooks are verified with the Binance public key. It needs Binance partner approval. Some details are TO VERIFY.
