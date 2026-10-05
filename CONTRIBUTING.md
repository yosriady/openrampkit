# Contributing to OpenRampKit

Thank you for your help. Contributions of all sizes are welcome. New provider adapters are the most useful.

- Start with a [good first issue](https://github.com/yosriady/openrampkit/labels/good%20first%20issue) or a [help wanted](https://github.com/yosriady/openrampkit/labels/help%20wanted) issue.
- For a large change, open an issue first. Agree on the design before you write the code.
- For a security problem, do not open an issue. Read [Security reports](#security-reports).

## Contents

- [Dev setup](#dev-setup)
- [Repo layout](#repo-layout)
- [Scripts](#scripts)
- [Write an adapter](#write-an-adapter)
- [Tests](#tests)
- [Changesets](#changesets)
- [Commits and pull requests](#commits-and-pull-requests)
- [Code style](#code-style)
- [Docs style](#docs-style)
- [Security reports](#security-reports)

## Dev setup

You need:

- **Node.js 22.** CI uses Node 22. The published packages need Node 20 or later.
- **pnpm 11.** The repo pins `pnpm@11.10.0` in `package.json`. Run `corepack enable` to get the right version.
- **Foundry (optional).** You need it only for `contracts/` and for the Anvil chain tests. Install it from [getfoundry.sh](https://getfoundry.sh).

Then:

```bash
git clone https://github.com/yosriady/openrampkit.git
cd openrampkit
pnpm install
pnpm build
pnpm test
```

To work on the contracts, get the submodules first:

```bash
git submodule update --init --recursive
cd contracts && forge build && forge test
```

To see your change in the browser, run the playground. It runs the real server in the page with mock providers, so you need no keys:

```bash
pnpm playground:dev   # http://localhost:5175/playground/
```

## Repo layout

```
.
├── packages/
│   ├── core/          types, exact money math, method and chain codes, planner, ranking
│   ├── adapter/       createAdapter(), conformance test kit, settlement helpers
│   ├── server/        createOpenRamp(): sessions, legs, webhooks, stores, sweep
│   ├── client/        framework-free HTTP client and controllers
│   ├── web/           <openramp-modal> web component (Lit)
│   ├── react/ vue/ svelte/ solid/   framework wrappers
│   ├── wagmi/ solana/ wallet adapters
│   ├── mcp/           MCP server for AI agents
│   └── adapters/      one folder per provider (relay, swapped, coinbase, ...)
├── contracts/         OpenRampSettlement (Foundry)
├── examples/
│   ├── next-demo/          Next.js app with Playwright tests
│   ├── playground/         static demo, server in the browser
│   ├── cloudflare-worker/  Worker with a Durable Object store
│   └── agent/              MCP agent example
├── docs/              VitePress docs site
├── scripts/           smoke test, Anvil, site build, live checks
└── .changeset/        pending release notes
```

Each package keeps its source in `src/` and its unit tests next to the code (`src/*.test.ts`).

## Scripts

Run these from the repo root.

| Script | What it does |
|---|---|
| `pnpm build` | Build all packages (tsup) |
| `pnpm typecheck` | Typecheck all packages |
| `pnpm test` | Unit and integration tests (Vitest) |
| `pnpm coverage` | Tests with coverage (CI runs this) |
| `pnpm smoke` | Pack and install each package, then check ESM, CJS, SSR and TypeScript |
| `pnpm test:chain` | A real `WALLET_TX` on a local Anvil chain (needs Foundry) |
| `pnpm chain:local` | Start a local Anvil chain with mock USDC |
| `pnpm docs:dev` | Docs site with hot reload |
| `pnpm docs:build` | Build the docs site (CI runs this) |
| `pnpm playground:dev` | Static playground at `http://localhost:5175/playground/` |
| `pnpm playground:build` | Build the playground |
| `pnpm site:build` | Build the docs and the playground into one site |
| `pnpm dev:example` | Next.js demo (`examples/next-demo`) |
| `pnpm live:relay` | Live Relay API check with your key (moves no money) |
| `pnpm testnet:settle` | One real settlement on Arbitrum Sepolia (or `NETWORK=tempo-testnet`) with test tokens. Reads `DEPLOYER_PRIVATE_KEY` |
| `pnpm solana:key` | Create or show the Solana devnet key of the playground (`--airdrop` asks for devnet SOL) |
| `pnpm solana:settle` | One real payment on Solana devnet with that key |
| `pnpm changeset` | Add a changeset |

To run one test file: `pnpm vitest run packages/server/src/withdraw.test.ts`.

## Write an adapter

An adapter connects one provider to OpenRampKit. It is like a wagmi connector.

1. Read [Writing an adapter](docs/adapters/writing-an-adapter.md). It covers the shape, legs, `quote()`, `start()`, `status()`, webhooks and the rules.
2. Copy a small adapter as a start. `packages/adapters/coinbase` (redirect) and `packages/adapters/xendit` (QR) are good examples.
3. Test it with the conformance kit from `@openrampkit/adapter/testing`. Use `fakeFetch` to script the provider API and `runAdapterConformance` to check the quotes, steps and webhooks. See [Test it with the kit](docs/adapters/writing-an-adapter.md#test-it-with-the-kit). The kit source is in [packages/adapter/src/testkit.ts](packages/adapter/src/testkit.ts).
4. Add a docs page in `docs/adapters/<id>.md` and a row in the adapter table of the README.
5. Mark each provider detail that you could not check against the live API with `TO VERIFY` in the source and the docs.

Adapter rules that reviewers check:

- Use decimal strings for money. Do not use floating point math. Use the helpers in `@openrampkit/core`.
- Verify provider webhooks over the raw body. Fail closed when a secret is missing.
- Never trust a value from the browser (a transaction hash, an amount, an address). Check it with the provider or on chain.
- Keep secrets on the server. A surface that goes to the browser must not contain a key.

To ask for an adapter that you will not write yourself, use the **New adapter request** issue template.

## Tests

| Kind | Where | How to run |
|---|---|---|
| Unit and integration | `packages/*/src/*.test.ts`, `packages/adapters/*/src/*.test.ts` | `pnpm test` |
| Chain (Anvil) | `packages/wagmi/src/anvil.test.ts` | `pnpm test:chain` (needs Foundry) |
| Settlement helpers (Anvil) | `packages/adapter/src/settlement*.test.ts` | `pnpm exec vitest run packages/adapter/src/settlement` (needs Foundry and the contract submodules; it runs `forge build` itself) |
| Contracts (Foundry) | `contracts/test/` (unit, fuzz, invariant) | `cd contracts && forge test` |
| Browser (Next.js demo) | `examples/next-demo/e2e/` (deposit, withdraw, axe, keyboard, locales) | see below |
| Browser (playground) | `examples/playground/e2e/` | see below |

Run the browser tests with Playwright:

```bash
pnpm build
pnpm --filter next-demo exec playwright install --with-deps chromium   # first time only
pnpm --filter next-demo e2e
pnpm --filter playground e2e
```

Rules:

- Add a test for each bug fix and each new feature.
- Tests must not call real provider APIs. Use `fakeFetch` and the mock adapter.
- A UI change needs an axe check on the new screen. Use `expectAccessible` from `examples/next-demo/e2e/a11y.ts`.

CI runs on each push to `main` and on each pull request: typecheck, `pnpm coverage`, a typecheck of the examples, `pnpm smoke`, `pnpm docs:build`, the Anvil test and the Foundry tests. See [.github/workflows/ci.yml](.github/workflows/ci.yml).

## Changesets

We use [Changesets](https://github.com/changesets/changesets) for versions and changelogs.

- When you change a published package (`packages/**`), run `pnpm changeset`. Pick the packages and the bump, then write one or two sentences for users.
- Use `patch` for fixes and `minor` for new features. All packages are `0.x`, so a breaking change is also `minor`. Say clearly in the changeset what breaks.
- Changes to docs, examples, tests and CI do not need a changeset.

## Commits and pull requests

Commits:

- Write the subject in the imperative, and keep it short. Start with the area when it helps: `Server: retry webhooks with backoff`, `Docs: MCP config reference`, `Adapter (relay): Solana deposit address`.
- Keep each commit to one change.

Pull requests:

1. Branch from `main`.
2. Run `pnpm build && pnpm typecheck && pnpm test` before you push. Run `pnpm docs:build` when you change docs.
3. Fill in the pull request template. Link the issue (`Closes #123`).
4. Add a changeset when you change a published package.
5. Add screenshots for UI changes, in the light and the dark theme.
6. Keep the pull request small. One topic per pull request is easier to review.

A maintainer reviews each pull request. CI must pass before we merge.

## Code style

There is no formatter config yet. Follow the style of the code around your change:

- TypeScript in `strict` mode with `noUncheckedIndexedAccess`. Do not use `any` when a real type is possible.
- No semicolons, single quotes, two spaces of indent, trailing commas in multi-line lists.
- ESM only, with `.js` extensions in relative imports. Use `import type` for types.
- Prefer small pure functions. Keep provider logic in adapters, not in the server or the modal.
- Errors are fields: an `OrkError` has a code, a safe message and a recovery hint. Build one with `orkError(code)` and throw it with `OrkException` (see `packages/core/src/errors.ts`).
- Use web-standard APIs (`fetch`, `Request`, `Response`, Web Crypto). The server must run on Workers, Node, Bun and Deno.
- Solidity: run `forge fmt` in `contracts/`. CI checks it.

## Docs style

The docs use plain, short sentences:

- One idea per sentence. Use the active voice.
- Follow ASD-STE100 Simplified Technical English: short sentences and simple, approved words.
- Do not use em dashes or en dashes. Use a colon, a period or parentheses.
- Use "to" for a range ("5 to 10").
- Each new public option needs a row in the docs.

## Security reports

OpenRampKit moves money. Do not open a public issue, discussion or pull request for a vulnerability.

Use GitHub private vulnerability reporting: open the **Security** tab of the repository and click **Report a vulnerability**. Read [SECURITY.md](SECURITY.md) for what to include, our response times and the threat model.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
