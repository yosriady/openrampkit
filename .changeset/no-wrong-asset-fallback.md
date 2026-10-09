---
'@openrampkit/adapter': minor
'@openrampkit/adapter-binance': patch
'@openrampkit/adapter-bridge': patch
'@openrampkit/adapter-coinbase': patch
'@openrampkit/adapter-meld': patch
'@openrampkit/adapter-moonpay': patch
'@openrampkit/adapter-onramper': patch
'@openrampkit/adapter-stripe': patch
'@openrampkit/adapter-swapped': patch
'@openrampkit/adapter-transak': patch
---

No silent fallback to the wrong asset. When the destination token is not one that the provider delivers, the onramp adapters (Binance, Coinbase, Meld, MoonPay, Onramper, Stripe, Swapped, Transak) now fail the quote with `NO_QUOTES`, and do not call the provider. Before, they quoted the first deliver asset (often USDC on Base). Bridge now checks the token too, not only the chain. New helpers in `@openrampkit/adapter`: `findDeliverAsset` (returns `undefined` on no match), `requireDeliverAsset` and `deliverableToAsset`.
