---
'@openrampkit/svelte': minor
---

**Breaking.** `onEvent` takes a typed `ClientEvent` (was `OrkEvent`), with an ISO `createdAt`. The package exports `ClientEvent` and `OpenRampError` (was `OrkEvent` and `OrkError`).

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
