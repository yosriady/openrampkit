---
'@openrampkit/core': minor
'@openrampkit/adapter': minor
'@openrampkit/server': minor
'@openrampkit/adapter-binance': patch
'@openrampkit/adapter-bridge': patch
'@openrampkit/adapter-coinbase': patch
'@openrampkit/adapter-lifi': patch
'@openrampkit/adapter-meld': patch
'@openrampkit/adapter-moonpay': patch
'@openrampkit/adapter-onramper': patch
'@openrampkit/adapter-peer': patch
'@openrampkit/adapter-relay': patch
'@openrampkit/adapter-stripe': patch
'@openrampkit/adapter-swapped': patch
'@openrampkit/adapter-transak': patch
'@openrampkit/adapter-xendit': patch
---

Leg capabilities now hold only what the server reads: `LegCapability` is `'settlement' | 'surface_after_processing'`. The values `webhooks`, `polling`, `refunds`, `exact_output` and `saved_methods` are removed: nothing read them, and adapters declared them in different ways. How the server learns a leg result now comes from the adapter: `resultChannels(adapter)` in `@openrampkit/adapter` gives `polling` (the adapter has `status()`) and `webhooks` (it has a `webhook` whose new `configured` flag is not `false`). Binance, Bridge, Coinbase, Meld, MoonPay and Onramper set `configured` from their webhook secret. The server writes a warning at start for an adapter with legs that has neither. `checkAdapterShape` reports an unknown capability.
