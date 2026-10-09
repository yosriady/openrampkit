# Features

This page lists every feature of OpenRampKit, with a link to its documentation. For how the parts fit together, read [Architecture](../concepts/architecture.md). For the step-by-step flows, read [Flows](../concepts/flows.md).

## Deposits

| Feature | What it does | Read more |
|---|---|---|
| Crypto destination | The money ends as a token on a chain, at an address that your backend sets | [Sessions](../concepts/sessions.md), [Pathways](../concepts/pathways.md#destination) |
| Merchant destination | The money ends in your own fiat account at a payment provider (Xendit). No crypto. | [Merchant fiat destination](./merchant-destination.md) |
| On-chain settlement | The payment goes through `OpenRampSettlement`. The chain records the session id. | [On-chain settlement](../concepts/settlement.md), [flow](../concepts/flows.md#on-chain-settlement) |
| Destination calls | Contract calls after delivery, in the same transaction (for example a vault deposit) | [Destination calls](../concepts/settlement.md#destination-calls) |
| Signed settlement intents | Your server signs an EIP-712 intent. The payer cannot change the recipient, token or calls. | [Signed intents](../concepts/settlement.md#signed-intents) |
| Fiat onramps | Card, bank and local methods at Coinbase, Transak, MoonPay, Stripe, Swapped, Meld, Onramper | [Adapters](../adapters/), [flow](../concepts/flows.md#fiat-onramp-with-redirect-or-iframe) |
| Local QR and e-wallets | QRIS, QR Ph, PromptPay, PayNow, VietQR, GCash, MoMo and more | [Xendit](../adapters/xendit.md), [Swapped](../adapters/swapped.md), [flow](../concepts/flows.md#local-qr-payment) |
| Crypto transfer | The user sends crypto from any wallet or exchange to a deposit address | [Relay](../adapters/relay.md), [flow](../concepts/flows.md#crypto-transfer-to-a-deposit-address) |
| Wallet payment | The user pays from a connected EVM or Solana wallet. Relay bridges or swaps when needed. | [Wallets (wagmi)](../adapters/wagmi.md), [Solana](./solana.md), [flow](../concepts/flows.md#crypto-payment-from-a-connected-wallet) |
| Two-leg pathways | An onramp buys a hop asset, then a Relay bridge moves it to the destination | [Hops](../concepts/pathways.md#hops), [flow](../concepts/flows.md#two-leg-pathway-onramp-then-relay-bridge) |
| Peer-to-peer onramp | Fiat to crypto through Peer | [Peer](../adapters/peer.md) |

## Withdrawals

| Feature | What it does | Read more |
|---|---|---|
| To wallet | The user sends the source asset to an address on a network they pick | [To wallet](./withdraw.md#to-wallet) |
| To cash | The user gets fiat in their own bank or e-wallet account | [To cash](./withdraw.md#to-cash) |
| User custody | The user's wallet signs the transaction (`custody: 'user_wallet'`) | [Custody](./withdraw.md#custody) |
| App custody | Your treasury hook sends the transaction (`custody: 'app'`), once per step | [custody: 'app'](./withdraw.md#custody-app) |
| Allowed targets | Limit the chains or currencies that a user can pick | [Allowed targets](./withdraw.md#allowed-targets) |
| Address screening | Your `screenAddress` hook refuses an address. An error also refuses it. | [Screen addresses](./withdraw.md#screen-addresses) |
| Withdraw events | `withdrawal.completed`, `withdrawal.failed` and `withdrawal.reversed` next to the session events | [Events](./withdraw.md#events) |

See the [withdraw flow](../concepts/flows.md#withdraw).

## Planning and quotes

| Feature | What it does | Read more |
|---|---|---|
| Pathway planner | A pure function builds every one-leg and two-leg pathway to the destination | [The planner algorithm](../concepts/pathways.md#the-planner-algorithm) |
| Method groups | Methods show as Connected, Most popular, Other options and Not available | [Grouping](../concepts/pathways.md#grouping) |
| Country rules | Region policy per leg, local methods first per country | [Method country rules](../concepts/pathways.md#method-country-rules) |
| Global payment methods | SEPA Instant, Faster Payments, pay by bank, iDEAL, Bancontact, BLIK, SPEI, PSE, Khipu, Interac, IMPS, PayID, M-Pesa and mobile money, next to cards, Apple Pay, Google Pay, ACH, Pix and UPI | [Payment methods](../concepts/payment-methods.md) |
| Policy | `maxLegs`, `regions`, `methodPriority`, `disabledMethods`, `hopPreference` | [createOpenRamp](../api/server.md#createopenramp-config) |
| Per-session method list | `allowedMethods` hides and blocks other methods | [Sessions](../concepts/sessions.md#creating-a-session) |
| Amount bounds | A min and a max per session, enforced on quotes and on select | [Amount bounds](../api/server.md#amount-bounds) |
| Live catalogs | An adapter can refine its legs per user (methods, limits, assets) | [Writing an adapter](../adapters/writing-an-adapter.md) |
| Parallel quotes | Up to 5 pathways per method, each with a timeout. Failures are fields, not exceptions. | [Quoting](../concepts/pathways.md#quoting) |
| Ranking | Best price and fastest badges | [Quoting](../concepts/pathways.md#quoting) |
| Exact output | Quote the amount that arrives (`amountSide: 'destination'`) on one-leg pathways | [POST /sessions/:id/quotes](../api/http.md#post-sessions-id-quotes) |

## Flow and UI

| Feature | What it does | Read more |
|---|---|---|
| Server-driven steps | The server sends a `Step`. The modal renders it. A new provider needs no UI release. | [Flow state machine](../concepts/flow.md) |
| Ten surfaces | `REDIRECT`, `IFRAME`, `PROVIDER_SDK`, `QR`, `DEEPLINK`, `BANK_FIELDS`, `DEPOSIT_ADDRESS`, `WALLET_TX`, `OTP`, `FORM` | [Surfaces](../concepts/surfaces.md) |
| Popup-safe start URLs | Provider checkouts open from a signed URL on your origin | [Popup-safe start URLs](../concepts/sessions.md#popup-safe-start-urls) |
| Iframe message protocol | Provider pages can signal completion. The modal checks origin and source. | [Iframe flow](../concepts/flows.md#iframe-message-protocol), [IFRAME](../concepts/surfaces.md#iframe) |
| Provider SDK renderers | Mount a provider's own UI, for example the Stripe onramp element | [PROVIDER_SDK](../concepts/surfaces.md#provider-sdk), [Stripe](../adapters/stripe.md) |
| Restart | "Choose another method" leaves a payment that waits for the user | [Transitions](../concepts/flow.md#transitions) |
| Errors as fields | `OrkError` with a code, a safe message and a recovery hint | [Errors as fields](../concepts/flow.md#errors-as-fields) |
| Web component | `<openramp-modal>` in Shadow DOM, for any framework or none | [Web component](./web-component.md), [@openrampkit/web](../api/web.md) |
| Embedded mode | Render the widget inline in your page | [Embedded mode](./web-component.md#embedded-mode) |
| Framework wrappers | React, Vue, Svelte and Solid | [React](../api/react.md), [Vue](../api/vue.md), [Svelte](../api/svelte.md), [Solid](../api/solid.md) |
| Headless controller | Drive `DepositController` with your own UI | [@openrampkit/client](../api/client.md), [Custom UIs](../concepts/surfaces.md#custom-uis) |
| Themes | Light, dark and auto themes, appearance options, CSS variables and parts | [Theming](./theming.md) |
| Languages | English, Vietnamese, Indonesian, Thai, Malay and Filipino. English unless the app sets a locale. | [Languages](./theming.md#languages) |
| Browser events | `modal.opened`, `method.selected`, `quote.selected`, `step.changed` and more, for analytics | [Browser events](../concepts/events.md#browser-events) |

## Wallets and chains

| Feature | What it does | Read more |
|---|---|---|
| EVM wallets | `wagmiWallet()` sends transactions and reads balances | [Wallets (wagmi)](../adapters/wagmi.md) |
| Solana wallets | `solanaWallet()` over Wallet Standard | [Solana](./solana.md#pay-from-a-solana-wallet) |
| Several wallets | `combineWallets()` joins an EVM and a Solana wallet | [Solana](./solana.md) |
| Solana destinations | Deposits to SOL and SPL tokens | [Send deposits to Solana](./solana.md#send-deposits-to-solana) |
| Tempo | Chain and token support for Tempo | [Tempo](../concepts/chains.md#tempo) |
| On-chain verification | Same-chain payments are checked on chain before a leg counts | [Security](./security.md#same-chain-payments-relay) |

## Server

| Feature | What it does | Read more |
|---|---|---|
| One web-standard handler | `Request` to `Response`. Runs on Workers, Vercel, Node, Bun and Deno. | [@openrampkit/server](../api/server.md), [HTTP routes](../api/http.md) |
| Sessions and client secrets | The backend fixes user and destination. The browser gets a scoped secret. | [Sessions and security](../concepts/sessions.md), [flow](../concepts/flows.md#session-creation) |
| Browser-created sessions | Optional `POST /sessions` through your `authorize` hook | [Browser-created sessions](../concepts/sessions.md#browser-created-sessions-optional) |
| Provider webhooks in | `POST /webhooks/:adapterId`, verified by the adapter | [Provider webhooks](./webhooks.md#provider-webhooks) |
| Signed webhooks out | HMAC-signed events to your backend, with an outbox and retries | [Webhooks to your backend](./webhooks.md), [flow](../concepts/flows.md#webhooks-to-your-backend) |
| Background sweep | Retries webhooks, refreshes payments, expires sessions | [Background sweep](../api/server.md#background-sweep), [flow](../concepts/flows.md#background-sweep-and-session-expiry) |
| Pay links | A signed, expiring page where a person pays one session | [POST /sessions/:id/pay-link](../api/http.md#post-sessions-id-pay-link), [GET /pay/:credential](../api/http.md#get-pay-credential) |
| Idempotency | `Idempotency-Key` on `select` and transitions | [Idempotency](../concepts/sessions.md#idempotency) |
| Rate limits | Provider calls per session per minute | [Limits](../api/http.md#limits) |
| Health checks | `GET /health`, and a deep check with the tasks token | [GET /health](../api/http.md#get-health) |
| CORS | Allow other origins to call the handler | [CORS](../api/http.md#cors) |
| Session stores | Durable Objects, Redis, Cloudflare KV, memory, or your own | [Session stores](../deploy/stores.md) |
| Test and live mode | `livemode` on sessions and events | [Events](../concepts/events.md#envelope) |

## Agents

| Feature | What it does | Read more |
|---|---|---|
| MCP server | Tools for an AI agent: `list_payment_methods`, `get_quotes`, `create_deposit_session`, `create_withdraw_session`, `get_session_status`, `wait_for_completion` | [Agents (MCP)](./agents.md#tools) |
| Guardrails | Allowed destinations and amount caps that the agent cannot change | [Guardrails](./agents.md#guardrails) |
| Transports | stdio (Claude Desktop, Claude Code) and Streamable HTTP | [Connect an agent](./agents.md#connect-an-agent) |

See the [agent flow](../concepts/flows.md#ai-agent-via-mcp).

## Adapters and testing

| Feature | What it does | Read more |
|---|---|---|
| 10 provider adapters and a mock | Relay, Swapped, Xendit, Coinbase, Transak, MoonPay, Stripe, Meld, Onramper, Peer, Mock | [Adapters](../adapters/) |
| `createAdapter()` | Write an adapter for any provider | [Writing an adapter](../adapters/writing-an-adapter.md), [@openrampkit/adapter](../api/adapter.md) |
| Conformance kit | `runAdapterConformance()` checks an adapter's shape, quotes, steps and webhooks | [@openrampkit/adapter](../api/adapter.md) |
| Mock adapter and mock wallet | Test every flow with no provider account | [Testing with mocks](./testing.md) |
| Anvil test | A real local chain test for wallet payments | [Real-chain test with Anvil](./testing.md#real-chain-test-with-anvil) |
| Examples | Next.js, Cloudflare Worker, static playground, agent | [Examples](./examples.md), [Live demo](./playground.md) |
