---
'@openrampkit/adapter': minor
---

**Breaking.** Adapter contract v2: `ADAPTER_API_VERSION` is 2, and `createAdapter` refuses an adapter built for another version with a message that says what changed.

- `LegEvent` is a `LegStep` with a `ref` (and an optional `eventId`), so a webhook can carry an action, a phase (for example a KYC review) or transactions. `legStepFromEvent()` keeps the event and adds a poll; `awaitingPayment()` is the step while the user pays.
- New helpers: `quoteExpiresAt()`, `statusMap()` (an unknown provider status gives `undefined` and one log, never a default), `verifyTimestampedHmac()` and `parseSignatureHeader()` (the `t=,v1=` webhook pattern), and `cachedJson()`.
- The conformance kit checks the v2 step rules, the quote output asset, a future `expiresAt`, fee assets, the guarantee fields, declared capabilities against implemented methods, and (option `errorPaths`) the codes and `retryable` values of HTTP 400, 401, 429, 500 and timeout. `LEG_STATUSES` is exported.

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
