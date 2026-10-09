# @openrampkit/client

## 0.1.0

### Minor Changes

- 9a88cec: **Breaking.** The controller reads `step.detail` and `session.payment` (were `step.sub` and `step.progress`). The `step.changed` event has `detail` (a code) in place of `sub`. The quote refresh timer is capped, so a quote that lives for weeks does not refresh at once.

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

- 51167ad: **Breaking.** `OrkClientError` and `toOrkError()` are `OpenRampClientError` and `toOpenRampError()`. `onEvent` gets a typed `ClientEvent` with an ISO `createdAt` (was `created` in Unix seconds). New `client.cancel(secret)`. The status and withdraw renames of the 0.1 data model apply.

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
- 8d66ab9: Locked withdraw targets and pay link revocation.

  - Server: `CreateSessionInput` has `target` and `lockDestination` for withdraw sessions. The server checks the target at creation (format, `allowedDestinations`, `screenAddress`) and stores it as the destination. With `lockDestination: true`, `POST /sessions/:id/target` answers `409 DESTINATION_LOCKED`, for the client secret and for a pay link. A cash target (`{ type: 'fiat', currency }`) can also be locked.
  - Server: pay links have an `id`. `openramp.sessions.revokePayLink(sessionId, linkId)` and `POST /sessions/:id/pay-link/revoke` make one link stop working. The credential format is now `{sessionId}.pay_{exp}_{linkId}_{sig}`.
  - Core: `PublicSession.destinationLocked` and the error code `DESTINATION_LOCKED`.
  - Client and web: with a locked target, the withdraw flow skips the target screen and the tabs, gets the plan with `/plan`, and shows the locked address read only.
  - MCP: a bound payout creates the session with the target set and locked, and then plans, quotes and starts it (no `/target` call). The operations from `createRampOps` have `revokePayLink(sessionId)`.

- 8a2ec99: Compare routes in demos: the mock adapter gets `id`, `feeBps`, `spreadBps`, `eta`, `methods`, `countries`, `cardCheckout: 'form'` (test card fields in the widget) and `exchange` (the new `exchange_transfer` method). Several mock instances can now run side by side. Core adds the `exchange_transfer` method ("From an exchange", a deposit address like `transfer`) and `isAddressTransfer()`. The widget treats it like `transfer` and names exchanges as examples. Selects in the widget have one chevron, centred, in every browser. The server reads request bodies in browsers without `Request.body` (Firefox).
- f4a89d0: Security: `POST /sessions/:id/quotes` now returns `PublicQuote[]`. Each leg has no adapter `data`, so provider URLs (for example the Coinbase onramp URL), request bodies and idempotency nonces stay on the server. New types: `PublicQuote` and `PublicLegQuote` in `@openrampkit/core`. The client, the web element and the MCP server use them. `@openrampkit/client` and `@openrampkit/web` re-export `PublicQuote` and `PublicLegQuote` in place of `Quote`. `rankQuotes` is generic. The server keeps the full `Quote` in its store for `start()`.
- bf08445: Solana and Tempo support.

  - New package `@openrampkit/solana`: a `WalletAdapter` for Solana wallets (Wallet Standard and `@solana/kit`). It signs Relay's Solana transactions (instructions and address lookup tables), serialized transactions, and SOL and SPL transfers (it creates the recipient token account when it is missing).
  - core: Solana devnet, Tempo (4217) and Tempo testnet (42431) metadata; USDC on Solana and Tempo; `normalizeToken` keeps the case of Solana mints; SPL amount helpers; `SolanaTxRequest` in `TxRequest`; `combineWallets` joins an EVM and a Solana wallet.
  - Relay: Solana as origin (wallet pay) and destination (wallet, deposit address, bridge hop), placeholder `user` per VM, and on-chain checks of same-chain Solana moves (`getSignatureStatuses`, `getTransaction`). One signature completes one payment only. Default RPCs for Solana and Tempo.
  - Mock: Solana destinations, Solana transfers and base58 test deposit addresses.
  - Client: pays with the account of the source chain when an EVM and a Solana wallet are both connected.
  - Server: Solana mints keep their case in sessions.
  - wagmi: no native balance on Tempo (fees are paid in stablecoins); refuses Solana transactions.

### Patch Changes

- 5997e23: Refunds and chargebacks after success. A provider event `refunded` for a leg that succeeded, or the new leg status `reversed` (a chargeback or a returned payout), no longer gets lost. The server keeps the leg with its new status, adds it to the timeline, sets the new step state `REVERSED` (error `PAYMENT_REVERSED`) and the new session status `reversed`, and sends the new `session.reversed` webhook once, with a deterministic event id (and `withdrawal.reversed` for a withdrawal). The event data has `index`, `adapterId`, `legId`, `legStatus` and `previous`. Take back or freeze the credit when you get it. A `REVERSED` session refuses `restart`, and a completed or reversed session refuses a new `select`.

  Core: new `StateName` `REVERSED` (`COMPLETED` can move to it), `LegStatus` `reversed`, `SessionStatus` `reversed`, event types `session.reversed` and `withdrawal.reversed`, and error code `PAYMENT_REVERSED`. Code that switches on these unions must handle the new members. The modal shows "Payment reversed" (in every built-in language), and the admin page has a filter, a stats card and a detail row for reversed sessions.

- c24a0f7: Security hardening: body size limits (413), input checks on sessions and browser routes, idempotency keys scoped per route, session deadline enforced on quote, select and restart, surface URL checks (no `javascript:` or `data:` URLs) on the server, client and web component, a single treasury send under concurrent requests, a block time check for Relay same-chain payments, minimum lengths for `webhooks.secret` and `tasksToken`, empty webhook keys refused by Stripe and Swapped, and the mock adapter refuses live sessions. New in core: `isWebUrl` and `isSafeLinkUrl`.
- 5c5019e: `Step.sub` is now a closed list of lowercase values: `StepSub`, with `STEP_SUBS` and `isStepSub` in `@openrampkit/core`. Before, it mixed case and raw provider strings (`CONFIRMING`, `confirming`, Relay and LI.FI statuses), and the web UI title-cased them. Adapters now map provider statuses to the list (for example LI.FI `WAIT_DESTINATION_TRANSACTION` is `bridging`, Relay `waiting` is `waiting_for_deposit`) and put the raw value in the new `LegStep.providerStatus`. The server writes it to the timeline (`leg.provider_status`), never to the browser, and drops a `sub` that is not in the list. The web element shows `messages.stepSub[sub]`, translated in every catalog (en, vi, id, th, ms, fil).
- Updated dependencies [25b1f98]
- Updated dependencies [9a88cec]
- Updated dependencies [51167ad]
- Updated dependencies [77f762d]
- Updated dependencies [230c5ad]
- Updated dependencies [3453854]
- Updated dependencies [9c135aa]
- Updated dependencies [7512a8e]
- Updated dependencies [8d66ab9]
- Updated dependencies [e2e8337]
- Updated dependencies [6e7899b]
- Updated dependencies [127b79a]
- Updated dependencies [8a2ec99]
- Updated dependencies [f4a89d0]
- Updated dependencies [fb978b8]
- Updated dependencies [5997e23]
- Updated dependencies [c24a0f7]
- Updated dependencies [63f3db5]
- Updated dependencies [bf08445]
- Updated dependencies [3b8e567]
- Updated dependencies [5c5019e]
  - @openrampkit/core@0.1.0
