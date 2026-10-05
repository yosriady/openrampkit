# Installation

OpenRampKit is a set of small packages. Install only what your app needs.

::: warning Not on npm yet
The packages are not published to npm yet. The first release will be `0.1.0`. Until then, `pnpm add @openrampkit/...` fails. Use one of the ways in [Try it before the npm release](#try-it-before-the-npm-release). The APIs can change before 1.0.
:::

## Packages

| Package | Runs on | What it is |
|---|---|---|
| `@openrampkit/server` | Server | The handler: sessions, planning, quotes, legs, webhooks, stores |
| `@openrampkit/adapter-*` | Server | Provider adapters: `relay`, `swapped`, `xendit`, `coinbase`, `transak`, `moonpay`, `stripe`, `meld`, `onramper`, `peer`, `mock` |
| `@openrampkit/web` | Browser | `<openramp-modal>`, `openDeposit()`, `openWithdraw()`, themes, provider renderers |
| `@openrampkit/react` | Browser (SSR-safe) | `OpenRampProvider`, `DepositButton`, `OpenRampEmbedded`, hooks |
| `@openrampkit/vue` | Browser (SSR-safe) | Vue 3 and Nuxt: `OpenRampProvider`, `DepositButton`, `OpenRampEmbedded`, composables |
| `@openrampkit/svelte` | Browser (SSR-safe) | Svelte 5 and 4, SvelteKit: `createOpenRamp`, stores, actions |
| `@openrampkit/solid` | Browser (SSR-safe) | Solid and SolidStart: `OpenRampProvider`, `DepositButton`, `OpenRampEmbedded`, primitives |
| `@openrampkit/client` | Browser or Node | HTTP client, `DepositController`, `createMockWallet` |
| `@openrampkit/wagmi` | Browser | `wagmiWallet()`: a `WalletAdapter` for wagmi apps |
| `@openrampkit/solana` | Browser | `solanaWallet()`: a `WalletAdapter` for Solana wallets (Wallet Standard) |
| `@openrampkit/mcp` | Node | An MCP server for AI agents. See [Agents (MCP)](./agents.md). |
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

```bash [Vue, Svelte or Solid]
# server
pnpm add @openrampkit/server @openrampkit/adapter-relay @openrampkit/adapter-mock
# browser: pick one
pnpm add @openrampkit/vue
pnpm add @openrampkit/svelte
pnpm add @openrampkit/solid
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

`@openrampkit/vue`, `@openrampkit/svelte` and `@openrampkit/solid` also include `@openrampkit/web` and `@openrampkit/client`. Their peer dependencies are `vue >= 3.3`, `svelte ^4 || ^5` and `solid-js ^1.8`. See [Vue](../api/vue.md), [Svelte](../api/svelte.md) and [Solid](../api/solid.md).

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

## Try it before the npm release

The packages are not on npm yet. You can use them today in two ways.

### Run the examples in the repository

This is the fastest way. You need Node.js 20 or later and pnpm.

```bash
git clone https://github.com/yosriady/openrampkit
cd openrampkit
pnpm install
pnpm build
pnpm dev:example      # the Next.js example on http://localhost:3000
pnpm playground:dev   # or the playground (mock and testnet modes)
```

### Install local tarballs in your own app

Build the packages and pack each one into a `.tgz` file:

```bash
git clone https://github.com/yosriady/openrampkit
cd openrampkit
pnpm install
pnpm build
pnpm -r --filter './packages/**' exec pnpm pack --pack-destination /tmp/openrampkit-packs
```

Then install the tarballs in your app. Also install the internal packages that they depend on (`core`, `adapter`, `client` and `web`). The package manager cannot get those from npm yet.

```bash
# in your app: the packages of the Next.js quick start
npm install /tmp/openrampkit-packs/openrampkit-{core,adapter,client,web,server,adapter-mock,adapter-relay,react}-*.tgz
```

To add another package, add its tarball to the list, for example `openrampkit-vue-*.tgz` or `openrampkit-adapter-xendit-*.tgz`. After you pull new changes, build and pack again, then install again.

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
