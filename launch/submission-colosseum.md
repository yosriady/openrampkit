# Colosseum Crypto World's Fair: submission draft

Fill the items in [brackets] before you submit. Due 12 October 2026.

## Project name

OpenRampKit

## Tracks (pick 3)

1. **Solana.** Solana wallet adapter (Wallet Standard, `@solana/kit`), USDC on Solana as a destination and a source, onchain checks of Solana payments.
2. **Tempo.** USDC on Tempo as a destination through Relay. Tempo is a payments chain for stablecoins, and OpenRampKit is the last mile into it.
3. **Arbitrum.** `OpenRampSettlement` contract: fiat in, vault position out, in one transaction.

We also ask to be considered for the **Public Goods Award**: MIT licence, self-hosted, no platform fee.

## One line

Open-source, unified deposit infrastructure for crypto apps. Solving the onboarding chasm of getting billions of users onchain. The RainbowKit for onramps and deposits: pay with a card, a bank transfer or a local rail (Pix, UPI, SEPA, VietQR, QRIS and more), and receive stablecoins on Solana, Tempo or any EVM chain.

## Insight (why now)

- Stablecoins won the rails. The last mile did not. Most people in the world pay from a bank app (Pix, UPI, SEPA, national QR codes), not with a card. Global ramps are card-first and cover only a few local methods. We start in Southeast Asia, where six national QR rails make the gap largest.
- The best route changes per country, per amount and per day. So an app must not hard-code a provider. It must choose a pathway at run time. Wallets solved the same problem with one standard UI over many connectors (RainbowKit). Ramps have no such standard. Closed aggregators (fun.xyz, Unifold, D0) take a fee and own the user relationship.
- AI agents now hold wallets but cannot use a bank app. They need a human to pay by QR once, then they act. That needs a pay link, guardrails and a status stream. We built it.

## Product

- One component: a web component with React, Vue, Svelte and Solid wrappers. The axe accessibility checks pass on desktop, Android and iPhone.
- A pathway planner across 10 provider adapters: Relay, Swapped, Coinbase, Transak, MoonPay, Stripe, Meld, Onramper, Peer, Xendit, and a mock.
- A self-hosted server: one web-standard handler on Cloudflare Workers with Durable Objects. It has signed sessions, idempotency, signed webhooks with retries, and deposit and withdraw flows. A security review is done, and `SECURITY.md` is published.
- Solana: a Wallet Standard adapter (about 13 KB). Relay routes to and from Solana USDC. Solana payments are checked onchain (one signature completes one payment).
- An MCP server for agents, with signed pay links.
- 742 unit and integration tests, browser tests on 3 devices, a real-chain test on Anvil, and Foundry tests for the contract.

## Execution in the contest period

The first commit was on 29 September 2026. [Link to the commit history and the changelog.]

## Market

- Global: [sourced size of local real-time payment rails, for example Pix and UPI volumes].
- First market, Southeast Asia: about 680 million people, and real-time QR payments are the default way to pay in most of the region.
- [Add 2 or 3 sourced numbers: QR payment volume per country, crypto adoption ranks of Vietnam, Indonesia and the Philippines.]
- Customers: wallets, exchanges, games, remittance apps, fintech, and any app that moves money.

## Business

Open core:

1. The kit is free and self-hosted, so it spreads like RainbowKit.
2. A hosted version with managed routing, analytics and compliance screening, as a monthly plan.
3. Routing share: providers pay for volume that we send them.

## Team and founder market fit

[Name, role, background. Why you are the right person for SEA payments. Prior products, users or volume.]

## Links

- Repo: https://github.com/yosriady/openrampkit [make public]
- Live demo: https://openrampkit-getformo.vercel.app/playground/
- Docs: https://openrampkit-getformo.vercel.app/
- Solana guide: https://openrampkit-getformo.vercel.app/guide/solana
- Demo video: [link, required]
- Pitch video or deck: [link]

## Gaps we state openly

- A Solana deposit address flow (send from an exchange) needs a Relay API key.
- Tempo uses standard EVM transactions. Tempo's own transaction type (fee token choice, sponsorship) is future work.
- The provider adapters are tested against sandboxes and mocks. Live partner accounts are in progress.
