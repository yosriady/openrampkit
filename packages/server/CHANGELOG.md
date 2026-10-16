# @openrampkit/server

## 0.1.0

### Minor Changes

- 138dc35: One `env: 'sandbox' | 'production'` option for every adapter, checked against `livemode`. Each adapter now shows its environment as the read-only `adapter.env` (new `AdapterEnv` type). Transak takes `env: 'sandbox'` (was `'staging'`), Peer takes `env: 'production'` (was `'live'`), and Coinbase takes `env` (was `sandbox: boolean`). The old values still work, with a one-time deprecation warning. Stripe and Xendit read `env` from the key prefix, take an optional `env`, and throw when the two do not agree. Binance and LI.FI are always `production`. Relay is `sandbox` on the testnets host, and the mock adapter is `sandbox`. `createOpenRamp` now refuses to start with `livemode: true` and a `sandbox` adapter, and warns for a `production` adapter when `livemode` is false. New helpers: `resolveEnv` and `warnDeprecatedOnce`.
- 96c30b6: Admin and observability tools. New `admin` config: a time index of new sessions on the store queues (no lost entries when sessions are created at the same time), and `openramp.admin.list`, `get`, `findByRef`, `findByTx`, `stats`, `resolve` (a forced final state with an audit note and the matching webhook) and `replayWebhooks`. With `admin.token` (at least 32 characters, compared in constant time), the HTTP routes `/admin/*` and a self-contained ops dashboard at `GET /admin` (CSP nonce, no external scripts, token in sessionStorage only) are on. New `telemetry.onMetric(name, value, tags)` callback for quote latency, start errors, webhook verify and delivery failures, dead letters, outbox depth and sweep lag. Sessions now keep `updatedAt` and a short timeline. `StoreQueue` has an optional `range` (all built-in stores have it).
- 7df029c: Agent-ready ramps. New `@openrampkit/mcp`: a Model Context Protocol server (stdio and Streamable HTTP) with the tools `list_payment_methods`, `get_quotes`, `create_deposit_session`, `create_withdraw_session`, `get_session_status` and `wait_for_completion`, inside config guardrails (allowed destinations, caps per currency). Server: signed, expiring pay links (`GET /pay/:credential`, `POST /sessions/:id/pay-link`, `openramp.sessions.payLink(id)`) that open the modal for one session, and the `payPage` option.
- 131dc8a: Withdraw to a Cash App `$cashtag` or a Lightning address.

  - Core: a `lightning` withdraw target (`{ type: 'lightning', address, cashtag? }`), `parseLightningTarget` (strict format; invoices, LNURLs, URLs and IP addresses are refused), `sameLightningAddress`, `LIGHTNING` and `LIGHTNING_BTC`, the endpoint locations `cash_app` and `lightning_address`, and `allowedDestinations.lightning.domains`.
  - Server: `POST /sessions/:id/target` and `sessions.create` take `{ type: 'lightning', address }`. The server parses the address, checks `allowedDestinations.lightning`, and runs the new `screenLightningAddress` hook (fail closed). With `screenAddress` set and no Lightning hook, every Lightning target is refused. A deposit cannot go to a Lightning address.
  - Client and web: a "To Cash App" withdraw tab when `allowedDestinations.lightning` is set, with a `$cashtag` input, format checks, and a hint about Cash App dollars, in all six locales.
  - Flashnet: payout legs `cash_app_payout` and `lightning_payout` through `POST /v1/orchestration/offramp`, from USDC on Base, Ethereum, Arbitrum, Optimism and Polygon. The adapter builds the ERC-20 transfer, checks the answer against the quote and the session target, and binds each quote, deposit address and funding transaction to one payout.

- 9a88cec: **Breaking.** The server runs the adapter contract v2.

  - One entry check (`sanitizeLegStep`) for every adapter step and provider event, also for earlier attempts: surface URLs, detail codes, actions, phases, and transaction fields. Adapter links are dropped; `Transaction.explorerUrl` comes from the chain table only.
  - The leg keeps every transaction that it reported. Any transaction that moves funds makes a failure final and blocks cancel and restart. A provider event may end a KYC review with a step for the user, like a status poll.
  - `PublicSession.payment` replaces `Step.progress`. `result.transactions` replaces `txHashes` and `sourceTxHashes`. `result.delivery` replaces `amountMismatch`; the output check uses the quote `minOutput` when it has one. Timeline `leg.delivery` and `leg.transaction`; metric `leg.delivery_mismatch` (was `leg.amount_mismatch`).
  - The pathway quote takes the weakest leg guarantee and the earliest expiry. A leg quote without a valid expiry lives 5 minutes.
  - Admin: `transactions` and `AdminLeg.transactions`, `providerRef`, `providerStatus`, `step.detail`, `delivery`. `findByTx` finds any transaction hash of any role in any attempt. The admin page shows fees, references and transactions.
  - `SESSION_SCHEMA` is 3. `migrateRecord` moves schema 2 records: fees, guarantees and expiries of stored quotes, leg steps (action, phase, detail, transactions), and `amountMismatch` to `delivery`. Payments in flight during the upgrade finish.
  - A status poll that repeats a provider REDIRECT is no change (no new start URL, no write).

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

  - A failed attempt is not a failed session. It sends `session.payment_failed`, sets `lastError` and goes back to `requires_payment_method`. `session.failed` is final: no attempts left (`policy.maxAttempts`, default 10), money arrived on a leg, or an operator resolve. Nothing follows it.
  - New events `session.requires_action`, `session.processing`, `session.payment_failed` and `session.canceled`. The `withdrawal.*` events are removed.
  - Webhooks follow Standard Webhooks. A `whsec_` secret is base64-decoded. New `generateWebhookSecret()` and `signWebhook()`. `verifyWebhook()` reads the new headers. The payload is a typed `WebhookEvent` with the backend `Session`; `sessions.retrieve()` and `sessions.refresh()` return it too. Every response has `openramp-version: 1`.
  - `externalId` on create (unique per app; a repeat by the same user with the same input returns `{ id, expiresAt, existing: true }`, other repeats are `409 EXTERNAL_ID_CONFLICT`). `Idempotency-Key` on every POST, with a body hash (`422 IDEMPOTENCY_MISMATCH`). `POST /sessions/:id/cancel` and `sessions.cancel(id)`, only before money moved.
  - Withdraw input `destination`, `lockDestination` and `allowedDestinations`. The old names are refused with a `400`.
  - `SESSION_SCHEMA` is 2. `migrateRecord()` brings schema 1 records (old statuses, `Amount.amount`, old withdraw names) up to date on read.

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

- b770da7: History in the widget. With the server option `history: true`, the server keeps one index of sessions per user, and `GET /sessions/:id/history` lists the past sessions of the session's user (newest first, at most 50): kind (`session` or `standing`), direction, status, amount, destination asset, and the delivery transaction with its explorer link. No secret, user id, IP, provider id or address. A pay link gets `403`. `client.history()`, `controller.openHistory()` and `snapshot.history`. The widget shows a History link only when the route answers, and a list with status badges, relative dates and explorer links. New type `HistoryItem` in core.
- e868d9f: A failed attempt is final (status `failed`) when money left on that attempt: a later leg started, the treasury sent, or a transaction was submitted. Before, such a session went back to `requires_payment_method`, so a new attempt could make the treasury send a second payout.

  New `TreasuryRefusedError` (and `isTreasuryRefused`). `treasury.send` throws it to refuse when nothing was sent; the user may then try again. Any other error from the hook is read as "the funds may have left": the failure is final and an operator resolves the session (fail closed).

- 77f762d: First release on npm. All `@openrampkit/*` packages have the same version (0.1.0). The Release workflow publishes them from GitHub Actions with npm provenance. Read [Releases and versions](https://github.com/yosriady/openrampkit/blob/main/docs/guide/releases.md) for the 0.x stability rules.
- c7f849c: New adapter (experimental): Flashnet Orchestra. A `cash_app` leg and a `lightning` leg: the user pays a USD-priced Lightning invoice (from Cash App or any Lightning wallet) and gets USDC at the destination, through `POST /v1/orchestration/onramp`, with a `QR` (or `DEEPLINK`) surface. A `transfer` leg for deposits from BTC on Bitcoin and USDT on Tron through an Orchestra deposit address. Status from `GET /v1/orchestration/status`, and webhooks verified with the timestamped HMAC. The adapter checks the invoice (network, amount, expiry), binds each payment hash, deposit address, order and deposit to one leg, and accepts a completed order only for the expected asset and recipient. Payouts to Cash App are not built yet. Built from the docs; no sandbox exists; some details TO VERIFY.

  Core: Bitcoin (`BITCOIN_MAINNET`, `bip122:000000000019d6689c085ae165831e93`) and Tron (`TRON_MAINNET`, `tron:728126428`) in the chain table, and `TRON_USDT`. Server: Bitcoin and Tron address formats in `isValidAddress`, and the source picker adds a known chain outside the USDC list when an adapter lists a token on it.

- 230c5ad: First MVP release: deposit and withdraw modal, self-hosted server, pathway planner, and 12 provider adapters.
- 3453854: Late payments after expiry. When the sweep expires a session whose payment still waits for the user (for example a bank transfer or a deposit address), it now keeps the session on a grace list and polls the payment at a slower rate: the new `latePayments` option, `{ graceHours: 72, pollMinutes: 10 }` by default (`graceHours: 0` turns it off). When the payment arrives inside the grace window (by this poll or by a provider webhook for the leg that waited at expiry), the session moves on from `EXPIRED` and completes, and the server sends `session.late_payment` with `reason: 'after_expiry'`, then `session.succeeded`. After the window, the session stays `EXPIRED` and the server sends `session.late_payment` with `reason: 'after_grace'`. A failure event, an event for an earlier attempt, or a browser request never changes an expired session. `session.late_payment` for an earlier attempt now has `reason: 'earlier_attempt'`. `SweepResult.sessions` has a new `grace` count. In the core table, `EXPIRED` can now move to `PROCESSING` or `COMPLETED`.
- 9c135aa: Leg capabilities now hold only what the server reads: `LegCapability` is `'settlement' | 'surface_after_processing'`. The values `webhooks`, `polling`, `refunds`, `exact_output` and `saved_methods` are removed: nothing read them, and adapters declared them in different ways. How the server learns a leg result now comes from the adapter: `resultChannels(adapter)` in `@openrampkit/adapter` gives `polling` (the adapter has `status()`) and `webhooks` (it has a `webhook` whose new `configured` flag is not `false`). Binance, Bridge, Coinbase, Meld, MoonPay and Onramper set `configured` from their webhook secret. The server writes a warning at start for an adapter with legs that has neither. `checkAdapterShape` reports an unknown capability.
- 7512a8e: Provider events now move a leg only forward. Core has `LEG_STATUS_RANK` and `isLegalLegMove(from, to)`. Status checks and browser transitions also move a leg only forward (one exception: a `processing` review step in `KYC` or `AUTH` can end with an `requires_action` step before any transaction); a backward poll is ignored and a backward transition answers `409`. A session with a completed or reversed payment refuses plan, quotes, target, select and transitions from the browser with `409`. The server ignores a provider event that would move a leg back (for example `pending` after `processing`), logs it, adds 1 to the new `event.out_of_order` metric, and answers the provider with `200`. One move back is allowed only when the leg opts in with the new `LegSpec` capability `surface_after_processing`: from `processing` to `requires_action` with a new surface of a kind in the spec's `surfaces`, before the leg has a transaction, once per leg. `LegEvent` has a new optional `eventId`. The server keeps the last 50 applied ids per session and ignores an event with an id that it already applied.
- 8d66ab9: Locked withdraw targets and pay link revocation.

  - Server: `CreateSessionInput` has `target` and `lockDestination` for withdraw sessions. The server checks the target at creation (format, `allowedDestinations`, `screenAddress`) and stores it as the destination. With `lockDestination: true`, `POST /sessions/:id/target` answers `409 DESTINATION_LOCKED`, for the client secret and for a pay link. A cash target (`{ type: 'fiat', currency }`) can also be locked.
  - Server: pay links have an `id`. `openramp.sessions.revokePayLink(sessionId, linkId)` and `POST /sessions/:id/pay-link/revoke` make one link stop working. The credential format is now `{sessionId}.pay_{exp}_{linkId}_{sig}`.
  - Core: `PublicSession.destinationLocked` and the error code `DESTINATION_LOCKED`.
  - Client and web: with a locked target, the withdraw flow skips the target screen and the tabs, gets the plan with `/plan`, and shows the locked address read only.
  - MCP: a bound payout creates the session with the target set and locked, and then plans, quotes and starts it (no `/target` call). The operations from `createRampOps` have `revokePayLink(sessionId)`.

- 127b79a: The server now compares each leg's reported output with the leg's quote. When a provider reports less than the quote by more than the new `policy.outputToleranceBps` (default 100, that is 1%), the leg keeps its result, but the session result gets the new `amountMismatch` field (`reason`, `legIndex`, `expected`, `received`, `shortfall`), so every webhook shows it. The check fails closed: an output in another asset (`asset_mismatch`) or with an amount that is not a number (`invalid_amount`) is flagged too, is not a confirmed output, and on a leg before the last it stops the pathway (`FAILED`, `DELIVERY_FAILED`) instead of starting the next leg. The server also adds a `leg.amount_mismatch` timeline entry, logs a warning and reports the `leg.amount_mismatch` metric. The admin page shows the shortfall on the leg. Core has the new `AmountMismatch` type.
- 0dfd32e: Provider health, ranking by success rate, a circuit breaker and failover at start. The server now counts, per adapter and hour, quotes that worked or failed, starts that worked or failed, and legs that succeeded or failed (best effort, in the store's KV space). Answers such as `AMOUNT_TOO_LOW` or `NO_QUOTES` are not failures. Quotes with the same output and ETA go in the order of the providers' recent success rate (`rankQuotes` takes an optional `successRate`). An adapter whose recent quotes and starts mostly fail is skipped with `PROVIDER_UNAVAILABLE` and no network call, and after a cool-down one probe quote may close the breaker again. When the chosen quote's `start()` throws a provider failure, `select` starts the next best quote of the same list (at most 2 more) and records `payment.failover`. That quote must have the same input and at least 99% of the chosen output. It never fails over on a timeout or once `start()` returned a step. One session counts at most one quote failure per adapter, so one browser cannot open the breaker for every user. New config `routing` (`healthWindowHours` 24, `minSamples` 20, `breakerFailureRate` 0.8, `breakerCooldownMinutes` 10, `breaker`), new `openramp.admin.providers()` and `GET /admin/providers`, and new metrics `payment.failover`, `breaker.opened`, `breaker.closed` and `quote.skipped`.
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

- 9080812: New option `screenDepositWallets`: run `screenAddress` on the wallet that pays a `wallet` deposit, on the chain it pays from, before the payment starts. A refused wallet gets `403 ADDRESS_REJECTED`. Default off.
- ba6810e: Stored session records now have a `schema` field (`SESSION_SCHEMA`, now 1), apart from the optimistic-lock `version`. The server runs the new `migrateRecord()` on every store read: a record written before this change (no `schema`) gets `updatedAt`, attempt numbers (`ActivePayment.n`) and empty lists filled in, and keeps working. New exports: `SESSION_SCHEMA`, `migrateRecord` and `migratingStore`. Custom stores need no change.
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

- 66c8f1d: A token list for the deposit source picker, from the server.

  - Core: `SourceToken`, `SourceChain`, `defaultSourceTokens`, `mergeSourceTokens`, `cleanSourceToken` and `searchSourceTokens`.
  - Adapter: optional `sourceTokens({ chains, method })`.
  - Relay: `sourceTokens` from Relay's verified default list (`/currencies/v2`), only deposit-address tokens for transfers, cached for 6 hours per chain.
  - Server: `GET /sessions/:id/sources?method=` merges the adapter lists after USDC and the native token, checks every field, keeps only https logos, and caches the answer for an hour.
  - Client: `client.sources()`, and the controller loads `snapshot.sources` when the user picks an address transfer. On an error the picker keeps the default list.
  - Web: the token select is now a list with logos (a letter shows when a logo does not load) and a search box when a chain has more than 6 tokens.

- 8ad4bd2: "Your deposit address" in the widget. With the server option `depositAddresses: { widget: true }`, a deposit session's plan offers the method `deposit_address`. The user picks the network and token, and the widget shows their standing address with a QR code and a copy button (`POST /sessions/:id/deposit-address`, `client.depositAddress()`, `snapshot.depositAddress`). The mock adapter gets `standing` for demos and tests.
- aad31d5: Standing deposit addresses: one permanent deposit address per user and route.

  - Server: `openramp.depositAddresses.get({ userId, origin, destination, adapterId? })` makes the address on the first call and returns the same one after that. `depositAddresses.list(userId)` lists a user's addresses.
  - `sweep()` polls each address (every 30 s after a deposit, up to every 10 minutes when idle, and not after 90 idle days until the next `get`). Each new deposit becomes a deposit session with an observed payment, so the usual session webhooks follow. `SweepResult.standing` counts the polls and the deposits.
  - New webhook event `deposit_address.deposit` (`depositAddressId`, `sessionId`, `depositId`, `input`). Such a session has `standingAddressId`, and its failure is final.
  - Core: the `StandingAddress` type, and `Session.standingAddressId`.
  - Adapter API: two optional methods, `standingAddress()` and `standingDeposits()`. `checkAdapterShape` checks that they come together with `status()` and a `transfer` leg.
  - Relay: standing addresses are Relay open deposit addresses. A deposit is keyed by its deposit transaction, and its status follows a re-quote under a new request id. Each poll looks back 24 hours, over up to 5 pages.

- bab3381: Standing deposit addresses for the same token on the same chain, with no bridge provider.

  - New `@openrampkit/adapter-chain-watch` (`chainWatch()`): the deposit address is the destination itself, and the adapter watches the chain (ERC-20 `Transfer` logs on EVM chains, SOL and SPL signatures on Solana). A transfer counts after `confirmations` blocks (default 12; Solana `finalized`). Each log or signature is claimed once, so it makes one session. `status()` reads the transaction again: a transfer that a re-org removed, or with another amount, fails the leg. Options: `rpcUrls`, `defaultRpcUrls`, `confirmations`, `solanaCommitment`, `logBlockRange`, `maxLogPages`, `requestsPerSecond`, `timeoutMs`, `minDeposit`. It has no session legs (it is never in a plan).
  - `@openrampkit/adapter`: new `createChainWatch()` (RPC URLs per chain, a rate limit per RPC URL, `Transfer` log pages with a block range cap, Solana reads), `txUsedKey`, `PUBLIC_RPC_URLS`, `solanaNetReceived` and `solanaMintDecimals`. New optional `Adapter.standingRoutes` (`'convert'` by default, or `'same'`).
  - `@openrampkit/adapter-relay`: the same-chain checks use `createChainWatch`. No behavior change. New option `rpcRequestsPerSecond`. `logBlockRange` is capped at 10000.
  - `@openrampkit/server`: `depositAddresses.get` accepts the same token on the same chain and picks an adapter that serves the route (`standingRoutes`). Such an adapter must return the destination address itself. The widget route picks the adapter by route too.

- 5c5019e: `Step.sub` is now a closed list of lowercase values: `StepSub`, with `STEP_SUBS` and `isStepSub` in `@openrampkit/core`. Before, it mixed case and raw provider strings (`CONFIRMING`, `confirming`, Relay and LI.FI statuses), and the web UI title-cased them. Adapters now map provider statuses to the list (for example LI.FI `WAIT_DESTINATION_TRANSACTION` is `bridging`, Relay `waiting` is `waiting_for_deposit`) and put the raw value in the new `LegStep.providerStatus`. The server writes it to the timeline (`leg.provider_status`), never to the browser, and drops a `sub` that is not in the list. The web element shows `messages.stepSub[sub]`, translated in every catalog (en, vi, id, th, ms, fil).
- 2c1daa4: Gas abstraction for wallet deposits. A user with USDC and no native gas can pay with the `wallet` method: the wallet signs Relay's permit (EIP-3009, EIP-712) and Relay's solver sends the origin transaction, with its gas taken from the token. New surface `WALLET_SIGN` (`{ chain, address, signatures: TypedDataRequest[] }`) with a SURFACE_RESULT transition that `expects: 'signatures'`. New optional `WalletAdapter.signTypedData(chain, data)` in `wagmiWallet`, `privyWallet` and `combineWallets`. The controller asks for it by `FlowOptions.gasless` (`'auto'` by default: only when the wallet reports a zero native balance) and signs with `signWalletMessages()`. `select` takes `gasless`, and `StartInput.gasless` passes it to the adapter. The Relay adapter (option `gasless`, default true) checks each message before the user sees it and recovers the signer of each signature before it posts it to `/execute/permits`. New `hashTypedData`, `recoverAddress` and `recoverTypedDataSigner` in `@openrampkit/adapter`. The mock adapter shows `WALLET_SIGN` in test mode, and `createMockWallet({ canSign: true })` signs.
- 609b907: Replay protection for provider webhooks that have no timestamp. `Adapter.webhook` has a new optional `replayKey(req, rawBody, ctx)`. After `verify`, the server claims the key for 7 days in the adapter's shared store with the new `claimWebhook` (built on `claimOnce`). A repeat gets `200` with `{ "received": true, "duplicate": true }`, changes nothing, and adds 1 to the new `webhook.replayed` metric. When the server cannot apply the events yet (`503`), it gives the key back with `releaseWebhook`, so the provider's retry still applies. New helpers: `webhookBodyKey(rawBody)` (SHA-256 of the body), `claimWebhook`, `releaseWebhook` and `WEBHOOK_REPLAY_TTL_SEC`. The Onramper, Swapped and Xendit adapters now give the body hash as the replay key and as the `eventId` of their events.
- 29dbf05: The widget shows standing bank accounts. With `depositAddresses.widget` and an adapter that gives standing bank accounts and lists their currencies (new optional `Adapter.standingCurrencies`; Bridge with `standing: true` sets it), the "Your deposit address" screen has "Crypto" and "Bank account" tabs. The bank tab shows every bank field, with a copy button where the provider allows one. `POST /sessions/:id/deposit-address` takes `{ currency }`: the browser picks only a currency that the adapter lists, and the server sets the user, the destination and the adapter. The method has `standingOrigins: { crypto, currencies }`. The client's `DepositAddressView` can have a fiat origin and `bank`, and the controller has `depositCurrency`, `setDepositCurrency()`, `depositCurrencies()` and `depositCrypto()`. New strings in all six locales. The mock adapter has a `standingBank` option.
- 18da157: Optional server-side balance check for withdrawals from the user's wallet. With `withdraw: { checkBalance: { rpcUrls, timeoutMs? } }`, the server reads the wallet balance of the source token (ERC-20 `balanceOf`, or `eth_getBalance` for `native`) on EVM chains before it quotes and again before it starts the first leg. An amount above the balance gets `422 AMOUNT_TOO_HIGH` with the balance in the message; with `amountSide: 'destination'`, quotes above the balance become errors. RPC errors and timeouts fail open and are logged. Off by default. The adapter package adds `erc20BalanceOfData(owner)` and a `timeoutMs` option on `evmRpc`.

### Patch Changes

- 70abb29: Admin tools: a session with no amount up front (for example a transfer from an exchange) now shows the amount that arrived, in the list, the detail drawer and the completed volume. The mock adapter's simulated deposit now sends a test amount (25) when the transfer has no amount.
- 243bf9c: Chain watch and Stripe Link: make claims and stage changes atomic.

  - `@openrampkit/adapter`: new `claimTransferLog` and `TX_LOGS_OWNER`. A Transfer log first claims its transaction for logs (one key with a wallet payment of the same transaction), then the log. So a log and a wallet payment that run at the same time cannot both count one transfer.
  - `@openrampkit/adapter-chain-watch` and `@openrampkit/adapter-relay` (same-chain transfer legs): EVM logs are claimed with `claimTransferLog`.
  - `@openrampkit/server`: a watched destination and a converting standing address to it are bound with one atomic claim (`sdwatch:`), so exactly one wins when they are made at the same time, and the loser leaves no mark.
  - `@openrampkit/adapter-stripe-link`: each change of a leg takes a lease on the record version (one atomic claim). Two `link_authenticated` calls cannot both bind a client key, two `checkout` calls send one checkout, and a transition cannot run next to a new sign-in. Each checkout sends an idempotency key with the record version.

- bd8fbb0: Withdraw: a late payment of an earlier attempt no longer completes the session when the user picked another target after the `restart`. Before, the session completed and `withdrawal.succeeded` showed the new target as the destination, but the funds went to the old one. The server now keeps the destination of each payment attempt, and sends `session.late_payment` (`reason: 'earlier_attempt'`) instead.
- 480b589: Fixes in the output check and in late events for earlier attempts:

  - The server checks a leg's output again when only its asset changes. Before, a provider could first report the quoted asset, then report the same amount in another asset, and the next leg started with no `amountMismatch`.
  - An earlier attempt that becomes the payment again (a late provider event after `restart`) now gets the same output check as any other leg. Before, its output was not checked, so another asset or a short amount did not stop the next leg and did not set `amountMismatch`.
  - A refund of an earlier attempt that never succeeded no longer makes that attempt the payment again. Before, it replaced the payment in progress, and the session became `REFUNDED`.

- d6e1063: Chain watch: fix deposit misattribution and address squatting.

  - `@openrampkit/server`: `depositAddresses.get` for the same token on the same chain now needs `dedicatedDestination: true` (else `400`). The server binds the watched destination (chain, token, address) to one user (`409` for another user). A deposit session or a converting standing address to a watched destination is refused (`409`), and a same-chain address for a destination that a converting address delivers to is refused, because the deliveries would count twice. The widget route `POST /sessions/:id/deposit-address` no longer gives same-chain addresses (`400`) and picks only adapters that convert.
  - `@openrampkit/server`: adapter keys that start with `txused:` (`txUsedKey`) are now one namespace for all adapters, so one transfer completes one payment only, whichever adapter sees it. Claims written under the adapter prefix before still count.
  - `@openrampkit/adapter-chain-watch`: `status()` uses the token's real decimals, not `destination.decimals` from the session input. A log from the RPC must be a `Transfer` of the watched token to the address in the asked block range. A log of a transaction that a wallet payment claimed is skipped, and a counted log marks its transaction for wallet payments.

- 901ea9a: New `claimOnce(shared, key, owner, ttlSec)` in `@openrampkit/adapter`: it records a transaction, log or deposit as used by one owner. `ScopedKV` has a new optional `putIfAbsent(key, value, ttlSec)`. The server gives it to adapters when the store has an atomic operation: `memoryStore`, `redisStore` (`SET NX EX` in a Lua script) and `durableObjectStore` have one, `cloudflareKvStore` does not. The Relay, LI.FI, Bridge and mock adapters now use `claimOnce`. On a store with `putIfAbsent`, two requests at the same time can no longer both take the same transaction. The stored keys and values do not change.
- 2b252cf: Safer deposits from exchanges, and no double payment on restart.

  - Relay: new option `exchangeTransfer` offers the transfer leg as the `exchange_transfer` method ("From an exchange"). A refund for it does not go to the exchange's hot wallet when a better address is known: an explicit `refundTo` address, then the connected wallet, then the recipient. Otherwise the deposit screen warns the user. `refundTo` also takes `'recipient'`. Relay binds the refund address to the deposit address, so an address with another refund address gets its own store key.
  - Server: `restart` first asks the provider for the status of the active leg. A payment that the provider already took (on its page, by QR code or by bank transfer) now blocks the restart. The server also asks the adapter to cancel the left provider order (`cancel`, best effort).
  - Web: the native token of a chain uses the chain's decimals (SOL: 9, not 18).

- 0d38d29: Provider health: a leg that failed because of the user (`PAYMENT_FAILED`, `KYC_REJECTED`, `PROVIDER_DECLINED`, `QUOTE_EXPIRED` and the other user codes) no longer counts as a provider failure, and each leg's outcome counts once, also when a save is retried after a conflict.
- e2e8337: One constant-time string compare: `timingSafeEqual(a, b)` is now in `@openrampkit/core`. `@openrampkit/adapter` exports the same function, and the server and the MCP HTTP handler use it. The result does not change.
- 8a2ec99: Compare routes in demos: the mock adapter gets `id`, `feeBps`, `spreadBps`, `eta`, `methods`, `countries`, `cardCheckout: 'form'` (test card fields in the widget) and `exchange` (the new `exchange_transfer` method). Several mock instances can now run side by side. Core adds the `exchange_transfer` method ("From an exchange", a deposit address like `transfer`) and `isAddressTransfer()`. The widget treats it like `transfer` and names exchanges as examples. Selects in the widget have one chevron, centred, in every browser. The server reads request bodies in browsers without `Request.body` (Firefox).
- 8295c59: A status check that fails half way is never saved. Before, when a poll moved a leg to `succeeded` and the next leg could not start (a provider error), the server kept the half-changed session in memory. When the same sweep also saw a change on an earlier attempt, it saved that session: the active leg had no step, and the session stopped (no next leg, no expiry). Now the error of the next leg goes to the caller: the sweep saves nothing for that session and tries again on its next run. `GET /sessions/:id/step` answers with the error (the client polls again), and `sessions.refresh` throws it.

  The same holds for the sweep's polls of earlier attempts. These polls now also move a leg only forward, like a provider event.

- 146684f: A status poll that reports `requires_action` with no surface and only poll transitions no longer replaces the user's current action. Before, the user's own transitions (for example `submit_tx`, a form, or the mock's `simulate_payment`) were lost after the first poll, and the next user action got `409`.
- c24a0f7: Security hardening: body size limits (413), input checks on sessions and browser routes, idempotency keys scoped per route, session deadline enforced on quote, select and restart, surface URL checks (no `javascript:` or `data:` URLs) on the server, client and web component, a single treasury send under concurrent requests, a block time check for Relay same-chain payments, minimum lengths for `webhooks.secret` and `tasksToken`, empty webhook keys refused by Stripe and Swapped, and the mock adapter refuses live sessions. New in core: `isWebUrl` and `isSafeLinkUrl`.
- 3b8e567: The session now shows the transaction that paid into each leg, next to the fill:

  - New optional field `LegStep.sourceTxHash` (and `LegEvent.sourceTxHash`): the transaction that paid into the leg, for example the origin chain transaction that the user's wallet sent with `submit_tx`. The server keeps the last value when a later step leaves it out.
  - `step.progress.legs[].sourceTxHash` and `result.sourceTxHashes` show it. `result.sourceTxHashes` is absent when no leg reports one. `result.txHashes` does not change: for a bridge or swap it is the fill on the destination chain.
  - Relay: the `wallet` leg reports the origin transaction (`submit_tx`, else Relay's `inTxHashes`) as `sourceTxHash`. Before, a completed session showed only the fill. The `transfer` and `bridge` legs report the transfer into the deposit address. Same-chain transfers report the same hash in both fields.
  - LI.FI: the `wallet` leg reports the source transaction as `sourceTxHash`.
  - The admin session detail has `sourceTxHashes`, and the MCP `get_session_status` tool has `source_tx_hashes`.

- 6bdce64: Standing addresses: a same-chain watch reads the older converting marker (`sdconv:`) again after its claim of the destination, so a watch and a converting address of an older server made at the same time cannot both win.
- b99f1fc: Withdraw with `custody: 'app'`: a failure after `treasury.send` (a provider error when the server reports the hash, a save conflict, or a stop of the process) can no longer make the treasury send a second time. Before the send, the server now saves the leg as `processing`, so the saved session shows the payment in progress: it refuses `restart` and a new `select`, and it shows no `WALLET_TX` to the user. When a provider event or a status check asks again for a step that the treasury already sent, the leg waits in `processing` and the server does not call the hook again.
- Updated dependencies [138dc35]
- Updated dependencies [243bf9c]
- Updated dependencies [131dc8a]
- Updated dependencies [d6e1063]
- Updated dependencies [901ea9a]
- Updated dependencies [25b1f98]
- Updated dependencies [9a88cec]
- Updated dependencies [9a88cec]
- Updated dependencies [51167ad]
- Updated dependencies [51167ad]
- Updated dependencies [b770da7]
- Updated dependencies [59811bd]
- Updated dependencies [977c386]
- Updated dependencies [77f762d]
- Updated dependencies [c7f849c]
- Updated dependencies [230c5ad]
- Updated dependencies [3453854]
- Updated dependencies [9c135aa]
- Updated dependencies [7512a8e]
- Updated dependencies [521c893]
- Updated dependencies [8d66ab9]
- Updated dependencies [b763cf0]
- Updated dependencies [0672f15]
- Updated dependencies [e2e8337]
- Updated dependencies [6e7899b]
- Updated dependencies [127b79a]
- Updated dependencies [8a2ec99]
- Updated dependencies [635d8f9]
- Updated dependencies [0dfd32e]
- Updated dependencies [f4a89d0]
- Updated dependencies [e74d5e3]
- Updated dependencies [fb978b8]
- Updated dependencies [5997e23]
- Updated dependencies [c24a0f7]
- Updated dependencies [a999c0c]
- Updated dependencies [63f3db5]
- Updated dependencies [d4523b2]
- Updated dependencies [bf08445]
- Updated dependencies [66c8f1d]
- Updated dependencies [3b8e567]
- Updated dependencies [8ad4bd2]
- Updated dependencies [aad31d5]
- Updated dependencies [bab3381]
- Updated dependencies [5c5019e]
- Updated dependencies [2c1daa4]
- Updated dependencies [609b907]
- Updated dependencies [29dbf05]
- Updated dependencies [18da157]
  - @openrampkit/adapter@0.1.0
  - @openrampkit/core@0.1.0
