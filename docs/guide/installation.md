# Installation

OpenRampKit is a set of small packages. Install only what your app needs.

::: warning Prototype packages
The packages are at version `0.0.1` and the APIs will change. If a package is not on npm yet, work inside the monorepo (`pnpm install` at the root) or link the packages from a local checkout.
:::

## Packages

| Package | Runs on | What it is |
|---|---|---|
| `@openrampkit/server` | Server | The handler: sessions, planning, quotes, legs, webhooks, stores |
| `@openrampkit/adapter-*` | Server | Provider adapters: `relay`, `swapped`, `coinbase`, `transak`, `xendit`, `mock` |
| `@openrampkit/web` | Browser | `<openramp-modal>` and `openDeposit()` |
| `@openrampkit/react` | Browser (SSR-safe) | `OpenRampProvider`, `DepositButton`, `OpenRampEmbedded`, hooks |
| `@openrampkit/client` | Browser or Node | HTTP client, `DepositController`, `createMockWallet` |
| `@openrampkit/wagmi` | Browser | `wagmiWallet()`: a `WalletAdapter` for wagmi apps |
| `@openrampkit/core` | Anywhere | Types, money math, codes, planner, flow table |
| `@openrampkit/adapter` | Server | `createAdapter()`, helpers, and the `/testing` kit |

## Pick your setup

::: code-group

```bash [React app]
# server
pnpm add @openrampkit/server @openrampkit/adapter-relay @openrampkit/adapter-mock
# browser
pnpm add @openrampkit/react
# optional: pay from a wagmi wallet
pnpm add @openrampkit/wagmi
```

```bash [Any framework]
# server
pnpm add @openrampkit/server @openrampkit/adapter-relay @openrampkit/adapter-mock
# browser
pnpm add @openrampkit/web
```

```bash [Custom UI]
# server
pnpm add @openrampkit/server @openrampkit/adapter-mock
# browser: drive DepositController yourself
pnpm add @openrampkit/client
# React hooks for the controller (optional)
pnpm add @openrampkit/react
```

```bash [Merchant fiat]
# server: pay-in to your own Xendit account, no crypto
pnpm add @openrampkit/server @openrampkit/adapter-xendit @openrampkit/adapter-mock
pnpm add @openrampkit/react   # or @openrampkit/web
```

```bash [Adapter author]
pnpm add @openrampkit/adapter @openrampkit/core
pnpm add -D vitest
```

:::

`@openrampkit/react` depends on `@openrampkit/web` and `@openrampkit/client`, so you do not add them yourself. Its peer dependency is `react >= 18`.

`@openrampkit/wagmi` has peer dependencies `@wagmi/core ^2` and `viem ^2`.

## Server and browser split

Adapters and the server are server-side only. Never import them in client code: they hold provider secrets.

The browser packages never see a provider key. They talk only to your server, with a per-session client secret.

## Next.js notes

The Next.js example lists the browser packages in `transpilePackages`:

```js
// next.config.mjs
export default {
  transpilePackages: ['@openrampkit/web', '@openrampkit/react', '@openrampkit/client', '@openrampkit/core'],
}
```

`@openrampkit/react` loads `@openrampkit/web` (and Lit) only in the browser, inside effects and click handlers. It is safe to render on the server.

To import themes in a server component, use `@openrampkit/web/theme`. It has no Lit import. `@openrampkit/react` re-exports the same theme functions.

## Develop the monorepo

```bash
git clone https://github.com/yosriady/openrampkit
cd openrampkit
pnpm install
pnpm test          # unit tests (vitest)
pnpm build         # build every package
pnpm dev:example   # run examples/next-demo on http://localhost:3000
pnpm docs:dev      # this site on http://localhost:5174
```
