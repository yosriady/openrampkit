---
'@openrampkit/adapter': minor
---

**Breaking.** The renames of the 0.1 data model reach the adapter contract: `LegStep.status` and `LegEvent.status` use `requires_action` (was `awaiting_user`), every `Amount` is `{ value, asset }`, and errors are `OpenRampException` and `openRampError()`. New optional `Adapter.cancel({ leg, ref }, ctx)`: the server calls it to void a provider order when a session is canceled. `ADAPTER_API_VERSION` does not change in this release.

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
