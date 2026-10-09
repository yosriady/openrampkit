---
'@openrampkit/server': patch
---

A status poll that reports `requires_action` with no surface and only poll transitions no longer replaces the user's current action. Before, the user's own transitions (for example `submit_tx`, a form, or the mock's `simulate_payment`) were lost after the first poll, and the next user action got `409`.
