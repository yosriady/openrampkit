---
'@openrampkit/server': minor
---

**Breaking.** The 0.1 data model (phase 1).

- A failed attempt is not a failed session. It sends `session.payment_failed`, sets `lastError` and goes back to `requires_payment_method`. `session.failed` is final: no attempts left (`policy.maxAttempts`, default 10), money arrived on a leg, or an operator resolve. Nothing follows it.
- New events `session.requires_action`, `session.processing`, `session.payment_failed` and `session.canceled`. The `withdrawal.*` events are removed.
- Webhooks follow Standard Webhooks. A `whsec_` secret is base64-decoded. New `generateWebhookSecret()` and `signWebhook()`. `verifyWebhook()` reads the new headers. The payload is a typed `WebhookEvent` with the backend `Session`; `sessions.retrieve()` and `sessions.refresh()` return it too. Every response has `openramp-version: 1`.
- `externalId` on create (unique per app; a repeat by the same user with the same input returns `{ id, expiresAt, existing: true }`, other repeats are `409 EXTERNAL_ID_CONFLICT`). `Idempotency-Key` on every POST, with a body hash (`422 IDEMPOTENCY_MISMATCH`). `POST /sessions/:id/cancel` and `sessions.cancel(id)`, only before money moved.
- Withdraw input `destination`, `lockDestination` and `allowedDestinations`. The old names are refused with a `400`.
- `SESSION_SCHEMA` is 2. `migrateRecord()` brings schema 1 records (old statuses, `Amount.amount`, old withdraw names) up to date on read.

Migration:

| Before | Now |
|---|---|
| `OrkError`, `OrkErrorCode`, `OrkException`, `orkError()`, `isOrkError()` | `OpenRampError`, `OpenRampErrorCode`, `OpenRampException`, `openRampError()`, `isOpenRampError()` |
| `OrkEvent`, `OrkEventType` | `WebhookEvent` (server to backend), `ClientEvent` (browser UI) |
| `Amount.amount` | `Amount.value` |
| Session status `open`, `awaiting_user`, `completed` | `requires_payment_method`, `requires_action`, `succeeded` |
| Leg status `awaiting_user` | `requires_action` |
| Event `session.completed` | `session.succeeded` |
| Events `withdrawal.completed`, `withdrawal.failed`, `withdrawal.reversed` | The `session.*` events (`data.object.session.direction` is `withdraw`) |
| Headers `openramp-id`, `openramp-timestamp`, `openramp-signature` (`v1=<hex>`) | `webhook-id`, `webhook-timestamp`, `webhook-signature` (`v1,<base64>`, Standard Webhooks) |
| Event `created` (Unix seconds), `data.object.userId`, `data.object.metadata` | `createdAt` (ISO 8601), `data.object.session.userId`, `data.object.session.metadata` |
| `target`, `lockTarget`, `allowedTargets`, `targetLocked` | `destination`, `lockDestination`, `allowedDestinations`, `destinationLocked` |
| `TARGET_NOT_ALLOWED`, `TARGET_LOCKED` | `DESTINATION_NOT_ALLOWED`, `DESTINATION_LOCKED` |

See the [0.1 data model record](https://github.com/yosriady/openrampkit/blob/main/docs/design/data-model-0.1.md).
