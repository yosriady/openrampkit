# Agents (MCP)

`@openrampkit/mcp` is a Model Context Protocol (MCP) server. With it, an AI agent can:

- **fund a wallet**: a person pays in with a local method (VietQR, QRIS, PromptPay, DuitNow, QR Ph, PayNow, card or crypto), and the funds go to a wallet that you allow.
- **pay out to a person**: your app sends funds, and the person picks how to receive them (for example a bank account or an e-wallet).

The agent does not move money itself. A person always does the payment step. The agent creates a session and gets a **pay link**. The person opens the pay link on a phone and pays. Then the agent waits for the result.

```
Agent ──MCP──> @openrampkit/mcp ──HTTP──> OpenRampKit server ──> providers
                                              │
Person <── pay link ── Agent                  └── GET /pay/:credential (the modal)
```

## Install

```bash
pnpm add @openrampkit/mcp
```

The package has a CLI (`openrampkit-mcp`) and a library.

::: tip Not on npm yet
`@openrampkit/mcp` is not published yet, so `npx -y @openrampkit/mcp` does not work today. Build the monorepo (`pnpm install && pnpm build`) and run the CLI with `node /absolute/path/to/openrampkit/packages/mcp/dist/cli.js` in place of `npx -y @openrampkit/mcp`. See [Try it before the npm release](./installation.md#try-it-before-the-npm-release).
:::

## Prepare the OpenRampKit server

The MCP server creates sessions with `POST {baseUrl}/sessions`. Your OpenRampKit server must have an `authorize` hook that checks an app key:

```ts
import { createOpenRamp, type CreateSessionInput } from '@openrampkit/server'

createOpenRamp({
  // ...
  authorize: async (req, body) => {
    if (req.headers.get('x-app-key') !== env.APP_API_KEY) return null
    return body as CreateSessionInput
  },
})
```

[`examples/cloudflare-worker`](https://github.com/yosriady/openrampkit/tree/main/examples/cloudflare-worker) uses this pattern.

::: warning Keep the app key secret
The app key lets a caller create sessions with any destination. Give it only to the MCP server. The MCP server applies the guardrails before it calls `POST /sessions`.
:::

## Configure the guardrails

Put the guardrails in a JSON file. Keep secrets (the URL and the app key) in environment variables.

```json
{
  "deposit": {
    "destinations": [
      {
        "name": "treasury",
        "description": "Agent wallet on Base",
        "chain": "eip155:8453",
        "token": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        "address": "0x000000000000000000000000000000000000beef",
        "symbol": "USDC",
        "decimals": 6
      }
    ]
  },
  "withdraw": {
    "source": { "chain": "eip155:8453", "token": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "symbol": "USDC", "decimals": 6, "custody": "app" }
  },
  "maxAmounts": { "VND": "2500000", "IDR": "1500000", "USDC": "100" }
}
```

| Field | Default | Description |
|---|---|---|
| `maxAmounts` | required | The largest amount per session, by currency code or token symbol. The agent can use only these currencies. |
| `deposit.destinations` | none | The only wallets that the agent can fund. The agent picks one by `name`. Without `deposit`, the deposit tool is off. |
| `deposit.allowCustomAddress` | off | `{ chains, tokens? }`: let the agent give its own address, on these chains and tokens only. |
| `withdraw.source` | none | The asset that leaves and who holds it. For agent payouts, use `custody: 'app'` and a server [`treasury`](./withdraw.md#custody-app). Without `withdraw`, the payout tool is off. |
| `withdraw.allowedTargets` | cash only | Where the person can receive the funds. See [Allowed targets](./withdraw.md#allowed-targets). |
| `allowedMethods` | all | Only these methods, for example `["vietqr", "qris"]` |
| `userId` | `agent` | The `userId` of each session |
| `sessionTtlMinutes` | `30` | The longest session life. The agent can ask for less. |
| `maxWaitSeconds` | `120` | The longest time of one `wait_for_completion` call (at most 600) |
| `pollIntervalMs` | `3000` | The poll interval of `wait_for_completion` |

The MCP server checks the config when it starts. It stops with an error when `maxAmounts` is empty, or when a destination address is not valid for its chain.

## Connect an agent

### Claude Desktop

Add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "openrampkit": {
      "command": "npx",
      "args": ["-y", "@openrampkit/mcp"],
      "env": {
        "OPENRAMP_URL": "https://ramp.example.workers.dev",
        "OPENRAMP_APP_KEY": "your-app-key",
        "OPENRAMP_MCP_CONFIG": "/absolute/path/to/mcp.config.json"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add openrampkit \
  -e OPENRAMP_URL=https://ramp.example.workers.dev \
  -e OPENRAMP_APP_KEY=your-app-key \
  -e OPENRAMP_MCP_CONFIG=/absolute/path/to/mcp.config.json \
  -- npx -y @openrampkit/mcp
```

### Streamable HTTP

```bash
MCP_HTTP_TOKEN=a-long-random-token npx @openrampkit/mcp --http --port 3333
```

Clients connect to `http://localhost:3333/mcp`. Each request must have `Authorization: Bearer <MCP_HTTP_TOKEN>`. The CLI does not start without the token. The token must have at least 16 characters. `--port` (or `PORT`) sets the port. The default is `3333`.

The CLI reads these environment variables:

| Variable | Description |
|---|---|
| `OPENRAMP_URL` | The `baseUrl` of your OpenRampKit server. It can also be `baseUrl` in the config file. |
| `OPENRAMP_APP_KEY` | The key that your `authorize` hook checks (header `x-app-key`). |
| `OPENRAMP_MCP_CONFIG` | The path to the JSON file with the guardrails. `--config <path>` also works. |
| `MCP_HTTP_TOKEN` | With `--http` only: the bearer token that clients send. |

On Cloudflare Workers, Deno or Bun, use the web-standard handler:

```ts
import { createMcpHttpHandler } from '@openrampkit/mcp'

const handler = createMcpHttpHandler(config, { bearerToken: env.MCP_HTTP_TOKEN })
export default { fetch: (req: Request) => handler(req) }
```

The handler is stateless. It keeps the session registry in memory for the life of the process. For many instances, give a shared `registry` (see [Library](#library)).

## Tools

All results are compact JSON. An error result has `isError: true` and `{ "error": { "code", "message" } }`.

| Tool | Input | Result |
|---|---|---|
| `list_payment_methods` | `country`, `direction?` (`deposit` or `withdraw`, default `deposit`), `destination?` (only with more than one destination) | The methods in that country: `method`, `name`, `kind`, `available`, `reason` (when not available), `eta`, `limits`, `providers` |
| `get_quotes` | `country`, `amount`, `method?`, `direction?`, `destination?` (only with more than one destination) | Quotes: `pay`, `receive`, `fees`, `eta`. Without `method`, it quotes up to 3 cash methods. |
| `create_deposit_session` | `country`, `destination?`, `custom_destination?` (only with `allowCustomAddress`), `currency?`, `max_amount?`, `min_amount?`, `method?`, `amount?`, `reference?`, `ttl_minutes?` | `session_id`, `pay_url`, `pay_url_expires_at`, `expires_at`, `bounds`, `next`. With `method` and `amount`: also `payment` (for example a VietQR `qr_payload`). |
| `create_withdraw_session` | `country`, `amount?`, `max_amount?`, `reference?`, `ttl_minutes?` | `session_id`, `pay_url`, `pay_url_expires_at`, `expires_at`, `bounds`, `next` |
| `get_session_status` | `session_id` | `status`, `state`, `done`, `expires_at`. When there is a result: `method`, `provider`, `paid`, `received`, `received_confirmed`, `tx_hashes`. Also `bounds` and `error` when set. |
| `wait_for_completion` | `session_id`, `timeout_seconds` (default 60, capped by `maxWaitSeconds`) | Like `get_session_status`, plus `waited_seconds`. `timed_out: true` when the payment did not finish in time. |

`list_payment_methods` and `get_quotes` use a short preview session (10 minutes) on your server. They do not move money.

`wait_for_completion` polls the server. It stops when the session is `completed`, `failed`, `expired` or `refunded`, or when the time ends. When the client sends a progress token, the tool sends progress notifications.

### A deposit, step by step

1. The agent calls `create_deposit_session` with `country: "VN"` and `max_amount: "1000000"`.
2. The agent shows `pay_url` to the person, as a link or a QR code.
3. The person opens the link, picks VietQR, and pays in the bank app.
4. The agent calls `wait_for_completion`. The result has `status: "completed"` and `received`, for example `"39.1 USDC"`.

To skip the method screen, give `method` and `amount`. The tool then starts the payment and returns the instructions in `payment`, for example `{ "kind": "QR", "qr_payload": "000201...", "amount": "500000 VND" }`. The agent can show the QR code in the chat.

### A payout, step by step

1. The agent calls `create_withdraw_session` with `country: "PH"` and `amount: "20"`. The amount is in the source token (USDC). The person cannot change it.
2. The agent sends `pay_url` to the person.
3. The person picks how to receive the funds (for example GCash) and enters the account details.
4. The server sends the USDC from your treasury. The agent calls `wait_for_completion`.

## Guardrails

- **Destinations.** The agent can fund only a named destination from the config. The `destination` input is an enum of these names. The `custom_destination` input exists only when `allowCustomAddress` is set, and then only for the chains and tokens that you list.
- **Payout targets.** The agent cannot set where a payout goes. The person picks the target, inside `withdraw.allowedTargets`. The server also runs [`screenAddress`](./withdraw.md#screen-addresses) on wallet targets.
- **Amounts.** Each session gets `amountBounds`, at most the cap in `maxAmounts`. The server enforces the bounds on each quote and each payment.
- **Session scope.** The agent can read only the sessions that this MCP server created. Preview sessions are not readable.
- **No secrets.** The MCP server keeps each client secret in its registry. Tool results never contain a client secret, the app key or the server secret. The `pay_url` has a pay credential that works only for that session and expires.
- **Bounded waits.** `wait_for_completion` never waits more than `maxWaitSeconds`.

::: warning Bounds and currencies
The server checks `amountBounds` only when the payment currency is the bounds currency. A deposit with bounds in VND does not limit a payment in USDC from the person's wallet. For a hard cap on deposits, set `allowedMethods` to the cash methods of one currency. Payouts are always capped, because the payment is in the source token.
:::

## The pay link

The pay link opens a page on your OpenRampKit server: `GET {baseUrl}/pay/{sessionId}.pay_{exp}_{sig}`. The page shows the modal ([`<openramp-modal>`](./web-component.md)) for that session, in embedded mode.

- The server signs the link with `secret` (HMAC-SHA256), like the start URLs. The signature covers the session id and the expiry.
- The link expires at the session expiry plus 30 minutes, or earlier when you ask for a shorter time. After that, the page answers `410`.
- The part after `/pay/` is a credential for that session only. The page gives it to the modal as the client secret. It cannot create a new pay link.
- The page sends `cache-control: no-store`, `referrer-policy: no-referrer` and a strict content security policy (`frame-ancestors 'none'`, a script nonce).

Make a link from your backend with `openramp.sessions.payLink(id)`, or over HTTP with `POST {baseUrl}/sessions/:id/pay-link`. See [HTTP routes](../api/http.md#post-sessions-id-pay-link).

By default, the page loads `@openrampkit/web` from `https://esm.sh/@openrampkit/web@0`. To serve the script yourself, set `payPage.scriptUrl`:

```ts
createOpenRamp({
  // ...
  payPage: { scriptUrl: '/static/openramp-web.js', title: 'Pay Acme' },
})
```

Set `payPage: false` to turn off the pay page and the pay-link route.

::: warning Until the npm release
The default script URL works only after `@openrampkit/web` is on npm. Until then, serve a bundle of `@openrampkit/web` yourself and set `payPage.scriptUrl` to it. [`examples/agent`](https://github.com/yosriady/openrampkit/tree/main/examples/agent) does this: it serves `/openramp-web.js` from the local build.
:::

## Library

```ts
import { createOpenRampMcpServer, createMcpHttpHandler, createRampOps, memoryRegistry } from '@openrampkit/mcp'
```

| Export | Description |
|---|---|
| `createOpenRampMcpServer(config)` | An `McpServer` with the tools. Connect it to any transport. |
| `createMcpHttpHandler(config, { bearerToken })` | A `(Request) => Promise<Response>` handler for Streamable HTTP |
| `createRampOps(config)` | The tool operations without MCP. Pass the result to `createOpenRampMcpServer` to share one registry. |
| `memoryRegistry(max?)` | The default registry. Write your own `SessionRegistry` (`get`, `set`) to share it between instances. |

`config.connection` is one of:

- `{ baseUrl, appKey, appKeyHeader?, fetch? }`: an OpenRampKit server over HTTP. `appKeyHeader` defaults to `x-app-key`.
- `{ openramp }`: an `OpenRamp` instance from `createOpenRamp` in the same process.

```ts
import { createOpenRamp } from '@openrampkit/server'
import { createOpenRampMcpServer } from '@openrampkit/mcp'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const openramp = createOpenRamp({ /* ... */ })
const server = createOpenRampMcpServer({
  connection: { openramp },
  deposit: { destinations: [/* ... */] },
  maxAmounts: { VND: '2500000' },
})
await server.connect(new StdioServerTransport())
```

## Try it

[`examples/agent`](https://github.com/yosriady/openrampkit/tree/main/examples/agent) runs the full flow with the mock adapter. No money moves.

```bash
pnpm install && pnpm build
cd examples/agent
node agent.mjs           # a script plays the person
node agent.mjs --serve   # you open the pay link in a browser
```

With `--serve`, the server listens on `http://localhost:8788`. To open the pay link on a phone on the same network, set `PUBLIC_URL=http://<your-computer-ip>:8788`.
