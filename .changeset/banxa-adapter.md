---
"@openrampkit/adapter-banxa": minor
---

New adapter: Banxa, a direct fiat onramp through Banxa Hosted Checkout. One `fiat_onramp` leg per Banxa buy method (card, Apple Pay, Google Pay, SEPA, Faster Payments, PayID, NPP, iDEAL, Klarna, PayPal, Interac, SPEI, Khipu, South African bank transfer, VietQR, UPI), with a live catalog from Banxa countries and payment methods. Quotes from `GET /v2/quotes/buy` with the Banxa blockchain code from the live crypto list, per-asset region rules and per-method limits. Orders with `POST /v2/buy` and a `REDIRECT` (or `IFRAME`) surface to the checkout. Status from `GET /v2/orders/{id}`. Webhooks verified with the Banxa HMAC key pair, with a replay key per order status. Built from the Banxa docs; some details are TO VERIFY.
