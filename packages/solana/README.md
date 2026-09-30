# @openrampkit/solana

Solana wallet adapter for OpenRampKit. It uses Wallet Standard (Phantom, Solflare, Backpack and other wallets) and `@solana/kit`.

Part of [OpenRampKit](https://github.com/yosriady/openrampkit): an open-source deposit and withdraw kit with a self-hosted server and pluggable adapters.

```bash
pnpm add @openrampkit/solana
```

```ts
import { solanaWallet } from '@openrampkit/solana'
import { combineWallets } from '@openrampkit/core'
import { wagmiWallet } from '@openrampkit/wagmi'

const sol = solanaWallet({ rpcUrl: 'https://your-solana-rpc.example' })
await sol.connect()
const wallet = combineWallets(wagmiWallet(wagmiConfig), sol)
```

Docs: https://github.com/yosriady/openrampkit/tree/main/docs/guide/solana.md

MIT licensed.
