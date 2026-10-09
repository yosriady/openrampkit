---
'@openrampkit/adapter': minor
'@openrampkit/adapter-binance': patch
'@openrampkit/adapter-bridge': patch
'@openrampkit/adapter-onramper': patch
---

New helpers in `@openrampkit/adapter`: `rsaVerify(publicKey, data, signatureB64)` (RSASSA-PKCS1-v1_5 with SHA-256; the key as PEM, base64 or `CryptoKey`), `importRsaPublicKey`, `rsaKeyDer`, `bytesToHex`, `base64ToBytes` and `bytesToBase64`. The Binance and Bridge adapters use the shared RSA check, and Onramper uses the shared hex and base64 helpers. Binance keeps its request signing. `importBridgePublicKey` now gives a clear error for a PKCS#1 PEM (`RSA PUBLIC KEY`); it still refuses such a key.
