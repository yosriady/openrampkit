---
'@openrampkit/client': minor
---

**Breaking.** The controller reads `step.detail` and `session.payment` (were `step.sub` and `step.progress`). The `step.changed` event has `detail` (a code) in place of `sub`. The quote refresh timer is capped, so a quote that lives for weeks does not refresh at once.

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
