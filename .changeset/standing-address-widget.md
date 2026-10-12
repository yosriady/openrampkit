---
"@openrampkit/core": minor
"@openrampkit/server": minor
"@openrampkit/client": minor
"@openrampkit/web": minor
"@openrampkit/adapter-mock": minor
---

"Your deposit address" in the widget. With the server option `depositAddresses: { widget: true }`, a deposit session's plan offers the method `deposit_address`. The user picks the network and token, and the widget shows their standing address with a QR code and a copy button (`POST /sessions/:id/deposit-address`, `client.depositAddress()`, `snapshot.depositAddress`). The mock adapter gets `standing` for demos and tests.
