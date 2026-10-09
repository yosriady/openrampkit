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

To get the keys, see [Get provider keys](../guide/provider-keys.md#relay).

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | none | Sent as `x-api-key`. Needed for `GET /requests/v3` (status of deposit-address legs) and higher rate limits. |
| `baseUrl` | `string` | `https://api.relay.link` | Use `https://api.testnets.relay.link` for testnets |
| `appFee` | `{ bps: number; recipient: string }` | none | Your fee in basis points. It accrues as a claimable balance at Relay. |
| `referrer` | `string` | none | Relay `referrer`, for attribution |
| `refundTo` | `'origin' \| string` | `'origin'` | Where Relay refunds failed deposit-address requests. `'origin'` turns on automatic refund to the original sender. |
| `rpcUrls` | `Record<string, string>` | public RPCs for Ethereum, Base, Arbitrum, Optimism, Polygon, Tempo, Solana (mainnet and devnet), Arbitrum Sepolia, Robinhood Chain Testnet | JSON-RPC URL per CAIP-2 chain. The adapter uses it to check same-chain, same-token moves on chain. Set your own in production: the public RPCs have rate limits. |
| `signSettlementIntent` | `(typedData) => Promise<string>` | none | Signs the EIP-712 intent for a settlement contract that has an intent signer. See [On-chain settlement](../concepts/settlement.md). |
| `settlementIntentTtlSec` | `number` | `1800` | How long a signed settlement intent stays valid, in seconds |
| `slippageBps` | `number` | none (Relay picks) | Relay `slippageTolerance` in basis points (0 to 10000), sent with every quote. The quote data has `minOutput`: the smallest output after slippage (Relay `minimumAmount`). |
| `amountToleranceBps` | `number` | `50` | How far below the expected amount a deposit can be and still complete a `transfer` leg, in basis points. A `bridge` leg uses at least 500. See [One deposit, one session](#one-deposit-one-session). |
| `logBlockRange` | `number` | `2000` | The most blocks in one `eth_getLogs` call, for same-chain `transfer` checks. Set it to the limit of your RPC. |

::: warning No API key
Set an API key. Two facts apply:

- Relay requires an API key for quotes (`POST /quote/v2`) under its announced policy from 2 Oct 2026. Some requests without a key may still work today, but Relay can refuse them at any time. Always set `RELAY_API_KEY`. The adapter uses quotes for prices and for deposit addresses. Source: [Relay API keys](https://docs.relay.link/references/api/api-keys). On 9 Oct 2026, some quotes without a key still returned `200`. A quote that sets `referrer` without a key is refused now. When Relay refuses a quote, it returns 401 with `errorCode` `UNAUTHORIZED_QUOTE`. The adapter maps it to `PROVIDER_UNAVAILABLE` (not retryable), with a message that names `RELAY_API_KEY`, and logs a warning.
- Without `apiKey`, status checks for `transfer` and `bridge` use the deprecated `GET /requests/v2`. Relay retires it on 2026-11-24.

When there is no key, the adapter logs a warning once, on its first call.
:::

## Legs

| Leg | Method | From | To | Surface | Notes |
|---|---|---|---|---|---|
| `wallet` | `wallet` | Any crypto in the user's wallet | Any crypto at an address | `WALLET_TX` | Requires a connected wallet (deposits). EVM and Solana source chains. Also the "To wallet" leg of withdrawals. |
| `transfer` | `transfer` | Any crypto in the user's wallet | Any crypto at an address | `DEPOSIT_ADDRESS` | Any amount. The user sends from any wallet or exchange. |
| `bridge` | (hop) | USDC on Base, Arbitrum, Optimism, Polygon or Ethereum, at an address | Any crypto at an address | none shown | The second leg of a two-leg pathway |

All legs allow every region.

### wallet

- The quote calls Relay `POST /quote/v2` with the user's source token and the destination. `EXACT_INPUT` by default; `EXACT_OUTPUT` when the amount is on the destination side.
- Same chain and same token: no Relay. The adapter builds a plain transfer (native value or ERC-20 `transfer`), with no fees. It checks the transfer on chain (see [Same-chain moves](#same-chain-moves)).
- On start, the adapter reuses the quote's transaction steps when they are less than 20 seconds old and built for the same user. Otherwise it quotes again with the user's address.
- Only `transaction` steps are supported. A route that needs a `signature` step fails with `PROVIDER_DECLINED` and suggests another token or "Transfer crypto".
- After the wallet sends, the client fires `submit_tx` with `{ txHash }`. The adapter then checks `GET /intents/status/v3?requestId=...`.

#### Solana and Tempo

- **Solana origin.** Relay returns Solana instructions and address lookup tables. The adapter puts them in the `WALLET_TX` surface as a `SolanaTxRequest` (`type: 'instructions'`). `@openrampkit/solana` builds, signs and sends the transaction. `submit_tx` takes the base58 signature.
- **Solana `user`.** Relay needs a `user` of the origin chain's kind. The quote uses a placeholder until a Solana address is known. The payment starts only with a Solana address; else it fails with "Connect a Solana wallet to pay from Solana."
- **Solana destination.** Deposits from EVM chains to Solana work with a Solana `recipient`. For open deposit addresses on an EVM origin, `user` is an EVM placeholder, because Relay rejects a Solana `user` there.
- **Solana deposit addresses.** An open deposit address on Solana (the user sends from Solana) needs a Relay API key.
- **Tempo.** Relay supports Tempo (chain id `4217`). USDC on Tempo is `0x20c000000000000000000000b9537d11c60e8b50`. See [Chains and tokens](../concepts/chains.md#tempo).

See [Solana](../guide/solana.md) for the full guide.

#### Withdrawals

In a [withdraw session](../guide/withdraw.md), the `wallet` leg sends the session's source token to the address the user picked, on any chain and token that Relay supports. The sender is the connected wallet (`custody: 'user_wallet'`), or `treasury.address` (`custody: 'app'`). Set `treasury.address` for app custody: Relay builds its transactions for the sender, and without it the quote uses a placeholder sender. The treasury hook gets every transaction step in order (for example an approval, then the deposit).

### transfer

- The quote asks Relay for an **open deposit address** (`useDepositAddress: true`) for the source token and the destination. Relay gives a new address for each quote. The adapter keeps one address per session and route (in the session store, for 24 hours). It never gives the address of one session to another session.
- When the user did not enter an amount, the quote uses a nominal amount (10 units of a 6 to 8 decimal token, else 0.005) to show the rate.
- The leg ref is `dep:<sessionId>:<address>`, so one ref maps to one session.
- Status reads the Relay requests of the deposit address (`depositAddress=...`), oldest first. It binds the first request that was created after the leg started (with one minute of slack) and that no other session has. Relay can re-quote a deposit under a new request id, so the bind key is the deposit tx hash (`depositAddress.depositTxHash`). Then status follows that request only (by `id` when it is no longer in the list).
- When the user entered an amount, the request deposit (`metadata.currencyIn.amount`) must be at least that amount minus `amountToleranceBps`. A smaller deposit does not complete the leg. Relay still delivers or refunds it.
- Same chain and same token: the address is the destination itself. See [Same-chain moves](#same-chain-moves).

![Transfer crypto](../screenshots/21-transfer-address.png)

### bridge

- Before the first leg is quoted, the server calls `prepareDeposit()`. The adapter returns an open deposit address from the hop asset to the destination. The first leg (for example Swapped) delivers there.
- The bridge leg starts as `PROCESSING` with sub-state `waiting_for_deposit`, and completes when Relay reports the request as `success`.
- The expected deposit is the input of the bridge quote. The tolerance is at least 5%, because the onramp can deliver a little less than its quote.

## Same-chain moves

When the source and the destination are the same token on the same chain, Relay is not involved. The adapter checks the chain itself, with JSON-RPC calls to `rpcUrls[chain]` (or the default public RPC). A chain without an RPC URL cannot use same-chain moves: the RPC step (the `transfer` start, or the `wallet` status check) fails with `PROVIDER_UNAVAILABLE` ("No RPC is configured to verify transfers on ...").

| Leg | Check |
|---|---|
| `wallet` | After `submit_tx`, the leg is `PROCESSING` (sub-state `confirming`) until the receipt exists (`eth_getTransactionReceipt`). The leg succeeds only when the transaction succeeded, was mined after the payment started (the block time from `eth_getBlockByNumber`, with 5 minutes of clock tolerance), paid the recipient at least the quoted amount (the value of a native transfer from `eth_getTransactionByHash`, or the sum of the token's `Transfer` logs to the recipient), and did not complete another payment before. Otherwise it fails with `DELIVERY_FAILED`. |
| `wallet` with `destination.settlement` | The wallet sends `approve` and `settle` to the settlement contract. The adapter reads the contract receipt of the session (`eth_call`) and its `Settled` log (`eth_getLogs`). The leg succeeds when the token, the recipient, the amount and the calls agree with the quote. It does not need the transaction hash. See [On-chain settlement](../concepts/settlement.md). |
| `transfer` | At start, the adapter records the current block (`eth_blockNumber`). Status reads the token's `Transfer` logs to the destination since that block (`eth_getLogs`), in pages of `logBlockRange` blocks, at most 5 pages per check. The next check goes on from where the last one stopped. One log completes the leg, with its amount as the output. The adapter does not add logs together. See [One deposit, one session](#one-deposit-one-session). Native tokens are not detected: the leg stays in `PAYMENT`. |
| `wallet` (Solana) | `getSignatureStatuses` must show `confirmed` or `finalized` with no error. Then `getTransaction` (`jsonParsed`) must show that the recipient got at least the quoted amount: the balance change of its token accounts for the mint, or its lamport change for SOL. The block time must not be before the payment started (5 minutes of tolerance). One signature completes one payment only. |
| `transfer` (Solana) | Status reads the recipient's token accounts for the mint (`getTokenAccountsByOwner`), then their recent signatures (`getSignaturesForAddress`) since the leg started. It reads the new, successful signatures oldest first. One signature completes the leg, with what it paid the recipient as the output. The adapter does not add signatures together. The rules are the same as for `Transfer` logs on EVM: see [One deposit, one session](#one-deposit-one-session). For SOL, it reads the signatures of the recipient address. |

::: warning What the check does not cover
The `wallet` check proves that a new transaction paid the recipient, and that no other session of this adapter used the same hash (the record lives in the shared store for 90 days). It does not check who sent it. The `transfer` check takes a transfer to the destination after the start block, from any sender. Store `result.txHashes` with a unique constraint when you credit. See [Credit exactly once](../guide/webhooks.md#credit-exactly-once).
:::

## One deposit, one session

A deposit completes one session only. These rules apply to same-chain `transfer` legs (EVM `Transfer` logs and Solana signatures) and to deposit-address legs (`transfer` and `bridge`).

1. **Amount.** When the user gave an amount, one deposit must be at least that amount minus `amountToleranceBps` (default 0.5%; a `bridge` leg uses at least 5%). The adapter uses integer math in base units. A dust transfer does not complete a leg. When the user gave no amount, any deposit above zero counts.
2. **Used record.** The adapter records each deposit as used in the shared store for 90 days: a `Transfer` log by (chain, tx hash, log index), a Solana deposit by (chain, signature), and a Relay request by its deposit tx hash. A used deposit never completes a second session. A same-chain `wallet` payment cannot use a transaction that a `transfer` leg used, and the reverse.
3. **Ambiguity.** Each open deposit leg puts a watch on its address in the shared store (for 24 hours). When another open leg on the same address could also claim a deposit, the deposit is ambiguous. An exception: the deposit is the exact amount of this leg (within the tolerance) and of no other leg. An ambiguous deposit completes no session. The leg stays in its waiting state with sub-state `ambiguous_deposit`, and the adapter logs a warning. A finished leg removes its watch.

The adapter writes the used record with `claimOnce`. On a store with `putIfAbsent` (`memoryStore`, `redisStore`, `durableObjectStore`), the claim is atomic: when two status checks take the same deposit at the same moment, exactly one wins. On a store without it (for example Workers KV), the adapter writes the used record, then reads it back. Two checks at the same moment can then still race.

::: tip Safe setups
A shared destination (one treasury or vault address for all users) cannot tell two sessions with the same amount apart. Use one of these:

- **A unique address per session.** Relay deposit-address legs do this: each session gets its own Relay address. For same-chain deposits, give each session its own destination address.
- **A wallet payment.** The `wallet` leg checks the tx hash that the user's wallet sent for this session.
- **A settlement contract.** With `destination.settlement`, the contract records the session id. See [On-chain settlement](../concepts/settlement.md).
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

## Sandbox limits

The testnets host (`https://api.testnets.relay.link`) knows ETH on Base Sepolia and on Sepolia. It does not know USDC on Base Sepolia. To test on testnets, quote ETH, not USDC. Checked on 9 Oct 2026. See [Get provider keys](../guide/provider-keys.md#sandbox-and-production).

## Verified vs TO VERIFY

The source has no TO VERIFY markers for Relay. The Relay API paths used are `/quote/v2`, `/currencies/v2`, `/intents/status/v3`, `/requests/v3` (with a key) or `/requests/v2` (by `depositAddress`, or by `id`), and `/chains` (health). A live check on 2026-10-05 showed: two `/quote/v2` calls with `useDepositAddress: true` and the same parameters give two different addresses; a request has `depositAddress.depositTxHash` and `metadata.currencyIn.amount` (base units); `inTxs[].data.value` is `0` for an ERC-20 deposit. Same-chain checks use the JSON-RPC methods `eth_getTransactionReceipt`, `eth_getTransactionByHash`, `eth_getBlockByNumber`, `eth_blockNumber`, `eth_getLogs` and `eth_call` (settlement receipts) on EVM chains, and `getSignatureStatuses`, `getTransaction`, `getTokenAccountsByOwner` and `getSignaturesForAddress` on Solana.
