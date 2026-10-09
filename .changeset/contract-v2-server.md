---
'@openrampkit/server': minor
---

**Breaking.** The server runs the adapter contract v2.

- One entry check (`sanitizeLegStep`) for every adapter step and provider event, also for earlier attempts: surface URLs, detail codes, actions, phases, and transaction fields. Adapter links are dropped; `Transaction.explorerUrl` comes from the chain table only.
- The leg keeps every transaction that it reported. Any transaction that moves funds makes a failure final and blocks cancel and restart. A provider event may end a KYC review with a step for the user, like a status poll.
- `PublicSession.payment` replaces `Step.progress`. `result.transactions` replaces `txHashes` and `sourceTxHashes`. `result.delivery` replaces `amountMismatch`; the output check uses the quote `minOutput` when it has one. Timeline `leg.delivery` and `leg.transaction`; metric `leg.delivery_mismatch` (was `leg.amount_mismatch`).
- The pathway quote takes the weakest leg guarantee and the earliest expiry. A leg quote without a valid expiry lives 5 minutes.
- Admin: `transactions` and `AdminLeg.transactions`, `providerRef`, `providerStatus`, `step.detail`, `delivery`. `findByTx` finds any transaction hash of any role in any attempt. The admin page shows fees, references and transactions.
- `SESSION_SCHEMA` is 3. `migrateRecord` moves schema 2 records: fees, guarantees and expiries of stored quotes, leg steps (action, phase, detail, transactions), and `amountMismatch` to `delivery`. Payments in flight during the upgrade finish.
- A status poll that repeats a provider REDIRECT is no change (no new start URL, no write).

Migration:

| Before | Now |
|---|---|
| `LegStep.state` and `status` | `status` only; `action { kind, surface, transitions }` with `requires_action`; `phase: 'kyc' \| 'auth'` for a review; `stateFor(step)` gives `Step.state` |
| `LegStep.surface`, `LegStep.transitions` | `action.surface`, `action.transitions` (a waiting step without action: `poll`) |
| `Step.sub`, `LegStep.sub`, `LegStep.providerStatus` | `detail { code, providerStatus }` |
| `STEP_SUBS`, `StepSub`, `isStepSub()` | `STEP_DETAIL_CODES`, `StepDetailCode`, `isStepDetailCode()` |
| `LegStep.txHash`, `LegStep.sourceTxHash` | `transactions: [{ role, hash, chain? }]` |
| `result.txHashes`, `result.sourceTxHashes`, `progress.legs[].txHash` | `result.transactions`, `payment.legs[].transactions` (`Transaction { role, chain, hash, legIndex, explorerUrl? }`) |
| `Step.progress.legs` | `PublicSession.payment.legs` (with `provider`, `ref`, `providerRef`) |
| `session.late_payment` `txHash` | `transactions` |
| `result.amountMismatch { reason }` | `result.delivery { status: ok \| short \| asset_mismatch \| invalid }` |
| `Fee { amount: string, currency, inRate }` | `Fee { kind, label, amount: Amount \| null, included }` |
| `LegQuote.expiresAt?`, `Quote.expiresAt?` | required `expiresAt`, plus `guarantee`, `minOutput?`, `slippageBps?` |
| `ADAPTER_API_VERSION` 1 | 2 (`createAdapter` refuses version 1) |
| `SESSION_SCHEMA` 2 | 3 (`migrateRecord` moves stored records) |

See the [0.1 data model record](https://github.com/yosriady/openrampkit/blob/main/docs/design/data-model-0.1.md).
