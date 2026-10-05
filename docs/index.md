---
layout: home
hero:
  name: OpenRampKit
  text: Unified deposits and withdrawals for any app
  tagline: The RainbowKit for onramps and deposits. Users pay with a card, a bank transfer, an exchange or a local QR rail, and stablecoins land on any chain. One modal, a server you host, no platform fee.
  actions:
    - theme: brand
      text: Try the live demo
      link: /playground/
      target: _self
    - theme: alt
      text: Why OpenRampKit?
      link: /guide/why
    - theme: alt
      text: Get started
      link: /guide/introduction
    - theme: alt
      text: GitHub
      link: https://github.com/yosriady/openrampkit
features:
  - title: Support for local payment rails
    details: Pix, UPI, SEPA, ACH and national QR codes where providers support them, next to cards, Apple Pay, Google Pay and wallets.
  - title: Pathways, not vendors
    details: A planner picks the best route at run time across 10 providers, for example a card or bank transfer to USDC on Base, then a bridge to Arbitrum. Every quote, fee and status is visible.
  - title: Onchain settlement
    details: OpenRampSettlement settles each session once and can deposit into a vault in the same transaction. Live on Arbitrum Sepolia, Robinhood Chain Testnet and Tempo Testnet.
  - title: Any chain
    details: USDC on Arbitrum, Base, Solana, Tempo and other chains. Withdrawals to a wallet or a bank account use the same kit.
  - title: Agent-ready
    details: An MCP server lets an AI agent send a person a pay link, wait for the payment, then act. Guardrails cap destinations and amounts.
  - title: Works in any framework
    details: One component for React, Vue, Svelte or plain HTML. Theme it to match your app.
  - title: Self-hosted
    details: One server you run on Cloudflare Workers, Next.js, Node, Bun or Deno. Your keys, your data, MIT licence.
  - title: Plug in any provider
    details: Each payment method or provider is an adapter. Add a new onramp, local rail or exchange with one adapter and a test kit, without forking.
---
