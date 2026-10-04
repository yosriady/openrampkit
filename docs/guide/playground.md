# Live demo (playground)

[Open the playground](../playground/){target="_self"}

::: warning Demo mode
The playground uses mock providers. It moves no real money. You do not need an account or an API key.
:::

## What it is

The playground is a static page. It runs the real `@openrampkit/server` in your browser tab, with four mock providers and `memoryStore()`. The widget sends its requests to that server through a custom `fetch`. No request leaves the page.

The server handler is a web-standard `Request -> Response` function. Thus, this line connects the widget to the server:

```ts
const fetch = (input, init) => openramp.handle(new Request(input, init))
```

The server also sends signed webhooks. A fake backend in the page receives them, verifies the signature with `openramp.webhooks.verify`, and shows them in the log.

## Mock providers

Four mock providers compete for each route. Each one has different fees, a different FX spread, different speeds and different coverage. Thus, most cash and card methods get more than one quote. The widget sorts the quotes and marks the best one with "Best price".

| Provider | Methods | Countries | Fee | Spread |
|---|---|---|---|---|
| Mock Onramp A | all, plus wallet, transfer, from an exchange and withdraw to cash | all | card 2.5%, local 1% | none |
| Mock Onramp B | card, Apple Pay, the large local methods, withdraw to cash | all | card 1.99%, local 0.6% | 0.6% |
| Mock Local Rails | VietQR, QRIS, PromptPay, QR Ph, DuitNow, PayNow | VN, ID, TH, PH, MY, SG | local 0.4% | 0.3% |
| Mock Card Onramp | card, Apple Pay, Google Pay | all | card 1.49% | 0.5% |

Methods and number of providers per country (deposit):

| Country | Methods (providers) |
|---|---|
| VN | VietQR (3), MoMo (2), bank transfer (2), card (3), Apple Pay (3), Google Pay (2), wallet, transfer crypto, from an exchange |
| ID | QRIS (3), GoPay (2), DANA (2), bank transfer (2), card (3), Apple Pay (3), Google Pay (2), wallet, transfer crypto, from an exchange |
| TH | PromptPay (3), bank transfer (2), card (3), Apple Pay (3), Google Pay (2), wallet, transfer crypto, from an exchange |
| MY | DuitNow (3), Touch 'n Go (1), bank transfer (2), card (3), Apple Pay (3), Google Pay (2), wallet, transfer crypto, from an exchange |
| PH | QR Ph (3), GCash (2), bank transfer (2), card (3), Apple Pay (3), Google Pay (2), wallet, transfer crypto, from an exchange |
| SG | PayNow (2), bank transfer (2), card (3), Apple Pay (3), Google Pay (2), wallet, transfer crypto, from an exchange |
| US | card (3), Apple Pay (3), Google Pay (2), wallet, transfer crypto, from an exchange |

## Controls

| Control | Values |
|---|---|
| Flow | Deposit or withdraw |
| User country | VN, ID, TH, MY, PH, SG, US. The country sets the local payment methods. |
| Language | en, vi, id, th, ms, fil |
| Display | Embedded (inline) or modal |
| Payment sources | Pay with wallet, transfer crypto, from an exchange, local cash, card. Each one is on or off. The page sends the selected methods to the server as the session's `allowedMethods`. |
| Theme | Light, dark or auto (follows the system) |
| Accent | Any color |
| Corners | Large, medium, small or square (theme `radius`) |
| Font | System, rounded, serif or monospace (theme `fontFamily`) |

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

## Try a card deposit

1. Set **User country** to United States.
2. In the widget, select **Card**. Enter an amount, then select **Continue**. Compare the quotes, then select **Confirm**.
3. Enter the test card `4242 4242 4242 4242`, an expiry such as `12/30` and a CVC such as `123`.
4. Select **Pay (test mode)**. The test card `4000 0000 0000 0002` is declined.

The static page cannot serve the hosted checkout page of the mock. Thus, the mock card leg shows its test card fields in the widget (`cardCheckout: 'form'`). A real card provider shows its own checkout.

## Try a deposit from an exchange

1. In the widget, select **Use Crypto**, then **From an exchange**.
2. Select the network and the token that you send from. Then select **Continue**.
3. The widget shows the deposit address, the network and the token. It tells the user to send from an exchange, for example Binance, Coinbase or OKX, and to choose the correct network.
4. Select **Simulate deposit (test mode)**.

## Limits

- The card checkout is a test form in the widget, not a hosted page. To try the hosted mock checkout in a new tab, run [`examples/next-demo`](./examples.md).
- "From an exchange" shows a deposit address only. A "connect your exchange account" flow is not available yet.
- The sessions are in memory. A page reload removes them.

## Run it locally

```bash
pnpm install
pnpm build
pnpm --filter playground dev   # http://localhost:5175/playground/
```

The source is in [`examples/playground`](https://github.com/yosriady/openrampkit/tree/main/examples/playground). The server setup is in `src/server.ts`.
