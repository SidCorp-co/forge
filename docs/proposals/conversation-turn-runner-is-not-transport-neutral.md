# The turn runner is neutral; four steps of the second adapter are not built

Status: step 1 of five landed on ISS-1002. Steps 2 to 5 are not implemented. Verified against the
tree 2026-09-14.

## What is landed, and how it is held

ISS-1001 extracted the conversation store out of the first adapter: `conversations`,
`conversation_participants` and `conversation_messages`, keyed by `(adapter, external_id)`, with
scope derived per read from handle memberships. It also declared what a transport must supply, as
four ports in `packages/core/src/conversations/ports.ts` — `resolveVenue`, `resolveSpeaker`,
`deliver`, `fetchHistory`.

ISS-1002 landed the thing that calls them. `packages/core/src/conversations/turn-runner.ts` opens
the venue, runs the model turn, screens the reply at the door the caller named, delivers through the
registered transport's `deliver`, and records what the venue was shown. The screening decision is
the runner's: a caller names a door, and the door's row in `packages/core/src/messaging/doors.ts`
carries the audience, the intent and the repair budget, so no adapter names a cell of its own.

`packages/core/src/conversations/transport-free.test.ts` holds both directions. No store module
names a transport, and **no file under `packages/core/src/integrations/` imports the store** — the
count that was three named Rocket.Chat files is zero, and the only conversation modules an adapter
may import are the ports, the turn and the transcript door.

## What is not built

The four steps ISS-1002 names after the first, in the order it gives, each the precondition of the
next:

1. **The collector window as rows.** It still lives in a process, so a window is lost on restart and
   the messages inside it are never routed — a silence with nobody to notice it. This is a migration
   and a change of behaviour, not a move.
2. **The proactivity guards**, derived from the message log rather than stored, and denominated in
   concurrency as well as in money: one handle in forty rooms can be reasonable in every room and
   unaffordable in total, and one busy room can exhaust the single provider login a box holds.
3. **Removing the @-mention gate.** It may not go before the guards that replace it exist, and it
   has to be argued as a replacement rather than added beside one.
4. **The Forge UI as the second adapter**, replacing the Conversations screen's use of session rows
   as conversations. That is the proof of the whole extraction: four functions, and no turn.

Two defects belong with steps 2 and 3 rather than to any of them alone: a loop breaker that counts
hops kills the feature's own purpose (cut on hops that introduce no new identifier), and a send into
an agent holding no job row is unaudited — the surface carrying content from one project into an
action under another's authority is the one with no record.

## What this deliberately gave up, and the price of it

Delivery now resolves its own credential from the venue, because the venue is all a neutral runner
holds. On the first adapter that means a reply is posted by whichever active connection binds the
room under this conversation's project, rather than by the socket the message arrived on. The
project-ownership guard is unchanged and is now a property of the door rather than a step each
caller remembers. The affinity is gone: where two connections on one server both bind one room under
one project, the answering bot can change between replies. The pick is ordered and logged so it at
least cannot change for no reason; carrying the connection into the venue would put a transport's
identifier inside the store, which is the thing the extraction exists to prevent.

## Honest costs

| Cost | What it takes from whoever picks this up |
|---|---|
| A migration, not a move | Step 1 was a move and added no schema. The collector window is rows, and a window half-written when a core restarts has to be claimable by exactly one core afterwards — which is a claim protocol to design, not a table to add. |
| A guard nobody can read the state of | The guards must be derived from the message log and never stored, because a stored counter makes "a human spoke, so proactivity resumes" a write that can be missed, leaving a room muted with no readable cause. Deriving it on every decision costs a query per turn, and that is the price of the property. |
| Removing a gate that currently bounds the bill | The @-mention requirement is what keeps cost and noise in a group room bounded today. It may only be removed by the change that lands its replacement, so steps 3 and 4 are one landing or none. |
| Paid on arrival, still | Nothing breaks while there is one adapter. The bill falls due when the second one arrives — and step 1 means it is now four functions rather than four functions plus a copy of the turn path. |
