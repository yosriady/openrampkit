# LI.FI

`@openrampkit/adapter-lifi` lets the user pay from a connected wallet with any token on any supported chain. [LI.FI](https://docs.li.fi) swaps and bridges the token to the session destination. It is a second router next to [Relay](./relay.md): the server quotes both adapters and ranks the quotes.

```ts
import { lifi } from '@openrampkit/adapter-lifi'

lifi({
  apiKey: process.env.LIFI_API_KEY,
  integrator: 'your-app',
  feeBps: 25, // needs a fee wallet for `integrator` in the LI.FI Partner Portal
  rpcUrls: { 'eip155:8453': process.env.BASE_RPC_URL! }, // delivery checks on chain
})
```

To get the keys, see [Get provider keys](../guide/provider-keys.md#lifi).

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | none | Sent as `x-lifi-api-key`. Get it in the LI.FI Partner Portal. Keep it on the server. |
| `baseUrl` | `string` | `https://li.quest/v1` | The LI.FI API |
| `integrator` | `string` | none | LI.FI `integrator`: your app name, for attribution and fees |
| `feeBps` | `number` | none | Your fee in basis points. The adapter sends it as LI.FI `fee` (a fraction: 25 bps is `0.0025`). It needs `integrator`. The factory throws without it. |
| `slippageBps` | `number` | none (LI.FI picks) | LI.FI `slippage` in basis points (50 is 0.5%) |
| `order` | `'FASTEST' \| 'CHEAPEST'` | none (LI.FI picks) | LI.FI route `order` |
| `rpcUrls` | `Record<string, string>` | public RPCs for Ethereum, Base, Arbitrum, Optimism, Polygon | JSON-RPC URL per CAIP-2 chain. The adapter reads the ERC-20 allowance on the source chain, and the delivery receipt on the destination chain. Set your own in production. |
| `verifyOnChain` | `boolean` | `true` | Check the delivery `Transfer` log on chain (EVM token destinations with an RPC). When `false`, the leg uses the amount in the LI.FI status. |

::: warning Set an API key
Without `apiKey`, LI.FI allows 75 `/quote` requests in two hours, per IP. The server quotes on each amount change, so this limit is easy to reach. The adapter logs a warning once, on its first call. With a key, the default limit is 100 requests per minute, applied as a two-hour window.
:::

::: warning Fees need the Partner Portal
LI.FI refuses a quote with `fee` when the `integrator` has no fee wallet (error code `1011`). Configure the fee wallet in the Partner Portal before you set `feeBps`. LI.FI also takes its own fee (0.25% in a live quote on 2026-10-05). The quote shows it as a provider fee.
:::

## Legs

| Leg | Method | From | To | Surface | Notes |
|---|---|---|---|---|---|
| `wallet` | `wallet` | Any token in the user's wallet, on an EVM chain or Solana | Any token on an EVM chain or Solana, at an address | `WALLET_TX` | Requires a connected wallet. All regions. |

### Quote

- The adapter calls `GET /v1/quote` with `fromAmount` (exact input). When the amount is on the destination side, it calls `GET /v1/quote/toAmount` with `toAmount` (exact output).
- LI.FI needs a `fromAddress`. Before the wallet is known, the quote uses a placeholder address. The start quotes again with the real address.
- The quote output is `estimate.toAmount`. The quote data has `minOutput`: LI.FI `estimate.toAmountMin`, the smallest delivery after slippage.
- Fees: each `estimate.feeCosts` entry is a provider fee. The integrator part (`feeSplit.integratorFee`) is the app fee. `estimate.gasCosts` is the network fee, added per gas token.
- Unknown token decimals come from `GET /v1/token`, cached for 7 days in the shared store.
- The adapter checks that the route is for the chains, the tokens and the receiver it asked for. Else it fails with `PROVIDER_UNAVAILABLE`.
- No quote (`NO_QUOTES`) for: the same token on the same chain (Relay does a plain transfer), a destination with a settlement contract, or a source chain that is not EVM or Solana mainnet.

### Start

- The payment needs the user's address of the source chain. Else it fails with "Connect a wallet".
- The adapter reuses the quote's transaction when it is less than 20 seconds old and built for the same user. Else it quotes again.
- EVM: when the source is an ERC-20 token, the adapter reads the allowance for `estimate.approvalAddress` (`eth_call`). When the allowance is too small, or the RPC does not answer, the first transaction is `approve(approvalAddress, fromAmount)`. The second transaction is LI.FI's `transactionRequest`, with `value` and `gasLimit` as decimal strings.
- Solana: LI.FI returns a serialized transaction (base64) in `transactionRequest.data`. The adapter puts it in the `WALLET_TX` surface as a `SolanaTxRequest` (`type: 'transaction'`).
- The leg ref is `lifi:<sessionId>:<random>`. The session store keeps the payment record for 7 days.
- After the wallet sends, the client fires `submit_tx` with `{ txHash }` (EVM hash or Solana signature).

## Status mapping

Status calls `GET /v1/status?txHash=...&fromChain=...&toChain=...`.

| LI.FI status | Substatus | Leg |
|---|---|---|
| HTTP 404 (code `1003`) or `NOT_FOUND` | | `processing`, sub-state `not_found` |
| `PENDING` | any | `processing`, the substatus in lower case is the sub-state |
| `DONE` | `COMPLETED` | `succeeded`, after the delivery checks below |
| `DONE` | `PARTIAL` | `failed` with `DELIVERY_FAILED`: LI.FI delivered another token |
| `DONE` or `FAILED` | `REFUNDED` | `refunded` |
| `FAILED` | other | `failed` with `DELIVERY_FAILED` |
| `INVALID` | | `failed` with `DELIVERY_FAILED` |

## One payment, one session

These checks stop one transaction from paying two sessions, and stop a short delivery from completing a leg.

1. **Source tx.** `submit_tx` records the source transaction as used by (chain, tx hash) in the shared store for 90 days. A hash that another payment holds is refused (409). Status checks the record again.
2. **Source match.** LI.FI must report the same hash as the source (`sending.txHash`), on the source chain. The source tx must not be older than the payment (5 minutes of clock tolerance). When LI.FI has the quote of the transfer (`quote.stepId`), it must be the quote that the adapter gave the wallet.
3. **Delivery.** `receiving` must be on the destination chain, in the destination token, and `toAddress` must be the receiver. `receiving.amount` must be at least the quote's `toAmountMin`. The adapter compares with bigint math in base units.
4. **On chain.** For an ERC-20 destination on an EVM chain with an RPC, the adapter reads the delivery receipt (`eth_getTransactionReceipt`). One `Transfer` log of the token to the receiver must pay at least `toAmountMin`. The adapter does not add logs together. It records the log as used by (chain, tx hash, log index), so a log never completes a second session. The leg output is the amount of that log.

::: warning What the check does not cover
- Native tokens and Solana destinations have no on-chain check. The leg uses the LI.FI status, and the source tx record.
- The used records are in the LI.FI adapter's shared store. Another adapter (for example a Relay `transfer` leg on the same address) does not see them. Store `result.txHashes` with a unique constraint when you credit. See [Credit exactly once](../guide/webhooks.md#credit-exactly-once).
- The shared store has no atomic "set if absent". The adapter writes the record, then reads it back. Two checks at the same moment on an eventually consistent store can still race.
:::

## Webhooks

The LI.FI adapter has no webhook handler. Status comes from polling: the browser's step poll, and the [background sweep](../api/server.md#background-sweep) (or `openramp.sessions.refresh(id)`) after the user leaves.

## Sandbox limits

LI.FI has no sandbox host: `staging.li.quest` returns `403`. Test with small quotes on the mainnet host only. Quotes move no money. Never send the transaction in a test. Checked on 9 Oct 2026. See [Get provider keys](../guide/provider-keys.md#sandbox-and-production).

## Verified vs TO VERIFY

Checked against the live API on 2026-10-05 (no money moved):

- `GET /v1/quote` and `GET /v1/quote/toAmount` return `id`, `tool`, `action` (`fromToken`, `toToken`, `fromChainId`, `toChainId`, `toAddress`), `estimate` (`fromAmount`, `toAmount`, `toAmountMin`, `approvalAddress`, `executionDuration`, `feeCosts` with `feeSplit`, `gasCosts`) and `transactionRequest` (`to`, `data`, `value` and `gasLimit` as hex, `chainId`).
- A Solana source gives `transactionRequest.data` as a base64 transaction. Solana is chain `1151111081099710` (key `SOL`). SOL is `11111111111111111111111111111111`. EVM native tokens are `0x0000000000000000000000000000000000000000`.
- A placeholder `fromAddress` gives a quote on EVM and on Solana.
- `fee` without a Partner Portal fee wallet gives HTTP 400, code `1011`.
- `GET /v1/status` for a done transfer has `status`, `substatus`, `toAddress`, `sending` and `receiving` (`txHash`, `chainId`, `amount`, `token`, `timestamp`). An unknown hash gives HTTP 404, code `1003`.
- Rate-limit headers: `ratelimit-limit: 75`, `ratelimit-reset: 7200` without a key.

TO VERIFY (marked in the source, not checked live):

- `quote.stepId` in the status matches the `/quote` `id`. The LI.FI docs say so. The adapter checks it only when LI.FI sends it.
- `INVALID` maps to `failed`. The adapter does not send `bridge`, so LI.FI should not return it.
- Tokens such as USDT on Ethereum need an allowance of 0 before a new approval. The adapter does not reset the allowance.
- Withdraw sessions with this leg are not tested.
