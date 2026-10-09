# @openrampkit/vue

A thin Vue 3 wrapper over `<openramp-modal>`. It has the same API shape as [`@openrampkit/react`](./react.md). Peer dependency: `vue >= 3.3`.

It is safe for server rendering (Nuxt). `@openrampkit/web` (and Lit) loads only in the browser, in `onMounted` and in click handlers. The package has no `.vue` files, so you do not need a special build step.

```ts
import {
  OpenRampProvider, provideOpenRamp, useOpenRamp, DepositButton, WithdrawButton, OpenRampEmbedded, useDepositController,
  lightTheme, darkTheme, autoTheme,
} from '@openrampkit/vue'
```

Callback props use the `on` prefix, so you can also write them as Vue listeners: `:on-complete="fn"` and `@complete="fn"` are the same.

## OpenRampProvider

Holds the shared config and opens the modal.

```vue
<script setup lang="ts">
import { OpenRampProvider, lightTheme } from '@openrampkit/vue'
</script>

<template>
  <OpenRampProvider base-url="/api/openramp" :theme="lightTheme()" :wallet="wallet" @event="track">
    <App />
  </OpenRampProvider>
</template>
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
| `onEvent` (`@event`) | `(e: OpenRampEvent) => void` | Every browser event |

Only one modal is open at a time. When you open a new modal, the previous modal closes. When the provider unmounts, the modal closes.

## provideOpenRamp(config)

Does the same as `OpenRampProvider`, without a wrapper component. Call it in `setup()`, for example in `App.vue` or in a Nuxt layout. `config` can be an object, a ref or a getter. The function returns the same API as `useOpenRamp()`.

```ts
import { ref } from 'vue'
import { provideOpenRamp, lightTheme } from '@openrampkit/vue'

const theme = ref(lightTheme())
const ramp = provideOpenRamp(() => ({ baseUrl: '/api/openramp', theme: theme.value }))
```

When the scope of the caller stops, the modal closes.

## useOpenRamp()

```ts
const { beginDeposit, beginWithdraw, close, isOpen } = useOpenRamp()

const session = await beginDeposit({
  clientSecret: () => fetch('/api/deposit-session', { method: 'POST' }).then((r) => r.json()).then((j) => j.clientSecret),
  onEvent: (e) => {},
})
```

| Member | Type | Description |
|---|---|---|
| `beginDeposit({ clientSecret, onEvent? })` | `Promise<PublicSession>` | Opens the modal. Resolves when the deposit completes. Rejects (with an `OpenRampError`) when the modal closes first. Rejects on the server. |
| `beginWithdraw({ clientSecret, onEvent? })` | `Promise<PublicSession>` | The same for a withdraw session (created with `direction: 'withdraw'`). |
| `close()` | `() => void` | Closes the modal |
| `isOpen` | `Readonly<Ref<boolean>>` | Whether the modal is open |

It throws when there is no `OpenRampProvider` or `provideOpenRamp()` above it.

## DepositButton

A ready-made button that calls `beginDeposit`. It is disabled while the modal is open. The `class` attribute goes to the `<button>`.

```vue
<DepositButton :get-client-secret="getClientSecret" class="btn" @complete="refreshBalance" @error="showError">
  Add funds
</DepositButton>
```

| Prop | Type | Description |
|---|---|---|
| `getClientSecret` | `string \| () => Promise<string>` | Required. A secret, or a function that fetches one on click. |
| `label` | `string` | Default "Deposit". The default slot replaces it. |
| `disabled` | `boolean` | |
| `onComplete` (`@complete`) | `(session: PublicSession) => void` | The deposit completed |
| `onError` (`@error`) | `(error: OpenRampError) => void` | The modal closed before completion (code `CLOSED`, or the step's error) |
| `onEvent` (`@event`) | `(e: OpenRampEvent) => void` | Browser events for this deposit (in addition to the provider's) |

### DepositButton.Custom

Use your own markup. The default slot gets `{ open, isOpen }`. The component is also exported as `DepositButtonCustom`.

```vue
<DepositButton.Custom :get-client-secret="getClientSecret" @complete="refreshBalance">
  <template #default="{ open, isOpen }">
    <button class="my-button" :disabled="isOpen" @click="open">Top up</button>
  </template>
</DepositButton.Custom>
```

The props are the same as `DepositButton` without `label` and `disabled`.

## WithdrawButton

A ready-made "Withdraw" button that calls `beginWithdraw`. `getClientSecret` must return the secret of a withdraw session. See [Withdrawals](../guide/withdraw.md). The props are the same as `DepositButton`. The default label is "Withdraw". Use `WithdrawButton.Custom` (or `WithdrawButtonCustom`) for your own markup.

```vue
<WithdrawButton :get-client-secret="getWithdrawSecret" @complete="refreshBalance" />
```

## OpenRampEmbedded

Renders `<openramp-modal embedded>` inline, without an overlay. It follows the direction of the session, so it works for deposit and withdraw sessions. The `class` and `style` attributes go to the element.

```vue
<OpenRampEmbedded :client-secret="clientSecret" style="max-width: 420px" @complete="router.push('/done')" />
```

| Prop | Type | Description |
|---|---|---|
| `clientSecret` | `string \| () => Promise<string>` | Required |
| `baseUrl` | `string` | Default: the provider's `baseUrl`. Required when there is no provider. |
| `wallet`, `theme`, `appearance`, `messages`, `locale` | | Default: the provider's values |
| `onEvent` (`@event`) | `(e) => void` | Called after the provider's `onEvent` |
| `onComplete` (`@complete`) | `(session) => void` | The deposit or withdrawal completed |
| `onClose` (`@close`) | `(session?) => void` | The user pressed Close or Done on a result or error screen |
| `onController` (`@controller`) | `(controller) => void` | Receives the controller when it exists |

It makes one controller for each client secret. A new string secret starts a new session. A new function does not. To start again with a function, change the `key` of the component.

## useDepositController(controller)

Subscribes to a `DepositController` and returns its `Snapshot` as a shallow ref. Use it for a fully custom UI, or next to `OpenRampEmbedded` with `@controller`. `controller` can be a value, a ref or a getter.

```ts
import { shallowRef } from 'vue'
import { useDepositController, type DepositController } from '@openrampkit/vue'

const controller = shallowRef<DepositController>()
const snap = useDepositController(controller)
// snap.value?.screen
```

The value is `undefined` when `controller` is `undefined` or `null`. It does not subscribe during server rendering.

## Nuxt

Nothing more is necessary. The components render a plain `<button>` or `<openramp-modal>` on the server, and the modal code loads in the browser. To stop the Vue warning about an unknown element in your own templates, tell the compiler that `openramp-modal` is a custom element:

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  vue: { compilerOptions: { isCustomElement: (tag) => tag === 'openramp-modal' } },
})
```

You need this only when you write `<openramp-modal>` in a template yourself. `OpenRampEmbedded` does not need it.

## Re-exports

Themes: `lightTheme`, `darkTheme`, `autoTheme` (from `@openrampkit/web/theme`, no Lit). Types: `Theme`, `ThemeOptions`, `ThemeColors`, `Appearance`, `RadiusScale`, `DepositController`, `WithdrawController`, `RampController`, `Snapshot`, `PublicSession`, `OpenRampError`, `OpenRampEvent`, `WalletAdapter`, `OpenRampConfig`, `OpenRampApi`, `OpenRampProviderProps`, `BeginDepositOptions`, `BeginWithdrawOptions`, `DepositButtonProps`, `DepositButtonCustomProps`, `DepositButtonSlotProps`, `WithdrawButtonProps`, `WithdrawButtonCustomProps`, `WithdrawButtonSlotProps`, `OpenRampEmbeddedProps`.
