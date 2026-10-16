---
"@openrampkit/adapter-paytrie": patch
---

PayTrie: one canonical email for the limits. The adapter takes only a plain ASCII email (no Unicode, zero-width or control characters, quoted local parts or trailing dots), lowercases it, and sends PayTrie exactly the string it counts. The per email limits also apply to the PayTrie user id, so spellings that PayTrie maps to one account share them. A try is given back only when PayTrie returns an access token. The email is locked on the last wrong try of the window, and a code older than one hour is never checked.
