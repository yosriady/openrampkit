---
'@openrampkit/server': minor
---

Stored session records now have a `schema` field (`SESSION_SCHEMA`, now 1), apart from the optimistic-lock `version`. The server runs the new `migrateRecord()` on every store read: a record written before this change (no `schema`) gets `updatedAt`, attempt numbers (`ActivePayment.n`) and empty lists filled in, and keeps working. New exports: `SESSION_SCHEMA`, `migrateRecord` and `migratingStore`. Custom stores need no change.
