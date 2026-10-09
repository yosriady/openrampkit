---
'@openrampkit/core': minor
'@openrampkit/server': minor
'@openrampkit/client': minor
'@openrampkit/web': minor
'@openrampkit/mcp': minor
---

Security: `POST /sessions/:id/quotes` now returns `PublicQuote[]`. Each leg has no adapter `data`, so provider URLs (for example the Coinbase onramp URL), request bodies and idempotency nonces stay on the server. New types: `PublicQuote` and `PublicLegQuote` in `@openrampkit/core`. The client, the web element and the MCP server use them. `@openrampkit/client` and `@openrampkit/web` re-export `PublicQuote` and `PublicLegQuote` in place of `Quote`. `rankQuotes` is generic. The server keeps the full `Quote` in its store for `start()`.
