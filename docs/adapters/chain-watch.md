# Chain watch

`@openrampkit/adapter-chain-watch` gives [standing deposit addresses](../guide/deposit-addresses.md) for the same token on the same chain. The user sends the destination token on the destination chain, so no bridge is needed: the deposit address is the destination address itself. The adapter watches the chain and reports each transfer in as one deposit. The server makes one session per deposit. No provider account is needed: only JSON-RPC URLs.

```ts
import { chainWatch } from '@openrampkit/adapter-chain-watch'
import { relay } from '@openrampkit/adapter-relay'

createOpenRamp({
  // ...
  adapters: [
    relay({ apiKey: process.env.RELAY_API_KEY }), // standing addresses that convert (another token or chain)
    chainWatch({
      rpcUrls: { 'eip155:8453': process.env.BASE_RPC_URL! },
      confirmations: { 'eip155:1': 20 },
      requestsPerSecond: 10,
      minDeposit: { 'eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': '1' }, // 1 USDC
    }),
  ],
})

const address = await openramp.depositAddresses.get({
  userId: user.id,
  origin: { chain: 'eip155:8453', token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' }, // USDC on Base
  // A deposit address that your backend made for this one user (not the user's own wallet)
  destination: { type: 'crypto', chain: 'eip155:8453', token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', address: user.depositWallet },
  dedicatedDestination: true, // required for the same token on the same chain
})
// address.address === user.depositWallet, address.adapterId === 'chain-watch'
```

Read [Security](#security) before you use it: the address is the destination, so the server credits every transfer into it to the user.

The adapter has `standingRoutes: ['same']`, so the server uses it only for a route with the same token on the same chain. A route that converts goes to another adapter, such as Relay. The adapter has no session legs: it is never part of a plan, a quote or a payment method. Its `transfer` leg is only for the deposit sessions of its addresses.

## Options

The options of the shared chain watcher (`createChainWatch` in `@openrampkit/adapter`), plus `minDeposit`.

| Option | Type | Default | Description |
|---|---|---|---|
| `rpcUrls` | `Record<string, string>` | none | JSON-RPC URL per CAIP-2 chain. Set your own in production. |
| `defaultRpcUrls` | `Record<string, string>` | public RPCs for Ethereum, Base, Arbitrum, Optimism, Polygon, Tempo, Solana (mainnet and devnet), Arbitrum Sepolia, Robinhood Chain Testnet | The URLs of the chains that `rpcUrls` does not name. Pass `{}` to watch only the chains in `rpcUrls`. The public RPCs have rate limits. |
| `confirmations` | `number \| Record<string, number>` | `12` | EVM: the blocks on top of a log's block before the log counts. One number, or one per chain (other chains get 12). |
| `solanaCommitment` | `'confirmed' \| 'finalized'` | `'finalized'` | The commitment of Solana reads |
| `logBlockRange` | `number` | `2000` | The most blocks in one `eth_getLogs` call. At most `10000`. Set it to the limit of your RPC. |
| `maxLogPages` | `number` | `5` | The most `eth_getLogs` pages in one poll (and Solana signature pages of 100). The next poll goes on from where this one stopped. |
| `requestsPerSecond` | `number` | no limit | The most RPC requests per second to one RPC URL, from this adapter instance. Calls wait for their turn. |
| `timeoutMs` | `number` | `8000` | The timeout of one RPC call |
| `minDeposit` | `Record<string, string>` | any amount above 0 | The smallest transfer that counts, in token units, per `{chain}:{token}` (lower-case token address on EVM chains, `native` for SOL). Smaller transfers are ignored. |

## What it watches

| Chain | Token | How |
|---|---|---|
| EVM | ERC-20 | The token's `Transfer` logs to the address (`eth_getLogs`), from the block after the address was made |
| EVM | native | Not supported: a native transfer has no log. `depositAddresses.get` throws `400`. |
| Solana | SPL | The signatures of the address's token accounts of the mint (`getSignaturesForAddress`), then each transaction (`getTransaction`). The amount is the net change of the owner's token balance. |
| Solana | SOL | The signatures of the address, then each transaction. The amount is the net change of the address's lamports. |

A transaction that sends more out of the address than in (a net change of 0 or less) is not a deposit.

## Money safety

- **Confirmations and re-orgs.** An EVM log counts only when its block has `confirmations` blocks on top. Solana reads use `finalized` by default. Before the leg succeeds, `status()` reads the receipt again: the transfer of the same token, recipient and amount must still be there, with its confirmations. A transaction that moved to a new block waits for its confirmations again. A transaction that is gone stays `processing` for one hour (a node can lag), then fails. A reverted transaction or another amount fails the leg at once.
- **No double counting.** Each EVM log (chain, transaction hash, log index) and each Solana signature is claimed once (`claimOnce`, key `txUsedKey`: `txused:...`). The server keeps all `txused:` keys in one namespace for all adapters, so a transfer that another adapter counted (for example a Relay same-chain payment or transfer leg) is not a deposit here, and a transfer that chain-watch counted cannot complete a Relay payment. An EVM log is also skipped when a wallet payment claimed its whole transaction, and a counted log marks its transaction for wallet payments. The deposit id is the same on every poll (`{chain}:{tx}:{logIndex}`, or `{chain}:{signature}`), so the server makes one session per deposit, also after a restart.
- **One user per address.** The first user that gets a standing address for a destination address (with its chain and token) owns it. Another user gets `409 CONFLICT`. The server keeps this binding too (for any adapter that serves same-chain routes).
- **Amounts.** A transfer below `minDeposit` is not a deposit. The session's input is the amount on chain, and `status()` checks that the chain still shows it. The session output is the same amount. The amount always uses the token's real decimals (known tokens, ERC-20 `decimals()`, or the Solana mint), never `destination.decimals` from the session input.
- **RPC replies.** The adapter does not trust the `eth_getLogs` filter. A log must be a `Transfer` of the watched token to the address, in the block range that it asked for. Other logs are skipped with a warning. The adapter still trusts your RPC for the chain state: use an RPC that you trust (your own node or a paid provider), not a public one.
- **No lost deposits.** A poll lists the deposits of the last 7 days that are at or after the server's `since` again, so a deposit that the server could not save comes back on the next poll.

## Security

The address is the destination itself, so **every transfer of the token into it counts as a deposit for its user, whoever sent it.** If a user could choose the address, the user could choose another person's wallet, and your app would credit the user for every transfer that anyone sends to that wallet. If the address also gets other payments, each of them would count twice.

So the server has these rules:

- **Only your backend asks for it.** `depositAddresses.get` needs `dedicatedDestination: true` for the same token on the same chain, else it throws `400`. Set it only for an address that your backend made for this one user (for example one deposit wallet per user that your app controls). Never pass a wallet address that the user typed or connected, and never a shared address such as your treasury.
- **Never from the widget.** `POST /sessions/:id/deposit-address` refuses the same token on the same chain (`400`). The browser cannot make the server watch an address, and it cannot take an address from another user.
- **One user per address.** A second user for the same chain, token and address gets `409 CONFLICT`.
- **Nothing else delivers to a watched address.** After a same-chain address exists, a deposit session to the same chain, token and address throws `409`, and so does a standing address of another route (one that converts) to it. A same-chain address for a destination that a converting standing address already delivers to also throws `409`. Their deliveries would arrive as transfers into the address and count twice.
- **One claim per transfer for all adapters** (see [Money safety](#money-safety)).

What the server cannot check, so you must:

- **Use a dedicated address per user.** Do not use the user's main wallet: the user may also buy crypto to it with an onramp of another app, get a payout to it, or use it for other payments. Each of those transfers would be credited again.
- **Sessions made before the watch.** The server refuses new deposit sessions to a watched address, but it does not look for open sessions that were made before. Do not watch an address that has open deposit sessions, or wait until they end.
- **Onramp deliveries.** Onramp providers do not claim their delivery transactions, so the claim namespace does not stop them. The rules above stop new sessions to a watched address; a dedicated address stops the rest.

## Limits

- Polling only: deposits are found by `sweep()`. An address that was idle for a long time catches up `logBlockRange × maxLogPages` blocks per poll.
- Solana: at most `maxLogPages × 100` new signatures per account and poll. With more, the adapter logs a warning and skips the older ones.
- A deposit made before the address existed is not counted.
- Dust: with no `minDeposit`, any transfer above 0 makes a session (and webhooks). Set `minDeposit` so that spam transfers cost the sender more than they cost you.
