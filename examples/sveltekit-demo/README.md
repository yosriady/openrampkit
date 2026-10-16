# SvelteKit demo

A minimal SvelteKit 3 app (Svelte 5) with OpenRampKit and `@openrampkit/svelte`. It uses mock providers only, so it works offline and no real money moves.

## Run

Run these commands from the root of a clone of the repository:

```bash
pnpm install
pnpm build                                        # the example imports the built packages (dist)
cp examples/sveltekit-demo/.env.example examples/sveltekit-demo/.env
pnpm --filter sveltekit-demo dev                  # http://localhost:3000
```

Open the page and click **Add funds**. The mock wallet pays, and the mock provider settles after 4 seconds.

To build and start the production server (`@sveltejs/adapter-node`):

```bash
pnpm --filter sveltekit-demo build
pnpm --filter sveltekit-demo start                # http://localhost:3000
```

The production server does not read `.env`. Set the variables in the shell.

Try the session route with curl:

```bash
curl -X POST -H 'content-type: application/json' -d '{}' http://localhost:3000/api/deposit-session
```

SvelteKit refuses cross-site POST requests with a form content type, so send JSON.

## Environment

| Variable | Default | Description |
|---|---|---|
| `OPENRAMP_SECRET` | a dev value | 32+ characters |
| `PUBLIC_URL` | `http://localhost:3000` | The public origin of the app. The `baseUrl` is `PUBLIC_URL` + `/api/openramp`. |

`src/env.ts` declares both variables. The server reads them from `$app/env/private`.

## Files

| File | Shows |
|---|---|
| `src/lib/server/openramp.ts` | `createOpenRamp` with the mock adapter |
| `src/routes/api/openramp/[...path]/+server.ts` | Mounting the handler: `openramp.handle(request)` for `GET`, `POST` and `OPTIONS` |
| `src/routes/api/deposit-session/+server.ts` | Creating a session in your backend |
| `src/routes/+page.svelte` | `setOpenRamp` and the `use:depositButton` action, with `createMockWallet` |

The Svelte helpers are safe for server rendering. The modal code loads only in the browser, when the user clicks the button. See [@openrampkit/svelte](../../docs/api/svelte.md).
