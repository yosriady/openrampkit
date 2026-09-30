# OpenRampKit

RainbowKit for money movement. An open-source deposit and withdraw kit: one modal (a web component that works in any framework), a server you host yourself, and provider adapters that anyone can write.

- **Open and self-hosted.** MIT. Your provider keys, your server, no platform fee.
- **Any destination.** A token on any chain (crypto apps), or your own fiat account (any app).
- **Pathways.** One to two legs, for example "VietQR, then Swapped to USDC on Base, then Relay to Monad". Every leg's quote, fee and status is visible.
- **Local rails first.** QRIS, PromptPay, QR Ph, DuitNow, VietQR, GCash, MoMo and more.
- **Adapters like wagmi connectors.** `createAdapter()` plus a conformance test kit.

> Status: prototype (phases 0 to 3 of the [spec](docs/design/spec.md)). APIs will change.

## Screenshots

| Use Cash (Vietnam) | Quote | VietQR payment | Complete |
|---|---|---|---|
| ![](docs/screenshots/01-vn-cash-methods.png) | ![](docs/screenshots/03-vn-quote.png) | ![](docs/screenshots/04-vn-qr.png) | ![](docs/screenshots/06-vn-complete.png) |

| Pay from wallet | Transfer crypto | Merchant QRIS (dark) | Phone sheet |
|---|---|---|---|
| ![](docs/screenshots/11-wallet-amount.png) | ![](docs/screenshots/21-transfer-address.png) | ![](docs/screenshots/41-merchant-qr-dark.png) | ![](docs/screenshots/50-mobile-sheet.png) |

All flows run on mock providers in `examples/next-demo`. Recapture with `npx playwright test e2e/screens.spec.ts`.

## Packages

| Package | What |
|---|---|
| `@openrampkit/core` | Types, exact money math, codes, region policy, flow table, pathway planner, ranking |
| `@openrampkit/adapter` | Adapter API (`createAdapter`) and test kit |
| `@openrampkit/server` | Web-standard handler: sessions, pathways, quotes, legs, webhooks. Runs on Cloudflare Workers, Next.js, Node, Bun, Deno |
| `@openrampkit/client` | Framework-free client and `DepositController`; `createMockWallet` for tests |
| `@openrampkit/web` | `<openramp-modal>` web component (Lit, Shadow DOM) and `openDeposit()` |
| `@openrampkit/react` | `OpenRampProvider`, `DepositButton`, `useOpenRamp`, headless hooks |
| `@openrampkit/vue` | Vue 3 and Nuxt: `OpenRampProvider`, `provideOpenRamp`, `DepositButton`, composables |
| `@openrampkit/svelte` | Svelte 5 and 4, SvelteKit: `createOpenRamp`, stores, `use:depositButton` and other actions |
| `@openrampkit/solid` | Solid and SolidStart: `OpenRampProvider`, `DepositButton`, primitives |
| `@openrampkit/wagmi` | Wallet adapter for wagmi apps |
| `@openrampkit/adapter-relay` | Wallet pay, transfer to a deposit address, and the bridge hop (Relay) |
| `@openrampkit/adapter-swapped` | Card, Apple Pay, Google Pay and SEA local methods (Swapped); payouts to bank transfer, Skrill, PIX and Interac for withdrawals |
| `@openrampkit/adapter-coinbase` | Coinbase Onramp |
| `@openrampkit/adapter-transak` | Transak |
| `@openrampkit/adapter-mock` | Test provider with every surface type. Moves no money |

## Why a server?

The browser cannot be trusted with provider secrets or with the destination address. The server:

1. holds provider secrets and signs provider URLs (Swapped, Coinbase, Transak),
2. fixes the user, destination and amount limits when the session is created,
3. receives provider webhooks and sends signed webhooks to your backend, so you credit balances from a trusted source,
4. runs a background sweep (`openramp.sweep()`, from a cron trigger or `POST /tasks/sweep`) that retries failed webhooks, checks the status of open payments after the user closes the tab, and expires idle sessions. Schedule it every minute; without a scheduled sweep, nothing runs after the user leaves.

It is a single `Request -> Response` handler, so you can deploy it as a Cloudflare Worker or mount it in your existing app.

## Quick start (Next.js)

```ts
// lib/openramp.ts (a Next.js route file may only export route handlers, so keep the instance here)
import { createOpenRamp } from '@openrampkit/server'
import { relay } from '@openrampkit/adapter-relay'
import { mockAdapter } from '@openrampkit/adapter-mock'

export const openramp = createOpenRamp({
  secret: process.env.OPENRAMP_SECRET!, // 32+ characters
  baseUrl: `${process.env.PUBLIC_URL}/api/openramp`,
  adapters: [relay(), mockAdapter()],
  webhooks: { url: `${process.env.PUBLIC_URL}/api/hooks`, secret: process.env.OPENRAMP_WEBHOOK_SECRET! },
})
```

```ts
// app/api/openramp/[...path]/route.ts
import { openramp } from '@/lib/openramp'

export const dynamic = 'force-dynamic'
export const { GET, POST, OPTIONS } = openramp.nextHandlers()
```

```ts
// app/api/deposit-session/route.ts: your backend decides who the user is and where the money goes
import { openramp } from '@/lib/openramp'

export async function POST() {
  const user = await getUser() // your auth
  const session = await openramp.sessions.create({
    userId: user.id,
    destination: {
      type: 'crypto',
      chain: 'eip155:8453', // Base
      token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC on Base
      address: user.depositAddress,
    },
  })
  return Response.json(session) // { id, clientSecret, expiresAt }
}
```

```tsx
'use client'
import { DepositButton, OpenRampProvider } from '@openrampkit/react'

<OpenRampProvider baseUrl="/api/openramp">
  <DepositButton getClientSecret={() => fetch('/api/deposit-session', { method: 'POST' }).then((r) => r.json()).then((j) => j.clientSecret)} />
</OpenRampProvider>
```

Without React:

```js
import { openDeposit } from '@openrampkit/web'
openDeposit({ baseUrl: '/api/openramp', clientSecret })
```

Credit balances from the signed `session.completed` webhook (`openramp.webhooks.verify(req, rawBody)`), not from the browser. See the docs: Guide > Quick start and Webhooks.

## Develop

```bash
pnpm install
pnpm test          # unit and end-to-end tests with the mock provider
pnpm build
```

Full documentation: `pnpm docs:dev` (VitePress in `docs/`). Design notes: [scope](docs/design/scope.md), [spec](docs/design/spec.md), [landscape](docs/design/landscape.md).
