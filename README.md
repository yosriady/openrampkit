# OpenRampKit

RainbowKit for money movement. An open-source deposit and withdraw kit: one modal (a web component that works in any framework), a server you host yourself, and provider adapters that anyone can write.

- **Open and self-hosted.** MIT. Your provider keys, your server, no platform fee.
- **Any destination.** A token on any chain (crypto apps), or your own fiat account (any app).
- **Pathways.** One to two legs, for example "VietQR, then Swapped to USDC on Base, then Relay to Monad". Every leg's quote, fee and status is visible.
- **Local rails first.** QRIS, PromptPay, QR Ph, DuitNow, VietQR, GCash, MoMo and more.
- **Adapters like wagmi connectors.** `createAdapter()` plus a conformance test kit.

> Status: prototype (phases 0 to 3 of `docs/SPEC.md`). APIs will change.

## Packages

| Package | What |
|---|---|
| `@openrampkit/core` | Types, exact money math, codes, region policy, flow table, pathway planner, ranking |
| `@openrampkit/adapter` | Adapter API (`createAdapter`) and test kit |
| `@openrampkit/server` | Web-standard handler: sessions, pathways, quotes, legs, webhooks. Runs on Cloudflare Workers, Next.js, Node, Bun, Deno |
| `@openrampkit/client` | Framework-free client and `DepositController`; `createMockWallet` for tests |
| `@openrampkit/web` | `<openramp-modal>` web component (Lit, Shadow DOM) and `openDeposit()` |
| `@openrampkit/react` | `OpenRampProvider`, `DepositButton`, `useOpenRamp`, headless hooks |
| `@openrampkit/wagmi` | Wallet adapter for wagmi apps |
| `@openrampkit/adapter-relay` | Wallet pay, transfer to a deposit address, and the bridge hop (Relay) |
| `@openrampkit/adapter-swapped` | Card, Apple Pay, Google Pay and SEA local methods (Swapped) |
| `@openrampkit/adapter-coinbase` | Coinbase Onramp |
| `@openrampkit/adapter-transak` | Transak |
| `@openrampkit/adapter-mock` | Test provider with every surface type. Moves no money |

## Why a server?

The browser cannot be trusted with provider secrets or with the destination address. The server:

1. holds provider secrets and signs provider URLs (Swapped, Coinbase, Transak),
2. fixes the user, destination and amount limits when the session is created,
3. receives provider webhooks and sends signed webhooks to your backend, so you credit balances from a trusted source,
4. keeps checking status if the user closes the tab.

It is a single `Request -> Response` handler, so you can deploy it as a Cloudflare Worker or mount it in your existing app.

## Quick start (Next.js)

```ts
// app/api/openramp/[...path]/route.ts
import { createOpenRamp } from '@openrampkit/server'
import { relay } from '@openrampkit/adapter-relay'
import { mockAdapter } from '@openrampkit/adapter-mock'

export const openramp = createOpenRamp({
  secret: process.env.OPENRAMP_SECRET!,
  baseUrl: `${process.env.PUBLIC_URL}/api/openramp`,
  adapters: [relay(), mockAdapter()],
})
export const { GET, POST, OPTIONS } = openramp.nextHandlers()
```

```ts
// your backend decides who the user is and where the money goes
const { clientSecret } = await openramp.sessions.create({
  userId: user.id,
  destination: { type: 'crypto', chain: 'eip155:8453', token: USDC_BASE, address: user.depositAddress },
})
```

```tsx
<OpenRampProvider baseUrl="/api/openramp">
  <DepositButton getClientSecret={() => fetch('/api/deposit-session', { method: 'POST' }).then((r) => r.json()).then((j) => j.clientSecret)} />
</OpenRampProvider>
```

Without React:

```js
import { openDeposit } from '@openrampkit/web'
openDeposit({ baseUrl: '/api/openramp', clientSecret })
```

## Develop

```bash
pnpm install
pnpm test          # unit and end-to-end tests with the mock provider
pnpm build
```

See `docs/SCOPE.md` and `docs/SPEC.md` for the design, and `examples/` for runnable apps.
