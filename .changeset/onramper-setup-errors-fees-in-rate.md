---
"@openrampkit/adapter-onramper": patch
"@openrampkit/core": patch
"@openrampkit/web": patch
"@openrampkit/mcp": patch
---

Onramper: a `401` or `403` (for example `errorId 4011` "No V2 signing key is registered for this API key") is now a setup error: `PROVIDER_UNAVAILABLE` with `retryable: false` and recovery `choose_other`. The user sees a neutral message, and the operator gets an error log that says what to do (register the Ed25519 public key, check the signature, the API key or the IP allowlist). An onramp quote with no fee fields (for example guardarian) now gets a fee line "included in rate": for USD to a USD stablecoin it is the input minus the payout, else the amount is `0` with the new `Fee.inRate` flag. The web quote row does not show "No fees" for such a quote, and the MCP quote view says "amount not given".
