# Flows

This page shows the key flows as sequence diagrams. Each diagram uses the real route names, function names, event names and states from the source. For the parts and the trust boundaries, read [Architecture](./architecture.md). For the states, read [Flow state machine](./flow.md).

Names in the diagrams:

- **Browser**: `<openramp-modal>` and `DepositController` from `@openrampkit/web` and `@openrampkit/client`.
- **Server**: the handler from `createOpenRamp()` in `@openrampkit/server`. All routes are relative to your `baseUrl`.
- **Store**: your `SessionStore` (Durable Object, Redis, Cloudflare KV or memory).
- **Adapter**: one adapter package, for example `@openrampkit/adapter-relay`.
- **App**: your app backend.

## Session creation

Your backend creates the session. The browser gets only the client secret.

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant B as Browser
  participant App as Your backend
  participant S as Server
  participant St as Store
  U->>B: Click "Deposit"
  B->>App: POST /api/deposit-session (your route, your auth)
  App->>S: openramp.sessions.create({ userId, country, destination, metadata })
  S->>S: checkInput(), checkSettlement()
  S->>St: put(SessionRecord) with secretHash = sha256(secret)
  S->>St: add the id to open-sessions
  S-->>App: session.created webhook (when webhooks are on)
  S-->>App: { id, clientSecret: "ors_id.secret", expiresAt }
  App-->>B: clientSecret
  B->>B: openDeposit({ baseUrl, clientSecret }) or DepositButton getClientSecret()
  B->>B: controller.start(): wallet.getAccounts()
  B->>S: GET /sessions/:id (Authorization: Bearer clientSecret)
  S->>St: get(id)
  S->>S: loadAuthed(): compare sha256(secret), expire when past the deadline
  S-->>B: PublicSession (step SELECT_METHOD)
  B->>S: POST /sessions/:id/plan { walletConnected, walletAddress, surfaces }
  S->>S: adapter.catalog() (optional), planPathways(), allowedMethods filter
  S->>St: save plan (version check)
  S-->>B: PlanResult: methods and pathways, grouped
  B->>U: Show methods: Connected, Most popular, Other options, Not available
```

`sessions.create()` runs in your backend. It does not go over HTTP.

Optional: the browser can create the session itself, through your `authorize` hook.

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser
  participant S as Server
  participant H as config.authorize
  B->>S: POST /sessions { your body }
  alt no authorize hook configured
    S-->>B: 404 NOT_FOUND
  else authorize configured
    S->>H: authorize(req, body)
    H-->>S: CreateSessionInput or null
    alt null
      S-->>B: 401 UNAUTHORIZED
    else input
      S->>S: createSession({ ...geoOf(req), ...input })
      S-->>B: 201 { id, clientSecret, expiresAt }
    end
  end
```

See [Sessions and security](./sessions.md).

## Fiat onramp with REDIRECT or IFRAME

A card or bank payment at a provider such as Coinbase, Transak, MoonPay or Swapped. The provider page opens in a popup (REDIRECT) or inside the modal (IFRAME).

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant B as Browser
  participant S as Server
  participant St as Store
  participant A as Adapter
  participant P as Provider
  participant App as Your backend
  U->>B: Pick a method and an amount
  B->>S: POST /sessions/:id/quotes { method, amount, amountSide }
  par up to 5 pathways, each with a 9 s timeout
    S->>A: quote({ leg, amountIn, deliverTo })
    A->>P: pricing API
    P-->>A: price and fees
    A-->>S: LegQuote
  end
  S->>S: rankQuotes(), boundsError(), keep at most 20 quotes
  S-->>B: { quotes, errors }
  Note over B: The controller asks for new quotes shortly before the earliest expiry
  U->>B: Confirm a quote
  B->>S: POST /sessions/:id/select { quoteId } with Idempotency-Key
  S->>S: check the quote, the expiry, no payment in progress, amountBounds
  S->>S: beginPayment() then startLeg(0)
  S->>A: start({ leg, quote, deliverTo })
  A->>P: create the order or sign the widget URL
  A-->>S: LegStep requires_action, action payment with surface REDIRECT or IFRAME and an AWAIT poll, ref, providerRef
  S->>S: sanitizeLegStep() (surface URLs and all adapter data), then wrapSurface() for REDIRECT
  S->>St: index ref:adapterId:ref to the session id, save the session
  S-->>B: Step PAYMENT
  alt REDIRECT
    U->>B: Click "Continue"
    B->>S: window.open(GET /start/:sessionId.:token.:sig)
    S->>S: check the HMAC signature and the 10 minute expiry
    S-->>B: 302 to the provider URL
    U->>P: Pay on the provider page
    P-->>B: Send the user to returnUrl (default GET /return closes the tab)
  else IFRAME
    B->>P: Load the provider page in an iframe
    U->>P: Pay inside the modal
    P-->>B: postMessage (a hint only, see the iframe protocol)
  end
  loop AWAIT: GET /sessions/:id/step with backoff
    B->>S: GET /sessions/:id/step
    S->>A: refreshActive(): status({ leg, ref }) at most every 2 s
    S-->>B: Step PAYMENT or PROCESSING
  end
  P->>S: POST /webhooks/:adapterId
  S->>A: webhook.verify(req, rawBody)
  S->>A: webhook.parse(rawBody) returns LegEvent[]
  S->>St: find the session by ref:adapterId:ref
  S->>S: applyEvent(), setLegStep() with status succeeded, check the output (result.delivery)
  S->>App: leg.succeeded
  S->>S: composeStep(): every leg succeeded, so COMPLETED
  S->>App: session.succeeded (signed)
  B->>S: GET /sessions/:id/step
  S-->>B: Step COMPLETED with result
  B->>U: Result screen, onComplete(session)
```

Notes:

- The browser never sees the provider URL before the user clicks. The start URL is on your own origin, so the popup opens inside the click handler.
- A provider event keeps the current surface until the leg ends. A webhook that arrives twice has no effect: `applyEvent()` ignores a leg that is already final.
- `applyEvent()` retries up to 3 times when a save meets a version conflict.

## Local QR payment

A QR rail such as QRIS, QR Ph, PromptPay or PayNow. The Xendit adapter returns a `QR` surface. The destination is your own merchant account. See [Merchant fiat destination](../guide/merchant-destination.md).

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant B as Browser
  participant S as Server
  participant X as Xendit adapter
  participant XP as Xendit API
  participant Bank as User's bank app
  participant App as Your backend
  Note over S: Session destination is { type: 'merchant', currency: 'IDR' }, country ID
  U->>B: Pick "QRIS" and an amount
  B->>S: POST /sessions/:id/quotes { method: 'qris', amount }
  S->>X: quote()
  X-->>S: LegQuote with the fee model of the adapter options
  S-->>B: { quotes }
  U->>B: Confirm
  B->>S: POST /sessions/:id/select { quoteId }
  S->>X: start()
  X->>XP: POST /v3/payment_requests { channel_code: 'QRIS', reference_id }
  XP-->>X: payment_request_id, actions QR_STRING
  X-->>S: LegStep requires_action, action payment with surface QR { payload, amount, currency, reference, expiresAt }, AWAIT poll
  S-->>B: Step PAYMENT
  B->>U: QR code with a countdown to expiresAt
  U->>Bank: Scan and pay
  loop AWAIT poll
    B->>S: GET /sessions/:id/step
    S->>X: status({ ref })
    X->>XP: GET /v3/payment_requests/:id
    S-->>B: Step PAYMENT
  end
  XP->>S: POST /webhooks/xendit (x-callback-token)
  S->>X: webhook.verify(), webhook.parse(): payment.capture
  S->>S: applyEvent({ ref, status: 'succeeded' })
  S->>App: session.succeeded
  B->>S: GET /sessions/:id/step
  S-->>B: Step COMPLETED
```

Other local rails:

- **VietQR, MoMo, GCash and other Swapped methods.** The Swapped adapter shows the Swapped widget in an `IFRAME` surface. The widget shows the QR code. The flow is the [fiat onramp flow](#fiat-onramp-with-redirect-or-iframe). Swapped sends order notifications to `POST /webhooks/swapped`.
- **E-wallets at Xendit.** Xendit can return a `WEB_URL` (a `REDIRECT` surface) or a `DEEPLINK_URL` (a `DEEPLINK` surface) in place of `QR_STRING`.
- **Tests and demos.** The mock adapter returns QR surfaces with no provider.

## Two-leg pathway: onramp, then Relay bridge

The user pays fiat at an onramp. The onramp buys a hop asset (USDC on Base, by default). A Relay bridge leg moves it to the destination chain and token.

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser
  participant S as Server
  participant On as Onramp adapter
  participant R as Relay adapter
  participant RA as Relay API
  participant App as Your backend
  B->>S: POST /sessions/:id/quotes { method, amount }
  S->>S: deliveryAddresses(): the last leg delivers to destination.address
  S->>R: prepareDeposit({ leg })
  R->>RA: POST /quote/v2 { useDepositAddress: true } (one per session)
  RA-->>R: open deposit address on the hop chain
  R-->>S: { address }
  S->>On: quote({ amountIn: fiat, deliverTo: Relay deposit address })
  On-->>S: LegQuote (output: USDC on Base)
  S->>R: quote({ amountIn: output of leg 0 })
  R-->>S: LegQuote (output: the destination token)
  S->>S: combineLegQuotes(): fees and ETAs add up, earliest expiry wins
  S-->>B: { quotes }
  B->>S: POST /sessions/:id/select { quoteId }
  S->>On: start() leg 0 with deliverTo = Relay deposit address
  On-->>S: LegStep requires_action with an action surface
  S-->>B: Step PAYMENT, session.payment shows 2 legs
  Note over B,On: The user pays at the onramp (see the fiat onramp flow)
  On->>S: provider webhook, leg 0 succeeded
  S->>App: leg.succeeded { index: 0 }
  S->>R: startLeg(1): start() bridge leg
  R-->>S: LegStep processing, detail waiting_for_deposit, ref = deposit address
  S-->>B: Step PROCESSING, legIndex 1
  loop AWAIT poll
    B->>S: GET /sessions/:id/step
    S->>R: status({ ref: deposit address })
    R->>RA: GET /requests/v3?depositAddress=... (v2 without apiKey)
    R-->>S: processing, or succeeded with output and a destination transaction
  end
  S->>S: composeStep(): both legs succeeded, so COMPLETED
  S->>App: leg.succeeded { index: 1 }, then session.succeeded
```

Notes:

- The Relay bridge leg has no webhook. The server learns the result from `status()`, from the browser poll or from the [background sweep](#background-sweep-and-session-expiry).
- The planner builds hops with `policy.hopPreference`. See [Pathways and legs](./pathways.md#hops).
- An exact output amount (`amountSide: 'destination'`) works on one-leg pathways only.

## Crypto transfer to a deposit address

The user sends crypto from any wallet or exchange. The Relay `transfer` leg shows a `DEPOSIT_ADDRESS` surface.

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant B as Browser
  participant S as Server
  participant R as Relay adapter
  participant RA as Relay API
  participant C as Chain RPC
  U->>B: Pick "Transfer crypto", a chain and a token
  B->>S: POST /sessions/:id/quotes { method: 'transfer', amount, source: { chain, token } }
  S->>R: quote() transfer leg
  alt source differs from the destination
    R->>RA: POST /quote/v2 { useDepositAddress: true, refundTo }
    RA-->>R: open deposit address, price
  else same chain and token
    R-->>R: the address is the destination itself (direct)
  end
  B->>S: POST /sessions/:id/select { quoteId }
  S->>R: start() transfer leg
  R-->>S: LegStep requires_action, action payment with surface DEPOSIT_ADDRESS { chain, token, address, warning }, ref = address
  S-->>B: Step PAYMENT
  U->>C: Send the token to the address from any wallet or exchange
  loop AWAIT poll
    B->>S: GET /sessions/:id/step
    S->>R: status({ ref: address })
    alt Relay route
      R->>RA: GET /requests/v3?depositAddress=address
      RA-->>R: requests created after the leg started
    else direct, EVM
      R->>C: eth_getLogs Transfer to the address since the start block
    else direct, Solana
      R->>C: getSignaturesForAddress, getTransaction
    end
    R-->>S: requires_action, processing or succeeded with output and transactions (source, destination)
  end
  S-->>B: Step COMPLETED
```

On Solana, each signature counts for one session only. Relay refunds a failed deposit-address request to the sender, when `refundTo` is `'origin'` (the default).

## Crypto payment from a connected wallet

The user pays from a wallet that the modal knows (`wagmiWallet()` or `solanaWallet()`). The Relay `wallet` leg shows a `WALLET_TX` surface.

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant B as Browser (DepositController)
  participant W as WalletAdapter (wagmi or Solana)
  participant S as Server
  participant R as Relay adapter
  participant RA as Relay API
  participant C as Chain RPC
  B->>W: getAccounts(), getBalances()
  B->>S: POST /sessions/:id/plan { walletConnected: true, walletAddress }
  U->>B: Pick "Wallet", a token and an amount
  B->>S: POST /sessions/:id/quotes { method: 'wallet', amount, source: { chain, token } }
  S->>R: quote() wallet leg
  alt cross chain or swap
    R->>RA: POST /quote/v2 (steps with transactions)
  else same chain and token
    R-->>R: direct transfer, no Relay call
  end
  B->>S: POST /sessions/:id/select { quoteId, walletAddress }
  S->>R: start({ source: { chain, token, address } })
  R-->>S: LegStep requires_action, action payment with surface WALLET_TX { chain, txs } and transition submit_tx (SURFACE_RESULT tx_hash)
  S-->>B: Step PAYMENT
  U->>B: Confirm in the modal
  B->>W: sendTransactions(chain, txs)
  W->>W: switchChain() when needed, send each tx in order
  W->>C: signed transactions
  W-->>B: { hash } of the last transaction
  B->>S: POST /sessions/:id/transitions/submit_tx { inputs: { txHash } } with Idempotency-Key
  S->>R: transition({ name: 'submit_tx', inputs })
  R-->>S: LegStep processing with a source transaction
  loop AWAIT poll
    B->>S: GET /sessions/:id/step
    S->>R: status({ ref })
    alt Relay route
      R->>RA: GET /intents/status/v3?requestId=ref
    else direct EVM
      R->>C: eth_getTransactionReceipt, eth_getBlockByNumber
      R->>R: status 0x1, block not older than the leg, amount paid to the recipient
      R->>R: mark txused so one hash completes one payment only
    else direct Solana
      R->>C: getSignatureStatuses, getTransaction
    end
    R-->>S: PROCESSING, COMPLETED or FAILED (DELIVERY_FAILED)
  end
  S-->>B: Step COMPLETED
```

The server does not trust the hash from the browser. A direct payment counts only after the on-chain checks pass. See [Security](../guide/security.md#same-chain-payments-relay).

## On-chain settlement

The destination has `settlement: { contract }`, and maybe `calls`. The Relay `wallet` leg pays through `OpenRampSettlement` on the destination chain. See [On-chain settlement](./settlement.md).

```mermaid
sequenceDiagram
  autonumber
  participant App as Your backend
  participant S as Server
  participant R as Relay adapter
  participant Sig as signSettlementIntent (your signer)
  participant B as Browser and wallet
  participant T as ERC-20 token
  participant K as OpenRampSettlement
  participant V as Call targets
  participant C as Chain RPC
  App->>S: sessions.create({ destination: { chain, token, address, settlement, calls } })
  S->>S: checkSettlement(): EVM chain, ERC-20 token, calls need settlement
  Note over S: The planner offers only pathways whose last leg has the settlement capability
  B->>S: POST /sessions/:id/select { quoteId, walletAddress }
  S->>R: start() wallet leg, same chain and token
  R->>R: settlementCallsFrom(destination.calls)
  opt the contract has an intent signer
    R->>Sig: settlementIntentTypedData({ sessionId, payer, token, recipient, minAmount, calls, deadline })
    Sig-->>R: EIP-712 signature
  end
  R->>R: buildSettlementTxs(): approve(contract, amount), then settle(settlement, intent)
  R->>C: eth_blockNumber (fromBlock for the log search)
  R-->>S: LegStep requires_action, action payment with WALLET_TX (2 txs), ref settle:...
  S-->>B: Step PAYMENT
  B->>T: approve(OpenRampSettlement, amount)
  B->>K: settle(settlement, intent)
  K->>K: _checkAndRecord(): not settled yet, intent signature, payer, deadline, minAmount
  K->>T: safeTransferFrom(payer, contract, amount)
  alt no calls
    K->>T: safeTransfer(recipient, amount)
  else call bundle
    loop each call
      K->>T: forceApprove(target, amount)
      K->>V: target.call(data)
      K->>T: forceApprove(target, 0)
    end
    K->>T: safeTransfer(recipient, leftover)
  end
  K->>K: store the receipt, emit Settled(sessionId, payer, recipient, token, amount, callsHash)
  B->>S: POST /sessions/:id/transitions/submit_tx { inputs: { txHash } }
  loop AWAIT poll
    B->>S: GET /sessions/:id/step
    S->>R: status({ ref })
    R->>C: verifySettlement(): eth_call receiptOf(sessionId)
    R->>C: eth_getLogs Settled topic and sessionId, from fromBlock
    R->>R: compare token, recipient, minAmount and callsHash
  end
  alt the receipt matches the quote
    R-->>S: succeeded with a settlement transaction (the Settled tx)
  else not settled, or a different settlement
    R-->>S: failed with DELIVERY_FAILED and a problem message
  end
  S->>App: session.succeeded or session.failed
```

The server verifies by session id. A transaction hash from the browser is not enough. Without an intent signer, another wallet can settle the session id first with other values. Then the receipt does not match, and the leg fails.

## Withdraw

A withdraw session sends a `source` asset out. The user picks the target. The funds leave with a `WALLET_TX`: the user's wallet signs it (`custody: 'user_wallet'`), or your treasury hook sends it (`custody: 'app'`). See [Withdrawals](../guide/withdraw.md).

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant B as Browser
  participant W as User wallet
  participant S as Server
  participant Scr as config.screenAddress
  participant A as Adapter (Relay or offramp)
  participant Tr as config.treasury
  participant App as Your backend
  App->>S: sessions.create({ direction: 'withdraw', source: { chain, token, custody }, allowedDestinations })
  S-->>App: { id, clientSecret }
  B->>S: GET /sessions/:id
  alt To wallet
    U->>B: Pick a network, a token and an address
    B->>S: POST /sessions/:id/target { type: 'crypto', chain, token, address }
    S->>S: parseTarget(), checkAllowed() (403 DESTINATION_NOT_ALLOWED)
    S->>Scr: screenAddress(address, chain)
    alt false
      S-->>B: 403 ADDRESS_REJECTED
    else error
      S-->>B: 503, the check fails closed
    end
  else To cash
    U->>B: Pick "To cash"
    B->>S: POST /sessions/:id/target { type: 'fiat', currency }
  end
  S->>S: targetDestination(), plan() with the source and the treasury flag
  S-->>B: PlanResult
  B->>S: POST /sessions/:id/quotes { method, amount }
  S->>A: quote({ source: withdrawSender() })
  Note over S: The sender is treasury.address for app custody, else the user's walletAddress
  B->>S: POST /sessions/:id/select { quoteId }
  S->>A: start({ source })
  A-->>S: LegStep requires_action, action payment with WALLET_TX and submit_tx
  alt custody user_wallet
    S-->>B: Step PAYMENT with WALLET_TX
    B->>W: sendTransactions(chain, txs)
    W-->>B: { hash }
    B->>S: POST /sessions/:id/transitions/submit_tx { inputs: { txHash } }
    S->>A: transition({ name: 'submit_tx', inputs })
  else custody app
    S->>S: treasuryStep(): mark the step as sent and save (idempotency key)
    S->>Tr: send({ sessionId, userId, chain, txs, idempotencyKey })
    Tr-->>S: { hash }
    S->>A: transition({ name: 'submit_tx', inputs: { txHash: hash } })
  end
  A-->>S: LegStep processing (the server adds the treasury hash as a source transaction)
  Note over A: A fiat payout completes when the provider pays the user's bank or e-wallet
  S->>A: status() or provider webhook
  S->>App: session.succeeded (direction withdraw)
```

For a fiat payout at an offramp (for example Swapped), the provider first shows its own page in an `IFRAME` for the payout details. Then a provider event carries a new `WALLET_TX` surface that pays the provider's deposit address.

A failed withdrawal attempt sends `session.payment_failed`, and the user can try again. A final failure sends `session.failed`. When the treasury hook throws `TreasuryRefusedError`, the leg fails with `PAYMENT_FAILED` and the user can try again. Any other error from the hook makes the failure final, because the funds may have left. The server never sends again for that step.

## Webhooks to your backend

The server writes each event into the session record (the outbox) in the same save as the change. It sends the event only after that save succeeds. A failed delivery stays in the outbox, and the sweep retries it.

```mermaid
sequenceDiagram
  autonumber
  participant S as Server
  participant St as Store
  participant App as Your backend
  participant Sw as sweep()
  S->>S: notify(rec, type, extra)
  alt the key type plus extra is in rec.notified
    S->>S: skip: each event goes out once per session
  else new
    S->>S: rec.notified.push(key), id = evt_ + sha256(sessionId, key)
    S->>S: rec.outbox.push({ id, body, attempts: 0 })
  end
  S->>St: queue.push(outbox, sessionId, now + 30 s)
  S->>St: put(rec, version): the change and its events in one write
  alt 409 conflict
    S->>S: nothing is sent; a retry makes the same event ids
  else saved
    S->>App: POST webhooks.url with headers webhook-id, webhook-timestamp, webhook-signature
    Note over S,App: webhook-signature = "v1," + base64 HMAC-SHA256(secret, id.timestamp.body), timeout 4 s
    App->>App: openramp.webhooks.verify(req, rawBody), 300 s tolerance
    App->>App: dedupe by event id or session id, then credit
    S->>St: put(rec, version): remove the sent events, or attempts + 1
  end
  loop every sweep
    Sw->>St: queue.claim(outbox, limit, lease 10 min)
    Sw->>St: get(sessionId), events where nextAt has passed
    Sw->>App: POST the same body with the same event id
    alt 2xx
      Sw->>St: remove the event
    else fails, inside retryHours (default 24 h)
      Sw->>St: attempts + 1, nextAt = now + backoff (30 s doubling, max 2 h)
    else fails, retryHours passed (or maxAttempts reached)
      Sw->>St: keep it as a dead letter (deadAt) and log an error
    end
    Sw->>St: queue.ack(sessionId) when no event is left, else queue.push(sessionId, next due time)
  end
```

Delivery is at least once. A retry, or a lease that ends during a slow sweep, can send one event twice, and a repeat has the same event id. Credit the user once per event id or session id. See [Webhooks to your backend](../guide/webhooks.md).

## Background sweep and session expiry

Run `openramp.sweep()` from a cron job, or call `POST /tasks/sweep` with `tasksToken`. It keeps sessions moving after the user closes the tab.

```mermaid
sequenceDiagram
  autonumber
  participant Cron as Scheduler (Cron Trigger, Vercel Cron)
  participant S as Server
  participant St as Store
  participant A as Adapter
  participant App as Your backend
  Cron->>S: POST /tasks/sweep?limit=50 (Authorization: Bearer tasksToken)
  alt no tasksToken configured
    S-->>Cron: 404
  else wrong token
    S-->>Cron: 401
  end
  S->>St: 1. retry the webhook outbox (see the webhooks flow)
  S->>St: 2. queue.claim(open-sessions, limit, lease 10 min): the entries that waited longest
  loop each claimed session
    S->>St: get(id)
    alt past expiresAt, and no payment, or the leg still waits for the user
      S->>S: expire(): status expired, step EXPIRED, SESSION_EXPIRED
      S->>St: save
      S->>App: session.expired
    else payment in progress, or earlier attempts that still wait
      S->>A: refreshActive(force), then refreshAttempts(): status({ leg, ref })
      A-->>S: new LegStep
      S->>St: save when changed (may start the next leg or complete)
    end
    S->>St: queue.ack(id) when final, else queue.push(id, now): back of the line
  end
  S-->>Cron: SweepResult { webhooks, sessions }
```

Other expiry paths:

- `loadAuthed()` expires a `requires_payment_method` session (no payment in progress, also after a failed attempt) on the next browser request after the deadline, and sends `session.expired`.
- After the deadline, `plan`, `target`, `quotes`, `select` and the `restart` transition answer `410 SESSION_EXPIRED`. A payment in progress can still finish.
- A leg can end as `expired`, for example a QR code that nobody paid. Then the step is `EXPIRED`.

## AI agent via MCP

`@openrampkit/mcp` lets an agent create a deposit, send a pay link to a person, and wait for the result. See [Agents (MCP)](../guide/agents.md).

```mermaid
sequenceDiagram
  autonumber
  participant Ag as AI agent
  participant M as MCP server (openrampkit-mcp)
  participant S as OpenRampKit server
  participant H as config.authorize
  actor Per as Person
  participant Pg as Pay page (browser)
  participant App as Your backend
  Ag->>M: create_deposit_session { country, destination, max_amount, reference }
  M->>M: guardrails: resolveDestination() from the allowed list, resolveBounds() under the caps
  M->>S: POST /sessions with the x-app-key header
  S->>H: authorize(req, body) checks the app key
  S-->>M: { id, clientSecret, expiresAt }
  M->>M: registry.set(id, clientSecret)
  M->>S: POST /sessions/:id/pay-link (Bearer clientSecret)
  S-->>M: { url: baseUrl/pay/credential, expiresAt }
  opt method and amount given
    M->>S: POST /sessions/:id/plan, /quotes, /select
    S-->>M: Step with a QR, bank fields, address or redirect
  end
  M-->>Ag: { session_id, pay_url, bounds, payment, next }
  Ag->>Per: Show pay_url as a link or a QR code
  Per->>Pg: Open pay_url on a phone
  Pg->>S: GET /pay/:credential
  S->>S: checkPayCredential(): HMAC and expiry
  S-->>Pg: HTML with a strict CSP, imports @openrampkit/web
  Pg->>Pg: openDeposit({ baseUrl, clientSecret: credential, embedded: true })
  Pg->>S: the normal deposit flow, Bearer credential
  Per->>Pg: Pick a method and pay
  Ag->>M: wait_for_completion { session_id }
  loop every pollIntervalMs (3 s), up to timeout_seconds (default 60, capped by maxWaitSeconds)
    M->>S: GET /sessions/:id/step
  end
  S->>App: session.succeeded with metadata.reference
  M-->>Ag: status completed, or timed_out with a next hint
```

In-process mode (`connection: { openramp }`) skips HTTP: the MCP server calls `openramp.sessions.create()` and `openramp.handle()` directly. A pay link cannot make another pay link.

## Iframe message protocol

A provider page inside an `IFRAME` surface can post messages to the modal. The modal treats them as hints. The server status decides the outcome.

```mermaid
sequenceDiagram
  autonumber
  participant P as Provider page (iframe)
  participant E as openramp-modal (window message listener)
  participant C as DepositController
  participant S as Server
  Note over E: The listener is on only while an IFRAME step is on screen
  P->>E: window.postMessage(data)
  E->>E: origin = iframeOrigin(surface): messages.origin, else surface.origin
  alt event.origin differs from origin
    E->>E: ignore
  else event.source is not this iframe's contentWindow
    E->>E: ignore
  else checks pass
    E->>E: classifyIframeMessage(data, surface.messages)
    Note over E: JSON strings are parsed. Generic form: { source: 'openramp-embed', type: 'payment.completed' | 'payment.failed' | 'closed' }. Else data[typeField] is matched to completed, failed and closed.
    alt no match
      E->>E: ignore
    else completed, failed or closed
      E->>C: notifySurface(kind, { origin })
      C->>C: emit surface.message
      opt kind is closed
        C->>C: surfaceClosed = true (offer "Try again" or "Choose another method")
      end
      C->>S: pollNow(): GET /sessions/:id/step
      S-->>C: Step from the provider status
    end
  end
```

The server also checks the surface before the browser sees it: an `IFRAME` needs an `https:` `url` and `origin` (`http:` in test mode too). `PROVIDER_SDK` renderers (for example `stripeOnrampRenderer()`) follow the same rule: their `completed()` and `failed()` callbacks only start a status check.
