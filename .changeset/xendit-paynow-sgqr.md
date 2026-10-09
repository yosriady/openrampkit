---
"@openrampkit/adapter-xendit": patch
---

PayNow QR now uses the Xendit channel code `SGQR` (from the Xendit PayNow QR channel page). The old code `PAYNOW` got `400 API_VALIDATION_ERROR`. The PayNow minimum is now 0.01 SGD. Two setup errors are now `PROVIDER_UNAVAILABLE` with `retryable: false` and recovery `choose_other`: `403 INVALID_MERCHANT_SETTINGS` (the channel is not active) and a `400 API_VALIDATION_ERROR` that names the channel. The adapter writes an error log that names the channel and tells the operator what to do.
