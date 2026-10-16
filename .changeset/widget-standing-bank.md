---
"@openrampkit/core": minor
"@openrampkit/adapter": minor
"@openrampkit/server": minor
"@openrampkit/client": minor
"@openrampkit/web": minor
"@openrampkit/adapter-bridge": minor
"@openrampkit/adapter-mock": minor
---

The widget shows standing bank accounts. With `depositAddresses.widget` and an adapter that gives standing bank accounts and lists their currencies (new optional `Adapter.standingCurrencies`; Bridge with `standing: true` sets it), the "Your deposit address" screen has "Crypto" and "Bank account" tabs. The bank tab shows every bank field, with a copy button where the provider allows one. `POST /sessions/:id/deposit-address` takes `{ currency }`: the browser picks only a currency that the adapter lists, and the server sets the user, the destination and the adapter. The method has `standingOrigins: { crypto, currencies }`. The client's `DepositAddressView` can have a fiat origin and `bank`, and the controller has `depositCurrency`, `setDepositCurrency()`, `depositCurrencies()` and `depositCrypto()`. New strings in all six locales. The mock adapter has a `standingBank` option.
