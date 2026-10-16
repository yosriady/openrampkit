# History

The widget can show the user's past deposits and withdrawals: the status, the amount, the date and a link to the block explorer. Users check here that a deposit arrived, without a support ticket.

## Turn it on

```ts
const openramp = createOpenRamp({
  // ...
  history: true,
})
```

The option is off by default. With it on:

- The server keeps one index of sessions per user, from the time you turn it on. Sessions made before that do not show.
- `GET /sessions/:id/history` answers with the user's past sessions (see the [HTTP API](../api/http.md#get-sessions-id-history)).
- The widget shows a History link on the methods screen, and on the withdraw "To wallet" form.

With the option off, the route answers `404`, and the widget hides the link. You do not change the client code.

The index needs a store queue with `range`. All built-in stores have it. A custom store without it gets `501` on the route.

## What the user sees

Each row shows:

- the kind: "Deposit", "Withdrawal", or "Deposit to your address" for a deposit to the user's [standing deposit address](./deposit-addresses.md),
- the amount the user paid in, and the asset that arrives ("USDC on Base"),
- the date, relative ("5 minutes ago") for the last 30 days, else the day,
- a status badge: Complete, In progress, Waiting, Not paid, Failed, Canceled, Expired, Refunded or Reversed,
- "View transaction", when the server knows the delivery transaction and the chain has an explorer in the trusted chain table.

The list has the newest sessions first, at most 50. A session where no payment started (the user opened the widget and left) is left out. With no past session, the screen says "No deposits or withdrawals yet." Back returns to the screen before.
## Privacy

The browser holds the client secret of one session. The route uses it to find the session's user, and lists that user's sessions only. Each item is a small view:

- the session id, kind, direction, status and creation time,
- the amount, and the chain and token (or the currency) of the destination,
- the delivery transaction hash and its explorer link.

An item never has a client secret, the user id, the IP, provider ids or references, or an address. A pay link cannot read the history (`403`): you can send a pay link to another person, so it shows only its own session.

## Headless

`client.history(secret)` returns the list. The controller loads it at start into `snapshot.history` (undefined when the server answers `404`), and `controller.openHistory()` shows the `history` screen. See [@openrampkit/client](../api/client.md).
