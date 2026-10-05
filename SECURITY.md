# Security policy

OpenRampKit moves money. We treat security reports as our first priority.

## Report a vulnerability

Do not open a public issue for a vulnerability.

1. Use GitHub private vulnerability reporting: go to the repository, open the **Security** tab, and click **Report a vulnerability**.
2. Tell us the package and the version, the steps to reproduce, and the effect (for example: "a user can complete a session without payment").
3. We reply in 3 business days. We send a fix plan in 10 business days.
4. We publish a fix and a GitHub security advisory. We give you credit, unless you tell us not to.

Do not test on production systems that you do not own. Do not move real funds that are not yours.

## Supported versions

We fix vulnerabilities in the latest minor version of each `@openrampkit/*` package. Update to the latest version to get fixes.

## Threat model

### Assets

- Provider API keys and webhook secrets, on the OpenRampKit server.
- The session destination: where the funds go.
- The app treasury, for withdrawals with `custody: 'app'`.
- The "payment completed" signal that the app uses to credit a user.

### Trust boundaries

| Part | Trust |
|---|---|
| App backend | Trusted. It creates sessions and credits users. |
| OpenRampKit server | Trusted. It runs in the app's infrastructure and holds the keys. |
| Browser (client, web component, React, wagmi) | Not trusted. The user controls every request. |
| Provider pages and webhooks | Trusted only after the adapter verifies the signature. |
| Chain RPCs | Trusted for same-chain checks. |

### Main threats and controls

| Threat | Control |
|---|---|
| One session acts on another session | Each session has its own random secret. The server stores only the hash and compares in constant time. The id in the URL must match the secret. |
| The user changes the destination | The app sets the destination on the server. The browser cannot change it. |
| A forged provider webhook completes a payment | Each adapter verifies the signature over the raw body, with a replay window when the provider signs a time. An adapter without its key refuses every webhook. |
| An old or reused transaction completes a new payment | Relay same-chain payments check the block time and keep a list of used transaction hashes. |
| A `javascript:` or `data:` URL runs in the app page | The server, the client and the web component accept only `https:` pages (and `http:` in test mode) for redirects and iframes, and refuse script schemes for deep links. |
| A forged or changed start URL | Start URLs are signed with HMAC and expire after 10 minutes. |
| The treasury sends twice | The server saves the session with a version check before it calls `treasury.send`, and gives an idempotency key. |
| A withdrawal to a sanctioned address | `screenAddress` runs before the user can use an address, and fails closed. |
| Denial of service | Body size limits, a per-session rate limit on provider calls, and timeouts on provider calls. |
| Secrets leak in errors or logs | The browser gets only error codes and safe messages. The server does not log keys or headers. |

### AI agents (MCP server)

`@openrampkit/mcp` lets an AI agent create deposit and payout sessions. Do not trust the agent. Its instructions can come from text that an attacker wrote (prompt injection), for example a web page, an email or a tool result. The agent can also loop and call the same tool many times. The operator config is trusted. The agent input is not.

| Threat | Control |
|---|---|
| Prompt injection sends funds to an attacker wallet | The agent cannot give an address for a payout. It picks only a name from `withdraw.targets`, which the operator sets. For a bound target, the MCP server makes no pay link, so nobody can change the target. Deposit destinations work the same way (`deposit.destinations`). |
| A pay link reaches the wrong person | For a payout without a bound target, the person who opens the pay link picks where the funds go, up to the bounds. The link cannot be revoked. Use `withdraw.requireBoundTarget` to turn off these payouts. The CLI turns them off by default. |
| A looping or injected agent drains the treasury in many small payouts | `maxAmounts` caps each session. `limits.maxTotalPerDay` caps the total per currency per UTC day. `limits.maxSessionsPerHour` caps the session rate. Each session counts its largest amount. |
| Payouts without a person to check them | The `approve` hook runs before each payout session and fails closed. The CLI has no hook, so it requires bound targets. |
| The agent reads or changes sessions that it did not create | The MCP server keeps each client secret in its registry. The agent sees only session ids. It can read only the sessions that this MCP server created. |
| Secrets leak to the agent | Tool results never contain a client secret, the app key or the server secret. Unknown errors give a generic message. |
| A caller on the network uses the HTTP transport | The HTTP transport needs a bearer token of at least 16 characters. The CLI listens on `127.0.0.1` by default and refuses a body larger than 1 MB. |

Limits:

- The limit counters live in the session registry. `memoryRegistry()` keeps them for one process. With more than one instance, give a shared registry with an atomic `incr`.
- Limit windows are fixed UTC hours and days. At a window boundary, an agent can use the old and the new window.
- The MCP server does not know the identity of the person who opens a pay link. Your OpenRampKit server and your providers handle KYC.

## Hardening measures

- Session secrets: 24 random bytes, stored as a SHA-256 hash, compared in constant time.
- Config checks: `secret` has at least 32 characters. `webhooks.secret` and `tasksToken` have at least 16.
- Session deadline: after `expiresAt`, a session cannot quote, select or restart.
- Input checks on `CreateSessionInput` (user id, metadata size, TTL, country, amount bounds, destination) and on browser requests (amounts, addresses, chains, tokens, targets).
- Body size limits: 64 KiB for JSON routes, 1 MiB for provider webhooks. A larger body gets `413`.
- Idempotency keys scoped to the session and the route, 1 to 255 printable characters.
- Own-key lookups for quote ids (no prototype values).
- Per-session rate limit on the routes that call providers (plan, target, quotes, select, transitions).
- Surface URL checks on the server, in the client and in the web component.
- Signed, short-lived start URLs with `no-store` and `no-referrer`.
- Provider webhook verification with the raw body, constant-time comparison and a replay window.
- Signed outgoing webhooks (HMAC-SHA256 over id, timestamp and body) with a 5-minute window in `verifyWebhook`.
- Iframe messages: the exact origin and the iframe window must match. A message never sets the outcome: the server status does.
- Withdrawals: address format checks, `allowedTargets`, `screenAddress` (fail closed), and a single treasury send per step.
- Relay same-chain payments: receipt status, amount, recipient, block time, and one use per transaction hash.
- The mock adapter refuses live sessions.
- CORS: an allow list of origins, no credentials.
- Operational routes (`/tasks/sweep`, `/health?deep=1`) need a bearer token.

For details and for what the app must do, see [docs/guide/security.md](docs/guide/security.md).
