---
'@openrampkit/core': minor
'@openrampkit/server': minor
'@openrampkit/mcp': patch
---

New session status `awaiting_user`: a payment started, and the active leg waits for the user (to pay, to send from the wallet, or to finish a provider step). Apps and the ops dashboard can now tell "waiting for the user to pay" from "payment in progress".

**Behavior change.** Before, a session whose step was `PAYMENT` (or another step where the active leg is `awaiting_user`) had the status `processing`. Now it has the status `awaiting_user`. The status becomes `processing` when the user paid or acted and the provider or the chain works. If your code checks `status === 'processing'` to find sessions that are not final, also check `awaiting_user` (or check for `open`, `awaiting_user` and `processing`). Webhook events do not change: no event is sent for this status. A stored session gets the new status at its next leg change.

- `SessionStatus` in `@openrampkit/core` has the new value.
- The server sets it from the active leg's status. The admin list filter (`state=awaiting_user`) and `stats.byStatus` show it. The dashboard has a "Waiting for the user" card and filter option.
- The MCP `get_session_status` tool description names it.
