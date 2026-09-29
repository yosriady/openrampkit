# OpenRampKit server on Cloudflare Workers

The OpenRampKit server uses only web standards (`Request`, `Response`, WebCrypto), so it runs on Workers as is.

```bash
cp .dev.vars.example .dev.vars
pnpm dev                      # wrangler dev on http://localhost:8787

# App backend: create a session (only your backend knows APP_API_KEY)
curl -X POST http://localhost:8787/sessions -H 'x-app-key: dev-app-key' -H 'content-type: application/json' \
  -d '{"userId":"u1","country":"VN","destination":{"type":"crypto","chain":"eip155:8453","token":"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913","address":"0x000000000000000000000000000000000000beef"}}'
# -> { "id": "ors_...", "clientSecret": "ors_....<secret>", "expiresAt": "..." }
```

Give `clientSecret` to the browser and point the widget at this worker (`baseUrl: 'http://localhost:8787'`).

Storage: `durableObjectStore` uses a Durable Object (built into Workers, strongly consistent). No extra service is needed.
