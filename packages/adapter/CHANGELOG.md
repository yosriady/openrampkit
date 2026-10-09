# @openrampkit/adapter

## 0.1.0

### Minor Changes

- 138dc35: One `env: 'sandbox' | 'production'` option for every adapter, checked against `livemode`. Each adapter now shows its environment as the read-only `adapter.env` (new `AdapterEnv` type). Transak takes `env: 'sandbox'` (was `'staging'`), Peer takes `env: 'production'` (was `'live'`), and Coinbase takes `env` (was `sandbox: boolean`). The old values still work, with a one-time deprecation warning. Stripe and Xendit read `env` from the key prefix, take an optional `env`, and throw when the two do not agree. Binance and LI.FI are always `production`. Relay is `sandbox` on the testnets host, and the mock adapter is `sandbox`. `createOpenRamp` now refuses to start with `livemode: true` and a `sandbox` adapter, and warns for a `production` adapter when `livemode` is false. New helpers: `resolveEnv` and `warnDeprecatedOnce`.
- 901ea9a: New `claimOnce(shared, key, owner, ttlSec)` in `@openrampkit/adapter`: it records a transaction, log or deposit as used by one owner. `ScopedKV` has a new optional `putIfAbsent(key, value, ttlSec)`. The server gives it to adapters when the store has an atomic operation: `memoryStore`, `redisStore` (`SET NX EX` in a Lua script) and `durableObjectStore` have one, `cloudflareKvStore` does not. The Relay, LI.FI, Bridge and mock adapters now use `claimOnce`. On a store with `putIfAbsent`, two requests at the same time can no longer both take the same transaction. The stored keys and values do not change.
- 9a88cec: **Breaking.** Adapter contract v2: `ADAPTER_API_VERSION` is 2, and `createAdapter` refuses an adapter built for another version with a message that says what changed.

  - `LegEvent` is a `LegStep` with a `ref` (and an optional `eventId`), so a webhook can carry an action, a phase (for example a KYC review) or transactions. `legStepFromEvent()` keeps the event and adds a poll; `awaitingPayment()` is the step while the user pays.
  - New helpers: `quoteExpiresAt()`, `statusMap()` (an unknown provider status gives `undefined` and one log, never a default), `verifyTimestampedHmac()` and `parseSignatureHeader()` (the `t=,v1=` webhook pattern), and `cachedJson()`.
  - The conformance kit checks the v2 step rules, the quote output asset, a future `expiresAt`, fee assets, the guarantee fields, declared capabilities against implemented methods, and (option `errorPaths`) the codes and `retryable` values of HTTP 400, 401, 429, 500 and timeout. `LEG_STATUSES` is exported.

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

- 51167ad: **Breaking.** The renames of the 0.1 data model reach the adapter contract: `LegStep.status` and `LegEvent.status` use `requires_action` (was `awaiting_user`), every `Amount` is `{ value, asset }`, and errors are `OpenRampException` and `openRampError()`. New optional `Adapter.cancel({ leg, ref }, ctx)`: the server calls it to void a provider order when a session is canceled. `ADAPTER_API_VERSION` does not change in this release.

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
- 521c893: Add EVM helpers to `@openrampkit/adapter` (`evmRpc`, `erc20PaidTo`, `erc20TransferData`, `topicAddress`, `ERC20_TRANSFER_TOPIC`). The Relay adapter uses them for its on-chain checks.

  Add the test-only `localChain` option to the mock adapter. It adds an `onchain` leg that pays with a real ERC-20 transfer on a local chain (for example Anvil) and checks the receipt over JSON-RPC.

- 0672f15: No silent fallback to the wrong asset. When the destination token is not one that the provider delivers, the onramp adapters (Binance, Coinbase, Meld, MoonPay, Onramper, Stripe, Swapped, Transak) now fail the quote with `NO_QUOTES`, and do not call the provider. Before, they quoted the first deliver asset (often USDC on Base). Bridge now checks the token too, not only the chain. New helpers in `@openrampkit/adapter`: `findDeliverAsset` (returns `undefined` on no match), `requireDeliverAsset` and `deliverableToAsset`.
- 635d8f9: A 401 or 403 from a provider is now a setup error. `httpErrorToOpenRamp` returns `PROVIDER_UNAVAILABLE` with `retryable: false`, recovery `choose_other` and the message "{Provider} is not set up for this app yet. Try another method." It writes one error log for the operator that names the provider. Before, it was retryable with only a warning. New: `providerSetupError(provider)` and the `setupHint` option. Relay keeps its `UNAUTHORIZED_QUOTE` hint in the operator log, and the user message is now neutral. Xendit maps 401 and 403 about the key to the setup error, not to `PROVIDER_DECLINED`. Every adapter that uses `httpErrorToOpenRamp` gets the new mapping.
- e74d5e3: New `minWithToleranceBps(expectedBase, bps)` in `@openrampkit/adapter`: the smallest amount that still counts as an expected amount with a tolerance in basis points (bigint math). The Relay adapter uses it, and its source is now split into modules (options, API client, quotes, deposit addresses, direct transfers, wallet). Its behavior and its exports do not change.
- a999c0c: Settlement contract fix: `settleFromBalance` now needs a `BalanceSettlementIntent` that binds the exact amount. Before, its intent bound only a minimum amount, so a caller with a valid intent could take other funds that the contract held. New: `settlementBalanceIntentTypedData` and `SETTLEMENT_BALANCE_INTENT_TYPES`. `encodeSettle(..., { fromBalance: true })` throws when the intent `minAmount` is not equal to `amount`. The ABI has the new `BALANCE_INTENT_TYPEHASH`, `balanceIntentDigest` and `AmountMismatch`. `settle` and its intent did not change. The deployed testnet contracts predate this fix and need a redeploy before any flow uses `settleFromBalance`.
- 63f3db5: Add on-chain settlement through the `OpenRampSettlement` contract (`contracts/`).

  - core: `destination.settlement` (`{ contract }`), the `settlement` leg capability, and chain data for Arbitrum Sepolia, Robinhood Chain and Robinhood Chain Testnet. USDC on Arbitrum Sepolia.
  - adapter: `OPEN_RAMP_SETTLEMENT_ABI`, `buildSettlementTxs`, `encodeSettle`, `settlementIntentTypedData`, `hashSettlementCalls`, `sessionIdToBytes32`, `verifySettlement` and `keccak256`.
  - relay: the `wallet` leg pays into the settlement contract (approve and settle) and verifies by session id. New options `signSettlementIntent` and `settlementIntentTtlSec`.
  - server: `destination.calls` is supported with `destination.settlement`.

- d4523b2: New helpers in `@openrampkit/adapter`: `rsaVerify(publicKey, data, signatureB64)` (RSASSA-PKCS1-v1_5 with SHA-256; the key as PEM, base64 or `CryptoKey`), `importRsaPublicKey`, `rsaKeyDer`, `bytesToHex`, `base64ToBytes` and `bytesToBase64`. The Binance and Bridge adapters use the shared RSA check, and Onramper uses the shared hex and base64 helpers. Binance keeps its request signing. `importBridgePublicKey` now gives a clear error for a PKCS#1 PEM (`RSA PUBLIC KEY`); it still refuses such a key.
- 609b907: Replay protection for provider webhooks that have no timestamp. `Adapter.webhook` has a new optional `replayKey(req, rawBody, ctx)`. After `verify`, the server claims the key for 7 days in the adapter's shared store with the new `claimWebhook` (built on `claimOnce`). A repeat gets `200` with `{ "received": true, "duplicate": true }`, changes nothing, and adds 1 to the new `webhook.replayed` metric. When the server cannot apply the events yet (`503`), it gives the key back with `releaseWebhook`, so the provider's retry still applies. New helpers: `webhookBodyKey(rawBody)` (SHA-256 of the body), `claimWebhook`, `releaseWebhook` and `WEBHOOK_REPLAY_TTL_SEC`. The Onramper, Swapped and Xendit adapters now give the body hash as the replay key and as the `eventId` of their events.

### Patch Changes

- e2e8337: One constant-time string compare: `timingSafeEqual(a, b)` is now in `@openrampkit/core`. `@openrampkit/adapter` exports the same function, and the server and the MCP HTTP handler use it. The result does not change.
- 5997e23: Refunds and chargebacks after success. A provider event `refunded` for a leg that succeeded, or the new leg status `reversed` (a chargeback or a returned payout), no longer gets lost. The server keeps the leg with its new status, adds it to the timeline, sets the new step state `REVERSED` (error `PAYMENT_REVERSED`) and the new session status `reversed`, and sends the new `session.reversed` webhook once, with a deterministic event id (and `withdrawal.reversed` for a withdrawal). The event data has `index`, `adapterId`, `legId`, `legStatus` and `previous`. Take back or freeze the credit when you get it. A `REVERSED` session refuses `restart`, and a completed or reversed session refuses a new `select`.

  Core: new `StateName` `REVERSED` (`COMPLETED` can move to it), `LegStatus` `reversed`, `SessionStatus` `reversed`, event types `session.reversed` and `withdrawal.reversed`, and error code `PAYMENT_REVERSED`. Code that switches on these unions must handle the new members. The modal shows "Payment reversed" (in every built-in language), and the admin page has a filter, a stats card and a detail row for reversed sessions.

- 3b8e567: The session now shows the transaction that paid into each leg, next to the fill:

  - New optional field `LegStep.sourceTxHash` (and `LegEvent.sourceTxHash`): the transaction that paid into the leg, for example the origin chain transaction that the user's wallet sent with `submit_tx`. The server keeps the last value when a later step leaves it out.
  - `step.progress.legs[].sourceTxHash` and `result.sourceTxHashes` show it. `result.sourceTxHashes` is absent when no leg reports one. `result.txHashes` does not change: for a bridge or swap it is the fill on the destination chain.
  - Relay: the `wallet` leg reports the origin transaction (`submit_tx`, else Relay's `inTxHashes`) as `sourceTxHash`. Before, a completed session showed only the fill. The `transfer` and `bridge` legs report the transfer into the deposit address. Same-chain transfers report the same hash in both fields.
  - LI.FI: the `wallet` leg reports the source transaction as `sourceTxHash`.
  - The admin session detail has `sourceTxHashes`, and the MCP `get_session_status` tool has `source_tx_hashes`.

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
