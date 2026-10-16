---
'@openrampkit/adapter-chain-watch': minor
'@openrampkit/adapter': minor
'@openrampkit/adapter-relay': patch
'@openrampkit/server': minor
---

Standing deposit addresses for the same token on the same chain, with no bridge provider.

- New `@openrampkit/adapter-chain-watch` (`chainWatch()`): the deposit address is the destination itself, and the adapter watches the chain (ERC-20 `Transfer` logs on EVM chains, SOL and SPL signatures on Solana). A transfer counts after `confirmations` blocks (default 12; Solana `finalized`). Each log or signature is claimed once, so it makes one session. `status()` reads the transaction again: a transfer that a re-org removed, or with another amount, fails the leg. Options: `rpcUrls`, `defaultRpcUrls`, `confirmations`, `solanaCommitment`, `logBlockRange`, `maxLogPages`, `requestsPerSecond`, `timeoutMs`, `minDeposit`. It has no session legs (it is never in a plan).
- `@openrampkit/adapter`: new `createChainWatch()` (RPC URLs per chain, a rate limit per RPC URL, `Transfer` log pages with a block range cap, Solana reads), `txUsedKey`, `PUBLIC_RPC_URLS`, `solanaNetReceived` and `solanaMintDecimals`. New optional `Adapter.standingRoutes` (`'convert'` by default, or `'same'`).
- `@openrampkit/adapter-relay`: the same-chain checks use `createChainWatch`. No behavior change. New option `rpcRequestsPerSecond`. `logBlockRange` is capped at 10000.
- `@openrampkit/server`: `depositAddresses.get` accepts the same token on the same chain and picks an adapter that serves the route (`standingRoutes`). Such an adapter must return the destination address itself. The widget route picks the adapter by route too.
