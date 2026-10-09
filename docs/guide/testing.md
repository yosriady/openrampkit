# Testing with mocks

You can build and test the whole flow without a provider account. The mock adapter simulates every surface, and the mock wallet simulates a connected wallet. No money moves.

## The mock adapter

```ts
import { mockAdapter } from '@openrampkit/adapter-mock'

createOpenRamp({
  // ...
  adapters: [mockAdapter({ crypto: true, bridge: true, settleMs: 3000 })],
})
```

| Option | Default | Description |
|---|---|---|
| `settleMs` | `3000` | Time from "paid" to "completed" |
| `crypto` | `false` | Add mock `wallet` and `transfer` legs (use when Relay is not configured) |
| `bridge` | `false` | Add a mock `bridge` leg for two-leg pathways (use when Relay is not configured) |
| `offramp` | `false` | Add a mock `offramp` leg for withdrawals to cash |
| `localChain` | none | Test only: add an `onchain` leg that pays with a real ERC-20 transfer on a local chain (Anvil) |
| `solanaLocalChain` | none | Test only: add a `solana-onchain` leg that pays with a real SPL transfer on Solana devnet |
| `name` | `'Test provider'` | Name shown to users |

The adapter has more options, for example `id`, `methods`, `countries`, `feeBps`, `spreadBps`, `eta`, `cardCheckout` and `exchange`. See [Mock adapter](../adapters/mock.md).

What each leg does:

| Leg | Methods | Surface | How to finish it |
|---|---|---|---|
| `card` | `card`, `apple_pay`, `google_pay` | `REDIRECT` to a mock hosted checkout | Press **Pay** (or **Decline payment**) in the new tab |
| `local` | `vietqr`, `momo`, `qris`, `gopay`, `dana`, `gcash`, `qrph`, `promptpay`, `duitnow`, `touchngo`, `paynow`, `bank_transfer` | `QR` | Press **Simulate payment (test mode)** |
| `payin` (merchant) | `qris`, `promptpay`, `vietqr`, `qrph`, `duitnow`, `paynow`, `card` | `QR` | Press **Simulate payment (test mode)** |
| `wallet` | `wallet` | `WALLET_TX` | Press **Confirm in wallet** (with a wallet adapter) |
| `transfer` | `transfer` | `DEPOSIT_ADDRESS` | Press **Simulate deposit (test mode)** |
| `bridge` | (hop) | none shown (the spec declares `DEPOSIT_ADDRESS`) | Settles by itself after `settleMs` |
| `offramp` | `bank_transfer`, `gcash`, `momo`, `promptpay` | `FORM`, then `WALLET_TX` | Fill in the payout form, then send the USDC with a wallet or the treasury |
| `onchain` | `wallet` | `WALLET_TX` | Send a real ERC-20 transfer on the local chain |
| `solana-onchain` | `wallet` | `WALLET_TX` | Send a real SPL transfer on Solana devnet |

See [Mock adapter](../adapters/mock.md) for the details.

## The mock wallet

```ts
import { createMockWallet } from '@openrampkit/client'

const wallet = createMockWallet({
  address: '0x1111111111111111111111111111111111111111', // default
  delayMs: 600, // default
  onSend: (chain, txs) => console.log('send', chain, txs),
})
wallet.sent // every send: { chain, txs, hash }
```

It reports two balances by default (250 USDC on Arbitrum and 40 USDC on Base), returns a random hash, and never touches a chain. Pass `balances` to change them. Pass it as `wallet` to `OpenRampProvider`, `OpenRampEmbedded` or `openDeposit()`.

## Test your server in-process

The server is a plain `Request -> Response` function, so tests do not need a network. Point a client at the handler with a custom `fetch`, and drive a `DepositController` like the modal does:

```ts
import { describe, expect, it } from 'vitest'
import { mockAdapter } from '@openrampkit/adapter-mock'
import { createOpenRamp } from '@openrampkit/server'
import { DepositController, createOpenRampClient } from '@openrampkit/client'

const BASE = 'http://localhost/api/openramp'

function setup() {
  const ramp = createOpenRamp({
    secret: 'test-secret-test-secret-test-secret-123',
    baseUrl: BASE,
    adapters: [mockAdapter({ settleMs: 0, crypto: true, bridge: true })],
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  })
  const fetch: typeof globalThis.fetch = async (input, init) => ramp.handle(new Request(String(input), init))
  return { ramp, client: createOpenRampClient({ baseUrl: BASE, fetch }) }
}

async function waitFor(fn: () => boolean, ms = 8000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('deposit', () => {
  it('VietQR to a merchant account completes', async () => {
    const { ramp, client } = setup()
    const s = await ramp.sessions.create({ userId: 'u1', country: 'VN', destination: { type: 'merchant', currency: 'VND' } })
    const c = new DepositController({ client, clientSecret: s.clientSecret })
    await c.start()
    await c.selectMethod('vietqr')
    c.setAmount('200000')
    await c.submitAmount()
    await c.confirm()
    expect(c.getSnapshot().session!.step.surface?.kind).toBe('QR')
    await c.fire('simulate_payment')
    await waitFor(() => c.getSnapshot().screen === 'result')
    expect((await c.done).step.state).toBe('COMPLETED')
    c.destroy()
  })
})
```

This is how the repo's own tests work (see `packages/client/src/controller.integration.test.ts`).

## Run the unit tests

From the repo root:

```bash
pnpm test        # vitest run: every packages/**/*.test.ts
pnpm coverage    # with v8 coverage
pnpm typecheck
```

Tests for the web component and React run in `happy-dom`. Adapter tests use `fakeFetch` from `@openrampkit/adapter/testing`, so they never call a real provider.

## Live provider tests

Some adapters also have live tests. They call the real provider API, so `pnpm test` does not run them. They run only when `LIVE=1` is set.

Put your keys in `.env.local` at the repo root (git ignores this file). Then run the live tests for one adapter:

```bash
set -a; . ./.env.local; set +a; LIVE=1 pnpm vitest run packages/adapters/<name>
```

For example, `packages/adapters/moonpay`. The `set -a` line exports every value in `.env.local` to the test process. Do not print the keys, and do not paste them in logs.

| Adapter | Key | What the live test does |
|---|---|---|
| MoonPay | `MOONPAY_PUBLISHABLE_KEY` (`pk_test_...`) | Reads the public countries and gets a test mode quote for USD 100 to `usdc` (Ethereum). |
| Relay | `RELAY_API_KEY` | Gets a deposit address quote and a wallet quote, USDC Arbitrum to USDC Base. Nothing is signed or sent. |
| LI.FI | `LIFI_API_KEY` | Gets one quote for 1 USDC, Arbitrum to Base, from the mainnet API. Nothing is signed or sent. |
| Peer | none | Reads the public orderbook. |
| Swapped | none | Reads the public catalog and prices. |

Rules:

- Without its key, a live test skips. The skip note gives the name of the missing variable. A fake key proves nothing, so the tests do not use one.
- Each live test has a 30 s timeout. The vitest default (5 s) is too short for real provider calls.
- Live tests get quotes only. They never send a transaction or move money.
- Sandboxes have limits. For example, MoonPay test mode has USDC only as `usdc` on Ethereum, and LI.FI has no sandbox. See the sandbox notes in [Get provider keys](./provider-keys.md).

## Real-chain test with Anvil

The mock wallet does not touch a chain. To test a `WALLET_TX` leg with real transactions, use a local [Anvil](https://book.getfoundry.sh/anvil/) chain. The test `packages/wagmi/src/anvil.test.ts` does these steps:

1. It starts Anvil on a free port (chain ID 31337, no fork).
2. It deploys a mock USDC (6 decimals) from `scripts/anvil/MockUSDC.sol`.
3. It mints 1000 mock USDC to the Anvil default dev account 0.
4. It connects the real `wagmiWallet` adapter through the wagmi `mock` connector. Anvil signs with its unlocked dev account.
5. It runs the server with `mockAdapter({ localChain })` and drives a `DepositController`: session, plan, quote, select and pay.
6. The wallet sends a real ERC-20 transfer. The adapter reads the receipt over JSON-RPC.
7. It runs `sweep()` and checks that the session is `COMPLETED`.
8. It reads the token balances on chain.

The test also checks that a transaction stays `PROCESSING` until it is mined, and that a transaction that pays another address fails.

Install Foundry first:

```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

Then run the test from the repo root:

```bash
pnpm test:chain
```

When `anvil` is not on your `PATH`, the test is skipped, and `pnpm test` skips it too. On CI, the `chain` job installs Foundry and sets `OPENRAMP_REQUIRE_ANVIL=1`. Then a missing `anvil` makes the job fail.

To start a chain for your own tests, run this command:

```bash
pnpm chain:local                  # a free port
pnpm chain:local -- --port 8545   # a fixed port
```

It prints the RPC URL and the mock USDC address. It runs until you press Ctrl+C. It needs Node 22.18 or later.

::: warning
Use only the Anvil default dev account and the mock USDC. Its private key is public. Never send real funds to it, and never use `localChain` with a real chain.
:::

## Browser tests with Playwright

`examples/next-demo` has Playwright tests that drive the real modal against the mock providers. They run in three projects:

| Project | Device |
|---|---|
| `desktop-chrome` | Desktop Chrome |
| `mobile-android` | Pixel 7 (Chrome) |
| `mobile-iphone` | iPhone 14 (WebKit, like Safari) |

```bash
cd examples/next-demo
npx playwright install           # once: download the browsers
pnpm e2e                         # all projects; starts `pnpm dev` on port 3000 for you
npx playwright test --project=mobile-iphone
npx playwright test e2e/deposit.spec.ts -g "Vietnam"
```

On CI (`CI` is set), the web server runs `pnpm build && pnpm start` and failed tests retry once.

Playwright locators pierce Shadow DOM, so you can query inside the element directly:

```ts
const modal = page.locator('openramp-modal')
await modal.getByRole('button', { name: /VietQR/ }).click()
await modal.getByRole('textbox', { name: 'Amount' }).fill('500000')
await page.getByRole('button', { name: 'Continue' }).click()
await expect(modal).toContainText('Deposit complete', { timeout: 30_000 })
```

The tests also check that your backend received `session.completed`: the demo page lists the webhooks it got.

## Capture screenshots

`e2e/screens.spec.ts` captures the screenshots used in these docs. It runs on desktop only.

```bash
cd examples/next-demo
npx playwright test e2e/screens.spec.ts --project=desktop-chrome
```

The files land in `examples/next-demo/e2e/screens/`. Copy the ones you want into `docs/screenshots/`.
