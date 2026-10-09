# @openrampkit/core

## 0.1.0

### Minor Changes

- 25b1f98: Coinbase: a new `coinbase_account` leg lets the user pay from the fiat or crypto balance of a Coinbase account (`FIAT_WALLET` or `CRYPTO_WALLET`, option `accountBalance`). A new `guest_apple_pay` leg (option `guestCheckout`) gives guest Apple Pay in the US with the Headless Onramp API: an order quote, a payment link in an `IFRAME`, order status and order webhooks. Core: new method code `coinbase_account` (kind `exchange`) and an optional `referrerPolicy` on the `IFRAME` surface. Web: the provider frame uses that referrer policy.
- 9a88cec: **Breaking.** The adapter contract v2 types (phase 2 of the 0.1 data model).

  - `LegStep` has one state field, `status`, and an `action` when the user must act. `stateFor()` is the one rule from a leg step to `Step.state`.
  - `Step.detail { code, providerStatus }` with the closed list `STEP_DETAIL_CODES`.
  - `Transaction` records with a role (`approval`, `source`, `hop`, `destination`, `settlement`, `refund`) in `SessionResult.transactions` and `PublicSession.payment.legs[].transactions`. `explorerTxUrl()` builds a block explorer link from the chain table (now with Etherscan, Basescan, Arbiscan, Optimism, Polygonscan and BscScan).
  - `PublicSession.payment` (`Payment`, `PaymentLeg`) with the provider, our `ref` and the provider's `providerRef`.
  - Quotes: `guarantee` (`firm`, `min_output`, `estimate`), `minOutput`, `slippageBps`, and a required `expiresAt`.
  - `Fee { kind, label, amount: Amount | null, included }`. `FeeKind` adds `bridge`.
  - `SessionResult.delivery` replaces `amountMismatch`.

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

- 51167ad: **Breaking.** The 0.1 data model (phase 1).

  - New names: `OpenRampError`, `OpenRampErrorCode` (a closed union, with `PROVIDER_ERROR`, `CANCELED`, `IDEMPOTENCY_MISMATCH`, `EXTERNAL_ID_CONFLICT` and `CLOSED`), `OpenRampException`, `openRampError()`, `isOpenRampError()`. `Amount` is `{ value, asset }`.
  - `SessionStatus` uses the Stripe names: `requires_payment_method`, `requires_action`, `processing`, `succeeded`, `failed`, `canceled`, `expired`, `refunded`, `reversed`. `isFinalStatus()` and `FINAL_SESSION_STATUSES`. `PublicSession` has `lastError` and `canceled`. `StateName` has `CANCELED`.
  - Typed events: `WebhookEvent` (a union on `type`, with `object`, `apiVersion: 1`, an ISO `createdAt` and the backend `Session` in `data.object.session`), `ClientEvent` for the browser UI, `createWebhookEvent()` and `createClientEvent()`. `OrkEvent`, `OrkEventType` and `createEvent()` are removed.
  - `AllowedDestinations` and `WithdrawDestination` (were `AllowedTargets` and `WithdrawTarget`).

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
- 9c135aa: Leg capabilities now hold only what the server reads: `LegCapability` is `'settlement' | 'surface_after_processing'`. The values `webhooks`, `polling`, `refunds`, `exact_output` and `saved_methods` are removed: nothing read them, and adapters declared them in different ways. How the server learns a leg result now comes from the adapter: `resultChannels(adapter)` in `@openrampkit/adapter` gives `polling` (the adapter has `status()`) and `webhooks` (it has a `webhook` whose new `configured` flag is not `false`). Binance, Bridge, Coinbase, Meld, MoonPay and Onramper set `configured` from their webhook secret. The server writes a warning at start for an adapter with legs that has neither. `checkAdapterShape` reports an unknown capability.
- 7512a8e: Provider events now move a leg only forward. Core has `LEG_STATUS_RANK` and `isLegalLegMove(from, to)`. Status checks and browser transitions also move a leg only forward (one exception: a `processing` review step in `KYC` or `AUTH` can end with an `requires_action` step before any transaction); a backward poll is ignored and a backward transition answers `409`. A session with a completed or reversed payment refuses plan, quotes, target, select and transitions from the browser with `409`. The server ignores a provider event that would move a leg back (for example `pending` after `processing`), logs it, adds 1 to the new `event.out_of_order` metric, and answers the provider with `200`. One move back is allowed only when the leg opts in with the new `LegSpec` capability `surface_after_processing`: from `processing` to `requires_action` with a new surface of a kind in the spec's `surfaces`, before the leg has a transaction, once per leg. `LegEvent` has a new optional `eventId`. The server keeps the last 50 applied ids per session and ignores an event with an id that it already applied.
- 8d66ab9: Locked withdraw targets and pay link revocation.

  - Server: `CreateSessionInput` has `target` and `lockDestination` for withdraw sessions. The server checks the target at creation (format, `allowedDestinations`, `screenAddress`) and stores it as the destination. With `lockDestination: true`, `POST /sessions/:id/target` answers `409 DESTINATION_LOCKED`, for the client secret and for a pay link. A cash target (`{ type: 'fiat', currency }`) can also be locked.
  - Server: pay links have an `id`. `openramp.sessions.revokePayLink(sessionId, linkId)` and `POST /sessions/:id/pay-link/revoke` make one link stop working. The credential format is now `{sessionId}.pay_{exp}_{linkId}_{sig}`.
  - Core: `PublicSession.destinationLocked` and the error code `DESTINATION_LOCKED`.
  - Client and web: with a locked target, the withdraw flow skips the target screen and the tabs, gets the plan with `/plan`, and shows the locked address read only.
  - MCP: a bound payout creates the session with the target set and locked, and then plans, quotes and starts it (no `/target` call). The operations from `createRampOps` have `revokePayLink(sessionId)`.

- e2e8337: One constant-time string compare: `timingSafeEqual(a, b)` is now in `@openrampkit/core`. `@openrampkit/adapter` exports the same function, and the server and the MCP HTTP handler use it. The result does not change.
- 127b79a: The server now compares each leg's reported output with the leg's quote. When a provider reports less than the quote by more than the new `policy.outputToleranceBps` (default 100, that is 1%), the leg keeps its result, but the session result gets the new `amountMismatch` field (`reason`, `legIndex`, `expected`, `received`, `shortfall`), so every webhook shows it. The check fails closed: an output in another asset (`asset_mismatch`) or with an amount that is not a number (`invalid_amount`) is flagged too, is not a confirmed output, and on a leg before the last it stops the pathway (`FAILED`, `DELIVERY_FAILED`) instead of starting the next leg. The server also adds a `leg.amount_mismatch` timeline entry, logs a warning and reports the `leg.amount_mismatch` metric. The admin page shows the shortfall on the leg. Core has the new `AmountMismatch` type.
- 8a2ec99: Compare routes in demos: the mock adapter gets `id`, `feeBps`, `spreadBps`, `eta`, `methods`, `countries`, `cardCheckout: 'form'` (test card fields in the widget) and `exchange` (the new `exchange_transfer` method). Several mock instances can now run side by side. Core adds the `exchange_transfer` method ("From an exchange", a deposit address like `transfer`) and `isAddressTransfer()`. The widget treats it like `transfer` and names exchanges as examples. Selects in the widget have one chevron, centred, in every browser. The server reads request bodies in browsers without `Request.body` (Firefox).
- f4a89d0: Security: `POST /sessions/:id/quotes` now returns `PublicQuote[]`. Each leg has no adapter `data`, so provider URLs (for example the Coinbase onramp URL), request bodies and idempotency nonces stay on the server. New types: `PublicQuote` and `PublicLegQuote` in `@openrampkit/core`. The client, the web element and the MCP server use them. `@openrampkit/client` and `@openrampkit/web` re-export `PublicQuote` and `PublicLegQuote` in place of `Quote`. `rankQuotes` is generic. The server keeps the full `Quote` in its store for `start()`.
- fb978b8: Reliable webhooks and sweeps.

  - Server: the webhook outbox and the open-session list are now store queues with atomic add, claim (with a lease) and claim-checked remove. A session or an event that is added while a sweep runs is no longer lost. The sweep takes the entries that waited longest (round robin), and two sweeps at the same time do not take the same entry. `SessionStore` has a new optional `queue`; all built-in stores implement it, and a custom store without it gets a fallback on the version check of `put`. The first sweep moves entries from the old KV array lists.
  - Server: webhook events are saved in the session record in the same versioned write as the change, and sent only after that write succeeds. Event ids are deterministic (a hash of the session id and the event), so a retry after a `409` conflict or a failed delivery has the same id. Deduplicate by event id.
  - Server: failed webhooks are retried for about 24 hours (`webhooks.retryHours`, backoff up to 2 hours). Then they stay in the session as dead letters, and `openramp.webhooks.replay(sessionId)` sends them again. `webhooks.maxAttempts` no longer has a default.
  - Server: `restart` keeps the left payment as an earlier attempt. A late provider event for it still applies: the session completes with it, or the server sends the new `session.late_payment` event when another payment is in progress or complete. The sweep keeps polling such sessions.
  - Server: `POST /webhooks/:adapterId` answers `503` (with `retry-after`) when an event could not be applied (unknown ref, or the session kept changing), so the provider sends it again. A verified event that is safe to ignore still gets `200`.
  - Core: `createEvent` takes an optional `id`. New event types `session.refunded` and `session.late_payment` in `OpenRampEventType`.

- 5997e23: Refunds and chargebacks after success. A provider event `refunded` for a leg that succeeded, or the new leg status `reversed` (a chargeback or a returned payout), no longer gets lost. The server keeps the leg with its new status, adds it to the timeline, sets the new step state `REVERSED` (error `PAYMENT_REVERSED`) and the new session status `reversed`, and sends the new `session.reversed` webhook once, with a deterministic event id (and `withdrawal.reversed` for a withdrawal). The event data has `index`, `adapterId`, `legId`, `legStatus` and `previous`. Take back or freeze the credit when you get it. A `REVERSED` session refuses `restart`, and a completed or reversed session refuses a new `select`.

  Core: new `StateName` `REVERSED` (`COMPLETED` can move to it), `LegStatus` `reversed`, `SessionStatus` `reversed`, event types `session.reversed` and `withdrawal.reversed`, and error code `PAYMENT_REVERSED`. Code that switches on these unions must handle the new members. The modal shows "Payment reversed" (in every built-in language), and the admin page has a filter, a stats card and a detail row for reversed sessions.

- 63f3db5: Add on-chain settlement through the `OpenRampSettlement` contract (`contracts/`).

  - core: `destination.settlement` (`{ contract }`), the `settlement` leg capability, and chain data for Arbitrum Sepolia, Robinhood Chain and Robinhood Chain Testnet. USDC on Arbitrum Sepolia.
  - adapter: `OPEN_RAMP_SETTLEMENT_ABI`, `buildSettlementTxs`, `encodeSettle`, `settlementIntentTypedData`, `hashSettlementCalls`, `sessionIdToBytes32`, `verifySettlement` and `keccak256`.
  - relay: the `wallet` leg pays into the settlement contract (approve and settle) and verifies by session id. New options `signSettlementIntent` and `settlementIntentTtlSec`.
  - server: `destination.calls` is supported with `destination.settlement`.

- bf08445: Solana and Tempo support.

  - New package `@openrampkit/solana`: a `WalletAdapter` for Solana wallets (Wallet Standard and `@solana/kit`). It signs Relay's Solana transactions (instructions and address lookup tables), serialized transactions, and SOL and SPL transfers (it creates the recipient token account when it is missing).
  - core: Solana devnet, Tempo (4217) and Tempo testnet (42431) metadata; USDC on Solana and Tempo; `normalizeToken` keeps the case of Solana mints; SPL amount helpers; `SolanaTxRequest` in `TxRequest`; `combineWallets` joins an EVM and a Solana wallet.
  - Relay: Solana as origin (wallet pay) and destination (wallet, deposit address, bridge hop), placeholder `user` per VM, and on-chain checks of same-chain Solana moves (`getSignatureStatuses`, `getTransaction`). One signature completes one payment only. Default RPCs for Solana and Tempo.
  - Mock: Solana destinations, Solana transfers and base58 test deposit addresses.
  - Client: pays with the account of the source chain when an EVM and a Solana wallet are both connected.
  - Server: Solana mints keep their case in sessions.
  - wagmi: no native balance on Tempo (fees are paid in stablecoins); refuses Solana transactions.

- 5c5019e: `Step.sub` is now a closed list of lowercase values: `StepSub`, with `STEP_SUBS` and `isStepSub` in `@openrampkit/core`. Before, it mixed case and raw provider strings (`CONFIRMING`, `confirming`, Relay and LI.FI statuses), and the web UI title-cased them. Adapters now map provider statuses to the list (for example LI.FI `WAIT_DESTINATION_TRANSACTION` is `bridging`, Relay `waiting` is `waiting_for_deposit`) and put the raw value in the new `LegStep.providerStatus`. The server writes it to the timeline (`leg.provider_status`), never to the browser, and drops a `sub` that is not in the list. The web element shows `messages.stepSub[sub]`, translated in every catalog (en, vi, id, th, ms, fil).

### Patch Changes

- 3453854: Late payments after expiry. When the sweep expires a session whose payment still waits for the user (for example a bank transfer or a deposit address), it now keeps the session on a grace list and polls the payment at a slower rate: the new `latePayments` option, `{ graceHours: 72, pollMinutes: 10 }` by default (`graceHours: 0` turns it off). When the payment arrives inside the grace window (by this poll or by a provider webhook for the leg that waited at expiry), the session moves on from `EXPIRED` and completes, and the server sends `session.late_payment` with `reason: 'after_expiry'`, then `session.succeeded`. After the window, the session stays `EXPIRED` and the server sends `session.late_payment` with `reason: 'after_grace'`. A failure event, an event for an earlier attempt, or a browser request never changes an expired session. `session.late_payment` for an earlier attempt now has `reason: 'earlier_attempt'`. `SweepResult.sessions` has a new `grace` count. In the core table, `EXPIRED` can now move to `PROCESSING` or `COMPLETED`.
- 6e7899b: Onramper: a `401` or `403` (for example `errorId 4011` "No V2 signing key is registered for this API key") is now a setup error: `PROVIDER_UNAVAILABLE` with `retryable: false` and recovery `choose_other`. The user sees a neutral message, and the operator gets an error log that says what to do (register the Ed25519 public key, check the signature, the API key or the IP allowlist). An onramp quote with no fee fields (for example guardarian) now gets a fee line "included in rate": for USD to a USD stablecoin it is the input minus the payout, else the amount is `0` with the new `Fee.inRate` flag. The web quote row does not show "No fees" for such a quote, and the MCP quote view says "amount not given".
- c24a0f7: Security hardening: body size limits (413), input checks on sessions and browser routes, idempotency keys scoped per route, session deadline enforced on quote, select and restart, surface URL checks (no `javascript:` or `data:` URLs) on the server, client and web component, a single treasury send under concurrent requests, a block time check for Relay same-chain payments, minimum lengths for `webhooks.secret` and `tasksToken`, empty webhook keys refused by Stripe and Swapped, and the mock adapter refuses live sessions. New in core: `isWebUrl` and `isSafeLinkUrl`.
- 3b8e567: The session now shows the transaction that paid into each leg, next to the fill:

  - New optional field `LegStep.sourceTxHash` (and `LegEvent.sourceTxHash`): the transaction that paid into the leg, for example the origin chain transaction that the user's wallet sent with `submit_tx`. The server keeps the last value when a later step leaves it out.
  - `step.progress.legs[].sourceTxHash` and `result.sourceTxHashes` show it. `result.sourceTxHashes` is absent when no leg reports one. `result.txHashes` does not change: for a bridge or swap it is the fill on the destination chain.
  - Relay: the `wallet` leg reports the origin transaction (`submit_tx`, else Relay's `inTxHashes`) as `sourceTxHash`. Before, a completed session showed only the fill. The `transfer` and `bridge` legs report the transfer into the deposit address. Same-chain transfers report the same hash in both fields.
  - LI.FI: the `wallet` leg reports the source transaction as `sourceTxHash`.
  - The admin session detail has `sourceTxHashes`, and the MCP `get_session_status` tool has `source_tx_hashes`.
