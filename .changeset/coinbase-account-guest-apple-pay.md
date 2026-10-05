---
'@openrampkit/adapter-coinbase': minor
'@openrampkit/core': minor
'@openrampkit/web': patch
---

Coinbase: a new `coinbase_account` leg lets the user pay from the fiat or crypto balance of a Coinbase account (`FIAT_WALLET` or `CRYPTO_WALLET`, option `accountBalance`). A new `guest_apple_pay` leg (option `guestCheckout`) gives guest Apple Pay in the US with the Headless Onramp API: an order quote, a payment link in an `IFRAME`, order status and order webhooks. Core: new method code `coinbase_account` (kind `exchange`) and an optional `referrerPolicy` on the `IFRAME` surface. Web: the provider frame uses that referrer policy.
