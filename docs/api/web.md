# @openrampkit/web

The `<openramp-modal>` web component (Lit, Shadow DOM), `openDeposit()`, `openWithdraw()`, themes and message catalogs.

```ts
import { openDeposit, openWithdraw, createDepositController, lightTheme, darkTheme, autoTheme, defaultMessages } from '@openrampkit/web'
```

In code that runs on the server, import themes from `@openrampkit/web/theme`. It has the theme functions only, with no Lit:

```ts
import { lightTheme, darkTheme, autoTheme } from '@openrampkit/web/theme'
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
| `locale` | `string` | session locale, then `en` | BCP 47 tag. Built-in catalogs: `en`, `vi`, `id`, `th`, `ms`, `fil`. The browser language is not used. |
| `messages` | `Partial<Messages>` | none | Overrides the locale catalog key by key |
| `container` | `HTMLElement` | `document.body` | Where to mount the element |
| `embedded` | `boolean` | `false` | Render inline, without the overlay |
| `flow` | `FlowOptions` | none | How the flow opens: first tab, a method to open at once, amount, presets, default tokens, a withdraw balance. See [Flow options](#flow-options). |
| `autoClose` | `boolean` | `false` | Close as soon as the payment completes, with no success screen. `done` and `onClose` still get the session. |
| `onEvent` | `(e: ClientEvent) => void` | none | [Browser events](../concepts/events.md#browser-events) |
| `onClose` | `(session?: PublicSession) => void` | none | Called once when the modal closes, with the last session |
| `fetch` | `typeof fetch` | global | Custom fetch, for tests and demos |
| `providerRenderers` | `Record<string, ProviderRenderer>` | none | Renderers for `PROVIDER_SDK` surfaces, keyed by the surface `provider`. When set, `PROVIDER_SDK` is added to the surfaces the client can draw. See [PROVIDER_SDK](../concepts/surfaces.md#provider-sdk). |

Returns a `DepositHandle`:

```ts
type DepositHandle = {
  element: OpenRampModal
  ready: Promise<DepositController>              // once the client secret is known
  readonly controller: DepositController | undefined
  done: Promise<PublicSession>                   // resolves on COMPLETED; rejects with an OpenRampError when closed first
  close(): void
}
```

When the modal closes before completion, `done` rejects with the step's error if there is one, else the controller's error, else an `OpenRampError` with code `CLOSED` (`CLOSED_CODE`). If the client secret function throws, the modal shows the error screen.

## Flow options

`flow` (`FlowOptions` from `@openrampkit/client`) sets how one session opens. Every option is optional. An option that does not fit the session is ignored: a method the plan does not have, a tab with no methods, or a chain the withdrawal does not allow.

| Option | Type | Description |
|---|---|---|
| `initialTab` | `'crypto' \| 'cash'` | The tab to show first. Deposit: `crypto` (wallet, transfer, exchanges) or `cash`. Withdraw: `crypto` (To wallet) or `cash` (To cash). |
| `initialMethod` | `string` | Deposit: open this method at once, for example `qris`, `transfer`, or `exchanges` (the exchange picker) |
| `lockMethod` | `boolean` | With `initialMethod`: hide the way back to the method list |
| `amount` | `string` | Amount to fill in, for example `'50'` |
| `presets` | `Record<string, string[]>` | Amount chips per currency code: a fiat code, or a token symbol for a wallet deposit. At most 4 show, with no repeats, and only values inside the bounds of the same currency. Without presets for the currency, the built-in chips show. |
| `defaultSource` | `{ chain, token? }` | Deposit: the token the user pays with first, for wallet and transfer. Without `token`: USDC on the chain, else the native token. |
| `defaultTarget` | `{ chain, token? }` | Withdraw: the chain and token to receive first on the "To wallet" tab |
| `balance` | `string` | Withdraw: the amount the user can withdraw, in the source token, when no wallet reports it (for example `custody: 'app'`). It turns on the MAX chip and the check against the balance. |

```ts
openDeposit({
  baseUrl: '/api/openramp',
  clientSecret,
  flow: { initialTab: 'cash', initialMethod: 'qris', amount: '100000', presets: { IDR: ['50000', '100000', '250000'] } },
  autoClose: true,
})
```

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
| `flow` | `FlowOptions` | Optional. See [Flow options](#flow-options). |

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
| `providerRenderers` | property | `Record<string, ProviderRenderer>` | Renderers for `PROVIDER_SDK` surfaces. Without one, the modal links to `params.redirectUrl` when it can. |
| `error` | property | `OpenRampError` | Error shown when there is no controller (for example the secret failed to load) |
| `open` | property and boolean attribute (reflected) | `boolean` | Show the modal (not embedded) |
| `embedded` | property and boolean attribute (reflected) | `boolean` | Inline mode: no overlay, no close button, Escape does not close |
| `autoClose` | property, boolean attribute `auto-close` | `boolean` | Close as soon as the payment completes, with no success screen |

### Methods

| Method | Description |
|---|---|
| `close()` | Closes: tells the controller (`controller.close()`), sets `open = false`, fires `openramp-close`, and returns focus to the element that had it |

### Events

| Event | Detail | Description |
|---|---|---|
| `openramp-close` | `{ session?: PublicSession }` | The user closed the modal (close button, Escape, overlay click, Done). Bubbles and is composed. |

The overlay click does not close the modal while a payment step is on screen.

### History

With the server option `history`, the methods screen (and the withdraw "To wallet" form) shows a History link. It opens a list of the user's past sessions: the kind, the amount, the asset that arrives, a relative date ("5 minutes ago"), a status badge and a "View transaction" link to the block explorer when the server knows the transaction. Back returns to the screen before. The link shows only when `GET /sessions/:id/history` answers with at least one item: with the option off, the server answers `404` and the link stays hidden. A new user has no item, so the link shows after the user's first payment (the widget loads the history again when a payment reaches a final status). See [History](../guide/history.md).

### Parts and styles

Parts: `overlay`, `card`, `header`, `body`, `footer`. The element sets `--ork-*` CSS variables inline and `data-mode="light"` or `"dark"` on itself. See [Theming](../guide/theming.md#css-variables).

### Accessibility

The modal is a `dialog` with `aria-modal` (a `region` when embedded). It traps focus with Tab, closes on Escape, moves focus to each new screen's title, and announces loading, errors and step progress in a polite live region.

### Provider iframe messages

For an `IFRAME` surface, the element listens for `message` events. It accepts a message only when `event.origin` equals the surface's allowed origin and `event.source` is its own iframe. It then calls `controller.notifySurface()`. Helpers: `classifyIframeMessage(data, cfg)`, `iframeOrigin(surface)`, `EMBED_SOURCE` (`'openramp-embed'`). See [Surfaces](../concepts/surfaces.md#iframe) and the [iframe message protocol](../concepts/flows.md#iframe-message-protocol).

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
| `resolveLocale({ locale?, sessionLocale? })` | `{ catalog, tag }`: explicit, then session, then `en`. The browser language is not used. Aliases: `tl` is `fil`, `in` is `id`, `zsm` is `ms`. |
| `resolveMessages({ ...sources, messages? })` | The messages to render |
| `mergeMessages(overrides?)` | Shallow merge over English |

Types: `Messages`, `CatalogLocale`, `LocaleSources`.

`messages.stepDetail` has one label for each value of `Step.detail.code` (`STEP_DETAIL_CODES` in `@openrampkit/core`), in every catalog. The processing screen shows it. Without a known code, the screen shows the state title (`messages.stepTitle`). It never shows a raw provider status. To change a label, override the whole `stepDetail` object.

The quote row never says "No fees" when a fee has no stated amount (`amount: null`). It shows `messages.feesInRate` ("Fees included in the rate"), or the known fees followed by `messages.feeInRate` ("+ a fee in the rate"). The step screen shows the legs of `session.payment` with the main transaction of each leg (the delivery, else the `source`).

## Provider renderers

| Export | Description |
|---|---|
| `stripeOnrampRenderer({ load? })` | A renderer for the Stripe onramp element (`@openrampkit/adapter-stripe` with the default `PROVIDER_SDK` surface) |
| `loadScript(src)` | Loads a script once per page, in the document head |
| `STRIPE_SCRIPTS` | The Stripe script URLs that `stripeOnrampRenderer` loads |

Types: `ProviderRenderer`, `ProviderRendererContext`, `ProviderSdkSurface`.

## Constants and other exports

| Export | Description |
|---|---|
| `SUPPORTED_SURFACES` | `REDIRECT`, `IFRAME`, `QR`, `DEEPLINK`, `BANK_FIELDS`, `DEPOSIT_ADDRESS`, `WALLET_TX`, `OTP`, `FORM` |
| `CLOSED_CODE` | `'CLOSED'` |
| `TAG_NAME` | `'openramp-modal'` |
| `OpenRampModal` | The element class |
| `defineOpenRampModal()` | Registers the element if it is not registered |
| `DepositController`, `WithdrawController`, `RampController` | Re-exported from `@openrampkit/client` (one class) |

Re-exported types: `Snapshot`, `ScreenName`, `SurfaceSignal`, `Tab`, `TargetDraft`, `IframeMessages`, `IframeSignal`, `MethodOption`, `PlanResult`, `PublicLegQuote`, `PublicQuote`, `PublicSession`, `Step`, `Surface`, `OpenRampError`, `ClientEvent`, `WalletAdapter`, `OpenDepositOptions`, `OpenWithdrawOptions`, `DepositHandle`, `WithdrawHandle`, `CreateControllerOptions`, `ClientSecretSource`.
