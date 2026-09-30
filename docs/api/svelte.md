# @openrampkit/svelte

A thin Svelte wrapper over `<openramp-modal>`. It works with Svelte 5 (runes) and Svelte 4. Peer dependency: `svelte ^4 || ^5`.

The package is plain TypeScript: stores, actions and context helpers. It has no `.svelte` files, so you do not need a special build step. It is safe for server rendering (SvelteKit). `@openrampkit/web` (and Lit) loads only in the browser, in actions and in click handlers.

```ts
import {
  createOpenRamp, setOpenRamp, getOpenRamp, depositButton, withdrawButton, openRampEmbedded, depositControllerStore,
  lightTheme, darkTheme, autoTheme,
} from '@openrampkit/svelte'
```

| React | Svelte |
|---|---|
| `OpenRampProvider` | `setOpenRamp(config)` in a parent component |
| `useOpenRamp()` | `getOpenRamp()`, or the value from `createOpenRamp()` |
| `DepositButton`, `WithdrawButton` | `use:depositButton`, `use:withdrawButton` on your own element |
| `DepositButton.Custom` | Your markup with `ramp.beginDeposit` and `$isOpen` |
| `OpenRampEmbedded` | `use:openRampEmbedded` |
| `useDepositController` | `depositControllerStore(controller)` |

## createOpenRamp(config)

Makes the modal state for your app. You can call it in a module or in a component. Nothing loads until you open the modal.

```ts
// lib/ramp.ts
import { createOpenRamp, lightTheme } from '@openrampkit/svelte'

export const ramp = createOpenRamp({ baseUrl: '/api/openramp', theme: lightTheme(), onEvent: track })
```

The config is the same as the `OpenRampProvider` props in React: `baseUrl` (required), `wallet`, `theme`, `appearance`, `messages`, `locale`, `providerRenderers` and `onEvent`.

It returns an `OpenRamp`:

| Member | Type | Description |
|---|---|---|
| `beginDeposit({ clientSecret, onEvent? })` | `Promise<PublicSession>` | Opens the modal. Resolves when the deposit completes. Rejects (with an `OrkError`) when the modal closes first. Rejects on the server. |
| `beginWithdraw({ clientSecret, onEvent? })` | `Promise<PublicSession>` | The same for a withdraw session (created with `direction: 'withdraw'`). |
| `close()` | `() => void` | Closes the modal |
| `isOpen` | `Readable<boolean>` | A store. Use `$isOpen` in a component. |
| `config` | `Readable<OpenRampConfig>` | A store with the current config |
| `update(config)` | `(partial) => void` | Merges new config values. Theme, appearance and locale changes go to an open modal. |

Only one modal is open at a time. When you open a new modal, the previous modal closes.

You can make an `OpenRamp` in a shared module, also on a SvelteKit server. On the server, `isOpen` stays `false` and `beginDeposit` rejects, so no state goes from one user to another.

## setOpenRamp(config) and getOpenRamp()

Share one `OpenRamp` with child components through the Svelte context. Call both functions during component initialization.

```svelte
<!-- +layout.svelte -->
<script>
  import { setOpenRamp, lightTheme } from '@openrampkit/svelte'
  let { children } = $props()
  setOpenRamp({ baseUrl: '/api/openramp', theme: lightTheme() })
</script>

{@render children()}
```

`setOpenRamp` accepts a config or an existing `OpenRamp`. When it makes the `OpenRamp`, the modal closes when the component is destroyed. `getOpenRamp()` throws when no parent called `setOpenRamp()`.

To keep the theme live with runes, call `update` in an effect:

```svelte
<script>
  const ramp = setOpenRamp({ baseUrl: '/api/openramp' })
  let dark = $state(false)
  $effect(() => ramp.update({ theme: dark ? darkTheme() : lightTheme() }))
</script>
```

## use:depositButton and use:withdrawButton

Actions for your own button. On click, the action opens the modal. The action disables the element while the modal is open (only for elements with a `disabled` property, such as `<button>`).

```svelte
<script>
  import { getOpenRamp, depositButton, withdrawButton } from '@openrampkit/svelte'
  const ramp = getOpenRamp()
  const isOpen = ramp.isOpen
</script>

<button use:depositButton={{ ramp, getClientSecret, onComplete: refreshBalance, onError: showError }}>
  {$isOpen ? 'Opening' : 'Deposit'}
</button>

<button use:withdrawButton={{ ramp, getClientSecret: getWithdrawSecret }}>Withdraw</button>
```

| Parameter | Type | Description |
|---|---|---|
| `ramp` | `OpenRamp` | Required. From `createOpenRamp()`, `setOpenRamp()` or `getOpenRamp()`. |
| `getClientSecret` | `string \| () => Promise<string>` | Required. A secret, or a function that fetches one on click. |
| `onComplete` | `(session: PublicSession) => void` | The deposit or withdrawal completed |
| `onError` | `(error: OrkError) => void` | The modal closed before completion (code `CLOSED`, or the step's error) |
| `onEvent` | `(e: OrkEvent) => void` | Browser events for this session (in addition to the ramp's) |
| `disabled` | `boolean` | Keep the element disabled |

For fully custom markup, call the ramp yourself:

```svelte
<a href="#top-up" onclick={() => ramp.beginDeposit({ clientSecret: getClientSecret }).then(refreshBalance, () => {})}>
  {$isOpen ? 'Opened' : 'Add funds'}
</a>
```

## use:openRampEmbedded

Renders the modal inline, without an overlay. It follows the direction of the session, so it works for deposit and withdraw sessions.

Put the action on `<openramp-modal>`. Then the server also renders the element. You can also put it on any container. Then the action adds an `<openramp-modal>` inside the container.

```svelte
<openramp-modal
  style="max-width: 420px"
  use:openRampEmbedded={{ ramp, clientSecret, onComplete: () => goto('/done') }}
></openramp-modal>
```

| Parameter | Type | Description |
|---|---|---|
| `clientSecret` | `string \| () => Promise<string>` | Required |
| `ramp` | `OpenRamp` | Default values for `baseUrl`, `wallet`, `theme`, `appearance`, `messages`, `locale` and `onEvent`. The action follows `ramp.update()`. |
| `baseUrl` | `string` | Required when there is no `ramp` |
| `wallet`, `theme`, `appearance`, `messages`, `locale` | | Default: the ramp's values |
| `onEvent` | `(e) => void` | Called after the ramp's `onEvent` |
| `onComplete` | `(session) => void` | The deposit or withdrawal completed |
| `onClose` | `(session?) => void` | The user pressed Close or Done on a result or error screen |
| `onController` | `(controller) => void` | Receives the controller when it exists |

It makes one controller for each client secret. A new string secret, `baseUrl` or `wallet` starts a new session. A new function does not. To start again with a function, wrap the element in `{#key}`.

## depositControllerStore(controller)

A store with the `Snapshot` of a `DepositController`. Use it for a fully custom UI, or next to `use:openRampEmbedded` with `onController`.

```svelte
<script>
  import { depositControllerStore } from '@openrampkit/svelte'
  let { controller } = $props()
  const snap = $derived(depositControllerStore(controller))
</script>

<p>{$snap?.screen}</p>
```

The value is `undefined` when `controller` is `undefined` or `null`.

## Re-exports

Themes: `lightTheme`, `darkTheme`, `autoTheme` (from `@openrampkit/web/theme`, no Lit). Types: `Theme`, `ThemeOptions`, `ThemeColors`, `Appearance`, `RadiusScale`, `DepositController`, `WithdrawController`, `RampController`, `Snapshot`, `PublicSession`, `OrkError`, `OrkEvent`, `WalletAdapter`, `OpenRamp`, `OpenRampConfig`, `BeginDepositOptions`, `BeginWithdrawOptions`, `ButtonActionParams`, `EmbeddedActionParams`, `ActionReturn`, `Readable`.
