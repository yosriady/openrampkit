---
'@openrampkit/core': minor
'@openrampkit/server': minor
'@openrampkit/web': minor
'@openrampkit/client': patch
'@openrampkit/adapter-bridge': patch
'@openrampkit/adapter-lifi': patch
'@openrampkit/adapter-mock': patch
'@openrampkit/adapter-relay': patch
'@openrampkit/adapter-swapped': patch
---

`Step.sub` is now a closed list of lowercase values: `StepSub`, with `STEP_SUBS` and `isStepSub` in `@openrampkit/core`. Before, it mixed case and raw provider strings (`CONFIRMING`, `confirming`, Relay and LI.FI statuses), and the web UI title-cased them. Adapters now map provider statuses to the list (for example LI.FI `WAIT_DESTINATION_TRANSACTION` is `bridging`, Relay `waiting` is `waiting_for_deposit`) and put the raw value in the new `LegStep.providerStatus`. The server writes it to the timeline (`leg.provider_status`), never to the browser, and drops a `sub` that is not in the list. The web element shows `messages.stepSub[sub]`, translated in every catalog (en, vi, id, th, ms, fil).
