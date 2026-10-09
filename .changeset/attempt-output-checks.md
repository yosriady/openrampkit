---
'@openrampkit/server': patch
---

Fixes in the output check and in late events for earlier attempts:

- The server checks a leg's output again when only its asset changes. Before, a provider could first report the quoted asset, then report the same amount in another asset, and the next leg started with no `amountMismatch`.
- An earlier attempt that becomes the payment again (a late provider event after `restart`) now gets the same output check as any other leg. Before, its output was not checked, so another asset or a short amount did not stop the next leg and did not set `amountMismatch`.
- A refund of an earlier attempt that never succeeded no longer makes that attempt the payment again. Before, it replaced the payment in progress, and the session became `REFUNDED`.
