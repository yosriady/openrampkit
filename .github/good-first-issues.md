# Good first issues

These issues are small, well scoped and real. Each one has context, acceptance criteria and pointers to the files. They are also open on GitHub. Most have the `good first issue` label. The React Native spike is larger and has `help wanted` only.

Read [CONTRIBUTING.md](../CONTRIBUTING.md) before you start. Comment on the issue to claim it.

---

## 1. Adapter: LI.FI for bridge and swap legs

Labels: good first issue, help wanted, adapter

### Context

Today the Relay adapter is the only bridge and swap adapter. It runs the second leg of a two-leg pathway (for example: VietQR to USDC on Base, then a bridge to a token on another chain), and it runs "Pay with wallet" and withdrawals to a wallet. A second bridge adapter gives the planner more routes and a price comparison on the crypto leg. LI.FI aggregates many bridges and DEXs and has a public quote API.

### Acceptance criteria

- A new package `packages/adapters/lifi` (`@openrampkit/adapter-lifi`) with a `lifi(options)` factory built on `createAdapter()`.
- A crypto-to-crypto leg (`from` an address on chain A, `to` an address on chain B) with `quote()`, `start()` (a `WALLET_TX` surface) and `status()`.
- Money is decimal strings. No floating point math.
- A test file that passes `runAdapterConformance` with `fakeFetch` fixtures. No real network calls in tests.
- A docs page `docs/adapters/lifi.md` and a row in the README adapter table. Mark each detail that you could not check against the live API with `TO VERIFY`.

### Pointers

- Guide: [docs/adapters/writing-an-adapter.md](../docs/adapters/writing-an-adapter.md)
- Reference adapter: [packages/adapters/relay/src](../packages/adapters/relay/src)
- Conformance kit: [packages/adapter/src/testkit.ts](../packages/adapter/src/testkit.ts)
- Pathway planner: `packages/core/src` (search for `plan`)

---

## 2. Wallet adapter: Privy

Labels: good first issue, help wanted, adapter

### Context

The modal pays from a connected wallet through a `WalletAdapter`. Today there are two: `wagmiWallet()` (EVM) and `solanaWallet()` (Solana Wallet Standard). Many apps use Privy embedded wallets. The roadmap in the README lists Privy as the next wallet adapter.

### Acceptance criteria

- A new package `packages/privy` (`@openrampkit/privy`) that exports `privyWallet(...)` and returns a `WalletAdapter`.
- It implements `connect()`, `getAccounts()`, `getBalances()` (USDC at least) and `sendTransactions(chain, txs)` for EVM chains.
- It is SSR-safe: `getAccounts()` returns `[]` on the server.
- Unit tests with a fake Privy provider, in the style of `packages/wagmi/src/wagmi.test.ts`.
- A docs section (a new page under `docs/guide/` or `docs/adapters/`) with a React example.

### Pointers

- Interface: [packages/core/src/wallet.ts](../packages/core/src/wallet.ts)
- Reference: [packages/wagmi/src/index.ts](../packages/wagmi/src/index.ts) (about 130 lines)
- Docs for wallets: [docs/adapters/wagmi.md](../docs/adapters/wagmi.md)

---

## 3. Example apps for Vue (Nuxt), Svelte (SvelteKit) and Solid (SolidStart)

Labels: good first issue, help wanted, dx

### Context

`@openrampkit/vue`, `@openrampkit/svelte` and `@openrampkit/solid` exist and have unit tests. But `examples/` has only a Next.js demo, a Worker, the playground and an MCP agent. A small runnable app per framework shows the setup end to end and catches integration bugs (SSR, hydration, bundling).

### Acceptance criteria

- One example per framework. You can take one framework per pull request: `examples/nuxt-demo`, `examples/sveltekit-demo` or `examples/solidstart-demo`.
- Each one has a server route with `createOpenRamp` and the mock adapter, a session route, and a deposit button.
- Each one builds with `pnpm --filter <name> build` and has a README with the run steps.
- Add the example to the `ignore` list in `.changeset/config.json` and to [docs/guide/examples.md](../docs/guide/examples.md).

### Pointers

- Wrappers: [packages/vue](../packages/vue), [packages/svelte](../packages/svelte), [packages/solid](../packages/solid)
- API docs: [docs/api/vue.md](../docs/api/vue.md), [docs/api/svelte.md](../docs/api/svelte.md), [docs/api/solid.md](../docs/api/solid.md)
- Reference app: [examples/next-demo](../examples/next-demo)

---

## 4. Accessibility: axe coverage for the BANK_FIELDS surface

Labels: good first issue, help wanted

### Context

`BANK_FIELDS` shows bank transfer details (for example an IBAN) with copy buttons. The web component renders it, and a unit test covers it (`packages/web/src/element.test.ts`). But no adapter in the demo returns `BANK_FIELDS`. The mock adapter uses `QR` for `bank_transfer`. Thus, the browser tests never run axe on this screen.

### Acceptance criteria

- The mock adapter can return a `BANK_FIELDS` surface (for example an option for `bank_transfer`, or a new mock leg). Keep the current default so other tests do not change.
- A Playwright test in `examples/next-demo/e2e/` opens the bank fields screen and runs `expectAccessible` in the light and the dark theme.
- The test checks that a copy button announces "Copied" through a status region.

### Pointers

- Mock adapter: [packages/adapters/mock/src/index.ts](../packages/adapters/mock/src/index.ts) (see the `surfaces` lists)
- Rendering: `packages/web/src/element.ts` (search for `BANK_FIELDS`)
- Axe helper: [examples/next-demo/e2e/a11y.ts](../examples/next-demo/e2e/a11y.ts)
- Example test: [examples/next-demo/e2e/a11y.spec.ts](../examples/next-demo/e2e/a11y.spec.ts)
- Surface docs: [docs/concepts/surfaces.md](../docs/concepts/surfaces.md)

---

## 5. Withdraw: optional server-side balance check for user wallets

Labels: good first issue, help wanted

### Context

For a withdraw session with `custody: 'user_wallet'`, the modal reads the wallet balance in the browser (`sourceBalance()` in the client). The server does not check the balance. A user with too little USDC gets quotes and only fails when the wallet rejects the transaction. An optional server check gives a clear error earlier.

### Acceptance criteria

- A new optional server config, for example `withdraw: { checkBalance: { rpcUrls } }`. It is off by default.
- When it is on, the server reads the ERC-20 `balanceOf` of `rec.walletAddress` for the session source token before it quotes or starts the first leg.
- When the balance is too low, the method is "Not available" or the request fails with a clear `OrkError` code and message.
- RPC errors do not block the withdrawal (fail open for this check only), and they are logged.
- Unit tests in `packages/server/src/withdraw.test.ts` with a fake RPC `fetch`.
- Docs in [docs/guide/withdraw.md](../docs/guide/withdraw.md).

### Pointers

- Sender logic: [packages/server/src/withdraw.ts](../packages/server/src/withdraw.ts) (`withdrawSender`)
- Wallet address input: `packages/server/src/routes.ts` (`walletAddressOf`)
- EVM helpers: [packages/adapter/src/evm.ts](../packages/adapter/src/evm.ts)
- Client balance: `packages/client/src/controller.ts` (`sourceBalance`)

---

## 6. Docs: API reference page for @openrampkit/solana

Labels: good first issue, docs

### Context

[docs/guide/solana.md](../docs/guide/solana.md) explains `solanaWallet()` and its options. But `docs/api/` has no page for `@openrampkit/solana`. Some exports are not documented: `getSolanaWallets()`, `isSolanaWallet()`, `walletStandardChain()`, `associatedTokenAddress()`, `DEFAULT_SOLANA_RPC_URLS` and the `SolanaWalletOptions` and `SolanaCommitment` types.

### Acceptance criteria

- A new page `docs/api/solana.md` with one row or section per export: signature, what it does, and a short example.
- The page is in the sidebar in `docs/.vitepress/config.ts`, next to the other API pages.
- The guide links to the new page.
- `pnpm docs:build` passes. Plain short sentences, no em dashes or en dashes.

### Pointers

- Source: [packages/solana/src/index.ts](../packages/solana/src/index.ts)
- Style reference: [docs/api/web.md](../docs/api/web.md)

---

## 7. Docs: full MCP config and CLI reference

Labels: good first issue, docs

### Context

[docs/guide/agents.md](../docs/guide/agents.md) has a table of the guardrail fields. Some fields of `OpenRampMcpConfig` are missing: `registry`, `serverInfo` and `connection`. The JSON file can also set `baseUrl`. The CLI reads `OPENRAMP_URL`, `OPENRAMP_APP_KEY`, `OPENRAMP_MCP_CONFIG`, `MCP_HTTP_TOKEN` and `PORT`, and the flags `--config` and `--port`. These are only in the source comments.

### Acceptance criteria

- The config table lists every field of `OpenRampMcpConfig`, with the default and a description.
- A new "CLI reference" section lists every environment variable and flag, and says which one wins when both are set.
- `pnpm docs:build` passes. Plain short sentences, no em dashes or en dashes.

### Pointers

- Config type: [packages/mcp/src/config.ts](../packages/mcp/src/config.ts)
- CLI: [packages/mcp/src/cli.ts](../packages/mcp/src/cli.ts)
- Example config: [examples/agent/mcp.config.example.json](../examples/agent/mcp.config.example.json)

---

## 8. CI: bundle size budget for the browser packages

Labels: good first issue, help wanted, dx

### Context

The modal ships to every user of an app, so its size matters. Today CI does not measure the size of the browser bundles. A size can grow by accident, for example when a server-only import leaks into `@openrampkit/web`.

### Acceptance criteria

- A script (for example `scripts/size.mjs`) that bundles and gzips the entry points of `@openrampkit/web`, `@openrampkit/client` and `@openrampkit/react`, and compares each one to a budget in a JSON file.
- A root script `pnpm size` that fails when a package is over its budget, and prints a table.
- A new CI step or job runs `pnpm size` after `pnpm build`. (Ask a maintainer before you edit `.github/workflows/ci.yml`.)
- A short note in CONTRIBUTING.md on how to raise a budget on purpose.

### Pointers

- Build: each package uses tsup (`packages/*/package.json`)
- Similar script: [scripts/smoke-packages.sh](../scripts/smoke-packages.sh)
- CI: [.github/workflows/ci.yml](workflows/ci.yml)

---

## 9. CI: nightly live provider checks

Labels: good first issue, help wanted, dx

### Context

Unit tests use `fakeFetch`, so they do not see a change in a provider API. `pnpm live:relay` checks the Relay adapter against the live API, and it moves no money. But it runs only by hand, and it reads the key from `examples/next-demo/.env.local`.

### Acceptance criteria

- `scripts/live-relay.mjs` also reads `RELAY_API_KEY` from the environment, and skips with a clear message when there is no key.
- A new workflow `.github/workflows/live.yml` runs on a nightly `schedule` and on `workflow_dispatch`. It builds the packages and runs `pnpm live:relay` with the key from a repository secret.
- The workflow never prints the key, and it moves no money.
- A failure opens or updates one issue (or a clear job summary), so a maintainer sees it.
- A short section in CONTRIBUTING.md on the live checks. Other providers can follow the same pattern later.

### Pointers

- Live check: [scripts/live-relay.mjs](../scripts/live-relay.mjs)
- Root script: `live:relay` in [package.json](../package.json)
- Relay adapter: [packages/adapters/relay/src](../packages/adapters/relay/src)

---

## 10. Spike: React Native package

Labels: help wanted, dx

### Context

The modal is a web component, so it does not run in React Native. Mobile apps are a large part of the users that need local payment methods. The README roadmap lists a React Native package. Before we build it, we need a short spike that finds the best approach.

### Acceptance criteria

- A short design note (a pull request that adds `docs/design/react-native.md`, or a comment on this issue) that compares at least two approaches. For example: a native UI built on `@openrampkit/client` controllers, or a WebView with the hosted pay page (`sessions.payLink()`).
- For each approach: which surfaces work (`REDIRECT`, `QR`, `DEEPLINK`, `WALLET_TX`, `IFRAME`), how a deeplink returns to the app, and how wallets connect.
- A minimal proof of concept (Expo is fine) that runs one mock deposit to `COMPLETED`.

### Pointers

- Framework-free controller: [packages/client/src/controller.ts](../packages/client/src/controller.ts)
- Pay links: [docs/api/server.md](../docs/api/server.md) (search for `payLink`)
- Surfaces: [docs/concepts/surfaces.md](../docs/concepts/surfaces.md)
