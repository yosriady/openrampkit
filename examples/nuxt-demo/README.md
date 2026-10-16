# Nuxt demo

A minimal Nuxt 4 app with OpenRampKit and `@openrampkit/vue`. It uses mock providers only, so it works offline and no real money moves.

## Run

Run these commands from the root of a clone of the repository:

```bash
pnpm install
pnpm build                                   # the example imports the built packages (dist)
cp examples/nuxt-demo/.env.example examples/nuxt-demo/.env
pnpm --filter nuxt-demo dev                  # http://localhost:3000
```

Open the page and click **Add funds**. The mock wallet pays, and the mock provider settles after 4 seconds.

To build and start the production server:

```bash
pnpm --filter nuxt-demo build
pnpm --filter nuxt-demo start                # http://localhost:3000
```

Try the session route with curl:

```bash
curl -X POST http://localhost:3000/api/deposit-session
```

## Environment

| Variable | Default | Description |
|---|---|---|
| `OPENRAMP_SECRET` | a dev value | 32+ characters |
| `PUBLIC_URL` | `http://localhost:3000` | The public origin of the app. The `baseUrl` is `PUBLIC_URL` + `/api/openramp`. |

## Files

| File | Shows |
|---|---|
| `server/utils/openramp.ts` | `createOpenRamp` with the mock adapter |
| `server/api/openramp/[...path].ts` | Mounting the handler: `openramp.handle(toWebRequest(event))` |
| `server/api/deposit-session.post.ts` | Creating a session in your backend |
| `app/app.vue` | `OpenRampProvider` and `DepositButton` from `@openrampkit/vue`, with `createMockWallet` |

The Vue components are safe for server rendering. The modal code loads only in the browser, when the user clicks the button. See [@openrampkit/vue](../../docs/api/vue.md).
