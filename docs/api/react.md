# @openrampkit/react

A thin React wrapper over `<openramp-modal>`. It is SSR-safe: `@openrampkit/web` (and Lit) loads only in the browser, inside effects and click handlers. Peer dependency: `react >= 18`.

```tsx
import {
  OpenRampProvider, useOpenRamp, DepositButton, OpenRampEmbedded, useDepositController,
  lightTheme, darkTheme, autoTheme,
} from '@openrampkit/react'
```

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
| `onEvent` | `(e: OrkEvent) => void` | Every browser event |
| `children` | `ReactNode` | |

Only one modal is open at a time: opening a new one closes the previous one. Unmounting the provider closes the modal.

## useOpenRamp()

```ts
const { beginDeposit, close, isOpen } = useOpenRamp()

const session = await beginDeposit({
  clientSecret: () => fetch('/api/deposit-session', { method: 'POST' }).then((r) => r.json()).then((j) => j.clientSecret),
  onEvent: (e) => {},
})
```

| Member | Type | Description |
|---|---|---|
| `beginDeposit({ clientSecret, onEvent? })` | `Promise<PublicSession>` | Opens the modal. Resolves when the deposit completes. Rejects (with an `OrkError`) when the modal closes first. Rejects in a non-browser environment. |
| `close()` | `() => void` | Closes the modal |
| `isOpen` | `boolean` | Whether the modal is open |

It throws when used outside `OpenRampProvider`.

## DepositButton

A ready-made button that calls `beginDeposit`. It is disabled while the modal is open.

```tsx
<DepositButton
  getClientSecret={getClientSecret}
  label="Add funds"
  className="btn"
  onComplete={(session) => {}}
  onError={(error) => {}}
/>
```

| Prop | Type | Description |
|---|---|---|
| `getClientSecret` | `string \| () => Promise<string>` | Required. A secret, or a function that fetches one on click. |
| `label` | `ReactNode` | Default "Deposit" |
| `className` | `string` | |
| `disabled` | `boolean` | |
| `onComplete` | `(session: PublicSession) => void` | The deposit completed |
| `onError` | `(error: OrkError) => void` | The modal closed before completion (code `CLOSED`, or the step's error) |
| `onEvent` | `(e: OrkEvent) => void` | Browser events for this deposit (in addition to the provider's) |

### DepositButton.Custom

Your own markup, like RainbowKit's `ConnectButton.Custom`:

```tsx
<DepositButton.Custom getClientSecret={getClientSecret} onComplete={refreshBalance}>
  {({ open, isOpen }) => (
    <button onClick={open} disabled={isOpen} className="my-button">
      Top up
    </button>
  )}
</DepositButton.Custom>
```

Props are the same as `DepositButton` without `label`, `className` and `disabled`, plus `children: ({ open, isOpen }) => ReactNode`.

## OpenRampEmbedded

Renders `<openramp-modal embedded>` inline, without an overlay.

```tsx
<OpenRampEmbedded clientSecret={clientSecret} onComplete={(s) => router.push('/done')} style={{ maxWidth: 420 }} />
```

| Prop | Type | Description |
|---|---|---|
| `clientSecret` | `string \| () => Promise<string>` | Required |
| `baseUrl` | `string` | Default: the provider's `baseUrl`. Required when there is no provider. |
| `wallet`, `theme`, `appearance`, `messages`, `locale` | | Default: the provider's values |
| `onEvent` | `(e) => void` | Called after the provider's `onEvent` |
| `onComplete` | `(session) => void` | The deposit completed |
| `onClose` | `(session?) => void` | The user pressed Close or Done on a result or error screen |
| `onController` | `(controller) => void` | Receives the controller once it exists |
| `className`, `style` | | For the element |

It creates one controller per client secret. A new string secret starts a new session. A new function identity does not. To restart with a function, change the component's `key`.

## useDepositController(controller)

Subscribes to a `DepositController` and returns its `Snapshot` (with `useSyncExternalStore`). Use it for a fully custom UI, or next to `OpenRampEmbedded` with `onController`.

```tsx
function Status({ controller }: { controller?: DepositController }) {
  const snap = useDepositController(controller)
  if (!snap) return null
  return <p>{snap.screen === 'step' ? snap.session?.step.state : snap.screen}</p>
}
```

It returns `undefined` when `controller` is `undefined` or `null`.

## Re-exports

Themes: `lightTheme`, `darkTheme`, `autoTheme` (from `@openrampkit/web/theme`, no Lit). Types: `Theme`, `ThemeOptions`, `ThemeColors`, `Appearance`, `RadiusScale`, `DepositController`, `Snapshot`, `PublicSession`, `OrkError`, `OrkEvent`, `WalletAdapter`, and the props types `OpenRampProviderProps`, `BeginDepositOptions`, `OpenRampApi`, `DepositButtonProps`, `DepositButtonCustomProps`, `DepositButtonRenderProps`, `OpenRampEmbeddedProps`.
