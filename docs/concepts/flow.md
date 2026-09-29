# Flow state machine

The server drives the flow. Every response carries the session's current `Step`. The modal renders the step and fires the transitions it allows.

## The Step

```ts
type Step = {
  sessionId: string
  state: StateName
  sub?: string                // provider sub-state, e.g. 'SETTLING' or 'waiting_for_deposit'
  legIndex?: number           // which leg of the pathway is active
  surface?: Surface           // what to show: QR, redirect, deposit address, ...
  transitions: Transition[]   // what the user or the client may do next
  error?: OrkError
  progress?: { legs: Array<{ adapterId: string; legId: string; provider?: string; status: LegStatus; txHash?: string }> }
  expiresAt?: string
}
```

## States

| State | Meaning | Terminal |
|---|---|---|
| `SELECT_METHOD` | No payment yet. The user picks a method, an amount and a quote. | No |
| `QUOTE` | A quote step inside a leg | No |
| `AUTH` | The provider needs the user to sign in | No |
| `KYC` | The provider needs identity checks | No |
| `PAYMENT` | The user must act: scan, pay, send, sign | No |
| `PROCESSING` | Paid; the provider or the chain is working | No |
| `COMPLETED` | Every leg succeeded | Yes |
| `FAILED` | A leg failed | Yes |
| `EXPIRED` | The session or the payment expired | Yes |
| `REFUNDED` | The provider refunded the payment | Yes |
| `BLOCKED` | Not allowed (policy or region) | Yes |

## The table as data

The legal moves live in one table in `@openrampkit/core`, `TRANSITION_TABLE`. The server, the client and the adapter test kit all read it. Terminality comes from this table, never from counting transitions.

| From | May move to |
|---|---|
| `SELECT_METHOD` | `QUOTE`, `BLOCKED`, `EXPIRED` |
| `QUOTE` | `SELECT_METHOD`, `AUTH`, `KYC`, `PAYMENT`, `PROCESSING`, `BLOCKED`, `EXPIRED` |
| `AUTH` | `KYC`, `PAYMENT`, `FAILED`, `EXPIRED` |
| `KYC` | `KYC`, `PAYMENT`, `FAILED`, `EXPIRED` |
| `PAYMENT` | `PAYMENT`, `PROCESSING`, `COMPLETED`, `FAILED`, `EXPIRED`, `QUOTE` |
| `PROCESSING` | `PROCESSING`, `PAYMENT`, `COMPLETED`, `FAILED`, `REFUNDED`, `EXPIRED` |
| `COMPLETED` | none |
| `FAILED` | `SELECT_METHOD` (try again) |
| `EXPIRED` | none |
| `REFUNDED` | none |
| `BLOCKED` | `SELECT_METHOD` |

Helpers: `isTerminal(state)`, `isLegalMove(from, to)`, `validateStep(step)`, `TABLE_VERSION` (currently `1`).

## Transitions

A step lists what may happen next:

```ts
type Transition =
  | { name: string; kind: 'SUBMIT'; label: string; inputs?: FieldSpec[] }        // a button, maybe with a form
  | { name: string; kind: 'AWAIT'; poll: PollSpec }                              // the client polls
  | { name: string; kind: 'SURFACE_RESULT'; expects: 'completed' | 'closed' | 'tx_hash' } // the surface reports back
```

- **SUBMIT**: the modal shows a button with `label`. For `FORM` and `OTP` surfaces, the first SUBMIT is the form's submit button. The mock adapter's "Simulate payment (test mode)" is a SUBMIT.
- **AWAIT**: the client polls `GET /sessions/:id/step`. The delay starts at `intervalMs`, grows by `backoff` per attempt up to `maxIntervalMs`, and stops after `giveUpAfterMs`.
- **SURFACE_RESULT**: the surface reports an outcome. For `WALLET_TX` with `expects: 'tx_hash'`, the controller sends the transactions with the wallet and fires the transition with `{ txHash }`. For `REDIRECT` with `expects: 'completed'`, the modal shows a "Continue" button after the user opened the checkout.

The client fires SUBMIT and SURFACE_RESULT with `POST /sessions/:id/transitions/:name`. The server refuses a name that is not in the current step, and refuses AWAIT names.

One name is special: `restart`. It leaves the current payment and goes back to `SELECT_METHOD`. It is allowed before payment starts, while the step is `PAYMENT`, and after a terminal state other than `COMPLETED`. The modal's "Choose another method" button on a `PAYMENT` step fires it, and so does `DepositController.back()` on a `PAYMENT` step.

## Legs and the session step

Adapters return a `LegStep` for their leg. The server wraps it into the session's `Step`:

- A leg's `status` (`pending`, `awaiting_user`, `processing`, `succeeded`, `failed`, `refunded`, `expired`) is tracked per leg in `progress`.
- When a leg succeeds and it is not the last one, the server starts the next leg at once. The session shows `PROCESSING` meanwhile.
- When every leg succeeded, the step is `COMPLETED`.
- A provider event (webhook) maps a leg status to a state: `awaiting_user` to `PAYMENT`, `pending` and `processing` to `PROCESSING`, `succeeded` to `COMPLETED`, and so on. The current surface stays until the leg ends.

The session's `status` follows the step: `open` (no active payment), `processing`, `completed`, `failed` (`FAILED` or `BLOCKED`), `expired`, `refunded`.

## Errors as fields

Errors do not end the flow with an exception. They travel as fields:

- `Step.error` on a failed step, with a recovery hint.
- `errors` next to `quotes`, one per pathway that could not be quoted.
- `MethodOption.reason` on an unavailable method.
- HTTP error responses as `{ "error": OrkError }`.

```ts
type OrkError = {
  code: OrkErrorCode
  message: string      // safe to show to the user
  retryable: boolean
  recovery?: 'requote' | 'retry_payment' | 'choose_other' | 'contact_support'
  legId?: string
}
```

| Code | Default message | Retryable |
|---|---|---|
| `REGION_UNSUPPORTED` | This method is not available in your region. | No |
| `AMOUNT_TOO_LOW` | The amount is below the minimum for this method. | No |
| `AMOUNT_TOO_HIGH` | The amount is above the maximum for this method. | No |
| `QUOTE_EXPIRED` | The quote expired. Get a new quote to continue. | Yes |
| `NO_QUOTES` | No provider can serve this amount right now. Try another method or amount. | Yes |
| `PROVIDER_DECLINED` | The provider declined this payment. Try another method. | No |
| `KYC_REJECTED` | The provider could not verify your identity. | No |
| `PAYMENT_FAILED` | The payment did not go through. You can try again. | Yes |
| `DELIVERY_FAILED` | The funds could not be delivered. Contact support. | No |
| `RATE_LIMITED` | Too many requests. Wait a moment and try again. | Yes |
| `PROVIDER_UNAVAILABLE` | The provider is not available right now. | Yes |
| `CLIENT_UPGRADE_REQUIRED` | Update the app to use this method. | No |
| `SESSION_EXPIRED` | This session expired. Start a new deposit. | No |
| `UNAUTHORIZED` | This session is not valid. | No |
| `BAD_REQUEST` | The request is not valid. | No |
| `NOT_FOUND` | Not found. | No |
| `INTERNAL` | Something went wrong on our side. | Yes |

Adapters may add their own codes. Build errors with `orkError(code, overrides)`, and throw them across boundaries as `new OrkException(error, httpStatus)`.

## The client side

`DepositController` in `@openrampkit/client` turns the steps into screens: `loading`, `methods`, `amount`, `quotes`, `step`, `result`, `error`. See [API: @openrampkit/client](../api/client.md).

![Processing, then complete](../screenshots/05-vn-processing.png)
