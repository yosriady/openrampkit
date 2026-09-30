# Live demo (playground)

[Open the playground](../playground/){target="_self"}

::: warning Demo mode
The playground uses mock providers. It moves no real money. You do not need an account or an API key.
:::

## What it is

The playground is a static page. It runs the real `@openrampkit/server` in your browser tab, with the mock adapter and `memoryStore()`. The widget sends its requests to that server through a custom `fetch`. No request leaves the page.

The server handler is a web-standard `Request -> Response` function. Thus, this line connects the widget to the server:

```ts
const fetch = (input, init) => openramp.handle(new Request(input, init))
```

The server also sends signed webhooks. A fake backend in the page receives them, verifies the signature with `openramp.webhooks.verify`, and shows them in the log.

## Controls

| Control | Values |
|---|---|
| Flow | Deposit or withdraw |
| User country | VN, ID, TH, MY, PH, SG, US. The country sets the local payment methods. |
| Language | en, vi, id, th, ms, fil |
| Theme | Light or dark |
| Accent | Any color |
| Display | Embedded (inline) or modal |

The page shows:

- a code sample for your options (the server call and the page call),
- the widget events (`onEvent`),
- the webhooks that your backend receives.

The options are in the URL. Copy the URL to share a setup, for example `/playground/?country=TH&locale=th&theme=dark`.

## Try a deposit

1. Set **User country** to Vietnam.
2. In the widget, select **Use Cash**, then **VietQR**.
3. Enter an amount, then select **Continue** and **Confirm**.
4. Select **Simulate payment (test mode)**.
5. After a few seconds, the widget shows **Deposit complete**. The log shows the `session.completed` webhook.

The page has a mock wallet with 40 USDC on Base. Use it for **Pay with wallet** and for withdrawals.

## Limits

- Card, Apple Pay and Google Pay are hidden. These methods open a hosted checkout page in a new tab, and a static site cannot serve it. To try them, run [`examples/next-demo`](./examples.md).
- The sessions are in memory. A page reload removes them.

## Run it locally

```bash
pnpm install
pnpm build
pnpm --filter playground dev   # http://localhost:5175/playground/
```

The source is in [`examples/playground`](https://github.com/yosriady/openrampkit/tree/main/examples/playground). The server setup is in `src/server.ts`.
