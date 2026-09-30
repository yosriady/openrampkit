# OpenRampKit demo voiceover (2:30)

Timed to `demo-draft.mp4` (1280x800, 2:30). Read at a calm pace, about 110 words per minute (about 270 words in total). Timestamps are video time. The on-screen captions in the draft match these beats.

| Time | On screen | Voiceover |
| --- | --- | --- |
| 0:00 to 0:05 | Title card | This is OpenRampKit. The RainbowKit for onramps and deposits. |
| 0:05 to 0:12 | Playground loads | Open-source, unified deposit infrastructure for crypto apps. We are solving the onboarding chasm: getting billions of users onchain. |
| 0:12 to 0:16 | Use Cash tab, Vietnam methods | Our user is in Vietnam. They see local payment methods. |
| 0:16 to 0:22 | VietQR, amount typed | They pick VietQR, the national bank QR, and enter an amount in dong. |
| 0:22 to 0:27 | Quotes | The pathway planner gets quotes from each provider and ranks them. |
| 0:27 to 0:32 | VietQR code | They scan this code with any Vietnamese banking app. |
| 0:32 to 0:39 | Simulate payment, progress, Deposit complete | In test mode, we simulate the bank payment. Seconds later: deposit complete. |
| 0:39 to 0:49 | Event log and webhook log | This playground runs the real OpenRampKit server in the browser. Your page gets widget events. Your backend gets signed webhooks. |
| 0:49 to 0:56 | Indonesia: QRIS, GoPay, DANA | Switch to Indonesia. Now it is QRIS, GoPay and DANA. |
| 0:56 to 1:00 | Thailand: PromptPay | Thailand gets PromptPay. Local QR rails come first. |
| 1:00 to 1:12 | Withdraw, To cash, bank transfer, amount | The same kit handles the way out. The user withdraws USDC to a Thai bank account. |
| 1:12 to 1:28 | Payout quote, payout details | They get a payout quote in baht. They enter their bank details. No new app. No exchange account. |
| 1:28 to 1:37 | Confirm in wallet, sending, Withdrawal complete | They approve one transaction in their wallet. The provider pays out in baht. |
| 1:37 to 1:48 | Code panel, dark theme | For developers, it is a few lines. Create a session on your server. Open the widget on your page. Theme it to match your app. |
| 1:48 to 1:57 | Arbitrum Sepolia explorer, transaction details | Ten provider adapters, from card onramps to local rails. Self-hosted, next to your own backend. |
| 1:57 to 2:11 | Logs tab, Settled event | Settlement is onchain. OpenRampSettlement is live on Arbitrum Sepolia and Robinhood Chain testnet. One transaction takes the funds and deposits them into a vault. It emits a Settled event that your app can verify. |
| 2:11 to 2:22 | End card | AI agents can use it too. Through MCP, an agent creates a pay link, and a person completes the payment. |
| 2:22 to 2:30 | End card | OpenRampKit. MIT licensed. Get your users onchain. |

## Facts to keep correct

- Contract: OpenRampSettlement at `0xBF66696115128B8f9f794780061348b4213A7132`, on Arbitrum Sepolia and Robinhood Chain testnet.
- Explorer transaction in the video: https://arbitrum-sepolia.blockscout.com/tx/0x7e6a3848d92ea11ae833d05b9584f3f83481b9bb4f3ed849843b2ffffeea87ac
- Ten provider adapters: Coinbase, Meld, MoonPay, Onramper, Peer, Relay, Stripe, Swapped, Transak, Xendit. The mock adapter used in the playground is not counted.
- License: MIT.

## Optional on-screen text for the address

If you want the address on screen, add it as a lower third from 1:57 to 2:11: `OpenRampSettlement 0xBF66...7132`.
