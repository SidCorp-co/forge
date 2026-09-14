# The Forge UI is not the second adapter, and the store it would read has no send

Status: ISS-1002 step 1 landed on ISS-1002; steps 2, 3 and 4 landed on ISS-1004. **Step 5 is not
implemented.** Verified against the tree 2026-09-14.

## What is landed

- **The store** (ISS-1001): `conversations`, `conversation_participants`, `conversation_messages`,
  keyed by `(adapter, external_id)`, scope derived per read from handle memberships, and the four
  ports a transport must supply in `packages/core/src/conversations/ports.ts`.
- **The turn** (ISS-1002): `packages/core/src/conversations/turn-runner.ts` opens the venue, runs the
  model, screens the reply at the door the caller named, delivers through the registered transport
  and records what the venue was shown.
- **The collector, the guards and the end of the @-mention gate** (ISS-1004):
  `conversations/windows.ts` (the window row, the claim, the lease, the delivery key),
  `collect-inbound.ts`, `proactivity.ts`, `route-window.ts`. A message in a bound Rocket.Chat room is
  collected rather than gated, and nothing in the tree decides whether a turn runs by looking for the
  bot's name.

## What is not built: step 5, the Forge UI as the second adapter

`packages/core/src/assistant/conversation-routes.ts` serves `/api/conversations` — list, read,
rename, delete. It has **no send**, no `web` transport is registered against
`registerConversationTransport`, and **web-v2 calls none of it**: the Conversations screen
(`packages/web-v2/src/features/conversations/`), the chat surface
(`features/session/components/chat-screen.tsx`) and its three mounts — the workspace layout overlay,
the chat dock, and the conversations split view — all read `agent_sessions` rows. Two paths are still
live: the one people use, which has none of the store, and the one the store has, which nobody uses.

That is the whole of what ISS-1004's second condition is still open on.

## Why it was left whole rather than half-landed

`ChatScreen` carries model pick, runner pick, invokable skills, the reader's working lenses, fork,
rerun, per-turn edit and regenerate. `conversation_messages` holds a role, a body, image references,
a delivery proof and a silence reason — none of the rest. Porting the screen is therefore a product
decision about which of those affordances are *conversation* and which are *run telemetry* that
belongs on the session surface, and neither half of that question is answerable by the diff that
moves the reads.

Half-porting it would have been the worse outcome in both directions: a second conversation UI beside
the first is the two live paths this work exists to remove, and building the `web` transport with no
screen reading it is an endpoint nobody calls — which is the same defect wearing the other face.

## Honest costs, for whoever picks it up

| Cost | What it takes |
|---|---|
| A product decision before a line of code | Which of fork, rerun, regenerate, per-turn edit, model pick and runner pick survive on a conversation, and which move to the session surface. A port that silently drops one is a regression nobody wrote down. |
| Four functions, and this time they are real | `resolveVenue`, `resolveSpeaker`, `deliver`, `fetchHistory` for `web`. `deliver` has no socket to post to: the durable row IS the delivery, and the receipt has to be something a reader can trust — a WebSocket broadcast proof, not a shrug. |
| A send endpoint | `POST /api/conversations/:id/messages`, running the neutral turn under the caller's own authority. The read routes already exist and already derive scope. |
| The old path leaves with it | `agent_sessions` keeps every run-shaped verb it has; what it loses is being the thing a person's chat is stored in. A change that adds the new reads and leaves the old ones is the defect, not the milestone. |
