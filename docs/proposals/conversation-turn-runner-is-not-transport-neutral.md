# The turn runner is still Rocket.Chat's, so a second adapter is not four functions

Status: not implemented. Verified against the tree 2026-09-14, at `3e8faa1a`.

## What ISS-1001 landed, and the half it did not

ISS-1001 extracted the conversation store out of Rocket.Chat. `chat_sessions` — one project column
and one JSON blob rewritten whole each turn — became `conversations`, `conversation_participants`
and `conversation_messages`, keyed by `(adapter, external_id)` with no project column at all: scope
is derived per read from handle memberships, and an empty scope is refused rather than granted.

It also declared what the store asks of an adapter, as four ports in
`packages/core/src/conversations/ports.ts`:

- `resolveVenue` — which conversation a transport's room is
- `resolveSpeaker` — who a transport's speaker is, as a Forge principal
- `deliver` — the one outbound door
- `fetchHistory` — the transcript an adapter can read back

`packages/core/src/integrations/rocketchat/conversation-port.ts` implements all four, and
`packages/core/src/conversations/transport-free.test.ts` holds the store to its side of the deal in
both directions: no file under `src/conversations/` names a transport, and none imports from
`src/integrations/`.

**What did not land is the other side.** Rocket.Chat's own runtime does not go through those four
ports — `connection-manager.ts` calls `openConversation` and `recordDelivery` directly, because
there is no transport-neutral thing to call. The ports describe the adapter's obligations; they are
not yet the store's API, and nothing today consumes `deliver` or `fetchHistory` at runtime
(`registerConversationTransport` is their only caller).

So a second adapter is not four functions yet. It is four functions **plus** a copy of the turn
path that lives inside `integrations/rocketchat/` today.

## Why this file exists

ISS-1001's acceptance criterion 35 said *"Rocket.Chat reaches the conversation store only through
the four adapter ports."* That is this document's subject, and the criterion was recorded as a
**FAIL** on that issue rather than reworded to something the change satisfies. A reviewer asked for
a neutral `conversations/dispatch.ts` in that issue and the ask was refused there as a second
issue's work inside one — correctly, but a refusal is not a plan, so the residual is written down
here instead of living only in a closed issue's comment thread.

## What the work is

A turn runner that takes a resolved venue, a resolved speaker and a message, and drives the store
without naming a transport — the piece `connection-manager.ts` currently is for one adapter. The
Rocket.Chat runtime then becomes a caller of it rather than a second implementation of it, and
`transport-free.test.ts` can be tightened from *"the Rocket.Chat tree reaches the store from
exactly three runtime files"* to *"no adapter tree reaches the store at all"*, which is what
criterion 35 was trying to say.

Two things to settle before it is written:

1. **Where the screening decision sits.** `reply-verdict.ts` holds the screen-and-retry decision
   today, one level above the connection manager. Whether that is the runner's or stays the
   adapter's is the first question, and it is entangled with ISS-997, which puts an
   audience-by-intent rule on the outbound path.
2. **What the collector window becomes.** ISS-1001's plan named the collector window as
   deliberately unchanged — it is still an in-process concern. A transport-neutral runner is the
   natural place for it to become rows, and that is a change of behaviour, not a move.

## What is NOT proposed here

Changing the store, the schema, the migration, or the four ports. Those landed and are measured.
This is about who calls them.

## Honest costs

| Cost | What it takes from whoever adopts this |
|---|---|
| A second rewrite of a just-rewritten path | The turn path in `integrations/rocketchat/` was reworked across seventeen commits for the store extraction — venue door, authority check, record modes, the rebound-room pair. Extracting a runner moves that code again: a second review of ground reviewed four times, and every test that reaches it by mocking `connection-manager.js` rewritten with it. |
| A collision with ISS-997 by construction | The screening decision is the first thing a runner must claim or decline, and ISS-997 puts an audience-by-intent rule on that same outbound path. Sequenced either way, one run rebases onto the other's rewrite; done at once they are one larger issue, not two. |
| An unanswered schema question | ISS-1001's plan left the collector window in-process. A neutral runner is the natural place for it to become rows — which is a migration and a behaviour change, so this cannot be costed as a pure move until that is decided. |
| Paid on arrival, not now | Nothing breaks if this is never done: one adapter works, and the store is already held transport-free in both directions by a gate. The price falls due only when a second adapter arrives, and it is paid then as a copy of the turn path instead of four functions — which is the whole of what criterion 35 recorded as failing. |
