---
"@openrampkit/mcp": minor
---

Guardrails across sessions for agents. New `limits` (`maxTotalPerDay` per currency, `maxSessionsPerHour`), with counters in the session registry (`SessionRegistry.incr`; `memoryRegistry()` has one). New `approve` hook: it runs before each payout session and fails closed (`NOT_APPROVED`). New `withdraw.targets`: the agent picks an operator-bound wallet by name, and the MCP server starts the payout with no pay link, so nobody can redirect the funds. New `withdraw.requireBoundTarget` turns off pay link payouts (default `true` in the CLI). The HTTP CLI listens on `127.0.0.1` by default (`HOST` or `--host` to change it) and refuses bodies over 1 MB. `createMcpHttpHandler` takes `maxBodyBytes`. The MCP handshake reports the package version.
