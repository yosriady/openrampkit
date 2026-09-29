# @openrampkit/web

The `<openramp-modal>` web component (Lit, Shadow DOM), `openDeposit()`, `openWithdraw()`, themes and message catalogs.

```ts
import { openDeposit, openWithdraw, createDepositController, lightTheme, darkTheme, autoTheme, defaultMessages } from '@openrampkit/web'
import { lightTheme } from '@openrampkit/web/theme' // themes only, no Lit (safe on the server)
```

Importing `@openrampkit/web` registers the element in the browser. On the server the registration is a no-op.

## openDeposit(options)

Mounts `<openramp-modal>`, starts a session and returns a handle. Browser only.

| Option | Type | Default | Description |
|---|---|---|---|
| `baseUrl` | `string` | required | Base URL of your OpenRampKit server |
| `clientSecret` | `string \| () => Promise<string>` | required | A client secret, or a function that fetches one |
| `wallet` | `WalletAdapter` | none | Enables "Pay with wallet" |
| `theme` | `Theme` | light | See [Theming](../guide/theming.md) |
| `appearance` | `Appearance` | none | See [Theming](../guide/theming.md#appearance) |
| `locale` | `string` | session locale, then browser, then `en` | BCP 47 tag. Built-in catalogs: `en`, `vi`, `id`, `th`, `ms`, `fil`. |
| `messages` | `Partial<Messages>` | none | Overrides the locale catalog key by key |
| `container` | `HTMLElement` | `document.body` | Where to mount the element |
| `embedded` | `boolean` | `false` | Render inline, without the overlay |
| `onEvent` | `(e: OrkEvent) => void` | none | [Browser events](../concepts/events.md#browser-events) |
| `onClose` | `(session?: PublicSession) => void` | none | Called once when the modal closes, with the last session |
| `fetch` | `typeof fetch` | global | Custom fetch, for tests and demos |

Returns a `DepositHandle`:

```ts
type DepositHandle = {
  element: OpenRampModal
  ready: Promise<DepositController>              // once the client secret is known
  readonly controller: DepositController | undefined
  done: Promise<PublicSession>                   // resolves on COMPLETED; rejects with an OrkError when closed first
  close(): void
}
```

When the modal closes before completion, `done` rejects with the step's error if there is one, else the controller's error, else an `OrkError` with code `CLOSED` (`CLOSED_CODE`). If the client secret function throws, the modal shows the error screen.

## openWithdraw(options)

Mounts `<openramp-modal>` for a withdraw session and returns a handle. Browser only. Create the session on your server with `direction: 'withdraw'` and a `source` (see [Withdrawals](../guide/withdraw.md)).

```ts
const handle = openWithdraw({ baseUrl: '/api/openramp', clientSecret: getClientSecret, wallet })
handle.done.then((session) => refreshBalance(), (error) => console.log(error.code))
```

The options are the same as `openDeposit` (`OpenWithdrawOptions`), and it returns a `WithdrawHandle` (the same shape as `DepositHandle`). `done` resolves when the withdrawal completes and rejects when the modal closes first. The modal refuses a deposit session: it shows "This is not a withdraw session.".

`wallet` is required when the source custody is `'user_wallet'`: the user signs the withdrawal with it. It also prefills the address and shows the source token balance.

## createDepositController(options)

Builds a `DepositController` for one session, with `surfaces` defaulting to `SUPPORTED_SURFACES`. Call `start()` on it.

| Option | Type | Description |
|---|---|---|
| `baseUrl` | `string` | Server base URL |
| `clientSecret` | `string` | The client secret (already resolved) |
| `wallet` | `WalletAdapter` | Optional |
| `onEvent` | `(e) => void` | Optional |
| `fetch` | `typeof fetch` | Optional |
| `surfaces` | `string[]` | Default `SUPPORTED_SURFACES` |
| `expect` | `'deposit' \| 'withdraw'` | Refuse a session of the other direction. Default: follow the session. |

`createWithdrawController(options)` is the same with `expect: 'withdraw'`.

`resolveClientSecret(src)` resolves a string or a function to a string.

## The element: `<openramp-modal>`

The element renders a controller snapshot and calls its actions. It never talks to the server itself. For a withdraw session it shows the "Withdraw" title, the "To wallet" and "To cash" tabs, and the target form.

### Properties and attributes

| Name | Kind | Type | Description |
|---|---|---|---|
| `controller` | property | `DepositController` | The controller to render |
| `theme` | property | `Theme` | Theme |
| `appearance` | property | `Appearance` | Appearance |
| `messages` | property | `Partial<Messages>` | Message overrides |
| `locale` | property and attribute | `string` | BCP 47 locale |
| `error` | property | `OrkError` | Error shown when there is no controller (for example the secret failed to load) |
| `open` | property and boolean attribute (reflected) | `boolean` | Show the modal (not embedded) |
| `embedded` | property and boolean attribute (reflected) | `boolean` | Inline mode: no overlay, no close button, Escape does not close |

### Methods

| Method | Description |
|---|---|
| `close()` | Closes: tells the controller (`controller.close()`), sets `open = false`, fires `openramp-close`, and returns focus to the element that had it |

### Events

| Event | Detail | Description |
|---|---|---|
| `openramp-close` | `{ session?: PublicSession }` | The user closed the modal (close button, Escape, overlay click, Done). Bubbles and is composed. |

The overlay click does not close the modal while a payment step is on screen.

### Parts and styles

Parts: `overlay`, `card`, `header`, `body`, `footer`. The element sets `--ork-*` CSS variables inline and `data-mode="light"` or `"dark"` on itself. See [Theming](../guide/theming.md#css-variables).

### Accessibility

The modal is a `dialog` with `aria-modal` (a `region` when embedded). It traps focus with Tab, closes on Escape, moves focus to each new screen's title, and announces loading, errors and step progress in a polite live region.

### Provider iframe messages

For an `IFRAME` surface, the element listens for `message` events. It accepts a message only when `event.origin` equals the surface's allowed origin and `event.source` is its own iframe. It then calls `controller.notifySurface()`. Helpers: `classifyIframeMessage(data, cfg)`, `iframeOrigin(surface)`, `EMBED_SOURCE` (`'openramp-embed'`). See [Surfaces](../concepts/surfaces.md#iframe).

## Themes

| Export | Description |
|---|---|
| `lightTheme(opts?)`, `darkTheme(opts?)`, `autoTheme(opts?)` | Build a `Theme`. `opts`: `accent`, `accentText`, `radius`, `fontFamily`, `colors`. |
| `themeVariables(theme, appearance, mode)` | The `--ork-*` variables for one mode |
| `lightColors`, `darkColors` | Default `ThemeColors` |
| `RADII` | Radius scales |
| `DEFAULT_FONT`, `DEFAULT_MONO` | Default font stacks |

Types: `Theme`, `ThemeOptions`, `ThemeColors`, `ThemeMode`, `RadiusScale`, `Appearance`.

## Messages

| Export | Description |
|---|---|
| `defaultMessages` | The English catalog |
| `catalogs` | `{ en, vi, id, th, ms, fil }` |
| `catalogFor(tag)` | The built-in catalog id for a BCP 47 tag, or `undefined` |
| `resolveLocale({ locale?, sessionLocale?, navigatorLanguage? })` | `{ catalog, tag }`: explicit, then session, then browser, then `en` |
| `resolveMessages({ ...sources, messages? })` | The messages to render |
| `mergeMessages(overrides?)` | Shallow merge over English |

Types: `Messages`, `CatalogLocale`, `LocaleSources`.

## Constants and other exports

| Export | Description |
|---|---|
| `SUPPORTED_SURFACES` | `REDIRECT`, `IFRAME`, `QR`, `DEEPLINK`, `BANK_FIELDS`, `DEPOSIT_ADDRESS`, `WALLET_TX`, `OTP`, `FORM` |
| `CLOSED_CODE` | `'CLOSED'` |
| `TAG_NAME` | `'openramp-modal'` |
| `OpenRampModal` | The element class |
| `defineOpenRampModal()` | Registers the element if it is not registered |
| `DepositController`, `WithdrawController`, `RampController` | Re-exported from `@openrampkit/client` (one class) |

Re-exported types: `Snapshot`, `ScreenName`, `SurfaceSignal`, `Tab`, `TargetDraft`, `IframeMessages`, `IframeSignal`, `MethodOption`, `PlanResult`, `PublicSession`, `Quote`, `Step`, `Surface`, `OrkError`, `OrkEvent`, `WalletAdapter`, `OpenDepositOptions`, `OpenWithdrawOptions`, `DepositHandle`, `WithdrawHandle`, `CreateControllerOptions`, `ClientSecretSource`.
