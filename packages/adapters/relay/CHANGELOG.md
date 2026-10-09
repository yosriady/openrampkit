# @openrampkit/adapter-relay

## 0.1.0

### Minor Changes

- 138dc35: One `env: 'sandbox' | 'production'` option for every adapter, checked against `livemode`. Each adapter now shows its environment as the read-only `adapter.env` (new `AdapterEnv` type). Transak takes `env: 'sandbox'` (was `'staging'`), Peer takes `env: 'production'` (was `'live'`), and Coinbase takes `env` (was `sandbox: boolean`). The old values still work, with a one-time deprecation warning. Stripe and Xendit read `env` from the key prefix, take an optional `env`, and throw when the two do not agree. Binance and LI.FI are always `production`. Relay is `sandbox` on the testnets host, and the mock adapter is `sandbox`. `createOpenRamp` now refuses to start with `livemode: true` and a `sandbox` adapter, and warns for a `production` adapter when `livemode` is false. New helpers: `resolveEnv` and `warnDeprecatedOnce`.
- 9a88cec: **Breaking.** The adapter uses the adapter contract v2 (`ADAPTER_API_VERSION` 2): steps with `status` and `action`, `detail`, and `transactions` with roles. Wallet quotes are `min_output` with Relay `minimumAmount` and the configured `slippageBps`; deposit-address legs are `estimate`; same-chain direct legs are `firm`. Gas is charged on top. `providerRef` is the Relay request id. A `statusMap` maps the intent statuses (with `depositing`); a refund reports its transaction with role `refund`.

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
- 3e3a347: One deposit now completes one session only.

  - Same-chain `transfer` legs (EVM): one `Transfer` log must pay at least the expected amount minus a tolerance (`amountToleranceBps`, default 50). The adapter does not add small transfers together. It records each log as used by (chain, tx hash, log index), so a log never completes a second session or a same-chain wallet payment. It reads logs in pages of `logBlockRange` blocks (default 2000) and goes on from the last page at the next check.
  - When two open sessions on the same address could both claim a deposit, neither session takes it. The leg stays in its waiting state with sub-state `ambiguous_deposit`, and the adapter logs a warning.
  - Deposit-address legs: each session gets its own Relay deposit address. The address is no longer shared across sessions for 24 hours. Status binds one Relay request to one session, by deposit tx hash, and checks the deposit amount when the user gave one.
  - Deposit legs use the ref `dep:<sessionId>:<address>`, so one ref maps to one session.
  - New option `slippageBps` sends Relay `slippageTolerance`. Quote data has `minOutput` (Relay `minimumAmount`).
  - Without `apiKey`, the warning about the retirement of `GET /requests/v2` (2026-11-24) now shows on the first adapter call.

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

### Patch Changes

- 901ea9a: New `claimOnce(shared, key, owner, ttlSec)` in `@openrampkit/adapter`: it records a transaction, log or deposit as used by one owner. `ScopedKV` has a new optional `putIfAbsent(key, value, ttlSec)`. The server gives it to adapters when the store has an atomic operation: `memoryStore`, `redisStore` (`SET NX EX` in a Lua script) and `durableObjectStore` have one, `cloudflareKvStore` does not. The Relay, LI.FI, Bridge and mock adapters now use `claimOnce`. On a store with `putIfAbsent`, two requests at the same time can no longer both take the same transaction. The stored keys and values do not change.
- 9c135aa: Leg capabilities now hold only what the server reads: `LegCapability` is `'settlement' | 'surface_after_processing'`. The values `webhooks`, `polling`, `refunds`, `exact_output` and `saved_methods` are removed: nothing read them, and adapters declared them in different ways. How the server learns a leg result now comes from the adapter: `resultChannels(adapter)` in `@openrampkit/adapter` gives `polling` (the adapter has `status()`) and `webhooks` (it has a `webhook` whose new `configured` flag is not `false`). Binance, Bridge, Coinbase, Meld, MoonPay and Onramper set `configured` from their webhook secret. The server writes a warning at start for an adapter with legs that has neither. `checkAdapterShape` reports an unknown capability.
- 521c893: Add EVM helpers to `@openrampkit/adapter` (`evmRpc`, `erc20PaidTo`, `erc20TransferData`, `topicAddress`, `ERC20_TRANSFER_TOPIC`). The Relay adapter uses them for its on-chain checks.

  Add the test-only `localChain` option to the mock adapter. It adds an `onchain` leg that pays with a real ERC-20 transfer on a local chain (for example Anvil) and checks the receipt over JSON-RPC.

- 635d8f9: A 401 or 403 from a provider is now a setup error. `httpErrorToOpenRamp` returns `PROVIDER_UNAVAILABLE` with `retryable: false`, recovery `choose_other` and the message "{Provider} is not set up for this app yet. Try another method." It writes one error log for the operator that names the provider. Before, it was retryable with only a warning. New: `providerSetupError(provider)` and the `setupHint` option. Relay keeps its `UNAUTHORIZED_QUOTE` hint in the operator log, and the user message is now neutral. Xendit maps 401 and 403 about the key to the setup error, not to `PROVIDER_DECLINED`. Every adapter that uses `httpErrorToOpenRamp` gets the new mapping.
- dc94194: The no-key warning now follows Relay's announced policy: Relay requires an API key for quotes from 2026-10-02. Some keyless requests may still work today, but Relay can refuse them at any time, so always set `RELAY_API_KEY`. The `401 UNAUTHORIZED_QUOTE` mapping does not change.
- e74d5e3: New `minWithToleranceBps(expectedBase, bps)` in `@openrampkit/adapter`: the smallest amount that still counts as an expected amount with a tolerance in basis points (bigint math). The Relay adapter uses it, and its source is now split into modules (options, API client, quotes, deposit addresses, direct transfers, wallet). Its behavior and its exports do not change.
- 2d1cbb3: Relay requires an API key for quotes (`POST /quote/v2`) under its announced policy from 2026-10-02. Some keyless requests may still work today, but Relay can refuse them at any time. The no-key warning now says this, tells you to always set `RELAY_API_KEY`, and says that `GET /requests/v2` retires on 2026-11-24. A 401 with `errorCode` `UNAUTHORIZED_QUOTE` now maps to `PROVIDER_UNAVAILABLE` (not retryable) with a message that names `RELAY_API_KEY`, and the adapter logs a warning.
- 0d2a702: Solana transfer to the destination itself now follows the same rules as EVM `Transfer` logs. Behavior change: the adapter no longer adds signatures together. One signature must pay at least the expected amount minus the tolerance on its own, so small transfers and transfers by other people to a shared address no longer complete a session. When another open leg on the same address could also claim the signature, no leg takes it, and the leg shows the sub-state `ambiguous_deposit`. Without an amount up front, a signature completes the leg only when no other open leg could claim it. The chosen signature is claimed with `claimOnce`: on a store with `putIfAbsent`, two sessions that check at the same time can no longer both take it. A finished Solana leg now removes its watch. The stored keys (`txused:<chain>:<signature>`), values and TTL do not change.
- 148ceb7: Relay `wallet` leg: a completed leg now reports the delivered `output`. Relay's intent status has no amount, so on `success` the adapter reads the request (`GET /requests/v3?id=`, or `/requests/v2` without a key) and takes `data.route.actual.destination.outputCurrency`, else `data.metadata.currencyOut`. The server then checks the real amount against the quote, and `result.outputConfirmed` is `true`. Before, it was `false` for every Relay wallet payment. When the lookup fails, the leg completes as before, without an output.

  An output in the same asset as the quote now has the quote's asset. Before, when the destination token was `native`, a delivery of native ETH (Relay address `0x0000...0000`) on a `transfer` or `bridge` leg gave `amountMismatch` with `asset_mismatch`.

- c24a0f7: Security hardening: body size limits (413), input checks on sessions and browser routes, idempotency keys scoped per route, session deadline enforced on quote, select and restart, surface URL checks (no `javascript:` or `data:` URLs) on the server, client and web component, a single treasury send under concurrent requests, a block time check for Relay same-chain payments, minimum lengths for `webhooks.secret` and `tasksToken`, empty webhook keys refused by Stripe and Swapped, and the mock adapter refuses live sessions. New in core: `isWebUrl` and `isSafeLinkUrl`.
- 3b8e567: The session now shows the transaction that paid into each leg, next to the fill:

  - New optional field `LegStep.sourceTxHash` (and `LegEvent.sourceTxHash`): the transaction that paid into the leg, for example the origin chain transaction that the user's wallet sent with `submit_tx`. The server keeps the last value when a later step leaves it out.
  - `step.progress.legs[].sourceTxHash` and `result.sourceTxHashes` show it. `result.sourceTxHashes` is absent when no leg reports one. `result.txHashes` does not change: for a bridge or swap it is the fill on the destination chain.
  - Relay: the `wallet` leg reports the origin transaction (`submit_tx`, else Relay's `inTxHashes`) as `sourceTxHash`. Before, a completed session showed only the fill. The `transfer` and `bridge` legs report the transfer into the deposit address. Same-chain transfers report the same hash in both fields.
  - LI.FI: the `wallet` leg reports the source transaction as `sourceTxHash`.
  - The admin session detail has `sourceTxHashes`, and the MCP `get_session_status` tool has `source_tx_hashes`.

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
