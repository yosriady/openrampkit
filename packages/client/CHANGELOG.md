# @openrampkit/client

## 0.1.0

### Minor Changes

- 131dc8a: Withdraw to a Cash App `$cashtag` or a Lightning address.

  - Core: a `lightning` withdraw target (`{ type: 'lightning', address, cashtag? }`), `parseLightningTarget` (strict format; invoices, LNURLs, URLs and IP addresses are refused), `sameLightningAddress`, `LIGHTNING` and `LIGHTNING_BTC`, the endpoint locations `cash_app` and `lightning_address`, and `allowedDestinations.lightning.domains`.
  - Server: `POST /sessions/:id/target` and `sessions.create` take `{ type: 'lightning', address }`. The server parses the address, checks `allowedDestinations.lightning`, and runs the new `screenLightningAddress` hook (fail closed). With `screenAddress` set and no Lightning hook, every Lightning target is refused. A deposit cannot go to a Lightning address.
  - Client and web: a "To Cash App" withdraw tab when `allowedDestinations.lightning` is set, with a `$cashtag` input, format checks, and a hint about Cash App dollars, in all six locales.
  - Flashnet: payout legs `cash_app_payout` and `lightning_payout` through `POST /v1/orchestration/offramp`, from USDC on Base, Ethereum, Arbitrum, Optimism and Polygon. The adapter builds the ERC-20 transfer, checks the answer against the quote and the session target, and binds each quote, deposit address and funding transaction to one payout.

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

- b770da7: History in the widget. With the server option `history: true`, the server keeps one index of sessions per user, and `GET /sessions/:id/history` lists the past sessions of the session's user (newest first, at most 50): kind (`session` or `standing`), direction, status, amount, destination asset, and the delivery transaction with its explorer link. No secret, user id, IP, provider id or address. A pay link gets `403`. `client.history()`, `controller.openHistory()` and `snapshot.history`. The widget shows a History link only when the route answers, and a list with status badges, relative dates and explorer links. New type `HistoryItem` in core.
- 977c386: Exchange picker ("From an exchange").

  - Core: `EXCHANGES` (Binance, Coinbase, OKX, Bybit, Kraken), `exchangeOptions(methods)` and `isExchangeMethod`. Each exchange row has a mode: `connect` (pay on the exchange's page: the Binance adapter's `exchange`, Meld `binance_pay`, Coinbase `coinbase_account`) or `deposit` (`exchange_transfer`). The plan decides which methods exist (adapters and regions), so the rows follow the plan.
  - Client: screen `exchanges`, `openExchanges()`, `selectExchange(id)`, `snapshot.exchange`, `depositFallback()` and `depositInstead()`. When the payment on the exchange's page waits or fails, the user can send from the same exchange to a deposit address. The server refuses this restart when the exchange already took the payment.
  - Web: with a connect method, one "From an exchange" row opens the picker. The deposit hint names the picked exchange. 6 locales.
  - Mock: `exchangeConnect` offers `coinbase_account` on the card leg, for tests and demos.

- 77f762d: First release on npm. All `@openrampkit/*` packages have the same version (0.1.0). The Release workflow publishes them from GitHub Actions with npm provenance. Read [Releases and versions](https://github.com/yosriady/openrampkit/blob/main/docs/guide/releases.md) for the 0.x stability rules.
- 5f1394c: Flow options and `autoClose`, for each session.

  - `flow` (`FlowOptions`): `initialTab`, `initialMethod` (also `exchanges`), `lockMethod`, `amount`, `presets` per currency, `defaultSource` (deposit), `defaultTarget` (withdraw) and `balance` (withdraw with app custody: turns on MAX and the balance check). An option that does not fit the session is ignored.
  - `autoClose`: close as soon as the payment completes, with no success screen. The element attribute is `auto-close`.
  - `openDeposit`, `openWithdraw`, `createDepositController`, `beginDeposit`, `beginWithdraw` and the embedded components take them.
  - The native token of a withdraw chain uses the chain's decimals (SOL: 9).

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

- 66c8f1d: A token list for the deposit source picker, from the server.

  - Core: `SourceToken`, `SourceChain`, `defaultSourceTokens`, `mergeSourceTokens`, `cleanSourceToken` and `searchSourceTokens`.
  - Adapter: optional `sourceTokens({ chains, method })`.
  - Relay: `sourceTokens` from Relay's verified default list (`/currencies/v2`), only deposit-address tokens for transfers, cached for 6 hours per chain.
  - Server: `GET /sessions/:id/sources?method=` merges the adapter lists after USDC and the native token, checks every field, keeps only https logos, and caches the answer for an hour.
  - Client: `client.sources()`, and the controller loads `snapshot.sources` when the user picks an address transfer. On an error the picker keeps the default list.
  - Web: the token select is now a list with logos (a letter shows when a logo does not load) and a search box when a chain has more than 6 tokens.

- 8ad4bd2: "Your deposit address" in the widget. With the server option `depositAddresses: { widget: true }`, a deposit session's plan offers the method `deposit_address`. The user picks the network and token, and the widget shows their standing address with a QR code and a copy button (`POST /sessions/:id/deposit-address`, `client.depositAddress()`, `snapshot.depositAddress`). The mock adapter gets `standing` for demos and tests.
- 2c1daa4: Gas abstraction for wallet deposits. A user with USDC and no native gas can pay with the `wallet` method: the wallet signs Relay's permit (EIP-3009, EIP-712) and Relay's solver sends the origin transaction, with its gas taken from the token. New surface `WALLET_SIGN` (`{ chain, address, signatures: TypedDataRequest[] }`) with a SURFACE_RESULT transition that `expects: 'signatures'`. New optional `WalletAdapter.signTypedData(chain, data)` in `wagmiWallet`, `privyWallet` and `combineWallets`. The controller asks for it by `FlowOptions.gasless` (`'auto'` by default: only when the wallet reports a zero native balance) and signs with `signWalletMessages()`. `select` takes `gasless`, and `StartInput.gasless` passes it to the adapter. The Relay adapter (option `gasless`, default true) checks each message before the user sees it and recovers the signer of each signature before it posts it to `/execute/permits`. New `hashTypedData`, `recoverAddress` and `recoverTypedDataSigner` in `@openrampkit/adapter`. The mock adapter shows `WALLET_SIGN` in test mode, and `createMockWallet({ canSign: true })` signs.
- 2250391: New entry `@openrampkit/web/stripe-link` with `stripeLinkRenderer()`, the modal renderer for the Stripe Link headless flow, on Stripe's `@stripe/crypto` (an optional peer dependency, loaded with a dynamic import). It makes a random client key in memory and sends it with every transition. KYC data and the phone number go to Stripe only. The main entry never imports it.

  `ProviderRendererContext` has `submit(name, inputs?)`: it calls a transition with inputs and resolves to the next step. The modal mounts a renderer again when `params.step` changes, and shows no `SUBMIT` buttons for a step that a renderer draws. `RampController.fire()` now returns the new session (or `undefined` on an error).

- 29dbf05: The widget shows standing bank accounts. With `depositAddresses.widget` and an adapter that gives standing bank accounts and lists their currencies (new optional `Adapter.standingCurrencies`; Bridge with `standing: true` sets it), the "Your deposit address" screen has "Crypto" and "Bank account" tabs. The bank tab shows every bank field, with a copy button where the provider allows one. `POST /sessions/:id/deposit-address` takes `{ currency }`: the browser picks only a currency that the adapter lists, and the server sets the user, the destination and the adapter. The method has `standingOrigins: { crypto, currencies }`. The client's `DepositAddressView` can have a fiat origin and `bank`, and the controller has `depositCurrency`, `setDepositCurrency()`, `depositCurrencies()` and `depositCrypto()`. New strings in all six locales. The mock adapter has a `standingBank` option.

### Patch Changes

- 5997e23: Refunds and chargebacks after success. A provider event `refunded` for a leg that succeeded, or the new leg status `reversed` (a chargeback or a returned payout), no longer gets lost. The server keeps the leg with its new status, adds it to the timeline, sets the new step state `REVERSED` (error `PAYMENT_REVERSED`) and the new session status `reversed`, and sends the new `session.reversed` webhook once, with a deterministic event id (and `withdrawal.reversed` for a withdrawal). The event data has `index`, `adapterId`, `legId`, `legStatus` and `previous`. Take back or freeze the credit when you get it. A `REVERSED` session refuses `restart`, and a completed or reversed session refuses a new `select`.

  Core: new `StateName` `REVERSED` (`COMPLETED` can move to it), `LegStatus` `reversed`, `SessionStatus` `reversed`, event types `session.reversed` and `withdrawal.reversed`, and error code `PAYMENT_REVERSED`. Code that switches on these unions must handle the new members. The modal shows "Payment reversed" (in every built-in language), and the admin page has a filter, a stats card and a detail row for reversed sessions.

- c24a0f7: Security hardening: body size limits (413), input checks on sessions and browser routes, idempotency keys scoped per route, session deadline enforced on quote, select and restart, surface URL checks (no `javascript:` or `data:` URLs) on the server, client and web component, a single treasury send under concurrent requests, a block time check for Relay same-chain payments, minimum lengths for `webhooks.secret` and `tasksToken`, empty webhook keys refused by Stripe and Swapped, and the mock adapter refuses live sessions. New in core: `isWebUrl` and `isSafeLinkUrl`.
- 5c5019e: `Step.sub` is now a closed list of lowercase values: `StepSub`, with `STEP_SUBS` and `isStepSub` in `@openrampkit/core`. Before, it mixed case and raw provider strings (`CONFIRMING`, `confirming`, Relay and LI.FI statuses), and the web UI title-cased them. Adapters now map provider statuses to the list (for example LI.FI `WAIT_DESTINATION_TRANSACTION` is `bridging`, Relay `waiting` is `waiting_for_deposit`) and put the raw value in the new `LegStep.providerStatus`. The server writes it to the timeline (`leg.provider_status`), never to the browser, and drops a `sub` that is not in the list. The web element shows `messages.stepSub[sub]`, translated in every catalog (en, vi, id, th, ms, fil).
- Updated dependencies [131dc8a]
- Updated dependencies [25b1f98]
- Updated dependencies [9a88cec]
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
- Updated dependencies [8d66ab9]
- Updated dependencies [b763cf0]
- Updated dependencies [e2e8337]
- Updated dependencies [6e7899b]
- Updated dependencies [127b79a]
- Updated dependencies [8a2ec99]
- Updated dependencies [0dfd32e]
- Updated dependencies [f4a89d0]
- Updated dependencies [fb978b8]
- Updated dependencies [5997e23]
- Updated dependencies [c24a0f7]
- Updated dependencies [63f3db5]
- Updated dependencies [bf08445]
- Updated dependencies [66c8f1d]
- Updated dependencies [3b8e567]
- Updated dependencies [8ad4bd2]
- Updated dependencies [aad31d5]
- Updated dependencies [5c5019e]
- Updated dependencies [2c1daa4]
- Updated dependencies [29dbf05]
  - @openrampkit/core@0.1.0
