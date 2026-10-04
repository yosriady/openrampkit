# OpenRampKit demo voiceover (2:30)

Timed to `demo-final.mp4` (1280x800, 2:30, H.264 and AAC). The voice is ElevenLabs "Sarah" (premade voice `EXAVITQu4vr4xnSDxMaL`, model `eleven_multilingual_v2`). The loudness is normalised to -16 LUFS. Each line starts about 0.25 s after its scene starts. The source of truth for the lines is `scripts/demo-lines.json`.

## How to rebuild

1. `bash launch/media/scripts/tts.sh` makes one clip per line in `launch/media/.vo/` (add `--force` to make them all again). It reads `ELEVENLABS_API_KEY` from `launch/media/.env`.
2. `pnpm playground:build`, then `cd examples/playground && npx vite preview --port 5188 --strictPort`.
3. `cd examples/playground && node ../../launch/media/scripts/record-demo.mjs` records `demo-raw.webm` and the key frames. Each scene lasts at least as long as its voice line.
4. `bash launch/media/scripts/mix-demo.sh` puts each clip at its scene and writes `demo-final-hq.mp4` and `demo-final.mp4` (under 10 MB).

## Script

| Time | On screen | Voiceover |
| --- | --- | --- |
| 0:00 to 0:08 | Title card | This is OpenRampKit. Unified deposits and withdrawals for any app. The RainbowKit for onramps and deposits. |
| 0:08 to 0:21 | Playground loads, demo banner | It is open-source deposit infrastructure for crypto apps. It solves the onboarding chasm: getting billions of users onchain. This playground runs the real server in your browser, with mock providers. |
| 0:21 to 0:29 | Vietnam, Use Cash, VietQR, 500000 VND | Our user is in Vietnam. Under Use Cash, they see local methods. They pick VietQR and enter five hundred thousand dong. |
| 0:29 to 0:37 | Three quotes, "Best price" on Mock Local Rails | The pathway planner asks each provider for a quote. Three providers answer. The best price comes first. |
| 0:37 to 0:43 | VietQR code, Simulate payment | They scan the VietQR code with any banking app. In test mode, we simulate the payment. |
| 0:43 to 0:50 | Deposit complete, event log, webhook log with "signature ok" | Deposit complete. Your page gets widget events. Your backend gets a signed webhook, and the signature checks out. |
| 0:50 to 0:59 | United States: Apple Pay, Card, Google Pay; card quotes | Now a user in the United States. Card, Apple Pay and Google Pay are there. They pick card and compare quotes. |
| 0:59 to 1:10 | Test card form in the widget (4242 4242 4242 4242), Pay (test mode), Deposit complete | They type the test card number, the expiry and the CVC right in the widget. Then they pay with the test card. |
| 1:10 to 1:23 | Use Crypto, From an exchange, deposit address with network and token, Simulate deposit | Some users keep their funds on an exchange. From an exchange shows a deposit address, with the network and the token. They send USDC from their exchange account. |
| 1:23 to 1:32 | Card source off (the Use Cash tab goes away), dark theme, small corners, rounded font | You choose which payment sources to offer. Turn off card, and it is gone. Then match your brand with theme, corners and font. |
| 1:32 to 1:42 | Withdraw, Vietnam, To cash, Bank transfer, 25 USDC, payout quotes in VND | The same kit handles the way out. The user withdraws USDC to a bank account. They get a payout quote in local currency. |
| 1:42 to 1:54 | Payout details, Confirm in wallet, Withdrawal complete | They enter their bank details. Then they approve one transaction in their wallet, and the provider pays out in dong. |
| 1:54 to 2:01 | Code panel | For developers, it is a few lines. Create a session on your server. Open the widget on your page. |
| 2:01 to 2:07 | Arbitrum Sepolia explorer, transaction | Ten provider adapters, from card onramps to local rails. Self-hosted, next to your own backend. |
| 2:07 to 2:19 | Logs tab, Settled event from OpenRampSettlement | Settlement is onchain. OpenRampSettlement is live on Arbitrum Sepolia and Robinhood Chain testnet. One transaction emits a Settled event that your app can verify. |
| 2:19 to 2:30 | End card: github.com/yosriady/openrampkit, openrampkit-getformo.vercel.app | AI agents can use it too. Through MCP, an agent creates a pay link, and a person pays. OpenRampKit. MIT licensed. Get your users onchain. |

## Facts to keep correct

- Contract: OpenRampSettlement at `0xBF66696115128B8f9f794780061348b4213A7132`, on Arbitrum Sepolia and Robinhood Chain testnet.
- Explorer transaction in the video: https://arbitrum-sepolia.blockscout.com/tx/0x7e6a3848d92ea11ae833d05b9584f3f83481b9bb4f3ed849843b2ffffeea87ac
- Ten provider adapters: Coinbase, Meld, MoonPay, Onramper, Peer, Relay, Stripe, Swapped, Transak, Xendit. The four mock providers in the playground (Mock Onramp A, Mock Onramp B, Mock Local Rails, Mock Card Onramp) are not counted.
- Test cards in the playground: 4242 4242 4242 4242 pays, 4000 0000 0000 0002 declines.
- License: MIT.
- Links: https://github.com/yosriady/openrampkit and https://openrampkit-getformo.vercel.app (playground at `/playground/`).
