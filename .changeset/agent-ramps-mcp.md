---
"@openrampkit/mcp": minor
"@openrampkit/server": minor
---

Agent-ready ramps. New `@openrampkit/mcp`: a Model Context Protocol server (stdio and Streamable HTTP) with the tools `list_payment_methods`, `get_quotes`, `create_deposit_session`, `create_withdraw_session`, `get_session_status` and `wait_for_completion`, inside config guardrails (allowed destinations, caps per currency). Server: signed, expiring pay links (`GET /pay/:credential`, `POST /sessions/:id/pay-link`, `openramp.sessions.payLink(id)`) that open the modal for one session, and the `payPage` option.
