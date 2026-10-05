---
"@openrampkit/server": minor
"@openrampkit/core": minor
"@openrampkit/client": minor
"@openrampkit/web": minor
"@openrampkit/mcp": minor
---

Locked withdraw targets and pay link revocation.

- Server: `CreateSessionInput` has `target` and `lockTarget` for withdraw sessions. The server checks the target at creation (format, `allowedTargets`, `screenAddress`) and stores it as the destination. With `lockTarget: true`, `POST /sessions/:id/target` answers `409 TARGET_LOCKED`, for the client secret and for a pay link. A cash target (`{ type: 'fiat', currency }`) can also be locked.
- Server: pay links have an `id`. `openramp.sessions.revokePayLink(sessionId, linkId)` and `POST /sessions/:id/pay-link/revoke` make one link stop working. The credential format is now `{sessionId}.pay_{exp}_{linkId}_{sig}`.
- Core: `PublicSession.targetLocked` and the error code `TARGET_LOCKED`.
- Client and web: with a locked target, the withdraw flow skips the target screen and the tabs, gets the plan with `/plan`, and shows the locked address read only.
- MCP: a bound payout creates the session with the target set and locked, and then plans, quotes and starts it (no `/target` call). The operations from `createRampOps` have `revokePayLink(sessionId)`.
