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
| [Relay](../adapters/relay.md) | API key. Relay requires one for quotes under its announced policy from 2 Oct 2026. Some requests without a key may still work today, but Relay can refuse them at any time. Status lookups use `/requests/v3`, which also needs one. Always set `RELAY_API_KEY`. | [dashboard.relay.link](https://dashboard.relay.link) |
| [LI.FI](../adapters/lifi.md) | API key and an integration string (`integrator`). Without a key the quote limit is 75 requests per 2 hours. | [portal.li.fi](https://portal.li.fi) |
| [Bridge](../adapters/bridge.md) | API key and the webhook public key (contact sales) | [apidocs.bridge.xyz](https://apidocs.bridge.xyz) |
| [Binance](../adapters/binance.md) | Partner approval: base URL, client id, access token, your RSA private key, Binance's webhook public key | See [Binance](../adapters/binance.md) |
| [Swapped](../adapters/swapped.md) | Merchant public key (`pk_...`) and secret key (`sk_...`) | [docs.swapped.com](https://docs.swapped.com) |
| [Coinbase](../adapters/coinbase.md) | CDP Secret API key (id and secret), and a CDP webhook subscription secret | [docs.cdp.coinbase.com/onramp](https://docs.cdp.coinbase.com/onramp) |
| [Transak](../adapters/transak.md) | Partner API key and API secret, and your registered referrer domain | [docs.transak.com](https://docs.transak.com) |
| [Xendit](../adapters/xendit.md) | Secret API key and webhook verification token | [docs.xendit.co](https://docs.xendit.co) |
| [MoonPay](../adapters/moonpay.md) | Publishable key, secret key, and a webhook API key | [dev.moonpay.com](https://dev.moonpay.com) |
| [Stripe](../adapters/stripe.md) | Secret key with onramp access, publishable key, and a webhook endpoint secret | [docs.stripe.com/crypto](https://docs.stripe.com/crypto) |
| [Meld](../adapters/meld.md) | API key, and a webhook profile secret | [docs.meld.io](https://docs.meld.io) |
| [Onramper](../adapters/onramper.md) | API key, an Ed25519 signing key, and a webhook secret | [docs.onramper.com](https://docs.onramper.com) |
| [Peer](../adapters/peer.md) | Merchant API key and webhook secret (opt-in with `enabled: true`) | See [Peer](../adapters/peer.md) |

Providers are the regulated party. They run KYC, take the payment and deliver the funds. Read each provider's terms before you go live.

## Secrets

Keep these out of your client bundle. Store them as environment variables or platform secrets.

| Name (as used in the examples) | Purpose |
|---|---|
| `OPENRAMP_SECRET` | Signs popup-safe start URLs. At least 32 characters. `createOpenRamp` throws if it is shorter. |
| `OPENRAMP_WEBHOOK_SECRET` | Signs the webhooks the server sends to your backend. At least 16 characters. |
| `CRON_SECRET` | Protects the cron route that calls `openramp.sweep()` (Next.js example). To use `POST /tasks/sweep` instead, set `tasksToken` (at least 16 characters). |
| `PUBLIC_URL` | The public origin of your app. The server's `baseUrl` is built from it. |
| Provider keys | For example `XENDIT_SECRET_KEY` and `XENDIT_WEBHOOK_TOKEN`. [Get provider keys](./provider-keys.md) shows where to get each one. |

Generate a strong secret:

```bash
openssl rand -hex 32
```

## A wallet (optional)

For "Pay with wallet", the modal needs a `WalletAdapter`. Use `@openrampkit/wagmi` if your app uses wagmi, `@openrampkit/solana` for Solana wallets, or `createMockWallet()` from `@openrampkit/client` for tests. See [Wallets (wagmi)](../adapters/wagmi.md) and [Solana](./solana.md#pay-from-a-solana-wallet).
