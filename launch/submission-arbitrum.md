# Arbitrum Open House Singapore: submission draft

Fill the items in [brackets] before you submit. Due 4 October 2026.

## Project name

OpenRampKit

## Tagline (one line)

The RainbowKit for onramps and deposits: open-source, unified deposit infrastructure that gets users onchain.

Alternative for the Arbitrum angle: Fiat in, onchain action out: pay with VietQR, QRIS or PromptPay and land in an Arbitrum vault in one step.

## Tracks

- Open category
- Promising Products (new financial primitive, agent-ready ramps)
- Robinhood Chain (the contract is also on Robinhood Chain testnet)

## Short description (about 100 words)

OpenRampKit is an open-source (MIT), self-hosted kit that lets any app take money in and pay money out. It targets Southeast Asia, where people pay with local QR rails, not cards. One component shows VietQR, QRIS, PromptPay, DuitNow, QR Ph and PayNow next to cards and wallets. A planner picks the best pathway at run time across 10 provider adapters. The new `OpenRampSettlement` contract on Arbitrum settles each session once, verifies it by event, and runs an allowlisted call bundle in the same transaction. So a user can pay in local currency and get a vault position on Arbitrum.

## Problem

- In Vietnam, Indonesia, Thailand, Malaysia and the Philippines, most people pay with a bank app and a national QR code. Card-first ramps fail them.
- Each ramp provider covers only a few local methods. An app that wants SEA users must integrate many providers, and handle KYC hand-offs, webhooks, retries and refunds.
- After the money arrives, the user must still do more steps onchain (bridge, approve, deposit). Each step loses users.

## Solution

1. **One component.** A web component with React, Vue, Svelte and Solid wrappers.
2. **Pathway planner.** It chooses one or two legs at run time, for example "VietQR to USDC, then Relay to Arbitrum". Every leg shows its quote, fee and status.
3. **Self-hosted server.** A single web-standard handler that runs on Cloudflare Workers with Durable Objects. It has signed sessions, idempotency, signed webhooks with retries, and a background sweep.
4. **OpenRampSettlement (new, on Arbitrum).** A contract that:
   - settles each session id at most once (replay-safe receipts),
   - forwards funds to the user and can run an allowlisted call bundle atomically (for example an ERC-4626 vault deposit),
   - can require an EIP-712 intent signed by the server, so a payer cannot redirect funds,
   - lets the server verify a payment by reading one `Settled` event, not by trusting a transaction hash.
5. **Agent-ready ramps (new).** An MCP server lets an AI agent create a session and send a person a signed pay link. The person pays by QR on a phone, and the agent acts when the payment completes. Guardrails: allowlisted destinations and amount caps.

## What is new in this buildathon

The project started on 29 September 2026. All code was written in the buildathon period. [Link to the commit history.]

## How it uses Arbitrum

- `OpenRampSettlement` is deployed and verified on Arbitrum Sepolia: `0xBF66696115128B8f9f794780061348b4213A7132` (https://arbitrum-sepolia.blockscout.com/address/0xBF66696115128B8f9f794780061348b4213A7132).
- Same address on Robinhood Chain testnet: https://explorer.testnet.chain.robinhood.com/address/0xBF66696115128B8f9f794780061348b4213A7132
- Demo settlements, including a vault deposit in the same transaction: contracts/deployments.md.
- Arbitrum One is a default destination and a Relay RPC target. The Relay adapter builds the `approve` and `settle` calls, then verifies the settlement onchain.

## Smart contract quality

- Solidity 0.8.28 with OpenZeppelin 5.1: `Ownable2Step`, `Pausable`, `ReentrancyGuardTransient`, `EIP712`, `SignatureChecker` (EOA and ERC-1271). No proxy, no upgrade path.
- The receipt is written before any external call. The allowance is reset to zero after each call. A balance invariant stops a call bundle from spending funds that do not belong to the session. Fee-on-transfer tokens are rejected.
- 45 unit and fuzz tests (4096 runs in CI) and 3 invariant tests. There is a gas snapshot. A settle with a vault deposit costs about 236k gas.
- The TypeScript encoding matches `cast calldata` byte for byte. An Anvil test deploys the real contract and settles with an intent signed by `eth_signTypedData_v4`.

## Links

- Repo: https://github.com/yosriady/openrampkit [make public]
- Live demo: https://yosriady.github.io/openrampkit/playground/
- Docs: https://yosriady.github.io/openrampkit/
- Settlement docs: https://yosriady.github.io/openrampkit/concepts/settlement
- Demo video: [link]
- Pitch deck: [link]

## Team

[Name, role, background. Why you: payments or SEA experience.]

## Business model

Open core. The kit is free and self-hosted. Revenue comes from:

- a hosted version (managed routing, analytics, compliance screening),
- routing share from providers for volume that we send them.

## Next 90 days (milestones for the 50% milestone payout)

1. Live pilots with 2 Arbitrum apps in Vietnam and Indonesia.
2. Settlement for cross-chain Relay routes and onramp routes, so fiat lands directly in the contract.
3. Arbitrum One deployment behind a multisig owner, with an external review of the contract.
4. The hosted version in beta.

## HackQuest form fields (each 300 characters or fewer)

**Link to frontend/UI/website**

https://yosriady.github.io/openrampkit/playground/ (live demo, mock providers). Docs: https://yosriady.github.io/openrampkit/

**Core Protocol / Smart Contract Addresses**

OpenRampSettlement on Arbitrum Sepolia: 0xBF66696115128B8f9f794780061348b4213A7132 (verified). OpenRampSettlement on Robinhood Chain testnet: 0xBF66696115128B8f9f794780061348b4213A7132 (same address, verified). Source and tests: https://github.com/yosriady/openrampkit/tree/main/contracts

**Factory / Pool Contracts**

Not applicable. OpenRampKit has no factory or pool contracts. One settlement contract per chain.

**Token Contract Address**

Not applicable. OpenRampKit has no token. Settlement uses existing USDC (Arbitrum Sepolia: 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d).

**Which parts of your code have been produced during the Buildathon?**

All of it. The first commit is on 29 September 2026, after the start on 14 September: the contract, server, 10 provider adapters, UI, SDKs, MCP server and tests. Git history: https://github.com/yosriady/openrampkit/commits/main
