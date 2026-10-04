# Introduction

OpenRampKit is an open-source kit for deposits and withdrawals. It gives your app three things:

1. **A modal.** `<openramp-modal>` is a web component (Lit, Shadow DOM). It works in any framework. A thin React wrapper is included.
2. **A server you host.** `@openrampkit/server` is a single `Request -> Response` handler. It holds your provider secrets, plans pathways, runs legs, takes provider webhooks and sends signed webhooks to your backend.
3. **Adapters.** Each payment or crypto provider is an adapter, like a wagmi connector. You pass configured adapters to the server. Anyone can write one with `createAdapter()` and test it with the conformance kit.

A deposit goes to a **destination** that your backend picks: a token on a chain (for crypto apps), or your own fiat account at a payment provider (for any app). A withdrawal sends a **source** asset that your backend picks to a target that the user picks: a wallet address, or their own bank or e-wallet account. See [Withdrawals](./withdraw.md).

![The playground in the Next.js example](../screenshots/00-playground.png)

::: warning Prototype
OpenRampKit is an early release. APIs can change before 1.0.
:::

## When to use it

OpenRampKit is not the only way to add deposits. Hosted players such as fun.xyz and Unifold give you one API key, one contract and a managed backend. See [Why OpenRampKit?](./why.md) for how we compare.

| You want | Choose |
|---|---|
| No provider contracts, one bill, the vendor handles provider onboarding | A hosted player (fun.xyz, Unifold, D0) |
| Your own provider keys, no platform fee, your own server and data | OpenRampKit |
| Local rails in Southeast Asia (QRIS, QR Ph, PromptPay, VietQR, GCash, MoMo) next to cards | OpenRampKit (the hosted players cover few of these) |
| Fiat into your own merchant account, no crypto at all | OpenRampKit with the [Xendit adapter](../adapters/xendit.md) |
| A provider that nobody supports yet | OpenRampKit: [write an adapter](../adapters/writing-an-adapter.md) |

The cost of self-hosting is real. You sign up with each provider, you keep their keys safe, you run a server and a session store, and you configure webhooks. The [production checklist](../deploy/checklist.md) lists the work.

## Core ideas

**The server fixes the destination.** Your backend creates a session with `openramp.sessions.create({ userId, destination })`. The browser gets only a client secret. It cannot change the user, the destination or the address. See [Sessions and security](../concepts/sessions.md).

**Pathways, not vendors.** A pathway is one or two legs. For example: VietQR at a fiat onramp that buys USDC on Base, then a Relay bridge to a token on Monad. A pure planner builds every pathway that can reach the destination and groups them by payment method. See [Pathways and legs](../concepts/pathways.md).

**Server-driven steps.** The server tells the modal what to show next as a `Step`: a state, a surface (a QR code, a redirect, a deposit address, a wallet transaction) and the allowed transitions. The modal has no provider logic. See [Flow state machine](../concepts/flow.md) and [Surfaces](../concepts/surfaces.md).

**Errors are fields.** A failed quote or payment is an `OrkError` with a code, a message that is safe to show, and a recovery hint. The flow does not throw.

**Local rails first.** The method vocabulary and the default order per country put local QR and e-wallet methods first, where people use them most.

## How a deposit works

1. Your backend creates a session and returns `clientSecret` to the browser.
2. The modal asks the server for a plan. It shows the methods, grouped as Connected, Most popular, Other options and Not available.
3. The user picks a method and an amount. The server quotes up to five pathways in parallel and ranks them.
4. The user confirms a quote. The server starts the first leg. The modal shows the leg's surface.
5. The server learns about progress from provider webhooks and status checks. When all legs succeed, the step is `COMPLETED`.
6. The server sends `session.completed` to your backend. You credit the user.

The [Flows](../concepts/flows.md) page shows each step as a sequence diagram.

## How a withdrawal works

1. Your backend creates a session with `direction: 'withdraw'` and a `source` (the asset, and who holds it). It returns `clientSecret` to the browser.
2. The user picks a target: a network, a token and an address ("To wallet"), or a payout method ("To cash").
3. The user enters an amount and confirms a quote. The server starts the leg.
4. The funds leave with a wallet transaction. The user's wallet signs it, or your treasury hook sends it.
5. The server sends `session.completed` and `withdrawal.completed` to your backend.

A background sweep keeps each session moving after the user closes the tab. See [Background sweep](../api/server.md#background-sweep).

## Next steps

- [Prerequisites](./prerequisites.md)
- [Installation](./installation.md)
- [Quick start (Next.js)](./quick-start-nextjs.md)
- [Withdrawals](./withdraw.md)
- [Features](./features.md): every feature, with links
- [Architecture](../concepts/architecture.md)
- [Flows](../concepts/flows.md): the key flows as sequence diagrams
