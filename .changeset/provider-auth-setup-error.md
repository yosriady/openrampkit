---
'@openrampkit/adapter': minor
'@openrampkit/adapter-relay': patch
'@openrampkit/adapter-xendit': patch
'@openrampkit/adapter-onramper': patch
'@openrampkit/adapter-coinbase': patch
---

A 401 or 403 from a provider is now a setup error. `httpErrorToOrk` returns `PROVIDER_UNAVAILABLE` with `retryable: false`, recovery `choose_other` and the message "{Provider} is not set up for this app yet. Try another method." It writes one error log for the operator that names the provider. Before, it was retryable with only a warning. New: `providerSetupError(provider)` and the `setupHint` option. Relay keeps its `UNAUTHORIZED_QUOTE` hint in the operator log, and the user message is now neutral. Xendit maps 401 and 403 about the key to the setup error, not to `PROVIDER_DECLINED`. Every adapter that uses `httpErrorToOrk` gets the new mapping.
