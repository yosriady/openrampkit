# Live testnet check: playground "Testnet (real wallet)" on Arbitrum Sepolia

- Date: 2026-10-05
- Site: https://openrampkit-getformo.vercel.app/playground/ (bundle `index-CZMobVJV.js`, includes "Testnet (real wallet)")
- Chain: Arbitrum Sepolia (421614), RPC `https://sepolia-rollup.arbitrum.io/rpc`
- Settlement contract: `0xBF66696115128B8f9f794780061348b4213A7132`
- Wallet: `0x13B95aeC9277B3aD809737a9A1435bb2e8e77D89` (test deployer)
- Script: `examples/playground/e2e/live-testnet.mjs` (run `node e2e/live-testnet.mjs` in `examples/playground`)

## Method

The script opens the live page in Chromium and injects `window.ethereum` (EIP-1193). The provider answers
account and chain calls in the page. It sends `eth_sendTransaction` to Node through `exposeFunction`. Node
signs with viem and sends to the public RPC. The private key stays in Node. The script selects
Mode "Testnet (real wallet)", network Arbitrum Sepolia, the token and the destination, then pays in the widget.
After each flow, the script reads the receipt and `isSettled(sessionId)` on chain.
All hashes below were also checked with `cast receipt <hash> --rpc-url ...` (status 1) and
`cast call 0xBF66...7132 'isSettled(bytes32)(bool)'` (true).

## Results

| Step | Result | Transaction | Evidence |
| --- | --- | --- | --- |
| A1 Mint 100 tUSDC | PASS | [0xa080e8e1...dd56](https://sepolia.arbiscan.io/tx/0xa080e8e1a476faccf6041f784bb6539e24d80e22c3e453ca8be090cf3be4dd56) | tUSDC 208 to 308 |
| A2 Plain settlement, 3 tUSDC | PASS | approve [0x04f3d853...0422](https://sepolia.arbiscan.io/tx/0x04f3d85320ccc8009945a981e3b972771125280795a88844fd54ab931acc0422), settle [0x8ce8c2a8...dc21](https://sepolia.arbiscan.io/tx/0x8ce8c2a81e0872c5ae0248e4c9fe8d61de2c40ef3ad78e49586896261fdbdc21) | session `ors_a656d408aa153a3319821372`, isSettled true, "Deposit complete" |
| B Vault deposit, 2 tUSDC | PASS | approve [0x109ef065...5bfd](https://sepolia.arbiscan.io/tx/0x109ef065fd6cfa491fde2e8c3829c8346c3d70b99e2322a99e32c92407315bfd), settle [0x147c616f...3c99](https://sepolia.arbiscan.io/tx/0x147c616f438ceb152df34c5c427bbd9efaf92678978653c3df382b4c138e3c99) | session `ors_aa7b70021035327dc379ba10`, isSettled true, vault shares 42 to 44 |
| C Plain settlement, 1 Circle USDC | PASS | approve [0x71c85b39...b730](https://sepolia.arbiscan.io/tx/0x71c85b390a24557a750ff3108feecab937c3e53c7eed42c2dbcdcbbef228b730), settle [0xdb3a5641...6de4](https://sepolia.arbiscan.io/tx/0xdb3a5641ac473bb2d6588112fd6917678da3d6f82d4da063ecb9b6505c296de4) | session `ors_613e36ddc601f4765a6b01df`, isSettled true |
| E1 Amount above balance (70 USDC, balance 20) | PASS | none | Widget shows "Not enough USDC. You have 20, and this payment needs 70. Get test USDC at https://faucet.circle.com/". Zero wallet requests. |
| E2 Re-use of a settled session | PASS | none | After "Deposit complete" the widget has no pay button, so the UI cannot pay the session again. On chain, a replay of the settle call for `ors_a656...1372` reverts with `AlreadySettled` (`0xb196a44a`). |

Plain settlement pays the payer itself, so the token balances stay the same apart from the vault deposit
(tUSDC 308 to 306 after B; USDC stays 20). Gas for the whole run: about 0.000043 ETH. No page errors.

Screenshots:

- `live-testnet-a-plain-test-token.png`
- `live-testnet-b-vault.png`
- `live-testnet-e1-over-balance.png`
- `live-testnet-c-circle-usdc.png`

Raw output: `live-testnet-results.json`.

## Bugs and observations

No functional bugs found in testnet mode. Minor observations, not fixed:

1. After a vault deposit, the completed screen says "You get about 2 tUSDC". The user gets 2 vault shares, not tUSDC.
2. After the balance error (E1), the widget still shows "Checking status" with a spinner under the error. The session is still open, so this is correct, but it can look like the payment is in progress.
3. Every change of token, destination or vault amount creates a new session (the webhook log fills up). This is how the demo is built.

An earlier run (same day) also passed B and C on chain. Its flow A failed only because the script
clicked in a widget that "Start deposit" replaced a moment later. The script now waits for the new widget.
Earlier run transactions: mint `0xa2c397fe020c33ba23a750540116a00a409b832c9edc5d245a35344a93e1b919`,
B settle `0xdc6d75fd68294488b40e7a8c93b5001984b7d8fb66dccf74e1fb2033e9951d0b`,
C settle `0xba9cb4cf73289055296617baddd8460cc07872b3192def2339dff1659787339b`.
