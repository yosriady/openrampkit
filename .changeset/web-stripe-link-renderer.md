---
'@openrampkit/web': minor
'@openrampkit/client': minor
---

New entry `@openrampkit/web/stripe-link` with `stripeLinkRenderer()`, the modal renderer for the Stripe Link headless flow, on Stripe's `@stripe/crypto` (an optional peer dependency, loaded with a dynamic import). It makes a random client key in memory and sends it with every transition. KYC data and the phone number go to Stripe only. The main entry never imports it.

`ProviderRendererContext` has `submit(name, inputs?)`: it calls a transition with inputs and resolves to the next step. The modal mounts a renderer again when `params.step` changes, and shows no `SUBMIT` buttons for a step that a renderer draws. `RampController.fire()` now returns the new session (or `undefined` on an error).
