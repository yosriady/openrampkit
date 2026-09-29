# Prerequisites

## Runtime and tools

- **Node.js 20 or later.** The server uses only web standards (`fetch`, `Request`, `Response`, WebCrypto). It also runs on Cloudflare Workers, Bun and Deno.
- **pnpm.** The monorepo uses pnpm workspaces (`packageManager: pnpm@11`). Your app can use any package manager.
- **TypeScript** is optional, but every package ships types.

## A place to run the server

The server must be reachable over HTTPS from two places: the user's browser, and your providers (for webhooks). Pick one:

| Host | Guide |
|---|---|
| Cloudflare Workers | [Deploy on Cloudflare Workers](../deploy/cloudflare-workers.md) |
| Next.js on Vercel (or any Next.js host) | [Deploy with Next.js](../deploy/nextjs.md) |
| Node, Bun or Deno | [Deploy on Node, Bun, Deno](../deploy/node.md) |

You also need a **session store** for production. The default in-memory store works only for local development and tests. See [Session stores](../deploy/stores.md).

::: tip Local webhooks
Providers cannot reach `localhost`. For local tests with real providers, expose your dev server with a tunnel (for example `cloudflared tunnel` or `ngrok`) and set `baseUrl` to the tunnel URL.
:::

## Provider accounts

Each adapter needs an account with its provider, except the mock adapter. You can start with the mock adapter and add real providers later.

| Adapter | What you need | Where |
|---|---|---|
| [Mock](../adapters/mock.md) | Nothing | |
| [Relay](../adapters/relay.md) | Optional API key (recommended: status lookups use `/requests/v3`, which needs a key) | [docs.relay.link](https://docs.relay.link) |
| [Swapped](../adapters/swapped.md) | Merchant public key (`pk_...`) and secret key (`sk_...`) | [docs.swapped.com](https://docs.swapped.com) |
| [Coinbase](../adapters/coinbase.md) | CDP Secret API key (id and secret), and a CDP webhook subscription secret | [docs.cdp.coinbase.com/onramp](https://docs.cdp.coinbase.com/onramp) |
| [Transak](../adapters/transak.md) | Partner API key and API secret, and your registered referrer domain | [docs.transak.com](https://docs.transak.com) |
| [Xendit](../adapters/xendit.md) | Secret API key and webhook verification token | [docs.xendit.co](https://docs.xendit.co) |

Providers are the regulated party. They run KYC, take the payment and deliver the funds. Read each provider's terms before you go live.

## Secrets

Keep these out of your client bundle. Store them as environment variables or platform secrets.

| Name (as used in the examples) | Purpose |
|---|---|
| `OPENRAMP_SECRET` | Signs popup-safe start URLs. At least 32 characters. `createOpenRamp` throws if it is shorter. |
| `OPENRAMP_WEBHOOK_SECRET` | Signs the webhooks the server sends to your backend. |
| `PUBLIC_URL` | The public origin of your app. The server's `baseUrl` is built from it. |
| Provider keys | For example `XENDIT_SECRET_KEY` and `XENDIT_WEBHOOK_TOKEN`. |

Generate a strong secret:

```bash
openssl rand -hex 32
```

## A wallet (optional)

For "Pay with wallet", the modal needs a `WalletAdapter`. Use `@openrampkit/wagmi` if your app uses wagmi, or `createMockWallet()` from `@openrampkit/client` for tests. See [Wallets (wagmi)](../adapters/wagmi.md).
