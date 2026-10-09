---
'@openrampkit/server': patch
---

A status check that fails half way is never saved. Before, when a poll moved a leg to `succeeded` and the next leg could not start (a provider error), the server kept the half-changed session in memory. When the same sweep also saw a change on an earlier attempt, it saved that session: the active leg had no step, and the session stopped (no next leg, no expiry). Now the error of the next leg goes to the caller: the sweep saves nothing for that session and tries again on its next run. `GET /sessions/:id/step` answers with the error (the client polls again), and `sessions.refresh` throws it.
