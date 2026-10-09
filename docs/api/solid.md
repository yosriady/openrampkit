# @openrampkit/solid

A thin Solid wrapper over `<openramp-modal>`. It has the same API shape as [`@openrampkit/react`](./react.md). Peer dependency: `solid-js ^1.8`.

It is safe for server rendering (SolidStart). `@openrampkit/web` (and Lit) loads only in the browser, in `onMount` and in click handlers. The package has no JSX in its build, so you do not need a Babel preset for it.

```tsx
import {
  OpenRampProvider, useOpenRamp, DepositButton, WithdrawButton, OpenRampEmbedded, useDepositController,
  lightTheme, darkTheme, autoTheme,
} from '@openrampkit/solid'
```

The differences from React are the Solid conventions: `class` in place of `className`, and `isOpen` is an accessor (`isOpen()`).

## OpenRampProvider

Holds the shared config and opens the modal.

```tsx
<OpenRampProvider baseUrl="/api/openramp" theme={lightTheme()} wallet={wallet} onEvent={track}>
  <App />
</OpenRampProvider>
```

| Prop | Type | Description |
|---|---|---|
| `baseUrl` | `string` | Required. Base URL of your OpenRampKit server. |
| `wallet` | `WalletAdapter` | Enables "Pay with wallet" |
| `theme` | `Theme` | Pushed live to an open modal |
| `appearance` | `Appearance` | Pushed live to an open modal |
| `locale` | `string` | BCP 47. Pushed live to an open modal. |
| `messages` | `Partial<Messages>` | Applied when the modal opens |
| `providerRenderers` | `Record<string, ProviderRenderer>` | Renderers for `PROVIDER_SDK` surfaces |
| `onEvent` | `(e: OpenRampEvent) => void` | Every browser event |
| `children` | `JSX.Element` | |

Only one modal is open at a time. When you open a new modal, the previous modal closes. When the provider unmounts, the modal closes.

## useOpenRamp()

```ts
const { beginDeposit, beginWithdraw, close, isOpen } = useOpenRamp()

const session = await beginDeposit({ clientSecret: getClientSecret, onEvent: (e) => {} })
```

| Member | Type | Description |
|---|---|---|
| `beginDeposit({ clientSecret, onEvent? })` | `Promise<PublicSession>` | Opens the modal. Resolves when the deposit completes. Rejects (with an `OpenRampError`) when the modal closes first. Rejects on the server. |
| `beginWithdraw({ clientSecret, onEvent? })` | `Promise<PublicSession>` | The same for a withdraw session (created with `direction: 'withdraw'`). |
| `close()` | `() => void` | Closes the modal |
| `isOpen` | `Accessor<boolean>` | Whether the modal is open |

It throws when there is no `OpenRampProvider` above it.

## DepositButton

A ready-made button that calls `beginDeposit`. It is disabled while the modal is open.

```tsx
<DepositButton getClientSecret={getClientSecret} label="Add funds" class="btn" onComplete={refreshBalance} onError={showError} />
```

| Prop | Type | Description |
|---|---|---|
| `getClientSecret` | `string \| () => Promise<string>` | Required. A secret, or a function that fetches one on click. |
| `label` | `JSX.Element` | Default "Deposit" |
| `class` | `string` | |
| `disabled` | `boolean` | |
| `onComplete` | `(session: PublicSession) => void` | The deposit completed |
| `onError` | `(error: OpenRampError) => void` | The modal closed before completion (code `CLOSED`, or the step's error) |
| `onEvent` | `(e: OpenRampEvent) => void` | Browser events for this deposit (in addition to the provider's) |

### DepositButton.Custom

Use your own markup. `children` is a function that gets `{ open, isOpen }`.

```tsx
<DepositButton.Custom getClientSecret={getClientSecret} onComplete={refreshBalance}>
  {({ open, isOpen }) => (
    <button onClick={open} disabled={isOpen()} class="my-button">
      Top up
    </button>
  )}
</DepositButton.Custom>
```

The props are the same as `DepositButton` without `label`, `class` and `disabled`.

## WithdrawButton

A ready-made "Withdraw" button that calls `beginWithdraw`. `getClientSecret` must return the secret of a withdraw session. See [Withdrawals](../guide/withdraw.md). The props are the same as `DepositButton`. The default label is "Withdraw". Use `WithdrawButton.Custom` for your own markup.

```tsx
<WithdrawButton getClientSecret={getWithdrawSecret} onComplete={refreshBalance} />
```

## OpenRampEmbedded

Renders `<openramp-modal embedded>` inline, without an overlay. It follows the direction of the session, so it works for deposit and withdraw sessions.

```tsx
<OpenRampEmbedded clientSecret={clientSecret} onComplete={() => navigate('/done')} style={{ 'max-width': '420px' }} />
```

| Prop | Type | Description |
|---|---|---|
| `clientSecret` | `string \| () => Promise<string>` | Required |
| `baseUrl` | `string` | Default: the provider's `baseUrl`. Required when there is no provider. |
| `wallet`, `theme`, `appearance`, `messages`, `locale` | | Default: the provider's values |
| `onEvent` | `(e) => void` | Called after the provider's `onEvent` |
| `onComplete` | `(session) => void` | The deposit or withdrawal completed |
| `onClose` | `(session?) => void` | The user pressed Close or Done on a result or error screen |
| `onController` | `(controller) => void` | Receives the controller when it exists |
| `class`, `style` | | For the element |

It makes one controller for each client secret. A new string secret starts a new session. A new function does not. To start again with a function, render the component again, for example with `<Show keyed>`.

## useDepositController(controller)

Subscribes to a `DepositController` and returns its `Snapshot` as an accessor. Use it for a fully custom UI, or next to `OpenRampEmbedded` with `onController`. `controller` can be a value or an accessor.

```tsx
function Status(props: { controller?: DepositController }) {
  const snap = useDepositController(() => props.controller)
  return <p>{snap()?.screen}</p>
}
```

The value is `undefined` when `controller` is `undefined` or `null`. It does not subscribe during server rendering.

## Re-exports

Themes: `lightTheme`, `darkTheme`, `autoTheme` (from `@openrampkit/web/theme`, no Lit). Types: `Theme`, `ThemeOptions`, `ThemeColors`, `Appearance`, `RadiusScale`, `DepositController`, `WithdrawController`, `RampController`, `Snapshot`, `PublicSession`, `OpenRampError`, `OpenRampEvent`, `WalletAdapter`, `OpenRampConfig`, `OpenRampApi`, `OpenRampProviderProps`, `BeginDepositOptions`, `BeginWithdrawOptions`, `DepositButtonProps`, `DepositButtonCustomProps`, `DepositButtonRenderProps`, `WithdrawButtonProps`, `WithdrawButtonCustomProps`, `WithdrawButtonRenderProps`, `OpenRampEmbeddedProps`.
