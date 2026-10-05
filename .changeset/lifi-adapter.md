---
"@openrampkit/adapter-lifi": minor
---

New `@openrampkit/adapter-lifi`: a second any-token, any-chain wallet router next to Relay. The `wallet` leg quotes with LI.FI `GET /v1/quote` (or `/v1/quote/toAmount`), gives the wallet an ERC-20 approval when needed and the LI.FI transaction (EVM), or a serialized transaction (Solana), and polls `GET /v1/status`. One source transaction pays one session only. The leg completes only when the destination got at least the quoted `toAmountMin` (bigint math). On EVM token destinations, one unused `Transfer` log must show it; the adapter records it by (chain, tx hash, log index) and does not add logs together. Options: `apiKey`, `integrator`, `feeBps`, `slippageBps`, `order`, `rpcUrls`, `verifyOnChain`.
