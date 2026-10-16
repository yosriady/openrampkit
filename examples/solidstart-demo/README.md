# SolidStart demo

A minimal SolidStart 2 app with OpenRampKit and `@openrampkit/solid`. It uses mock providers only, so it works offline and no real money moves.

SolidStart 2 needs Node.js 24 or later.

## Run

Run these commands from the root of a clone of the repository:

```bash
pnpm install
pnpm build                                        # the example imports the built packages (dist)
pnpm --filter solidstart-demo dev                 # http://localhost:3000
```

Open the page and click **Add funds**. The mock wallet pays, and the mock provider settles after 4 seconds.

To build and start the production server:

```bash
pnpm --filter solidstart-demo build
pnpm --filter solidstart-demo start               # http://localhost:3000
```

Try the session route with curl:

```bash
curl -X POST http://localhost:3000/api/deposit-session
```

## Environment

The server reads `process.env`. The defaults work for local development. To change them, set the variables in the shell. `.env.example` lists them.

| Variable | Default | Description |
|---|---|---|
| `OPENRAMP_SECRET` | a dev value | 32+ characters |
| `PUBLIC_URL` | `http://localhost:3000` | The public origin of the app. The `baseUrl` is `PUBLIC_URL` + `/api/openramp`. |

## Files

| File | Shows |
|---|---|
| `src/lib/openramp.server.ts` | `createOpenRamp` with the mock adapter |
| `src/routes/api/openramp/[...path].ts` | Mounting the handler: `openramp.handle(event.request)` for `GET`, `POST` and `OPTIONS` |
| `src/routes/api/deposit-session.ts` | Creating a session in your backend |
| `src/routes/index.tsx` | `OpenRampProvider` and `DepositButton` from `@openrampkit/solid`, with `createMockWallet` |

The Solid components are safe for server rendering. The modal code loads only in the browser, when the user clicks the button. See [@openrampkit/solid](../../docs/api/solid.md).
