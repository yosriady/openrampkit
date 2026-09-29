# OpenRampKit: scope (v1, updated 2026-09-29)

> RainbowKit for money movement. One open-source modal that lets users put money into your app and take it out again. Local payment methods are first-class. You bring your own provider accounts, and nobody takes a cut.

Status: research done, scope set, spec written ([spec](./spec.md)). No code yet. Decisions that are still open are at the end.

Related:
- [Spec](./spec.md): detailed spec and phased implementation plan
- [Landscape](./landscape.md): market research and competitor teardowns
- Diagrams: https://claude.ai/artifact/YVe96tnDr1LhAyonwzdteV (private until shared)

---

## 1. Problem

Every app that holds a user balance needs a "Deposit" button and a "Withdraw" button. Building them is hard:

- Each rail is a separate integration: card onramps (MoonPay, Transak, Stripe, Coinbase), bank transfer, local QR (QRIS, PromptPay, QRPh, DuitNow, VietQR), e-wallets (GCash, MoMo, GoPay), exchange connect, wallet transfer and deposit address.
- Each provider has its own KYC flow, region rules, limits, quote format, surface (redirect, iframe, SDK, QR) and webhook format.
- No single onramp covers the world. Coverage, price and approval rates change by country and by method.
- In emerging markets, cards do not work. Card ownership is 3% in PH, 4.6% in IN, 5.8% in VN and 5.9% in ID (D0, Aug 2026). People pay with local QR codes and e-wallets.
- Many target chains are not listed by any onramp. The only way to reach them is to buy on a listed chain and bridge (the "hop").

## 2. Market

The industry has three layers (Harry Alford, Monad Foundation, "The Deposit Stack, Explained for Founders", Sep 2026):

1. **Fiat onramps** (licensed, fiat to crypto): Swapped, Transak, MoonPay, Coinbase, Stripe. Aggregators: Onramper, Meld.
2. **Crypto deposit** (crypto to crypto): Relay, LI.FI, Blink, Daimo Pay.
3. **Unified deposit** (one integration for the whole flow): fun.xyz, Unifold, Calm, D0, Privy funding.

OpenRampKit is a layer-3 product with a different model: open source, self-hosted, and with the app's own provider keys.

| Unified player | Model | Open? | Fee | SEA local rails | Fiat out |
|---|---|---|---|---|---|
| fun.xyz | Hosted. RainbowKit fork. Polymarket, Lighter, Ostium | npm "MIT", repo private | bps app fee on each Relay route | Via Swapped | Via Swapped |
| Unifold (YC W26) | Hosted. Deposit addresses + hop. React, RN, Solid, Svelte, web | npm MIT / Apache-2.0, repo private | `platform_fee_percent` on each deposit | None | None |
| D0 | Hosted cashier. Merchant server creates the session | UNLICENSED | Not public | QRPh, PromptPay, DuitNow, QRIS | Yes |
| Privy | Inside the Privy wallet SDK. Stripe + Meld/MoonPay/Coinbase | No | Not public | Via Meld | Yes |
| Blink | Crypto deposit only | npm MIT, repo private | 0.33 to 1 bp | None | No |

**The gap:** no one offers a provider-neutral deposit and withdraw kit that is open source, self-hosted, works with any wallet stack (or none), and has SEA rails and merchant fiat accounts built in.

## 3. Product thesis

OpenRampKit is an MIT-licensed SDK. The app brings its own provider accounts. OpenRampKit gives it:

1. **A drop-in modal** (Deposit / Withdraw) with RainbowKit-level polish, themes, and a "Use Crypto / Use Cash" switch.
2. **Headless hooks and a framework-free core**, for apps that draw their own UI.
3. **A server package** that holds provider secrets, creates signed sessions, plans pathways, runs legs, and normalizes webhooks.
4. **Adapters** for providers, like wagmi connectors. Anyone can publish one, and a shared test kit checks it.

Four key ideas:

- **The destination is a parameter.** A deposit ends at a crypto address (crypto apps) or in the merchant's own fiat account (any app). One modal, one state machine and one event stream serve both.
- **Pathways are explicit.** A pathway is a chain of one to three legs (for example: GCash, then Swapped to USDC on Polygon, then Relay to USDC on Monad). The app can inspect each leg's quote, fee and status.
- **No custody by us.** Funds move directly between the user, the providers, Relay deposit addresses and the app's own addresses or accounts. OpenRampKit is software, not a money transmitter. The provider that the app contracts with is the regulated party.
- **No platform fee.** The app can add its own fee (for example through Relay `appFees`) and keeps all of it.

## 4. Who it is for (in order)

1. **Crypto apps that take deposits** (perps, prediction markets, onchain games, RWA, new chains). Pain: vendor lock-in, bps fees on every deposit, and no rails for their chain.
2. **SEA consumer apps with a stored balance** (wallet top-up, marketplaces, games, creators). They need QRIS, PromptPay, QRPh, DuitNow and VietQR pay-in, and bank or e-wallet payout. Today they build Xendit or 2C2P screens by hand.
3. **Wallet and infra teams** that want a ramp without adopting a whole vendor stack.
4. **Chain ecosystems** (for example Monad) that want fiat access for their apps on day one.

## 5. What we take from each teardown

| Idea | Source | Why |
|---|---|---|
| Server-driven steps: the server sends `{state, transitions}`, the client only draws; errors are fields; the terminal flag comes from a table stored as data | fun.xyz `@fun-xyz/fiat-contract` | Handles KYC and provider differences without client releases |
| Method picker: connected, recommended, more, unavailable (with a reason); limit and time on each row | fun.xyz | Proven at Polymarket scale |
| Deposit address as the middle step, with a watcher that settles to the destination | Unifold, fun.xyz | The cleanest model for "onramp, then bridge" and for unlisted chains |
| Relay open deposit addresses (reusable per route, variable amounts, Relay watches and fills) | Relay docs | Gives us deposit addresses without running a watcher or holding keys |
| Session created by the app's server, bound to user and destination | D0, Stripe | Secrets stay on the server, and the destination cannot be changed in the browser |
| "Use Crypto / Use Cash" switch; one QR rail per currency | D0, fun.xyz | Clear for SEA users |
| Appearance playground as the demo site | D0 | Shows theming in seconds; best sales tool |
| Small, versioned embed protocol | D0 | Same events in iframe and in-page modes |
| Layers: controller with no framework, then hooks, then modal; thin framework wrappers | Unifold | Cheap support for React, Vue, Svelte, Solid and plain web |
| `begin()` returns a Promise; one event envelope shared by modal, hooks and webhooks | Unifold, Stripe | Easy to integrate and to track |
| Popup-safe start URL: the browser opens it at once, the server redirects | Unifold | Popup blockers do not break provider redirects |
| Flags resolved as "prop, then server config, then default", with a hard server switch | Unifold, fun.xyz | Safe per-country rollout |
| Theme tokens, `Custom` render prop, modal shell | RainbowKit (MIT) | The design language that developers already know |

We copy **ideas**, not code. fun.xyz and Unifold publish MIT or Apache-2.0 bundles, but their repos are private. D0 is UNLICENSED. RainbowKit code may be reused with its MIT notice.

## 6. Decisions made

| Decision | Choice | Reason |
|---|---|---|
| Fork RainbowKit? | **No.** Borrow its patterns and specific files with the MIT notice | Wallet connection is not our product. Non-crypto apps must work without wagmi. Most apps already have a wallet stack |
| Base the code on D0? | **No.** Copy its ideas | Its code is UNLICENSED and tied to D0's API |
| Wallet access | A small `WalletAdapter` interface. The first implementation is `@openrampkit/wagmi` | Works next to RainbowKit, Privy, Dynamic and Reown |
| Deposit addresses | Relay open deposit addresses by default. The app can also give its own address | No custody, no watcher to run in v1 |
| Extensibility | Provider adapters, like wagmi connectors, with a public test kit | Third parties can add providers and legs without forking |
| Hosting | Self-hosted server package that runs on Node, edge and serverless | "Open" must mean the app owns the flow |
| License | MIT | Same as RainbowKit, for maximum adoption |
| Org and names | GitHub `openrampkit`, npm scope `@openrampkit` | `openrampkit` is free. `openramp` belongs to an inactive 2022 org. "RampKit" is taken |

## 7. Scope of v1 (first public release)

### 7.1 Packages

| Package | Contents |
|---|---|
| `@openrampkit/core` | Types, money helpers, CAIP ids, ISO codes and method codes (with SEA methods), region policy, flow table, pathway planner, ranking, event envelope, errors. No dependencies |
| `@openrampkit/adapter` | The adapter API (`createAdapter`, leg specs, capability flags) and `@openrampkit/adapter-testkit` |
| `@openrampkit/server` | HTTP handler (Web `Request`/`Response`), session store interface, signed sessions, idempotency, planner runtime, leg runner, webhook intake, outbound webhooks. Bindings for Next.js, Hono and Express |
| `@openrampkit/client` | Framework-free controller (`getSnapshot`, `subscribe`, `begin`) and API client |
| `@openrampkit/react` | Provider, headless hooks, modal, `DepositButton` and `DepositButton.Custom`, themes, i18n |
| `@openrampkit/wagmi` | `WalletAdapter` for wagmi (connected wallet balance, sign and send) |
| `@openrampkit/adapter-*` | First-party adapters (list below) |

### 7.2 Pathways in v1

| Pathway | Destination | Legs | Adapters |
|---|---|---|---|
| Pay from connected wallet | crypto | `wallet_transfer`, or `bridge_swap` | wagmi + Relay |
| Transfer crypto (address + QR) | crypto | user sends to a Relay open deposit address, then Relay fills | Relay |
| Card, Apple Pay, Google Pay | crypto | `fiat_onramp`, plus `bridge_swap` if the destination is not listed | Coinbase, Transak |
| SEA local methods (VietQR, MoMo, GCash, GoPay, DANA, OVO, Touch 'n Go, PromptPay...) | crypto | `fiat_onramp` via Swapped, then Relay | Swapped + Relay |
| SEA local QR to the merchant account (QRIS, QRPh, PromptPay, DuitNow, VietQR) | merchant | `fiat_payin` | Xendit (coverage to verify) |
| Withdraw to an address | crypto | host signs, then Relay | wagmi + Relay |

Minimum for a public alpha: wallet, transfer crypto, Coinbase, Transak, Swapped and Xendit. This covers crypto and non-crypto apps and the main SEA rails.

### 7.3 Out of scope for v1

- Holding funds, custody, or any licensed activity. We store no KYC data.
- A hosted OpenRampKit backend (a possible later product; see open decisions).
- Our own bridge or solver. We call Relay (and LI.FI later).
- Our own wallet connection.
- Fiat offramp to a user's bank through onramp providers (phase 5).
- React Native (phase 5; the core stays DOM-free so it can port).
- Fraud scoring, chargebacks, tax reports, card issuing.

## 8. Success metrics

- Time to the first sandbox deposit in the example app: under 15 minutes.
- 3 design partners live by the public alpha: at least 1 crypto app, 1 SEA app with a merchant destination, and 1 new chain.
- Deposit funnel completion per country, method and provider, reported through `onEvent`.
- Community adapters: at least 2 published by third parties within 3 months of the alpha.
- GitHub stars and weekly npm downloads, as a proxy for "default choice".

## 9. Risks

| Risk | Plan |
|---|---|
| Provider access needs applications (Stripe, Coinbase CDP, Swapped, Xendit) | Apply in phase 0. Build against recorded fixtures until approved |
| Each user must create a Swapped account (extra login, KYC for larger amounts) | Show it in the UI as a clear step. Offer Transak or other options side by side |
| VND and other local rails depend on the provider's local partners and can switch off | Show methods from live provider catalogs, not hardcoded lists. Health-check them |
| Relay deposit address edge cases (wrong token, wrong chain, underpayment) | Always set `refundTo`. Show chain and token warnings. Document recovery |
| Legal: must stay "software, not money transmitter" | No custody. The app contracts the providers. Get a legal review before the alpha |
| Adapter maintenance cost | Contract tests, nightly sandbox runs, and community ownership of long-tail adapters |
| Competitors with funding (Unifold, fun.xyz) | Compete on openness, zero fee, self-hosting and SEA. Do not try to match their provider count |

## 10. Open decisions

1. **Business model.** Pure open source, or open core with an optional hosted "OpenRamp Cloud" (managed webhooks, quote cache, routing analytics, provider referral revenue)? This does not block phases 0 to 3.
2. **Provider accounts.** Which providers can we open sandbox accounts with first: Swapped, Transak, Coinbase CDP, Xendit?
3. **Analytics.** Should the funnel events map to Formo's event schema out of the box?
4. **npm scope.** Reserve `@openrampkit` on npmjs.com. The automated check could not confirm it.
