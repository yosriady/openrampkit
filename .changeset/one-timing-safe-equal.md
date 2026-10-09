---
'@openrampkit/core': minor
'@openrampkit/adapter': patch
'@openrampkit/server': patch
'@openrampkit/mcp': patch
---

One constant-time string compare: `timingSafeEqual(a, b)` is now in `@openrampkit/core`. `@openrampkit/adapter` exports the same function, and the server and the MCP HTTP handler use it. The result does not change.
