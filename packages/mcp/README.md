# @openrampkit/mcp

A Model Context Protocol (MCP) server for OpenRampKit. An AI agent can fund a wallet or pay out to a person. A person always does the payment step: the agent gets a signed pay link, and the person opens it on a phone and pays (for example with VietQR, QRIS or PromptPay).

Part of [OpenRampKit](https://github.com/yosriady/openrampkit): an open-source deposit and withdraw kit with a self-hosted server and pluggable adapters.

```bash
pnpm add @openrampkit/mcp
```

Tools: `list_payment_methods`, `get_quotes`, `create_deposit_session`, `create_withdraw_session`, `get_session_status`, `wait_for_completion`.

Guardrails: the agent funds only destinations from your config, never above `maxAmounts`, and never sees a client secret.

```ts
import { createOpenRampMcpServer } from '@openrampkit/mcp'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const server = createOpenRampMcpServer({
  connection: { baseUrl: 'https://ramp.example.workers.dev', appKey: process.env.OPENRAMP_APP_KEY! },
  deposit: { destinations: [{ name: 'treasury', chain: 'eip155:8453', token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', address: '0x...', symbol: 'USDC', decimals: 6 }] },
  maxAmounts: { VND: '2500000', USDC: '100' },
})
await server.connect(new StdioServerTransport())
```

Or run the CLI: `npx @openrampkit/mcp` (stdio) or `npx @openrampkit/mcp --http` (Streamable HTTP).

Docs: https://github.com/yosriady/openrampkit/tree/main/docs/guide/agents.md

MIT licensed.
