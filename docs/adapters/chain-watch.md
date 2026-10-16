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
  destination: { type: 'crypto', chain: 'eip155:8453', token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', address: user.depositWallet },
})
// address.address === user.depositWallet, address.adapterId === 'chain-watch'
```

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
- **No double counting.** Each EVM log (chain, transaction hash, log index) and each Solana signature is claimed once in the adapter's shared store (`claimOnce`, key `txused:...`). The deposit id is the same on every poll (`{chain}:{tx}:{logIndex}`, or `{chain}:{signature}`), so the server makes one session per deposit, also after a restart.
- **One user per address.** The first user that gets a standing address for a destination address (with its chain and token) owns it. Another user gets `409 CONFLICT`.
- **Amounts.** A transfer below `minDeposit` is not a deposit. The session's input is the amount on chain, and `status()` checks that the chain still shows it. The session output is the same amount.
- **No lost deposits.** A poll lists the deposits of the last 7 days that are at or after the server's `since` again, so a deposit that the server could not save comes back on the next poll.

## Read this first

The address is the destination itself, so **every transfer of the token into it counts as a deposit, whoever sent it.** Use a destination address that receives only these deposits, for example one deposit wallet per user that your app controls. Do not use an address that also gets other payments, such as onramp deliveries of your own sessions or Relay same-chain transfers: each such transfer would also make a deposit session. The chain-watch claims live in this adapter's store, so they do not see the claims of other adapters.

## Limits

- Polling only: deposits are found by `sweep()`. An address that was idle for a long time catches up `logBlockRange × maxLogPages` blocks per poll.
- Solana: at most `maxLogPages × 100` new signatures per account and poll. With more, the adapter logs a warning and skips the older ones.
- A deposit made before the address existed is not counted.
