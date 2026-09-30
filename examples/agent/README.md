# Agent ramps (MCP)

An AI agent funds a wallet or pays out to a person with `@openrampkit/mcp`. The agent creates the session and gets a pay link. A person opens the link on a phone and pays (for example with VietQR). The agent waits until the payment completes.

## Run the script

```bash
pnpm install
pnpm build
cd examples/agent
node agent.mjs            # a script plays the person
node agent.mjs --serve    # you play the person: open the printed pay link in a browser
```

The script runs an OpenRampKit server with the mock adapter (no money moves) and connects an MCP client to the MCP server. The client calls `list_payment_methods`, `get_quotes`, `create_deposit_session` and `wait_for_completion`, like an agent does.

With `--serve`, the server listens on `http://localhost:8788` and serves the web component for the pay page. To open the link on a phone on the same network, set `PUBLIC_URL=http://<your-computer-ip>:8788`.

## Claude Desktop

Run your OpenRampKit server with an `authorize` hook that checks `x-app-key` (see `examples/cloudflare-worker`). Copy `mcp.config.example.json`, set your destinations and caps, then add this to `claude_desktop_config.json`:

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

## Claude Code

```bash
claude mcp add openrampkit \
  -e OPENRAMP_URL=https://ramp.example.workers.dev \
  -e OPENRAMP_APP_KEY=your-app-key \
  -e OPENRAMP_MCP_CONFIG=/absolute/path/to/mcp.config.json \
  -- npx -y @openrampkit/mcp
```

Then ask: "Create a deposit of up to 1,000,000 VND to the treasury and give me the pay link."

## Streamable HTTP

```bash
MCP_HTTP_TOKEN=a-long-random-token OPENRAMP_URL=... OPENRAMP_APP_KEY=... OPENRAMP_MCP_CONFIG=./mcp.config.json \
  npx @openrampkit/mcp --http --port 3333
```

Clients connect to `http://localhost:3333/mcp` with `Authorization: Bearer a-long-random-token`.

Docs: [Agents (MCP)](../../docs/guide/agents.md)
