# Live demo (playground)

[Open the playground](../playground/){target="_self"}

::: warning Two modes
**Demo** is the default. It uses mock providers and moves no real money. You do not need an account or an API key.

**Testnet (real wallet)** sends real transactions from your browser wallet on Arbitrum Sepolia, Robinhood Chain Testnet or Tempo Testnet, or from your Solana wallet on Solana devnet. It uses test tokens with no value. See [Testnet mode](#testnet-mode-real-wallet) and [Solana devnet](#solana-devnet).
:::

## What it is

The playground is a static page. It runs the real `@openrampkit/server` in your browser tab, with four mock providers and `memoryStore()`. The widget sends its requests to that server through a custom `fetch`. In demo mode, no request leaves the page.

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
| Mode | Demo (mock providers) or Testnet (real wallet) |
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

The page has a mock wallet with 250 USDC on Arbitrum and 40 USDC on Base. Use it for **Pay with wallet** and for withdrawals.

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

## Testnet mode (real wallet)

Set **Mode** to **Testnet (real wallet)**. The banner names the network, for example "Testnet: real transactions on Arbitrum Sepolia, test tokens with no value."

In this mode, your own wallet pays a session through the [OpenRampSettlement contract](../concepts/settlement.md). The transactions are real. The tokens have no value.

You need these items:

- A browser wallet, for example MetaMask or Rabby (any EIP-1193 wallet).
- A small amount of test ETH for gas on Arbitrum Sepolia or Robinhood Chain Testnet. Tempo Testnet has no gas token: you pay fees in pathUSD. Get pathUSD (and AlphaUSD) from the [Tempo faucet](https://docs.tempo.xyz/quickstart/faucet).
- Test tokens. The page can mint them for you.

### Steps

1. Select the **Network**: Arbitrum Sepolia, Robinhood Chain Testnet or Tempo Testnet. For Solana, see [Solana devnet](#solana-devnet).
2. Select the **Token**:
   - **Test token (free, mint in one click)**. Select **Mint 100 tUSDC**. Your wallet sends one `mint` transaction.
   - **Circle test USDC** (Arbitrum Sepolia only). Get it from the [Circle faucet](https://faucet.circle.com/).
   - **AlphaUSD (TIP-20, Tempo faucet)** (Tempo Testnet only). A TIP-20 test stablecoin. Get it from the [Tempo faucet](https://docs.tempo.xyz/quickstart/faucet).
3. Select the **Destination**:
   - **Plain settlement**. The contract sends the tokens to the recipient.
   - **Deposit into vault** (test token only). The contract deposits the tokens into a test ERC-4626 vault for the recipient, in the same transaction. The vault call has a fixed amount. Set it in **Vault amount** (default 5), and enter the same amount in the widget.
4. Select **Connect wallet**. If your wallet is on another network, select **Switch to** and the network name (for example **Switch to Arbitrum Sepolia**).
5. In the widget, select **Pay with wallet**. Enter an amount, then select **Continue** and **Confirm**.
6. Select **Confirm in wallet**. Your wallet asks you to sign two transactions: `approve` on the token, then `settle` on the contract.
7. The server reads the contract over the public RPC and checks the session with `verifySettlement`. Then the widget shows **Deposit complete**. The page shows links to the transaction on the explorers of the network: Arbiscan and Blockscout on Arbitrum Sepolia, Blockscout on Robinhood Chain Testnet, and Tempo Explorer on Tempo Testnet.

The recipient is your connected wallet. Thus, a plain settlement sends the tokens back to you, and a vault deposit gives you vault shares.

### How it works

The page creates the session that your backend would create:

```ts
await openramp.sessions.create({
  userId: user.id,
  destination: {
    type: 'crypto',
    chain: 'eip155:421614', // Arbitrum Sepolia (Robinhood Chain Testnet: eip155:46630, Tempo Testnet: eip155:42431)
    token: TOKEN, // the token that you selected
    address: user.address,
    settlement: { contract: '0xBF66696115128B8f9f794780061348b4213A7132' },
  },
})
```

Each network uses the same contract address. The test token `tUSDC` (`0x9A38C55160186C3E1e770e193fA96997e60ed425`) and the test vault (`0xA83fE1B79cEd7772f5d90D19833b2fDD844c7801`) also have the same address on each network.

| Network | Chain id | RPC | Tokens |
|---|---|---|---|
| Arbitrum Sepolia | `eip155:421614` | `https://sepolia-rollup.arbitrum.io/rpc` | tUSDC, Circle test USDC (`0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`) |
| Robinhood Chain Testnet | `eip155:46630` | `https://rpc.testnet.chain.robinhood.com` | tUSDC |
| Tempo Testnet | `eip155:42431` | `https://rpc.moderato.tempo.xyz` | tUSDC, AlphaUSD (`0x20c0000000000000000000000000000000000001`) |

The wallet leg is the `localChain` leg of `@openrampkit/adapter-mock`. With a destination `settlement`, the leg asks for `approve` and `settle` (from `buildSettlementTxs`). It completes only when `verifySettlement` finds a receipt for the session id that pays the quoted amount. The leg does not call Relay or any other API. It reads the chain only.

The wallet is `wagmiWallet` from `@openrampkit/wagmi`, with the wagmi injected connector.

The page uses public testnet contracts and public RPCs. It has no secrets and needs no server.

### What the page checks

| Case | What you see |
|---|---|
| No wallet installed | "No browser wallet found. Install MetaMask or Rabby, then reload this page." |
| Wrong network | A **Switch** button. The widget also asks the wallet to switch before it pays. |
| You reject a request | "You rejected the request in your wallet. Nothing was sent." Select **Confirm in wallet** again. |
| Balance too low | The page checks the balance before the wallet opens. It tells you the balance and the amount, and how to get more. |
| Session already settled | The page checks the contract before the wallet opens. It tells you to start a new deposit. |
| Not enough test ETH for gas | A message that tells you to get test ETH from a faucet. |

## Solana devnet

Set **Mode** to **Testnet (real wallet)**, then set **Network** to **Solana Devnet**. You can also open `/playground/?mode=testnet&network=solana-devnet`. The banner changes to "Devnet: real transactions on Solana devnet, test tokens with no value."

You need these items:

- A Solana wallet that supports Wallet Standard, for example Phantom, Solflare or Backpack.
- Devnet USDC. Get it from the [Circle faucet](https://faucet.circle.com/). Choose **Solana Devnet**.
- A little devnet SOL for fees (0.001 SOL is enough). Get it from the [Solana faucet](https://faucet.solana.com/).

### Steps

1. Select **Connect Solana wallet**. If you have more than one Solana wallet, select one in **Solana wallet** first.
2. The panel shows your address, your devnet USDC and your devnet SOL.
3. In the widget, select **Pay with wallet**. Enter an amount, then select **Continue** and **Confirm**.
4. Select **Confirm in wallet**. Your wallet asks you to sign one USDC transfer to your own address.
5. The server checks the transfer on chain. Then the widget shows **Deposit complete**. The page shows a link to the transaction in Solana Explorer (`https://explorer.solana.com/tx/<signature>?cluster=devnet`).

The recipient is your connected wallet. Thus you get the USDC back, and you lose only the fee.

### How it works

- The session has a destination of devnet USDC (`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`) to your address.
- The wallet leg is the `solanaLocalChain` leg of `@openrampkit/adapter-mock`. It asks for one SPL transfer (`WALLET_TX`).
- The wallet is `solanaWallet` from `@openrampkit/solana`. The page asks the wallet to sign only. Then it sends the transaction through `https://api.devnet.solana.com`. Thus the transaction goes to devnet, even when the network setting of the wallet is mainnet.
- The server reads devnet over JSON-RPC. It completes the payment only when the signature succeeded, the transaction is newer than the payment, the transaction moves at least the amount of the mint to your token account, and no other payment used the signature before.

### What the page checks

| Case | What you see |
|---|---|
| No Solana wallet | "No Solana wallet found. Install Phantom, Solflare or Backpack, then reload this page." |
| Wrong network | Your wallet account does not support devnet. The page tells you to turn on testnet mode in your wallet, pick Devnet, and connect again. |
| No USDC token account | A message and a link to the Circle faucet. The widget does not open. |
| Low SOL for fees | A message and a link to the Solana faucet. The widget does not open. |
| You reject a request | "You rejected the request in your wallet. Nothing was sent." Select **Confirm in wallet** again. |
| Balance too low | The page checks the balance before the wallet opens. It tells you the balance and the amount. |
| Signature already used | The server refuses it: "This transaction was already used for another payment." |

To run the same flow from Node with a local devnet key, see [Solana devnet from Node](./solana.md#from-node).

## Limits

- The card checkout is a test form in the widget, not a hosted page. To try the hosted mock checkout in a new tab, run [`examples/next-demo`](./examples.md).
- "From an exchange" shows a deposit address only. A "connect your exchange account" flow is not available yet.
- The sessions are in memory. A page reload removes them.
- Testnet mode supports deposits only, with **Pay with wallet**.
- On Solana devnet, the page pays devnet USDC to your own wallet only.
- The testnet contracts have no intent signer. Do not use this setup in production. Read [Signed intents](../concepts/settlement.md#signed-intents).

## Run it locally

```bash
pnpm install
pnpm build
pnpm playground:dev   # http://localhost:5175/playground/
```

`pnpm playground:build` writes the static files to `examples/playground/dist`.

The source is in [`examples/playground`](https://github.com/yosriady/openrampkit/tree/main/examples/playground). The server setup is in `src/server.ts`. Testnet mode is in `src/testnet/`.

The Playwright tests run testnet mode against a local Anvil chain. They deploy the real contract with Foundry and inject a test wallet into the page. They are skipped when `anvil` or `forge` is not installed.

The Solana devnet tests inject a fake Wallet Standard wallet and answer the devnet RPC calls with a fake RPC. They need no network.

```bash
pnpm --filter playground e2e
```
