# Agents (MCP)

`@openrampkit/mcp` is a Model Context Protocol (MCP) server. With it, an AI agent can:

- **fund a wallet**: a person pays in with a local method (VietQR, QRIS, PromptPay, DuitNow, QR Ph, PayNow, card or crypto), and the funds go to a wallet that you allow.
- **pay out to a person**: your app sends funds, and the person picks how to receive them (for example a bank account or an e-wallet).
- **pay out to a bound target**: your app sends funds to a wallet that you listed in the config. No pay link is made.

For deposits and pay link payouts, a person does the payment step. The agent creates a session and gets a **pay link**. The person opens the pay link on a phone and pays. Then the agent waits for the result. For a payout to a bound target, the MCP server starts the payout itself, inside your limits and after your approval.

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
    "source": { "chain": "eip155:8453", "token": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "symbol": "USDC", "decimals": 6, "custody": "app" },
    "targets": [
      {
        "name": "ops",
        "description": "Operations wallet on Base",
        "chain": "eip155:8453",
        "token": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        "address": "0x000000000000000000000000000000000000cafe",
        "symbol": "USDC",
        "decimals": 6
      }
    ],
    "requireBoundTarget": true
  },
  "maxAmounts": { "VND": "2500000", "IDR": "1500000", "USDC": "100" },
  "limits": {
    "maxTotalPerDay": { "VND": "10000000", "IDR": "6000000", "USDC": "300" },
    "maxSessionsPerHour": 10
  }
}
```

This table lists every field of `OpenRampMcpConfig`. The CLI reads the same fields from the JSON file, except the fields marked "library only".

| Field | Default | Description |
|---|---|---|
| `connection` | required (library) | How the MCP server reaches your OpenRampKit server: `{ baseUrl, appKey, appKeyHeader?, fetch? }` or `{ openramp }`. See [Library](#library). The CLI builds it from `OPENRAMP_URL` (or `baseUrl` in the file), `OPENRAMP_APP_KEY` and `appKeyHeader`. The CLI ignores a `connection` field in the file. |
| `maxAmounts` | required | The largest amount per session, by currency code or token symbol. The agent can use only these currencies. |
| `deposit` | none | Turns on deposits (`create_deposit_session`). Without `deposit`, the deposit tool is off. |
| `deposit.destinations` | required in `deposit` | The only wallets that the agent can fund. The agent picks one by `name`. See [Named destinations](#named-destinations). |
| `deposit.allowCustomAddress` | off | `{ chains, tokens? }`: let the agent give its own address, on these chains and tokens only. `tokens` maps a chain to the allowed token addresses. Without `tokens`, the tokens of `deposit.destinations` on that chain are allowed. |
| `withdraw` | none | Turns on payouts (`create_withdraw_session`). Without `withdraw`, the payout tool is off. |
| `withdraw.source` | required in `withdraw` | The asset that leaves and who holds it. For agent payouts, use `custody: 'app'` and a server [`treasury`](./withdraw.md#custody-app). |
| `withdraw.allowedDestinations` | cash only (`{ fiat: {} }`) | Where the person can receive the funds on a pay link. See [Allowed targets](./withdraw.md#allowed-targets). |
| `withdraw.targets` | none | Bound payout wallets, in the same form as `deposit.destinations`. The agent picks one by `name`. The MCP server sets the target and starts the payout. No pay link is made. Needs `custody: 'app'`. |
| `withdraw.requireBoundTarget` | `false` in the library, `true` in the CLI | Refuse payouts without a bound target. Then the agent cannot make a payout pay link. |
| `limits` | none | Limits across sessions. The counters are in `registry`. Set them for any agent that can make payouts. |
| `limits.maxTotalPerDay` | none | The largest total per UTC day, by currency. When set, it must list each currency of `maxAmounts`. Each session counts its largest amount. Payouts and deposits have separate totals. |
| `limits.maxSessionsPerHour` | none | The most sessions (deposits and payouts together) that the agent can create in one UTC hour |
| `approve` | none | Library only. `async (request) => boolean`. It runs before each payout session. See [Operator approval](#operator-approval). |
| `registry` | `memoryRegistry()` | Library only. Keeps client secrets and the `limits` counters. See [Library](#library). |
| `allowedMethods` | all | Only these methods, for example `["vietqr", "qris"]` |
| `userId` | `agent` | The `userId` of each session |
| `sessionTtlMinutes` | `30` | The longest session life, in minutes. The agent can ask for less. |
| `maxWaitSeconds` | `120` | The longest time of one `wait_for_completion` call, in seconds (at most 600) |
| `pollIntervalMs` | `3000` | The poll interval of `wait_for_completion`, in milliseconds |
| `serverInfo` | `{ name: 'openrampkit', version: <package version> }` | `{ name, version }`: the name and version in the MCP handshake |

The JSON file of the CLI can also have these fields. They are not part of `OpenRampMcpConfig`:

| Field | Default | Description |
|---|---|---|
| `baseUrl` | none | The base URL of your OpenRampKit server. `OPENRAMP_URL` wins when both are set. |
| `appKeyHeader` | `x-app-key` | The header that carries the app key |

### Named destinations

Each entry of `deposit.destinations` and `withdraw.targets` has these fields:

| Field | Required | Description |
|---|---|---|
| `name` | yes | The short name that the agent uses, for example `treasury`. Names must be unique. |
| `description` | no | Shown to the agent, for example "Team wallet on Base" |
| `chain` | yes | CAIP-2 chain id, for example `eip155:8453` |
| `token` | yes | The token address, or `native` |
| `address` | yes | The wallet address. It must be valid for `chain`. |
| `symbol` | no | The token symbol, for example `USDC` |
| `decimals` | no | The token decimals, for example `6` |

The MCP server checks the config when it starts. It stops with an error when:

- `maxAmounts` is empty.
- A destination or target address is not valid for its chain, or two names are the same.
- `withdraw.targets` is set and `custody` is not `app`.
- `requireBoundTarget` is `true` and `withdraw.targets` is empty.
- `limits.maxTotalPerDay` does not list each currency of `maxAmounts`.
- `limits` is set and the `registry` has no `incr` function.

::: warning Set limits for payouts
`maxAmounts` caps one session only. Without `limits`, a looping agent or an agent that follows injected instructions can create many payouts, each under the cap. Always set `limits` when `withdraw` is on. The CLI writes a warning when they are missing.
:::

### Operator approval

In the library, give an `approve` function. The MCP server calls it before it creates each payout session. Only `true` allows the payout. `false`, any other value or an error refuses it, and the agent gets `NOT_APPROVED`.

```ts
const server = createOpenRampMcpServer({
  // ...
  approve: async ({ amount, target, reference }) => {
    // For example: ask a person in a chat, then wait for the answer.
    return askOperator(`Pay out ${amount.max} ${amount.currency} to ${target?.name ?? 'a pay link'} (${reference ?? 'no reference'})?`)
  },
})
```

The request has `direction`, `country`, `amount` (`max`, `min?`, `currency`), `source`, `target` (only for a bound target) and `reference`.

The CLI cannot run a function. In the CLI, `withdraw.requireBoundTarget` is `true` by default, so payouts go only to the wallets in `withdraw.targets`. To allow pay link payouts in the CLI, set `"requireBoundTarget": false` in the config file. The CLI then writes a warning.

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

Clients connect to `http://127.0.0.1:3333/mcp`. Each request must have `Authorization: Bearer <MCP_HTTP_TOKEN>`. The CLI does not start without the token. The token must have at least 16 characters. `--port` (or `PORT`) sets the port. The default is `3333`.

The CLI listens on `127.0.0.1` only. To listen on other interfaces, set `--host 0.0.0.0` (or `HOST`). Do this only behind a proxy with TLS. A request body larger than 1 MB gets `413`.

For all the environment variables and flags, see [CLI reference](#cli-reference).

On Cloudflare Workers, Deno or Bun, use the web-standard handler:

```ts
import { createMcpHttpHandler } from '@openrampkit/mcp'

const handler = createMcpHttpHandler(config, { bearerToken: env.MCP_HTTP_TOKEN })
export default { fetch: (req: Request) => handler(req) }
```

The handler is stateless. It keeps the session registry in memory for the life of the process. For many instances, give a shared `registry` (see [Library](#library)). Each instance with its own memory registry has its own `limits` counters. The handler refuses a body larger than `maxBodyBytes` (default 1 MB) with `413`.

## CLI reference

```bash
openrampkit-mcp [--config <path>] [--http] [--port <port>] [--host <host>]
```

Without `--http`, the CLI uses stdio. The CLI writes its messages to stderr. On an error, it writes `openrampkit-mcp: <message>` and exits with code 1.

### Flags

| Flag | Description |
|---|---|
| `--config <path>` | The path to the JSON file with the guardrails. It wins over `OPENRAMP_MCP_CONFIG`. |
| `--http` | Use Streamable HTTP in place of stdio. Clients connect to `http://<host>:<port>/mcp`. Needs `MCP_HTTP_TOKEN`. |
| `--port <port>` | With `--http` only: the port. It wins over `PORT`. The default is `3333`. |
| `--host <host>` | With `--http` only: the interface. It wins over `HOST`. The default is `127.0.0.1`. Set `0.0.0.0` only behind a proxy with TLS. |

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `OPENRAMP_URL` | yes, unless the file has `baseUrl` | The base URL of your OpenRampKit server. It wins over `baseUrl` in the config file. |
| `OPENRAMP_APP_KEY` | yes | The key that your `authorize` hook checks. The CLI sends it in `x-app-key`, or in the header that `appKeyHeader` sets. The config file cannot set the key. |
| `OPENRAMP_MCP_CONFIG` | yes, unless you give `--config` | The path to the JSON file with the guardrails |
| `MCP_HTTP_TOKEN` | with `--http` | The bearer token that clients send. It must have at least 16 characters. |
| `PORT` | no | With `--http` only: the port. The default is `3333`. |
| `HOST` | no | With `--http` only: the interface. The default is `127.0.0.1`. |

### Which value wins

When a flag, an environment variable and the config file set the same value, the CLI uses the first one in this order:

| Value | Order |
|---|---|
| Config file path | `--config`, then `OPENRAMP_MCP_CONFIG` |
| Server URL | `OPENRAMP_URL`, then `baseUrl` in the file |
| App key | `OPENRAMP_APP_KEY` only |
| App key header | `appKeyHeader` in the file, then `x-app-key` |
| HTTP port | `--port`, then `PORT`, then `3333` |
| HTTP interface | `--host`, then `HOST`, then `127.0.0.1` |
| HTTP bearer token | `MCP_HTTP_TOKEN` only |

### Checks at start

The CLI stops with an error when:

- There is no config file path.
- `OPENRAMP_APP_KEY` is not set, or there is no server URL.
- `--http` is set and `MCP_HTTP_TOKEN` is not set, or it has fewer than 16 characters.
- `withdraw` is set, `withdraw.targets` is empty, and the file does not set `withdraw.requireBoundTarget`. To allow pay link payouts, set `"requireBoundTarget": false`.
- The config fails a check in [Configure the guardrails](#configure-the-guardrails).

The CLI writes a warning (and starts) when `withdraw.requireBoundTarget` is `false`, or when payouts are on with no `limits`.

## Tools

All results are compact JSON. An error result has `isError: true` and `{ "error": { "code", "message" } }`.

| Tool | Input | Result |
|---|---|---|
| `list_payment_methods` | `country`, `direction?` (`deposit` or `withdraw`, default `deposit`), `destination?` (only with more than one destination) | The methods in that country: `method`, `name`, `kind`, `available`, `reason` (when not available), `eta`, `limits`, `providers` |
| `get_quotes` | `country`, `amount`, `method?`, `direction?`, `destination?` (only with more than one destination) | Quotes: `pay`, `receive`, `guarantee` (`firm`, `min_output` or `estimate`), `min_receive` (when the provider guarantees a minimum), `slippage_bps` (when set), `fees`, `eta`, `expires_at`. Each fee line gives the amount, or "amount not given", and "included in rate" or "charged on top". Without `method`, it quotes up to 3 cash methods. |
| `create_deposit_session` | `country`, `destination?`, `custom_destination?` (only with `allowCustomAddress`), `currency?`, `max_amount?`, `min_amount?`, `method?`, `amount?`, `reference?`, `ttl_minutes?` | `session_id`, `pay_url`, `pay_url_expires_at`, `expires_at`, `bounds`, `next`. With `method` and `amount`: also `payment` (for example a VietQR `qr_payload`). |
| `create_withdraw_session` | `country`, `target?` (only with `withdraw.targets`; required with `requireBoundTarget`), `amount?` (required with `target`), `max_amount?` (not with `requireBoundTarget`), `reference?`, `ttl_minutes?` | Without `target`: `session_id`, `pay_url`, `pay_url_expires_at`, `expires_at`, `bounds`, `next`. With `target`: `session_id`, `status`, `target`, `quote`, `expires_at`, `bounds`, `next` (no `pay_url`). |
| `get_session_status` | `session_id` | `status`, `state`, `done`, `expires_at`. When there is a result: `method`, `provider`, `paid`, `received`, `received_confirmed`, `transactions` (each with `role`, `chain`, `hash` and `leg`), and `delivery` with `short_by` when the received amount is not the quote. `provider_refs` lists the provider order ids (`provider`, `ref`) for provider support. Also `bounds` and `error` when set. |
| `wait_for_completion` | `session_id`, `timeout_seconds` (default 60, capped by `maxWaitSeconds`) | Like `get_session_status`, plus `waited_seconds`. `timed_out: true` when the payment did not finish in time. |

`list_payment_methods` and `get_quotes` use a short preview session (10 minutes) on your server. They do not move money.

`wait_for_completion` polls the server. It stops when the session is `succeeded`, `failed`, `canceled`, `expired`, `refunded` or `reversed`, when an attempt failed (`attempt_failed: true`, the person must choose again), or when the time ends. When the client sends a progress token, the tool sends progress notifications.

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

With a bound target:

1. The agent calls `create_withdraw_session` with `target: "ops"` and `amount: "20"`.
2. The MCP server checks the limits and calls `approve`. Then it creates the session with the destination set and locked (`destination` and `lockDestination: true`, see [Locked targets](./withdraw.md#locked-targets)). It plans, quotes and starts the payout with the client secret. The agent never sees the client secret.
3. The server sends the USDC from your treasury to the target wallet. The agent calls `wait_for_completion`.

## Guardrails

- **Destinations.** The agent can fund only a named destination from the config. The `destination` input is an enum of these names. The `custom_destination` input exists only when `allowCustomAddress` is set, and then only for the chains and tokens that you list.
- **Payout targets.** The agent cannot give an address for a payout. It can pick only a name from `withdraw.targets`. For a bound target, the server locks the target when it creates the session (`destinationLocked: true`), and the MCP server makes no pay link. Nobody can change the target: `POST /sessions/:id/target` answers `409 DESTINATION_LOCKED`, also for a pay link. Without a bound target, the person who opens the pay link picks the target, inside `withdraw.allowedDestinations`. The server also runs [`screenAddress`](./withdraw.md#screen-addresses) on wallet targets.
- **Amounts.** Each session gets `amountBounds`, at most the cap in `maxAmounts`. The server enforces the bounds on each quote and each payment.
- **Limits.** `limits.maxTotalPerDay` and `limits.maxSessionsPerHour` stop a looping agent. A session that passes a limit is refused with `LIMIT_REACHED`, and nothing is counted for it. A session that the server refuses is not counted.
- **Approval.** `approve` runs before each payout. It fails closed (`NOT_APPROVED`).
- **Session scope.** The agent can read only the sessions that this MCP server created. Preview sessions are not readable.
- **No secrets.** The MCP server keeps each client secret in its registry. Tool results never contain a client secret, the app key or the server secret. The `pay_url` has a pay credential that works only for that session and expires.
- **Bounded waits.** `wait_for_completion` never waits more than `maxWaitSeconds`.

::: warning Bounds and currencies
The server checks `amountBounds` only when the payment currency is the bounds currency. A deposit with bounds in VND does not limit a payment in USDC from the person's wallet. For a hard cap on deposits, set `allowedMethods` to the cash methods of one currency. Payouts are always capped, because the payment is in the source token.
:::

::: warning A pay link is a bearer credential
For a payout without a bound target, the person who opens `pay_url` picks where the funds go, up to the bounds. Send the link only to the person who must receive the funds, on a private channel. The link works until the session expiry plus 30 minutes, or until you revoke it. To revoke it, call `revokePayLink(sessionId)` on the operations from `createRampOps` (see [Library](#library)). When you do not need a person to pick the target, use `withdraw.targets` and `requireBoundTarget`.
:::

Limit windows are fixed UTC hours and UTC days. At the boundary of a window, an agent can use the limit of the old window and then of the new window. Set limits with this in mind.

Error codes from the guardrails:

| Code | Meaning |
|---|---|
| `AMOUNT_TOO_HIGH` | Above the cap in `maxAmounts` |
| `CURRENCY_NOT_ALLOWED` | The currency is not in `maxAmounts` |
| `LIMIT_REACHED` | A limit in `limits` is reached. The message says when the window ends. |
| `NOT_APPROVED` | `approve` did not return `true` |
| `TARGET_REQUIRED` | `requireBoundTarget` is on and the agent gave no `target` |
| `DESTINATION_NOT_ALLOWED` | The `target` is not in `withdraw.targets` |

## The pay link

The pay link opens a page on your OpenRampKit server: `GET {baseUrl}/pay/{sessionId}.pay_{exp}_{linkId}_{sig}`. The page shows the modal ([`<openramp-modal>`](./web-component.md)) for that session, in embedded mode.

- The server signs the link with `secret` (HMAC-SHA256), like the start URLs. The signature covers the session id, the expiry and a random link id.
- The link expires at the session expiry plus 30 minutes, or earlier when you ask for a shorter time. After that, the page answers `410`.
- The part after `/pay/` is a credential for that session only. The page gives it to the modal as the client secret. It cannot create or revoke a pay link.
- To make a link stop working before it expires, call `openramp.sessions.revokePayLink(sessionId, linkId)`, or `POST {baseUrl}/sessions/:id/pay-link/revoke` with the client secret. `linkId` is the `id` of the link. Then the page answers `410`. See [HTTP routes](../api/http.md#post-sessions-id-pay-link-revoke).
- A person with the pay link cannot change a [locked target](./withdraw.md#locked-targets).
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
| `createRampOps(config)` | The tool operations without MCP. Pass the result to `createOpenRampMcpServer` to share one registry. It also has `revokePayLink(sessionId)`, which is not a tool: it makes the pay link of a session stop working (`NO_PAY_LINK` when this server made no pay link for it). |
| `memoryRegistry(max?)` | The default registry, in memory, for one process. Write your own `SessionRegistry` to share it between instances. |

A `SessionRegistry` has `get(id)`, `set(id, entry)` and, for `limits`, `incr(key, amount, ttlMs)`. `incr` adds a decimal string (it can be negative) to a counter and returns the new total as a decimal string. The counter starts at `"0"` and is removed `ttlMs` after its first add. `incr` must be atomic across all instances, for example Redis `INCRBYFLOAT` with `PEXPIRE ... NX`, or one database row update.

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
