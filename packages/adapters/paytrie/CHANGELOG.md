# @openrampkit/adapter-paytrie

## 0.1.0

### Minor Changes

- 7e3f16e: New adapter: PayTrie, Interac e-Transfer in Canada (CAD to USDC), headless through the PayTrie Platform API v2. One `interac` leg for CA. The user signs in with an email code (`OTP`), does KYC on the PayTrie page when needed (`REDIRECT`), and gets the Interac details (`BANK_FIELDS`). Quotes from `GET /v2/quotes`, orders with `POST /v2/transactions` (the server wallet, the quote id and the leg ref), status from `GET /v2/transactions/{id}` with the user's sealed access token, and `transaction.update` webhooks verified with the v1 HMAC and a 5 minute window. Webhooks find the leg only through the adapter's own order index. Built from the PayTrie docs; some details are TO VERIFY.
- 11925b2: PayTrie sign-in code limits across sessions. Code checks are limited per email (5 per 15 minutes, a right code gives its try back) and per app user (10), and code emails per email (5 per hour) and per app user (10), with account lookups per app user (20 per hour). Each check and each email takes an atomic slot in the adapter's shared store before the PayTrie call, so requests at the same time never pass together. Over the email limit, the email is locked, and a code sent before the lock never counts again. A new code does not reset the tries of the email. `requireSessionEmail` now defaults to `true`; set it to `false` to let users type an email.

### Patch Changes

- 273a9fa: PayTrie: one canonical email for the limits. The adapter takes only a plain ASCII email (no Unicode, zero-width or control characters, quoted local parts or trailing dots), lowercases it, and sends PayTrie exactly the string it counts. The per email limits also apply to the PayTrie user id, so spellings that PayTrie maps to one account share them. A try is given back only when PayTrie returns an access token. The email is locked on the last wrong try of the window, and a code older than one hour is never checked.
- Updated dependencies [138dc35]
- Updated dependencies [243bf9c]
- Updated dependencies [131dc8a]
- Updated dependencies [d6e1063]
- Updated dependencies [901ea9a]
- Updated dependencies [25b1f98]
- Updated dependencies [9a88cec]
- Updated dependencies [9a88cec]
- Updated dependencies [51167ad]
- Updated dependencies [51167ad]
- Updated dependencies [b770da7]
- Updated dependencies [59811bd]
- Updated dependencies [977c386]
- Updated dependencies [77f762d]
- Updated dependencies [c7f849c]
- Updated dependencies [230c5ad]
- Updated dependencies [3453854]
- Updated dependencies [9c135aa]
- Updated dependencies [7512a8e]
- Updated dependencies [521c893]
- Updated dependencies [8d66ab9]
- Updated dependencies [b763cf0]
- Updated dependencies [0672f15]
- Updated dependencies [e2e8337]
- Updated dependencies [6e7899b]
- Updated dependencies [127b79a]
- Updated dependencies [8a2ec99]
- Updated dependencies [635d8f9]
- Updated dependencies [0dfd32e]
- Updated dependencies [f4a89d0]
- Updated dependencies [e74d5e3]
- Updated dependencies [fb978b8]
- Updated dependencies [5997e23]
- Updated dependencies [c24a0f7]
- Updated dependencies [a999c0c]
- Updated dependencies [63f3db5]
- Updated dependencies [d4523b2]
- Updated dependencies [bf08445]
- Updated dependencies [66c8f1d]
- Updated dependencies [3b8e567]
- Updated dependencies [8ad4bd2]
- Updated dependencies [aad31d5]
- Updated dependencies [bab3381]
- Updated dependencies [5c5019e]
- Updated dependencies [2c1daa4]
- Updated dependencies [609b907]
- Updated dependencies [29dbf05]
- Updated dependencies [18da157]
  - @openrampkit/adapter@0.1.0
  - @openrampkit/core@0.1.0
