---
"@openrampkit/adapter-paytrie": minor
---

PayTrie sign-in code limits across sessions. Code checks are limited per email (5 per 15 minutes, a right code gives its try back) and per app user (10), and code emails per email (5 per hour) and per app user (10), with account lookups per app user (20 per hour). Each check and each email takes an atomic slot in the adapter's shared store before the PayTrie call, so requests at the same time never pass together. Over the email limit, the email is locked, and a code sent before the lock never counts again. A new code does not reset the tries of the email. `requireSessionEmail` now defaults to `true`; set it to `false` to let users type an email.
