---
"@openrampkit/server": minor
"@openrampkit/adapter": minor
---

Optional server-side balance check for withdrawals from the user's wallet. With `withdraw: { checkBalance: { rpcUrls, timeoutMs? } }`, the server reads the wallet balance of the source token (ERC-20 `balanceOf`, or `eth_getBalance` for `native`) on EVM chains before it quotes and again before it starts the first leg. An amount above the balance gets `422 AMOUNT_TOO_HIGH` with the balance in the message; with `amountSide: 'destination'`, quotes above the balance become errors. RPC errors and timeouts fail open and are logged. Off by default. The adapter package adds `erc20BalanceOfData(owner)` and a `timeoutMs` option on `evmRpc`.
