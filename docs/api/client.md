# @openrampkit/client

A framework-free client for the OpenRampKit server, and `DepositController`, the state machine behind the modal. Use it to build a custom UI, to test flows, or in React Native.

```ts
import { createOpenRampClient, DepositController, createMockWallet, toOrkError, OrkClientError } from '@openrampkit/client'
```

## createOpenRampClient(options)

```ts
const client = createOpenRampClient({
  baseUrl: '/api/openramp', // or 'https://ramp.example.workers.dev'
  fetch,                    // optional: custom fetch (tests, React Native)
})
```

Every method takes the client secret first and calls one [HTTP route](./http.md) with `Authorization: Bearer {secret}`.

| Method | Route | Returns |
|---|---|---|
| `getSession(secret)` | `GET /sessions/:id` | `PublicSession` |
| `plan(secret, { walletConnected, walletAddress?, surfaces? })` | `POST /sessions/:id/plan` | `PlanResult` |
| `quotes(secret, { method, amount, amountSide, source? })` | `POST /sessions/:id/quotes` | `{ quotes: Quote[]; errors: OrkError[] }` |
| `select(secret, { quoteId, walletAddress? })` | `POST /sessions/:id/select` (with a random `idempotency-key`) | `PublicSession` |
| `transition(secret, name, inputs?)` | `POST /sessions/:id/transitions/:name` (with a random `idempotency-key`) | `PublicSession` |
| `step(secret)` | `GET /sessions/:id/step` | `PublicSession` |
| `baseUrl` | | The base URL without a trailing slash |

The type is `OpenRampClient`.

### Errors

A non-OK response throws `OrkClientError`, which has `error` (an `OrkError`) and `status` (the HTTP status). When the body has no `OrkError` (for example an HTML 502 from a proxy), the error is built from the status: 401 and 403 give `UNAUTHORIZED`, 404 `NOT_FOUND`, 429 `RATE_LIMITED`, 5xx `PROVIDER_UNAVAILABLE`, others `INTERNAL`. A 2xx body that is not JSON throws `INTERNAL`.

`toOrkError(e)` turns anything thrown by the client, the controller or a wallet into an `OrkError`.

## DepositController

```ts
const controller = new DepositController({
  client,
  clientSecret,
  wallet,            // optional WalletAdapter
  surfaces,          // optional: surfaces your UI can draw (when unset, the server assumes every kind except PROVIDER_SDK)
  onEvent: (e) => {} // optional: browser events
})

const unsubscribe = controller.subscribe(() => render(controller.getSnapshot()))
await controller.start()
```

`createDepositController()` from `@openrampkit/web` builds one with `surfaces: SUPPORTED_SURFACES`.

It works like an external store: `getSnapshot()` returns an immutable `Snapshot`, and `subscribe(fn)` calls `fn` on every change. In React, use `useDepositController(controller)`.

### Methods

| Method | Description |
|---|---|
| `start()` | Reads the wallet accounts and balances, loads the session, and plans. If the session is already past `SELECT_METHOD` (a reload during a payment), it goes straight to the step. Emits `modal.opened` the first time. |
| `setTab(tab)` | `'crypto'` or `'cash'` |
| `methodsForTab(tab?)` | The plan's methods for a tab. Crypto: methods of kind `crypto` or `exchange`. |
| `selectMethod(method)` | Picks a method (ignored when unavailable). For `transfer` it quotes at once; otherwise it moves to the amount screen. |
| `setSource({ chain, token, symbol?, decimals? })` | The token the user pays with (`wallet`, `transfer`). Re-quotes on the transfer screen. |
| `setAmount(text)` | Keeps digits and the first decimal point: `"1,000.50"` becomes `"1000.50"` |
| `submitAmount()` | Checks the amount is above zero, then quotes |
| `refreshQuotes()` | Quotes again. Stale answers are dropped. Schedules a re-quote 10 seconds before the earliest expiry (at least 5 seconds). |
| `selectQuote(id)` | Picks a quote (the best one is picked by default) |
| `confirm()` | Selects the quote on the server and starts the first leg |
| `fire(name, inputs?)` | Fires a SUBMIT or SURFACE_RESULT transition |
| `sendWalletTransactions()` | For a `WALLET_TX` surface: sends the transactions with the wallet, then fires the `tx_hash` transition with `{ txHash }` |
| `openSurface()` | For `REDIRECT` and `DEEPLINK`: opens the URL in a new window. Call it inside a click handler. A blocked `DEEPLINK` falls back to navigating the page. |
| `notifySurface(kind, detail?)` | For a UI that reads provider iframe messages: `'completed'`, `'failed'` or `'closed'`. Polls at once. `closed` sets `surfaceClosed`. Never sets the outcome. |
| `reopenSurface()` | Clears `surfaceClosed` |
| `restart()` | Fires the server `restart` transition (back to the methods) |
| `back()` | Quotes to amount (or methods for transfer), amount to methods, and `PAYMENT` step to `restart()` |
| `close()` | Emits `modal.closed`, rejects `done` unless completed, and destroys the controller |
| `destroy()` | Stops timers and removes listeners |
| `done` | `Promise<PublicSession>`: resolves on `COMPLETED`. Rejects on `close()` before completion. A failure does not settle it: the user may try again. |

### Polling

When the step has an `AWAIT` transition, the controller polls `GET /sessions/:id/step` with the step's `PollSpec`: the delay starts at `intervalMs`, grows by `backoff` per attempt, is capped at `maxIntervalMs`, and polling stops after `giveUpAfterMs`. A poll answer that raced with a user action is dropped.

### Snapshot

```ts
type Snapshot = {
  screen: 'loading' | 'methods' | 'amount' | 'quotes' | 'step' | 'result' | 'error'
  tab: 'crypto' | 'cash'
  session?: PublicSession
  plan?: PlanResult
  method?: MethodOption
  amount: string
  amountSide: 'source' | 'destination'
  quotes: Quote[]
  quoteErrors: OrkError[]
  quotesLoading: boolean
  selectedQuoteId?: string
  busy: boolean              // an action is in flight
  error?: OrkError           // the last error, or the step's error
  walletConnected: boolean
  walletAddress?: string
  balances: WalletBalance[]  // balances above zero
  source?: { chain: string; token: string; symbol?: string; decimals?: number }
  surfaceClosed: boolean     // the provider iframe said the user closed it
}
```

| Screen | When |
|---|---|
| `loading` | Starting or re-planning |
| `methods` | The plan is ready. The tab is `cash` for merchant sessions or when no crypto method is available. |
| `amount` | A method was picked |
| `quotes` | Quotes are loading or shown |
| `step` | A payment is in progress (a non-terminal step) |
| `result` | A terminal step: `COMPLETED`, `FAILED`, `EXPIRED`, `REFUNDED` or `BLOCKED` |
| `error` | The session could not load |

When the step goes back to `SELECT_METHOD` (after `restart`), the controller clears the method and quotes and plans again.

The default source token is the largest wallet balance, else USDC on Arbitrum, Base or Optimism (not the destination chain).

## createMockWallet(options?)

A fake `WalletAdapter` for development and tests. See [Testing with mocks](../guide/testing.md#the-mock-wallet).

| Option | Default | Description |
|---|---|---|
| `address` | `0x1111...1111` | Returned on `eip155:8453` |
| `balances` | 250 USDC on Arbitrum, 40 USDC on Base | `WalletBalance[]` |
| `delayMs` | `600` | Delay before `sendTransactions` resolves |
| `onSend` | none | `(chain, txs) => void` |

The returned object also has `sent: Array<{ chain, txs, hash }>`.

## Re-exported types

`MethodOption`, `PlanResult`, `PublicSession`, `Quote`, `Step`, `WalletAdapter`, `WalletBalance` from `@openrampkit/core`; `ClientOptions`, `OpenRampClient`, `ControllerOptions`, `ScreenName`, `Snapshot`, `SurfaceSignal`, `Tab`.
