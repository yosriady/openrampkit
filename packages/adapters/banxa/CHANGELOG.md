# @openrampkit/adapter-banxa

## 0.1.0

### Minor Changes

- ff007ae: New adapter: Banxa, a direct fiat onramp through Banxa Hosted Checkout. One `fiat_onramp` leg per Banxa buy method (card, Apple Pay, Google Pay, SEPA, Faster Payments, PayID, NPP, iDEAL, Klarna, PayPal, Interac, SPEI, Khipu, South African bank transfer, VietQR, UPI), with a live catalog from Banxa countries and payment methods. Quotes from `GET /v2/quotes/buy` with the Banxa blockchain code from the live crypto list, per-asset region rules and per-method limits. Orders with `POST /v2/buy` and a `REDIRECT` (or `IFRAME`) surface to the checkout. Status from `GET /v2/orders/{id}`. Webhooks verified with the Banxa HMAC key pair, with a replay key per order status. Built from the Banxa docs; some details are TO VERIFY.

### Patch Changes

- Updated dependencies [138dc35]
- Updated dependencies [243bf9c]
- Updated dependencies [131dc8a]
- Updated dependencies [d6e1063]
- Updated dependencies [901ea9a]
- Updated dependencies [25b1f98]
- Updated dependencies [9a88cec]
- Updated dependencies [9a88cec]
- Updated dependencies [51167ad]
- Updated dependencies [51167ad]
- Updated dependencies [b770da7]
- Updated dependencies [59811bd]
- Updated dependencies [977c386]
- Updated dependencies [77f762d]
- Updated dependencies [c7f849c]
- Updated dependencies [230c5ad]
- Updated dependencies [3453854]
- Updated dependencies [9c135aa]
- Updated dependencies [7512a8e]
- Updated dependencies [521c893]
- Updated dependencies [8d66ab9]
- Updated dependencies [b763cf0]
- Updated dependencies [0672f15]
- Updated dependencies [e2e8337]
- Updated dependencies [6e7899b]
- Updated dependencies [127b79a]
- Updated dependencies [8a2ec99]
- Updated dependencies [635d8f9]
- Updated dependencies [0dfd32e]
- Updated dependencies [f4a89d0]
- Updated dependencies [e74d5e3]
- Updated dependencies [fb978b8]
- Updated dependencies [5997e23]
- Updated dependencies [c24a0f7]
- Updated dependencies [a999c0c]
- Updated dependencies [63f3db5]
- Updated dependencies [d4523b2]
- Updated dependencies [bf08445]
- Updated dependencies [66c8f1d]
- Updated dependencies [3b8e567]
- Updated dependencies [8ad4bd2]
- Updated dependencies [aad31d5]
- Updated dependencies [bab3381]
- Updated dependencies [5c5019e]
- Updated dependencies [2c1daa4]
- Updated dependencies [609b907]
- Updated dependencies [29dbf05]
- Updated dependencies [18da157]
  - @openrampkit/adapter@0.1.0
  - @openrampkit/core@0.1.0
