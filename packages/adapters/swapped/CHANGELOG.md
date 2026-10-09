# @openrampkit/adapter-swapped

## 0.1.0

### Minor Changes

- 138dc35: One `env: 'sandbox' | 'production'` option for every adapter, checked against `livemode`. Each adapter now shows its environment as the read-only `adapter.env` (new `AdapterEnv` type). Transak takes `env: 'sandbox'` (was `'staging'`), Peer takes `env: 'production'` (was `'live'`), and Coinbase takes `env` (was `sandbox: boolean`). The old values still work, with a one-time deprecation warning. Stripe and Xendit read `env` from the key prefix, take an optional `env`, and throw when the two do not agree. Binance and LI.FI are always `production`. Relay is `sandbox` on the testnets host, and the mock adapter is `sandbox`. `createOpenRamp` now refuses to start with `livemode: true` and a `sandbox` adapter, and warns for a `production` adapter when `livemode` is false. New helpers: `resolveEnv` and `warnDeprecatedOnce`.
- 9a88cec: **Breaking.** The adapter uses the adapter contract v2 (`ADAPTER_API_VERSION` 2): steps with `status` and `action`, `detail`, and `transactions` with roles. Quotes are `estimate`. `providerRef` is the Swapped order id. `statusMap` tables for buy and sell; an unknown status keeps the last known step.

  Migration:

  | Before                                                               | Now                                                                                                                                                       |
  | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `LegStep.state` and `status`                                         | `status` only; `action { kind, surface, transitions }` with `requires_action`; `phase: 'kyc' \| 'auth'` for a review; `stateFor(step)` gives `Step.state` |
  | `LegStep.surface`, `LegStep.transitions`                             | `action.surface`, `action.transitions` (a waiting step without action: `poll`)                                                                            |
  | `Step.sub`, `LegStep.sub`, `LegStep.providerStatus`                  | `detail { code, providerStatus }`                                                                                                                         |
  | `STEP_SUBS`, `StepSub`, `isStepSub()`                                | `STEP_DETAIL_CODES`, `StepDetailCode`, `isStepDetailCode()`                                                                                               |
  | `LegStep.txHash`, `LegStep.sourceTxHash`                             | `transactions: [{ role, hash, chain? }]`                                                                                                                  |
  | `result.txHashes`, `result.sourceTxHashes`, `progress.legs[].txHash` | `result.transactions`, `payment.legs[].transactions` (`Transaction { role, chain, hash, legIndex, explorerUrl? }`)                                        |
  | `Step.progress.legs`                                                 | `PublicSession.payment.legs` (with `provider`, `ref`, `providerRef`)                                                                                      |
  | `session.late_payment` `txHash`                                      | `transactions`                                                                                                                                            |
  | `result.amountMismatch { reason }`                                   | `result.delivery { status: ok \| short \| asset_mismatch \| invalid }`                                                                                    |
  | `Fee { amount: string, currency, inRate }`                           | `Fee { kind, label, amount: Amount \| null, included }`                                                                                                   |
  | `LegQuote.expiresAt?`, `Quote.expiresAt?`                            | required `expiresAt`, plus `guarantee`, `minOutput?`, `slippageBps?`                                                                                      |
  | `ADAPTER_API_VERSION` 1                                              | 2 (`createAdapter` refuses version 1)                                                                                                                     |
  | `SESSION_SCHEMA` 2                                                   | 3 (`migrateRecord` moves stored records)                                                                                                                  |

  See the [0.1 data model record](https://github.com/yosriady/openrampkit/blob/main/docs/design/data-model-0.1.md).

- 51167ad: **Breaking (mechanical).** The adapter follows the renames of the 0.1 data model: `Amount.value` (was `amount`), the leg status `requires_action` (was `awaiting_user`), and `OpenRampException` (was `OrkException`). The provider calls do not change.

  Migration:

  | Before                                                                         | Now                                                                                               |
  | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
  | `OrkError`, `OrkErrorCode`, `OrkException`, `orkError()`, `isOrkError()`       | `OpenRampError`, `OpenRampErrorCode`, `OpenRampException`, `openRampError()`, `isOpenRampError()` |
  | `OrkEvent`, `OrkEventType`                                                     | `WebhookEvent` (server to backend), `ClientEvent` (browser UI)                                    |
  | `Amount.amount`                                                                | `Amount.value`                                                                                    |
  | Session status `open`, `awaiting_user`, `completed`                            | `requires_payment_method`, `requires_action`, `succeeded`                                         |
  | Leg status `awaiting_user`                                                     | `requires_action`                                                                                 |
  | Event `session.completed`                                                      | `session.succeeded`                                                                               |
  | Events `withdrawal.completed`, `withdrawal.failed`, `withdrawal.reversed`      | The `session.*` events (`data.object.session.direction` is `withdraw`)                            |
  | Headers `openramp-id`, `openramp-timestamp`, `openramp-signature` (`v1=<hex>`) | `webhook-id`, `webhook-timestamp`, `webhook-signature` (`v1,<base64>`, Standard Webhooks)         |
  | Event `created` (Unix seconds), `data.object.userId`, `data.object.metadata`   | `createdAt` (ISO 8601), `data.object.session.userId`, `data.object.session.metadata`              |
  | `target`, `lockTarget`, `allowedTargets`, `targetLocked`                       | `destination`, `lockDestination`, `allowedDestinations`, `destinationLocked`                      |
  | `TARGET_NOT_ALLOWED`, `TARGET_LOCKED`                                          | `DESTINATION_NOT_ALLOWED`, `DESTINATION_LOCKED`                                                   |

  See the [0.1 data model record](https://github.com/yosriady/openrampkit/blob/main/docs/design/data-model-0.1.md).

- 77f762d: First release on npm. All `@openrampkit/*` packages have the same version (0.1.0). The Release workflow publishes them from GitHub Actions with npm provenance. Read [Releases and versions](https://github.com/yosriady/openrampkit/blob/main/docs/guide/releases.md) for the 0.x stability rules.
- 230c5ad: First MVP release: deposit and withdraw modal, self-hosted server, pathway planner, and 12 provider adapters.
- 609b907: Replay protection for provider webhooks that have no timestamp. `Adapter.webhook` has a new optional `replayKey(req, rawBody, ctx)`. After `verify`, the server claims the key for 7 days in the adapter's shared store with the new `claimWebhook` (built on `claimOnce`). A repeat gets `200` with `{ "received": true, "duplicate": true }`, changes nothing, and adds 1 to the new `webhook.replayed` metric. When the server cannot apply the events yet (`503`), it gives the key back with `releaseWebhook`, so the provider's retry still applies. New helpers: `webhookBodyKey(rawBody)` (SHA-256 of the body), `claimWebhook`, `releaseWebhook` and `WEBHOOK_REPLAY_TTL_SEC`. The Onramper, Swapped and Xendit adapters now give the body hash as the replay key and as the `eventId` of their events.

### Patch Changes

- 9c135aa: Leg capabilities now hold only what the server reads: `LegCapability` is `'settlement' | 'surface_after_processing'`. The values `webhooks`, `polling`, `refunds`, `exact_output` and `saved_methods` are removed: nothing read them, and adapters declared them in different ways. How the server learns a leg result now comes from the adapter: `resultChannels(adapter)` in `@openrampkit/adapter` gives `polling` (the adapter has `status()`) and `webhooks` (it has a `webhook` whose new `configured` flag is not `false`). Binance, Bridge, Coinbase, Meld, MoonPay and Onramper set `configured` from their webhook secret. The server writes a warning at start for an adapter with legs that has neither. `checkAdapterShape` reports an unknown capability.
- 0672f15: No silent fallback to the wrong asset. When the destination token is not one that the provider delivers, the onramp adapters (Binance, Coinbase, Meld, MoonPay, Onramper, Stripe, Swapped, Transak) now fail the quote with `NO_QUOTES`, and do not call the provider. Before, they quoted the first deliver asset (often USDC on Base). Bridge now checks the token too, not only the chain. New helpers in `@openrampkit/adapter`: `findDeliverAsset` (returns `undefined` on no match), `requireDeliverAsset` and `deliverableToAsset`.
- c24a0f7: Security hardening: body size limits (413), input checks on sessions and browser routes, idempotency keys scoped per route, session deadline enforced on quote, select and restart, surface URL checks (no `javascript:` or `data:` URLs) on the server, client and web component, a single treasury send under concurrent requests, a block time check for Relay same-chain payments, minimum lengths for `webhooks.secret` and `tasksToken`, empty webhook keys refused by Stripe and Swapped, and the mock adapter refuses live sessions. New in core: `isWebUrl` and `isSafeLinkUrl`.
- 5c5019e: `Step.sub` is now a closed list of lowercase values: `StepSub`, with `STEP_SUBS` and `isStepSub` in `@openrampkit/core`. Before, it mixed case and raw provider strings (`CONFIRMING`, `confirming`, Relay and LI.FI statuses), and the web UI title-cased them. Adapters now map provider statuses to the list (for example LI.FI `WAIT_DESTINATION_TRANSACTION` is `bridging`, Relay `waiting` is `waiting_for_deposit`) and put the raw value in the new `LegStep.providerStatus`. The server writes it to the timeline (`leg.provider_status`), never to the browser, and drops a `sub` that is not in the list. The web element shows `messages.stepSub[sub]`, translated in every catalog (en, vi, id, th, ms, fil).
- Updated dependencies [138dc35]
- Updated dependencies [901ea9a]
- Updated dependencies [25b1f98]
- Updated dependencies [9a88cec]
- Updated dependencies [9a88cec]
- Updated dependencies [51167ad]
- Updated dependencies [51167ad]
- Updated dependencies [77f762d]
- Updated dependencies [230c5ad]
- Updated dependencies [3453854]
- Updated dependencies [9c135aa]
- Updated dependencies [7512a8e]
- Updated dependencies [521c893]
- Updated dependencies [8d66ab9]
- Updated dependencies [0672f15]
- Updated dependencies [e2e8337]
- Updated dependencies [6e7899b]
- Updated dependencies [127b79a]
- Updated dependencies [8a2ec99]
- Updated dependencies [635d8f9]
- Updated dependencies [f4a89d0]
- Updated dependencies [e74d5e3]
- Updated dependencies [fb978b8]
- Updated dependencies [5997e23]
- Updated dependencies [c24a0f7]
- Updated dependencies [a999c0c]
- Updated dependencies [63f3db5]
- Updated dependencies [d4523b2]
- Updated dependencies [bf08445]
- Updated dependencies [3b8e567]
- Updated dependencies [5c5019e]
- Updated dependencies [609b907]
  - @openrampkit/adapter@0.1.0
  - @openrampkit/core@0.1.0
