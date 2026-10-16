# PayTrie

`@openrampkit/adapter-paytrie` buys USDC with CAD by Interac e-Transfer, for users in Canada, through the [PayTrie](https://docs.paytrie.com/v2) Platform API v2. The purchase runs in your own UI: an email sign-in code, the PayTrie KYC page when the user needs it, then the Interac payment details. PayTrie shows only its sign-up page and its KYC page.

::: info New adapter, not yet verified
This adapter is built from the PayTrie v2 docs (16 Oct 2026). No live order has run through it yet, and PayTrie documents no sandbox. Some provider details are marked TO VERIFY in the source (listed below).
:::

```ts
import { paytrie } from '@openrampkit/adapter-paytrie'

paytrie({
  apiKey: process.env.PAYTRIE_API_KEY!,               // developer API key (x-api-key)
  webhookSecret: process.env.PAYTRIE_WEBHOOK_SECRET,  // from PUT /v2/webhook-configurations
  tokenKey: process.env.PAYTRIE_TOKEN_KEY,            // optional, 32+ characters
})
```

To get the keys, see [Get provider keys](../guide/provider-keys.md#paytrie).

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | required | The developer API key, sent as `x-api-key` on every call. Server-side only. |
| `webhookSecret` | `string` | none | The webhook signing secret (`whsec_...`). Without it, webhooks are rejected and the adapter relies on status checks. |
| `env` | `'sandbox' \| 'production'` | `'production'` | PayTrie documents only `https://api.paytrie.com`. `'sandbox'` needs `apiUrl` (a test host from PayTrie). The server checks `env` against `livemode`. |
| `apiUrl` | `string` | `https://api.paytrie.com` | Override the host |
| `tokenKey` | `string` | derived from `apiKey` | Secret for the key that encrypts the user's access token in the session store (at least 32 characters) |
| `requireSessionEmail` | `boolean` | `true` | Only the session's own `email` (set by your `authorize` hook) may sign in, and a session with no email cannot start this leg. With `false`, the user types an email, so any user can make PayTrie email a code to any address and guess codes for it (within the limits below). Keep `true` unless your app has no email for its users. |
| `deliverAssets` | `PaytrieDeliverAsset[]` | USDC on Base, Ethereum, Arbitrum, Optimism, Polygon, Solana | Tokens PayTrie may deliver, with the PayTrie label (for example `USDC-BASE`). A destination token that is not in the list gets no quote (`NO_QUOTES`). |
| `signupUrl` | `string` | `https://app.paytrie.com/SignupEmail` | The PayTrie sign-up page for users with no account |

## Leg

One `fiat_onramp` leg, `interac`: CAD in the user's bank account to USDC at an address.

- Country: `CA`. Currency: `CAD`.
- Limits: 10 to 9,999 CAD per transaction. The Platform API takes orders down to 10 CAD; the 9,999 CAD maximum is the documented default (`GET /v2/limits` can show more for some accounts). PayTrie also caps each user at 9,999 CAD per 24 hours and 3 open transactions; an order over those gets the PayTrie message.
- Surfaces: `FORM` (the email, when the session has none), `OTP` (the sign-in code), `REDIRECT` (the PayTrie sign-up and KYC pages), `BANK_FIELDS` (the Interac details).
- `requires: ['provider_account', 'provider_kyc', 'otp']`.

USDC labels from the Price Quotes page: `USDC-ETH`, `USDC-POLY`, `USDC-ARB`, `USDC-OP`, `USDC-BASE`, `USDC-AVAX`, `USDC-BSC`, `USDC-CELO`, `USDC-SOL`, `USDC-SX`. CADC has `CADC-ETH`, `CADC-POLY`, `CADC-ARB`, `CADC-BASE`, `CADC-SOL`. The defaults cover the chains that OpenRampKit routes; add others with `deliverAssets`.

## Flow

| Stage | PayTrie call | Step |
|---|---|---|
| Email | none | `requires_action`, `auth`, `FORM` with an `email` field, transition `submit_email`. Only with `requireSessionEmail: false` and a session with no email. A session email is always used and locked. |
| Account | `GET /v2/users?email=` | No account: `requires_action`, `auth`, `REDIRECT` to the PayTrie sign-up page, transition `signed_up` (checks again) |
| Sign-in | `POST /v2/auth/login-codes` | `requires_action`, `auth`, `OTP` (`channel: 'email'`, the email masked), transitions `submit_code` (input `code`, 4 digits) and `resend_code` |
| Code | `POST /v2/auth/login-codes/verify` | The access token (1 hour) is sealed in the session store. It never goes to the client. |
| KYC | `GET /v2/users/{id}`, `GET /v2/users/{id}/kyc-url` | Not verified: `requires_action`, `kyc`, `REDIRECT` to the PayTrie KYC page (Sumsub), transitions `kyc_done` and an AWAIT poll. In review: `processing`, phase `kyc`. Rejected: `failed`, `KYC_REJECTED`. |
| Order | `POST /v2/transactions` | `requires_action`, `payment`, `BANK_FIELDS`: the amount in CAD, the Interac reference (`rmtId`) and how to pay; an AWAIT poll |
| Result | `GET /v2/transactions/{id}`, webhook | See the status table |

- The order has `leftSideLabel: 'CAD'`, `leftSideValue` (the quote input), `rightSideLabel` (the token label), `wallet` (`deliverTo`, or the session destination), `quoteId` (when the quote is less than 9 minutes old; PayTrie honours it for about 10) and `externalSessionId` (the leg ref, `ptr_{random}`).
- The answer must name the same wallet, token and amount. Otherwise the adapter cancels the order (`PUT /v2/transactions/{id}/cancel`) and the leg fails with `contact_support`.
- When the access token expires before the order (for example during KYC), the leg asks the user for a new code (`FORM` with no fields and a `send_code` transition). A status poll never emails a code by itself.
- A buy expires when the Interac payment has not arrived within 1 hour.

## Quotes

- `GET /v2/quotes?leftSideLabel=CAD&leftSideValue=...&rightSideLabel=USDC-BASE` (or `rightSideValue` for an exact output), with `x-api-key`.
- Fees, in CAD, `included: true`: the PayTrie fee (`breakdown.paytrieFee`, `provider`) and the network fee (`breakdown.gasFee`, `network`).
- The guarantee is `estimate`: the order is made after the sign-in (and maybe KYC), when the quote id may be stale and PayTrie uses its latest rate. The quote expires after 5 minutes.
- Amounts outside 10 to 9,999 CAD get `AMOUNT_TOO_LOW` or `AMOUNT_TOO_HIGH` before the call.

## Status

`status()` reads `GET /v2/transactions/{id}` with the user's access token. Without a token (after 1 hour), it reads only when PayTrie lists `apiKey` in the user's `accessibleBy` (an integration that PayTrie approved); else the leg waits for the webhook.

| PayTrie status | Leg | Detail code |
|---|---|---|
| `awaiting-fiat` | `requires_action` (the user pays by Interac) | `bank_details` |
| `processing-fiat` | `processing` | `processing` |
| `finalizing-fiat` | `processing` | `settling` |
| `sending-crypto` | `processing` | `confirming` |
| `complete` | `succeeded`, with `rightSideValue` as the output, and `paymentId` as the `destination` transaction when it is a chain hash | |
| `cancelled` | `failed`, `PROVIDER_DECLINED` (recovery `contact_support`) | |
| `expired` | `expired` | |
| `expired-contact-support` | `failed`, `PAYMENT_FAILED` (recovery `contact_support`): the payment came after the order expired | |
| `refunded` | `refunded` | |
| `replaced` | `failed`, `PROVIDER_DECLINED` (recovery `contact_support`) | |
| other (for example the sell statuses) | no event: the adapter logs the unknown status once, and the leg keeps its current step | |

- Only `complete` is a success, and only when the transaction names the leg's wallet and token.
- The raw PayTrie status goes to `detail.providerStatus`.

## Webhooks

Register `{baseUrl}/webhooks/paytrie` with `PUT /v2/webhook-configurations` and pass the returned `signingSecret` as `webhookSecret` (see [Get provider keys](../guide/provider-keys.md#paytrie)).

- Verification: `X-Paytrie-Signature: v1=<hex>` is the HMAC-SHA256, with the signing secret, of `{X-Paytrie-Timestamp}.{raw body}`. The timestamp must be within 5 minutes. The compare is constant time. A signature without `v1=` never verifies.
- Replay key and event id: the envelope `id` (`paytrie:{id}`); `eventId` when there is no `id`; else the SHA-256 of the body.
- Events: `transaction.update` only, with the status table above. `user.update` gives no event: `status()` reads the user while the leg waits for KYC.
- Binding: the adapter writes its own index (`ptx:{transaction id}`, 30 days) when it creates the order, and a webhook finds its leg only through that index. `externalSessionId` alone never routes an event, because a PayTrie widget URL can carry any value. When both exist, they must agree, and the wallet and token must match the index.
- PayTrie sends each webhook once and does not retry. Keep the endpoint up; status checks cover the first hour.

## Errors

| PayTrie answer | OpenRampKit error |
|---|---|
| Quote `400` or `422` | `NO_QUOTES` with the PayTrie message |
| Order `400` or `422` (a limit, an open transaction count) | `PROVIDER_DECLINED` with the PayTrie message (recovery `requote`); the user may try again |
| Order timeout or `5xx` | The leg fails with `contact_support`; the adapter never creates a second order for the leg |
| Wrong sign-in code | `BAD_REQUEST`. Over a limit (below): `RATE_LIMITED` |
| `401` on a call with the user token | Before the order: the leg asks for a new sign-in code. After the order: the leg waits for the webhook. |
| `401` or `403` on a call with only the API key | `PROVIDER_UNAVAILABLE`, not retryable, with an operator log |
| `429` | `RATE_LIMITED` |
| other `5xx`, network error, timeout | `PROVIDER_UNAVAILABLE` (retryable) |

## Security

- The wallet is set by the server at start (`deliverTo` or the session destination). No client input can change it, nor the token or the amount.
- A session email is locked. A typed email is locked after the code check. The access token is sealed with AES-256-GCM, bound to the session, the app user, the leg and the email, and dropped when the leg ends or is canceled.
- Sign-in code limits. A code has 4 digits, so the adapter limits tries and emails across all sessions, in the adapter's shared store (`PAYTRIE_LIMITS`):

  | Limit | Value |
  |---|---|
  | Code checks per email (trimmed, lowercase), wrong or right | 5 per 15 minutes; a right code gives its try back |
  | Code checks per app user | 10 per 15 minutes |
  | Code emails per email | 5 per hour |
  | Code emails per app user | 10 per hour |
  | Account lookups per app user | 20 per hour |
  | Per leg | 5 wrong codes per code, 3 codes |

  Each check and each email takes one slot, an atomic claim with a TTL, before the PayTrie call, so requests at the same time never pass together. When the email limit is hit, the email is locked: a code sent before the lock never counts again, and the user needs a new code after the window. A new code does not reset the tries of the email. The shared store keeps the SHA-256 of the email, never the email. On a store with no atomic `putIfAbsent` (Workers KV), a claim writes and reads back, which catches most races but not all.
- A code works only on the leg that sent it: the leg record names its session, app user and email, and the token is bound to them.
- Each change of a leg runs under a lease (`claimOnce`), and the order creation has its own claim, so two requests never create two orders.
- Each leg record names its session and app user; another session gets `SESSION_EXPIRED`.
- With `requireSessionEmail: false`, a user who types an email learns whether PayTrie has an account for it (the sign-up step), and can make PayTrie email codes to it (within the limits). The default (`true`) allows only the email that your `authorize` hook sets. Do not copy an email from the browser into the session unless you verified it.

## Verified vs TO VERIFY

Verified from the PayTrie v2 docs (16 Oct 2026), not yet against a live account:

- The base URL, `x-api-key` auth, the login code flow and the JWT (1 hour), and the endpoints and fields of users, KYC URL, quotes, transactions and cancel.
- The transaction statuses, the user statuses, the limits and expiry, and the token labels.
- The webhook envelope, payload, headers, signature and timestamp advice, and that webhooks are not retried.

TO VERIFY (marked in the source):

- How the user pays: we read `rmtId` (v1 called the status "pending request money transfer") as an Interac request that PayTrie sends to the user's email. The payment details say so.
- That `gasFee` is in CAD (the docs example adds up only that way).
- The HTTP status of a wrong sign-in code (we read 400, 401, 403, 404 and 422 as wrong).
- Whether user status `active` means "no KYC yet".
- What `replaced` means for the leg.
- Whether the transaction webhook uses `id` or `eventId` (the docs show both).
- That `GET /v2/webhook-configurations` answers `404` before a URL is set (`health()` reads it as a working key).
- The Interac delivery time (`eta`).

Before the TO VERIFY marks go: one live order to `complete`, with webhooks and status checks, recorded as test fixtures.
