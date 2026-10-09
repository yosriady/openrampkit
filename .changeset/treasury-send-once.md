---
'@openrampkit/server': patch
---

Withdraw with `custody: 'app'`: a failure after `treasury.send` (a provider error when the server reports the hash, a save conflict, or a stop of the process) can no longer make the treasury send a second time. Before the send, the server now saves the leg as `processing`, so the saved session shows the payment in progress: it refuses `restart` and a new `select`, and it shows no `WALLET_TX` to the user. When a provider event or a status check asks again for a step that the treasury already sent, the leg waits in `processing` and the server does not call the hook again.
