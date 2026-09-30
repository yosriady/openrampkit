# Relay

`@openrampkit/adapter-relay` moves crypto with [Relay](https://docs.relay.link): pay from a connected wallet, send to a deposit address, the bridge hop after a fiat onramp, and withdrawals to any wallet address.

```ts
import { relay } from '@openrampkit/adapter-relay'

relay({
  apiKey: process.env.RELAY_API_KEY,
  appFee: { bps: 25, recipient: '0xYourFeeAddress' },
  referrer: 'your-app',
  rpcUrls: { 'eip155:8453': process.env.BASE_RPC_URL! }, // for same-chain checks
})
```

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | none | Sent as `x-api-key`. Needed for `GET /requests/v3` (status of deposit-address legs) and higher rate limits. |
| `baseUrl` | `string` | `https://api.relay.link` | Use `https://api.testnets.relay.link` for testnets |
| `appFee` | `{ bps: number; recipient: string }` | none | Your fee in basis points. It accrues as a claimable balance at Relay. |
| `referrer` | `string` | none | Relay `referrer`, for attribution |
| `refundTo` | `'origin' \| string` | `'origin'` | Where Relay refunds failed deposit-address requests. `'origin'` turns on automatic refund to the original sender. |
| `rpcUrls` | `Record<string, string>` | public RPCs for Ethereum, Base, Arbitrum, Optimism, Polygon, Arbitrum Sepolia, Robinhood Chain Testnet | JSON-RPC URL per CAIP-2 chain. The adapter uses it to check same-chain, same-token moves on chain. Set your own in production: the public RPCs have rate limits. |
| `signSettlementIntent` | `(typedData) => Promise<string>` | none | Signs the EIP-712 intent for a settlement contract that has an intent signer. See [On-chain settlement](../concepts/settlement.md). |
| `settlementIntentTtlSec` | `number` | `1800` | How long a signed settlement intent stays valid, in seconds |

::: warning No API key
Without `apiKey`, status checks for `transfer` and `bridge` use the deprecated `GET /requests/v2`. Relay retires it on 2026-11-24. The adapter logs a warning once. Set an API key.
:::

## Legs

| Leg | Method | From | To | Surface | Notes |
|---|---|---|---|---|---|
| `wallet` | `wallet` | Any crypto in the user's wallet | Any crypto at an address | `WALLET_TX` | Requires a connected wallet (deposits). EVM source chains only. Also the "To wallet" leg of withdrawals. |
| `transfer` | `transfer` | Any crypto in the user's wallet | Any crypto at an address | `DEPOSIT_ADDRESS` | Any amount. The user sends from any wallet or exchange. |
| `bridge` | (hop) | USDC on Base, Arbitrum, Optimism, Polygon or Ethereum, at an address | Any crypto at an address | none shown | The second leg of a two-leg pathway |

All legs allow every region.

### wallet

- The quote calls Relay `POST /quote/v2` with the user's source token and the destination. `EXACT_INPUT` by default; `EXACT_OUTPUT` when the amount is on the destination side.
- Same chain and same token: no Relay. The adapter builds a plain transfer (native value or ERC-20 `transfer`), with no fees. It checks the transfer on chain (see [Same-chain moves](#same-chain-moves)).
- On start, the adapter reuses the quote's transaction steps when they are less than 20 seconds old and built for the same user. Otherwise it quotes again with the user's address.
- Only `transaction` steps are supported. A route that needs a `signature` step fails with `PROVIDER_DECLINED` and suggests another token or "Transfer crypto".
- After the wallet sends, the client fires `submit_tx` with `{ txHash }`. The adapter then checks `GET /intents/status/v3?requestId=...`.

#### Withdrawals

In a [withdraw session](../guide/withdraw.md), the `wallet` leg sends the session's source token to the address the user picked, on any chain and token that Relay supports. The sender is the connected wallet (`custody: 'user_wallet'`), or `treasury.address` (`custody: 'app'`). Set `treasury.address` for app custody: Relay builds its transactions for the sender, and without it the quote uses a placeholder sender. The treasury hook gets every transaction step in order (for example an approval, then the deposit).

### transfer

- The quote asks Relay for an **open deposit address** (`useDepositAddress: true`) for the source token and the destination. Deposit addresses are cached per recipient and route for 24 hours, so a user sees the same address again.
- When the user did not enter an amount, the quote uses a nominal amount (10 units of a 6 to 8 decimal token, else 0.005) to show the rate.
- Status looks for Relay requests to the deposit address that were created after the leg started (with one minute of slack), newest first.
- Same chain and same token: the address is the destination itself. See [Same-chain moves](#same-chain-moves).

![Transfer crypto](../screenshots/21-transfer-address.png)

### bridge

- Before the first leg is quoted, the server calls `prepareDeposit()`. The adapter returns an open deposit address from the hop asset to the destination. The first leg (for example Swapped) delivers there.
- The bridge leg starts as `PROCESSING` with sub-state `waiting_for_deposit`, and completes when Relay reports the request as `success`.

## Same-chain moves

When the source and the destination are the same token on the same chain, Relay is not involved. The adapter checks the chain itself, with JSON-RPC calls to `rpcUrls[chain]` (or the default public RPC). A chain without an RPC URL cannot use same-chain moves: the RPC step (the `transfer` start, or the `wallet` status check) fails with `PROVIDER_UNAVAILABLE` ("No RPC is configured to verify transfers on ...").

| Leg | Check |
|---|---|
| `wallet` | After `submit_tx`, the leg is `PROCESSING` (sub-state `confirming`) until the receipt exists (`eth_getTransactionReceipt`). The leg succeeds only when the transaction succeeded and paid the recipient at least the quoted amount: the value of a native transfer (`eth_getTransactionByHash`), or the sum of the token's `Transfer` logs to the recipient. Otherwise it fails with `DELIVERY_FAILED`. |
| `wallet` with `destination.settlement` | The wallet sends `approve` and `settle` to the settlement contract. The adapter reads the contract receipt of the session (`eth_call`) and its `Settled` log (`eth_getLogs`). The leg succeeds when the token, the recipient, the amount and the calls agree with the quote. It does not need the transaction hash. See [On-chain settlement](../concepts/settlement.md). |
| `transfer` | At start, the adapter records the current block (`eth_blockNumber`). Status looks for the token's `Transfer` logs to the destination since that block (`eth_getLogs`), and completes with their sum as the output. Native tokens are not detected: the leg stays in `PAYMENT`. |

::: warning What the check does not cover
The `wallet` check proves that the transaction paid the recipient. It does not check who sent it, or that no other session used the same hash. The `transfer` check counts every transfer to the destination after the start block, from any sender. Store `result.txHashes` with a unique constraint when you credit. See [Credit exactly once](../guide/webhooks.md#credit-exactly-once).
:::

## Status mapping

| Relay status | Leg |
|---|---|
| `success` | `succeeded` (`COMPLETED`) |
| `failure` | `failed` with `DELIVERY_FAILED` |
| `refund` | `refunded` (`REFUNDED`) |
| other | `processing` (the Relay status is the `sub` state) |

## Webhooks

The Relay adapter has no webhook handler. Status comes from polling: the browser's step poll, and the [background sweep](../api/server.md#background-sweep) (or `openramp.sessions.refresh(id)`) after the user leaves.

## Verified vs TO VERIFY

The source has no TO VERIFY markers for Relay. The Relay API paths used are `/quote/v2`, `/currencies/v2`, `/intents/status/v3`, `/requests/v3` (with a key) or `/requests/v2`, and `/chains` (health). Same-chain checks use the JSON-RPC methods `eth_getTransactionReceipt`, `eth_getTransactionByHash`, `eth_blockNumber` and `eth_getLogs`.
