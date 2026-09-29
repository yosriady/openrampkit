# Market research: deposit and ramp landscape (2026-09-29)

Sources are linked inline. "Not verified" marks claims we could not confirm. Local code snapshots (not for publishing): `~/funkit-reference`, `~/d0fi-reference`, `~/unifold-reference`. Diagrams: https://claude.ai/artifact/YVe96tnDr1LhAyonwzdteV

## Industry map

From "The Deposit Stack, Explained for Founders" (Harry Alford, Monad Foundation, 2026-09-08, https://x.com/HarryAlford3/status/2097348116303270094):

- **Fiat onramps** convert fiat to crypto and are licensed: Swapped, Transak, Onramper, Meld (the last two are aggregators).
- **Crypto deposit** solutions move crypto to crypto, mostly stablecoins: Blink, Relay (liquidity and deposit addresses under many apps).
- **Unified deposit** solutions sit on top of both: fun.xyz, Unifold, Calm. They aggregate fiat ramps by geography behind one UX.
- Advice in the article: most founders should start with a unified provider and build in-house only when deposits are a proven bottleneck. Fomo built its own flow (deposit addresses plus Crossmint and Coinbase by geography).

## Unified deposit players

### fun.xyz
- Products: Deposit, Withdraw, Orchestration, Checkout. Claims "$18B+ volume/yr". Customers: Polymarket, Lighter, Ostium, Ventuals, plus about 50 customer keys hardcoded in `@funkit/api-base`.
- SDK: `@funkit/connect` is a RainbowKit fork (theme attribute `data-rk`, RainbowKit strings, about 50 wallet connectors). npm says MIT; the repo (github.com/fun-xyz/funkit) is private. Source maps include full TypeScript for `connect-core`, `api-base`, `fun-relay`.
- Backend: `api.fun.xyz/v1` and `frog.fun.xyz`, public `X-Api-Key` in the browser.
- Money moves by direct execution (wallet signs Relay steps) or a per-user deposit address that Fun watches and routes through Relay.
- Rails: wallet, transfer (10 chains), Meld card, Swapped (card, Apple Pay, Google Pay, SEPA, Venmo, Revolut, and local methods such as VietQR, MoMo, GCash, GoPay, DANA, OVO, Touch 'n Go, PromptPay, PIX), Bluvo (Coinbase), Bridge.xyz virtual bank, Lightning (Flashnet), headless fiat v2 (Transak, Swapped, Banxa, MoonPay, Stripe, Coinbase, Crossmint).
- Headless fiat contract `@fun-xyz/fiat-contract` (first published 2026-08): server-driven steps, transition table as data, errors as fields. Best design idea in the category.
- Fee: bps from `frog.fun.xyz/api/fee`, added as Relay `appFees` to Fun's wallet.
- Withdraw: wallet (Relay), custom callbacks (Lighter, Nado, Hypercore, Solana), fiat via Swapped CRYPTO_TO_FIAT.
- Legal: "technology only"; partners hold the licenses.

### Unifold (unifold.io)
- YC W26, Robinhood Ventures. Launch partner for Robinhood Chain and USDG. Case study: Alpha Arcade (Algorand).
- npm: `@unifold/core` (MIT), `headless-react` and `connect-react` (Apache-2.0), `ui-react`, `ui-web`, `connect-react-native`, `connect-solid`, `connect-svelte`, `node`. Repos private. Docs behind a login.
- Browser uses a publishable key only. Server uses `sk_` keys. Webhooks are HMAC signed.
- Deposit addresses per user and destination; a "direct execution" swaps and bridges through Relay. The "hop" buys on a chain the onramp supports and bridges to unlisted chains.
- Rails: transfer, wallet (own EIP-6963 connector, no wagmi), card (Meld, Banxa, UPI via Onramp Money and Onmeta), Apple Pay and Google Pay via Coinbase (US only), Stripe Link, bank (SEPA, US ACH, wire, RTP via HiFi), Interac (PayTrie), Cash App, Coinbase and Binance.
- No SEA rails. Withdraw is crypto only; no fiat payout.
- Fee: `platform_fee_percent` on deposits for paying orgs; pricing is "talk to sales".

### D0 (d0fi.com)
- Payment infrastructure for onchain trading platforms in emerging markets. Private beta. YZi Labs EASY Residency S4.
- SDK `@d0fi/checkout-react` 0.3.1 (UNLICENSED, first published 2026-09-04). Demo: https://demo.d0fi.com/
- The merchant backend creates a session (`POST /v1/checkout/sessions`); the widget renders in page or in a hosted iframe with a versioned postMessage protocol.
- Own wallet layer (EIP-6963, Wallet Standard, Privy), plus RainbowKit and AppKit shims and a codemod to migrate off them.
- Fiat pay-in through "SetlPay QR": PH QRPh, TH PromptPay, MY DuitNow, ID QRIS. Fiat payouts with a 16-value status model.
- The D0 article gives card ownership: PH 3%, IN 4.6%, VN 5.8%, ID 5.9%.

### Privy
- 2026-07-07: global fiat onramps. Stripe Crypto Onramp for US and EU; Privy's aggregator (Meld, MoonPay, Coinbase) for 100+ other countries. `useFiatOnramp().fund(...)` in `@privy-io/react-auth`. Works only with Privy wallets. https://privy.io/blog/introducing-global-fiat-onramps

### Calm
- Named as a unified deposit player in the Alford article. Not studied.

## Crypto deposit layer

### Relay (relay.link)
- Cross-chain swaps, bridges and calls on 69+ chains (EVM, Solana, Bitcoin, Hyperliquid, Lighter and more). Solvers fill on the destination from their own funds and are repaid through Relay's settlement protocol.
- Fees: $0.02 plus destination gas; platform fee 0% (same-token bridge), 0.01% (stablecoin swap), 0.06% (major), 0.15% (minor). Revenue share for integrators above $10M a month.
- App fees in bps with an EVM claim address, collected as a USDC balance.
- Deposit addresses: `useDepositAddress: true` on `/quote/v2`. Open addresses take variable amounts and are reusable per route. Strict addresses are bound to one order and need `refundTo`.
- Docs: https://docs.relay.link

### Blink (docs.blink.cash)
- Crypto-only deposit modal on Privy, Turnkey or Dynamic. `@swype-org/deposit` (npm MIT, source private). Merchant-signed deposit links; iframe modal. Relay likely underneath (inferred). Fees 0.33 to 1 bp by volume.

### Others
- LI.FI (widget Apache-2.0), Daimo Pay (`@daimo/pay`, open source).

## Fiat onramps and aggregators

### Swapped (swapped.com)
- Licensed onramp and offramp. Swapped ApS (Denmark, also FINTRAC), Swappedcom Inc. (FinCEN, NMLS), Northstake ApS (MiCA CASP), AUSTRAC registration. Claims 40+ methods in 150+ countries.
- Integration: signed iframe URL `widget.swapped.com/?apiKey&signature&currencyCode&walletAddress&method...`; sell flow at `/sell`. Methods per merchant and currency from `get_payment_methods`. Event `SWAPPED_ORDER_DATA`. Users log in with a one-time code; KYC level set by `customerKYC`.
- Vietnam: offers VietQR, MoMo and bank transfer (seen in fun.xyz from VN, $3,000 per method). No Vietnamese entity is listed; VND is most likely collected through a licensed local payment partner (inferred; partner not public).
- Docs: https://docs.swapped.com

### Onramper
- Aggregator (MoonPay, Transak, Banxa, Stripe, Guardarian, Ramp, Coinify and others). Separate from Swapped.
- "Headless Ramps" page shows `@onramper/sdk`, which is not on public npm. Public: REST API, checkout intent v2 signed with Ed25519, iOS SDK with `@onramper/onramper-react-native`, `@onramper/wdk-protocol-fiat`.

### Meld
- Aggregator API used by Privy, fun.xyz and Unifold.

### Others (from background knowledge, not verified in this research)
- Transak (strong in India and SEA), MoonPay, Coinbase Onramp, Stripe Crypto Onramp (merchant of record, US and EU), Bridge (Stripe), Alchemy Pay (many APMs), TransFi (PromptPay and other EM rails), Banxa, Mercuryo, Onmeta and Onramp Money (India).

## Vietnam payments (for local rails)
- VietQR is the NAPAS national QR standard over NAPAS 247 (instant, 24/7). MoMo is the leading wallet with a merchant program.
- Collecting VND needs an SBV intermediary payment license (local entity, about USD 2M capital) or a licensed partner. Foreign firms use partners. Strict FX controls. Sources: https://www.kaadxpay.com/en/countries/vietnam , https://docs.dlocal.com/docs/vietnam , https://www.nuvei.com/apm/momo-wallet

## Open-source kits and names
- No open-source, provider-neutral onramp modal with real traction exists. Small projects: `@cinaconnect/onramp-sdk`, `humanperzeus/cyrusgate`, `xelis-project/xelis-fiat-onramp`.
- `openrampkit` is free on npm and GitHub. `github.com/openramp` is an inactive 2022 organization ("A decentralized P2P ramp for Web3"). "RampKit" is used by an onboarding SaaS and by Stellar LATAM packages.
