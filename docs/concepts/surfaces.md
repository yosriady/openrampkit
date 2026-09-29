# Surfaces

A **surface** is what the user must see or do in a step. Adapters return a surface in their `LegStep`. The modal draws it. The modal has no provider-specific code: a new provider works in the modal as long as it uses these kinds.

```ts
type SurfaceKind = 'REDIRECT' | 'IFRAME' | 'PROVIDER_SDK' | 'QR' | 'DEEPLINK' | 'BANK_FIELDS'
                 | 'DEPOSIT_ADDRESS' | 'WALLET_TX' | 'OTP' | 'FORM'
```

Each leg spec lists the surfaces it may use (`LegSpec.surfaces`). The client tells the server which surfaces it can draw (`POST /plan` with `surfaces`). The planner marks legs that need other surfaces as unavailable with `CLIENT_UPGRADE_REQUIRED`. The web modal draws every kind except `PROVIDER_SDK` (`SUPPORTED_SURFACES`).

## REDIRECT

```ts
{ kind: 'REDIRECT'; url: string; popup: boolean; provider?: string; keepReferrer?: boolean }
```

A hosted page at the provider: a card checkout, a bank login, an e-wallet web checkout.

- The server replaces `url` with a signed, popup-safe start URL on your own origin (see [Sessions](./sessions.md#popup-safe-start-urls)).
- The modal shows "You will finish this step on {provider}. Come back here when you are done." and a **Continue to {provider}** button. The click opens the URL in a new tab, so popup blockers allow it.
- After the click, the text changes to "Waiting for {provider}. Keep this window open." and the button to **Open again**. If the step has a `SURFACE_RESULT` transition with `expects: 'completed'`, a **Continue** button fires it.
- The modal keeps polling the step while the user pays in the other tab.

| Redirect | Hosted checkout (mock) |
|---|---|
| ![](../screenshots/30-card-redirect.png) | ![](../screenshots/31-card-checkout.png) |

## IFRAME

```ts
{ kind: 'IFRAME'; url: string; origin: string; allow?: string; height?: number; provider?: string; messages?: IframeMessages }
```

A provider widget inside the modal (Swapped, Transak by default).

- The iframe gets `allow` (default `payment; camera; microphone; clipboard-write`), a `sandbox` that allows scripts, same origin, forms, popups and top navigation on user action, and `height` (default 560 px).
- `messages` tells the modal how to read `postMessage` events from the widget:

```ts
type IframeMessages = {
  origin?: string        // allowed sender origin; default: the surface `origin`
  completed?: string[]   // event types that mean the user finished paying
  failed?: string[]      // event types that mean the payment failed
  closed?: string[]      // event types that mean the user closed the provider page
  typeField?: string     // field of event.data that holds the type; default 'type'
}
```

The modal also accepts a generic message shape from any widget: `{ source: 'openramp-embed', type: 'payment.completed' | 'payment.failed' | 'closed' }`.

::: warning Messages are hints
The modal accepts a message only when `event.origin` equals the allowed origin exactly and `event.source` is the modal's own iframe. Even then, a message never sets the outcome. It only makes the client check the server status at once. On `closed`, the modal shows a notice with **Try again** (show the widget again) and **Choose another method**.
:::

## PROVIDER_SDK

```ts
{ kind: 'PROVIDER_SDK'; provider: string; params: Record<string, unknown> }
```

A step that needs the provider's own browser SDK. The web modal does not draw it: it shows "This step needs the {provider} SDK. This screen cannot show it." The web client does not list it in its surfaces, so the planner hides legs that need only this surface. A custom UI can support it.

## QR

```ts
{ kind: 'QR'; payload: string; amount: string; currency: string; reference?: string; method?: string; expiresAt?: string }
```

A payment QR code: QRIS, QR Ph, PromptPay, VietQR, DuitNow, PayNow and so on.

- The modal shows the amount in large text, the method name and "Scan with your banking or e-wallet app", the QR code, a countdown when `expiresAt` is set, and the `reference` with a copy button.

![VietQR](../screenshots/04-vn-qr.png)

## DEEPLINK

```ts
{ kind: 'DEEPLINK'; url: string; appName: string }
```

Opens an app on the phone, for example an e-wallet. The modal shows an **Open {appName}** button. It tries a new window first. If the browser blocks it, it navigates the current page to the link.

## BANK_FIELDS

```ts
{ kind: 'BANK_FIELDS'; fields: Array<{ label: string; value: string; copy: boolean }> }
```

Bank transfer details: account number, bank name, reference. The modal shows each field as a row, with a copy button when `copy` is true.

## DEPOSIT_ADDRESS

```ts
{ kind: 'DEPOSIT_ADDRESS'; chain: string; chainName?: string; token: string; symbol?: string;
  address: string; min?: string; memo?: string; warning?: string }
```

"Transfer crypto": the user sends tokens from any wallet or exchange.

- The modal shows "Send {symbol} on {chain} to this address", a QR code of the address, the address and memo with copy buttons, the network and the token, the minimum, and a warning. The default warning is "Send only {symbol} on {chain}. If you send another token or use another network, you can lose the funds."

![Deposit address](../screenshots/21-transfer-address.png)

## WALLET_TX

```ts
{ kind: 'WALLET_TX'; chain: string; txs: TxRequest[] }
type TxRequest = { to: string; data?: string; value?: string; chainId: number; gas?: string }
```

Transactions for the user's connected wallet to sign, in order (for example an approval, then a deposit).

- The modal shows "Approve N transactions on {chain}." and a **Confirm in wallet** button. While the wallet is open, the button says "Check your wallet".
- On click, `DepositController.sendWalletTransactions()` calls `wallet.sendTransactions(chain, txs)` and fires the step's `SURFACE_RESULT` (`expects: 'tx_hash'`) transition with `{ txHash }`.

![Confirm in wallet](../screenshots/12-wallet-confirm.png)

## OTP

```ts
{ kind: 'OTP'; channel: 'email' | 'sms'; to: string }
```

A one-time code. The modal shows "Enter the code we sent to {to}" and a code field (numeric keyboard, `autocomplete="one-time-code"`). The field id comes from the first SUBMIT transition's first input, or `code`. Submitting fires that transition with `{ [id]: value }`.

## FORM

```ts
{ kind: 'FORM'; fields: FieldSpec[] }
type FieldSpec = { id: string; label: string; type: 'text' | 'email' | 'tel' | 'number' | 'select' | 'checkbox';
                   required?: boolean; options?: Array<{ value: string; label: string }> }
```

A small form, for example extra details a provider needs. The first SUBMIT transition is the submit button. The values are sent as `inputs` keyed by field id.

## No surface

A step without a surface (for example `PROCESSING` during a bridge hop) shows a spinner and the progress of each leg: "1. Test provider: done. 2. Relay: in progress".

## Custom UIs

If you build your own UI on `DepositController`, pass the surfaces you can draw as `surfaces` in the controller options (or `createDepositController`). The server then plans only pathways your UI can finish.
