# Why OpenRampKit?

OpenRampKit is the RainbowKit for onramps and deposits. It is open-source, unified deposit infrastructure for crypto apps. This page explains the problem, who the kit is for, and why it is built this way.

[Try the live demo](/playground/){target="_self"}. It runs the real server and modal in your browser, with mock providers and no real money.

## The problem: the onboarding chasm

A new user wants to use your app. First, they must get money onchain. Most users stop at this step.

- **Most people do not pay with a card.** They pay from a bank app. In Brazil that is Pix. In India it is UPI. In Europe it is SEPA. In Southeast Asia it is a national QR code: VietQR, QRIS, PromptPay, PayNow, QR Ph or DuitNow. Most onramps are built for cards first.
- **Each provider covers only a part.** One onramp supports some countries. Another supports some payment methods. To cover your users, you must connect to many providers, and handle their KYC hand-offs, webhooks, retries and failures.
- **After the money arrives, there are more steps.** The user must bridge, approve and deposit. Each extra step loses more users.

## What OpenRampKit does

One modal shows every way to pay, for the user's country. A planner picks the best route at run time, and the money lands where your app needs it.

1. **The user picks how to pay:** a card, a bank transfer, a local QR rail, a wallet, or a crypto transfer from another chain or exchange.
2. **The planner builds a pathway** of one or two steps across 10 provider adapters. For example: VietQR to USDC, then a Relay bridge to Arbitrum. The modal shows each step's quote, fee and status.
3. **The money lands at your destination:** stablecoins on Arbitrum, Base, Solana, Tempo or another chain, a vault position through the `OpenRampSettlement` contract, or your own fiat merchant account.
4. **Your backend gets signed webhooks** for each change, with retries.

The same kit runs withdrawals: from a wallet or your treasury, to a wallet or a local bank account.

## Who it is for

| You are | What you get |
|---|---|
| A wallet, exchange or DeFi app | More users finish their first deposit, with local payment methods next to cards |
| A game or consumer app | A top-up flow that works in the user's own currency and payment app |
| A new chain or L2 | A ready deposit flow that you can give to every app on your chain |
| An app with AI agents | Agents can ask a person to top up through a pay link, then act when the money arrives |
| A business that collects fiat | Local payment methods into your own merchant account, with no crypto needed |

## Why it is built this way

**Open source and self-hosted.** The kit uses the MIT licence. You run the server yourself, for example on Cloudflare Workers. You use your own provider keys. There is no platform fee on top of the provider fees, and no vendor between you and your users.

**Pathways, not vendors.** The best route changes per country, per amount and per day. So your app does not pick a provider. The planner picks a pathway at run time, from the providers that you turn on.

**Adapters like wagmi connectors.** Each provider is an adapter. To add a provider, you write one adapter and test it with the conformance kit. You do not fork the kit.

**One UI for every app.** The modal is a web component, with React, Vue, Svelte and Solid wrappers. It works on desktop and phone, and passes automated accessibility checks.

**Settlement you can verify onchain.** The `OpenRampSettlement` contract settles each session at most once. In the same transaction, it can run an approved action, for example a vault deposit. Your server verifies the payment by one `Settled` event, not by a transaction hash from the browser.

## How it compares

| | OpenRampKit | Hosted deposit platforms | One onramp provider |
|---|---|---|---|
| Licence and hosting | MIT, on your server | Closed, hosted by the vendor | Closed, hosted by the provider |
| Fee on top of provider fees | None | Usually yes | Not applicable |
| Choice of providers | Any, through adapters | The vendor's list | One |
| Local payment rails | First class | Some | A few |
| Withdrawals to a bank | Yes | Some | Some |
| Your data and user relationship | Yours | Shared with the vendor | Shared with the provider |

Hosted platforms are a good choice when you want one contract, one bill and no server to run. OpenRampKit is for teams that want control, no extra fee, and the payment methods their users already use.

## Why now

- **Stablecoins are ready.** Chains such as Arbitrum, Solana and Tempo make stablecoin transfers fast and cheap. The weak part is the first step: getting money in.
- **Local real-time payment rails keep growing.** Users expect to pay with the app they already use.
- **AI agents hold wallets, but cannot open a bank app.** They need a person to pay once, with guardrails. OpenRampKit gives them a pay link and a status stream.

## What is live today

- The playground on this site: deposits and withdrawals with mock providers.
- `OpenRampSettlement` on Arbitrum Sepolia, Robinhood Chain Testnet and Tempo Testnet at `0x12196D55b9009145c9CBAe7e256f3d32F9e27Af5`, with verified source and demo settlements. See [On-chain settlement](../concepts/settlement.md).
- 10 provider adapters, Solana and EVM wallet adapters, and an MCP server for agents.
- A security review, with the fixes and a threat model in [Security](./security.md).

## Limits

OpenRampKit is an early release. Read these before you use it in production:

- Most provider adapters are tested with mocks and sandboxes. Tests against live provider accounts are in progress.
- You must sign up with each provider that you turn on, and keep their keys safe.
- The settlement contract is on testnets. A mainnet deployment needs an external review first.

## Next steps

- [Try the live demo](/playground/){target="_self"}
- [Features](./features.md): the full list
- [Architecture](../concepts/architecture.md) and [Flows](../concepts/flows.md): how it works, with diagrams
- [Quick start (Next.js)](./quick-start-nextjs.md): add it to your app
