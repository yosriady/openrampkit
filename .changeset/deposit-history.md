---
"@openrampkit/core": minor
"@openrampkit/server": minor
"@openrampkit/client": minor
"@openrampkit/web": minor
---

History in the widget. With the server option `history: true`, the server keeps one index of sessions per user, and `GET /sessions/:id/history` lists the past sessions of the session's user (newest first, at most 50): kind (`session` or `standing`), direction, status, amount, destination asset, and the delivery transaction with its explorer link. No secret, user id, IP, provider id or address. A pay link gets `403`. `client.history()`, `controller.openHistory()` and `snapshot.history`. The widget shows a History link only when the route answers, and a list with status badges, relative dates and explorer links. New type `HistoryItem` in core.
