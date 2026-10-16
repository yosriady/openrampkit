---
"@openrampkit/adapter-paytrie": minor
---

New adapter: PayTrie, Interac e-Transfer in Canada (CAD to USDC), headless through the PayTrie Platform API v2. One `interac` leg for CA. The user signs in with an email code (`OTP`), does KYC on the PayTrie page when needed (`REDIRECT`), and gets the Interac details (`BANK_FIELDS`). Quotes from `GET /v2/quotes`, orders with `POST /v2/transactions` (the server wallet, the quote id and the leg ref), status from `GET /v2/transactions/{id}` with the user's sealed access token, and `transaction.update` webhooks verified with the v1 HMAC and a 5 minute window. Webhooks find the leg only through the adapter's own order index. Built from the PayTrie docs; some details are TO VERIFY.
