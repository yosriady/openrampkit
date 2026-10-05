---
"@openrampkit/adapter-relay": minor
---

One deposit now completes one session only.

- Same-chain `transfer` legs (EVM): one `Transfer` log must pay at least the expected amount minus a tolerance (`amountToleranceBps`, default 50). The adapter does not add small transfers together. It records each log as used by (chain, tx hash, log index), so a log never completes a second session or a same-chain wallet payment. It reads logs in pages of `logBlockRange` blocks (default 2000) and goes on from the last page at the next check.
- When two open sessions on the same address could both claim a deposit, neither session takes it. The leg stays in its waiting state with sub-state `ambiguous_deposit`, and the adapter logs a warning.
- Deposit-address legs: each session gets its own Relay deposit address. The address is no longer shared across sessions for 24 hours. Status binds one Relay request to one session, by deposit tx hash, and checks the deposit amount when the user gave one.
- Deposit legs use the ref `dep:<sessionId>:<address>`, so one ref maps to one session.
- New option `slippageBps` sends Relay `slippageTolerance`. Quote data has `minOutput` (Relay `minimumAmount`).
- Without `apiKey`, the warning about the retirement of `GET /requests/v2` (2026-11-24) now shows on the first adapter call.
