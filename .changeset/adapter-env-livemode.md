---
'@openrampkit/adapter': minor
'@openrampkit/server': minor
'@openrampkit/adapter-binance': minor
'@openrampkit/adapter-bridge': minor
'@openrampkit/adapter-coinbase': minor
'@openrampkit/adapter-lifi': minor
'@openrampkit/adapter-meld': minor
'@openrampkit/adapter-mock': minor
'@openrampkit/adapter-moonpay': minor
'@openrampkit/adapter-onramper': minor
'@openrampkit/adapter-peer': minor
'@openrampkit/adapter-relay': minor
'@openrampkit/adapter-stripe': minor
'@openrampkit/adapter-swapped': minor
'@openrampkit/adapter-transak': minor
'@openrampkit/adapter-xendit': minor
---

One `env: 'sandbox' | 'production'` option for every adapter, checked against `livemode`. Each adapter now shows its environment as the read-only `adapter.env` (new `AdapterEnv` type). Transak takes `env: 'sandbox'` (was `'staging'`), Peer takes `env: 'production'` (was `'live'`), and Coinbase takes `env` (was `sandbox: boolean`). The old values still work, with a one-time deprecation warning. Stripe and Xendit read `env` from the key prefix, take an optional `env`, and throw when the two do not agree. Binance and LI.FI are always `production`. Relay is `sandbox` on the testnets host, and the mock adapter is `sandbox`. `createOpenRamp` now refuses to start with `livemode: true` and a `sandbox` adapter, and warns for a `production` adapter when `livemode` is false. New helpers: `resolveEnv` and `warnDeprecatedOnce`.
