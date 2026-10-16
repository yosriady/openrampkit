---
'@openrampkit/adapter-stripe-link': minor
---

New adapter `@openrampkit/adapter-stripe-link` for the Stripe Link headless crypto onramp (Embedded Components). The user signs in to Link, and the purchase runs in the app's own screens. The Link access token stays on the server, sealed with AES-256-GCM, for at most one hour. The adapter keeps no refresh token. Unverified: built from Stripe's docs, and Stripe must onboard the account (private preview).
