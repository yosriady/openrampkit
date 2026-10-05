---
'@openrampkit/server': patch
'@openrampkit/adapter-mock': patch
---

Admin tools: a session with no amount up front (for example a transfer from an exchange) now shows the amount that arrived, in the list, the detail drawer and the completed volume. The mock adapter's simulated deposit now sends a test amount (25) when the transfer has no amount.
