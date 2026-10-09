# Without React (web component)

`@openrampkit/web` works in any framework, or with no framework. It has two entry points:

- `openDeposit(options)`: mounts `<openramp-modal>`, starts the session, and returns a handle. This is the easy path.
- `<openramp-modal>` plus `createDepositController()`: you place the element and connect a controller yourself.

Both need a server (see [Quick start](./quick-start-nextjs.md) steps 3 to 5, or [Deploy](../deploy/cloudflare-workers.md)) and a client secret from your backend.

## openDeposit()

```ts
import { openDeposit, lightTheme, type OpenRampError } from '@openrampkit/web'

const handle = openDeposit({
  baseUrl: '/api/openramp',
  // a string, or a function that fetches one from your backend
  clientSecret: async () => {
    const r = await fetch('/api/deposit-session', { method: 'POST' })
    return (await r.json()).clientSecret
  },
  theme: lightTheme({ accent: '#2744C4' }),
  onEvent: (e) => console.log(e.type),
  onClose: (session) => console.log('closed', session?.status),
})

try {
  const session = await handle.done
  console.log('deposit complete', session.id)
} catch (err) {
  // An OpenRampError. `code` is 'CLOSED' when the user closed the modal before completion,
  // or the step's error code when the payment failed.
  const error = err as OpenRampError
  console.log(error.code, error.message)
}
```

The modal opens at once. It shows a loading state while `clientSecret` resolves.

`handle` has these members:

| Member | Type | Description |
|---|---|---|
| `element` | `OpenRampModal` | The mounted element |
| `ready` | `Promise<DepositController>` | Resolves once the client secret is known |
| `controller` | `DepositController \| undefined` | The controller, or `undefined` while the secret loads |
| `done` | `Promise<PublicSession>` | Resolves when the step reaches `COMPLETED`. Rejects with an `OpenRampError` when the modal closes first. |
| `close()` | `() => void` | Closes and removes the element |

`done` resolves when the deposit completes, even if the success screen is still open. The element is removed when the user presses **Done** or **Close**, or when you call `close()`.

See [API: @openrampkit/web](../api/web.md) for every option.

## Embedded mode

Pass `embedded: true` and a `container` to render the widget inline, without the overlay:

```ts
openDeposit({
  baseUrl: '/api/openramp',
  clientSecret,
  embedded: true,
  container: document.getElementById('deposit')!,
})
```

In embedded mode:

- There is no overlay and no close button in the header. Escape does not close it.
- The element does not take focus from your page until the user works inside it.
- The **Done** and **Close** buttons on the result and error screens still close it. With `openDeposit`, closing removes the element from `container`.

## The element directly

Use the element when you want to control its place in the DOM or reuse one element for many sessions. The element never talks to the server itself: it renders a `DepositController` snapshot and calls its actions.

```html
<openramp-modal id="deposit" embedded></openramp-modal>

<script type="module">
  import { createDepositController, darkTheme } from '@openrampkit/web'

  const el = document.getElementById('deposit')
  const { clientSecret } = await fetch('/api/deposit-session', { method: 'POST' }).then((r) => r.json())

  const controller = createDepositController({ baseUrl: '/api/openramp', clientSecret })
  el.theme = darkTheme()
  el.controller = controller
  controller.start()

  controller.done.then((session) => console.log('complete', session.id))
  el.addEventListener('openramp-close', (e) => console.log('closed', e.detail.session))
</script>
```

Importing `@openrampkit/web` registers the element (`customElements.define('openramp-modal', ...)`). The call is safe on the server: it does nothing when `customElements` does not exist. You can also call `defineOpenRampModal()` yourself.

`controller`, `theme`, `appearance`, `messages` and `error` are JavaScript properties, not attributes. `open` and `embedded` are boolean attributes and properties. `locale` is a string attribute and property (for example `<openramp-modal locale="vi">`). For a modal (not embedded), set `el.open = true` to show it.

## Bundlers and script tags

`@openrampkit/web` is an ES module package with `lit` and `qrcode-generator` as dependencies. There is no UMD or IIFE build.

::: code-group

```ts [Vite]
// main.ts (any Vite app: vanilla, Vue, Svelte, Solid)
import { openDeposit } from '@openrampkit/web'

document.querySelector('#deposit-button')!.addEventListener('click', () => {
  openDeposit({ baseUrl: 'https://ramp.example.workers.dev', clientSecret: getClientSecret })
})
```

```html [Script tag (ESM CDN)]
<!-- An ESM CDN resolves the bare imports (lit and friends) for you.
     This works once the package is published to npm. -->
<button id="deposit-button">Deposit</button>
<script type="module">
  import { openDeposit } from 'https://esm.sh/@openrampkit/web'

  document.getElementById('deposit-button').addEventListener('click', () => {
    openDeposit({ baseUrl: '/api/openramp', clientSecret: getClientSecret })
  })
</script>
```

:::

::: tip Popups
Call `openDeposit()` inside a click handler. Hosted checkouts open in a new tab from a later click (the "Continue to ..." button), so popup blockers allow them. See [Surfaces](../concepts/surfaces.md#redirect).
:::

## Cross-origin servers

If the server runs on another origin (for example a Cloudflare Worker), set `baseUrl` to its full URL and allow your app's origin with the server's `cors` option:

```ts
createOpenRamp({ /* ... */ cors: { origins: ['https://app.example.com'] } })
```

## Wallets

Pass a `WalletAdapter` as `wallet` to enable "Pay with wallet":

```ts
import { wagmiWallet } from '@openrampkit/wagmi'
openDeposit({ baseUrl, clientSecret, wallet: wagmiWallet(wagmiConfig) })
```

The controller reads the wallet's accounts once, when it starts. Connect the wallet before you open the modal. See [Wallets (wagmi)](../adapters/wagmi.md).

## Framework notes

- **Vue**: tell the compiler that `openramp-modal` is a custom element (`compilerOptions.isCustomElement = (tag) => tag === 'openramp-modal'`), then set properties with `:controller.prop="controller"`.
- **Svelte**: `<openramp-modal embedded bind:this={el} />`, then set `el.controller` in `onMount`.
- **Angular**: add `CUSTOM_ELEMENTS_SCHEMA` to the component, and set properties through a `ViewChild` reference.
