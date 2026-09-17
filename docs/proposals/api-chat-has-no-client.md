# `POST /api/chat` is mounted, answers, and has no client

**Status: OPEN, on a narrower question than it was filed with. Measured by ISS-1005 (2026-09-14) at
`483ff67e`, recorded rather than acted on because removing an SSE surface is a product decision and
there is nothing to prove the removal against. The product decision was taken on 2026-09-17 and went
the other way from this route — see *The condition that ends this*. What is left is the diff.**

## What was measured

`assistant/routes.ts` mounts `POST /api/chat` behind the `chatProvider` feature flag, which
`lib/feature-flags.ts` defaults to `true`. The route authenticates, resolves the project's provider,
opens a `web` venue on the durable conversation store, builds the project toolset and streams the
turn back over SSE through `run-turn.ts`.

Nothing calls it.

| Where a caller would be | What is there |
|---|---|
| `packages/web-v2` | `/chat-logs` only, which backs the Activity feed. No request to `/chat` |
| `packages/runner` (Rust) | nothing |
| The `forge` CLI | nothing |
| `packages/core` itself | `conversations/turn-runner.ts` and `integrations/rocketchat/escalation-bridge.ts` call `runExternalChatTurn`, which is `external-chat.ts` — the same resolution, drained to one reply. Neither goes through the route |

The browser's own chat does not use it either. ISS-1004 step 5 pointed the Forge UI at
`POST /api/conversations/:id/messages`, which collects the message into the durable log, opens a
collector window and routes it through `runConversationTurn`. That path answers inline and records
a decision; `/api/chat` streams and records none.

## Why this is not simply deleted

Three reasons, and the first is the only one that is about the code.

1. ~~**It is the only streaming surface.**~~ **Spent, 2026-09-17 (ISS-1078).** It was the only one:
   the conversation path answers in one HTTP response, by design — `conversation-routes.ts` states
   why, and it is the right call for a caller that must be able to tell a delivered answer from a
   lost one — and a caret that moves while the model thinks was a property somebody might want back.
   Somebody did. It was built on the WebSocket instead, so this is no longer a reason to keep the
   route.
2. **There is nothing to prove a removal against.** No client means no regression test can show the
   removal is safe and none can show it is not. That is an argument for a decision, not for a diff.
3. **ISS-1005 was instructed to correct an annotation inside that file**, which presumes the file
   survives the issue that found this.

## What it costs to leave

Two live answerers on one store. Each has its own toolset construction and its own venue opening,
and only one of them is reached. A change to the fenced toolset, the provider resolution or the
venue rules has two sites, and a reader cannot tell from either which one runs. That is the same
shape ISS-1005 exists to collapse, one level down.

**The persona half of this is paid.** ISS-1007 moved `webConversationPersona` into
`assistant/door-persona.ts` and pointed both web doors at it, so the two surfaces no longer assemble
two voices — `/api/chat` also stopped answering on the one-line fallback it had been running on.
What remains is the toolset construction, the venue opening and the provider resolution, and the
decision below is still owed.

## Honest costs

The price of deciding either way, not the price of the drift.

| Cost | What it takes |
|---|---|
| Keeping it, and giving the conversation route a streaming sibling | Two surfaces stay, and the second grows: the send route answers inline today because that is what lets a caller tell a delivered answer from a lost one, and a streaming reply cannot. Every one of the three "no answer yet" states on screen has to be right before a 202-and-a-push is safe, which is the same bill ISS-1039 paid for a diverted turn: Agent mode answers 202 and pushes, and it ships with a named entry for dispatched, running, delivered and failed alike |
| Removing it | `assistant/routes.ts`, `run-turn.ts` and the `chatProvider` flag go together, and `run-turn.ts` is the only SSE turn loop in the codebase — there is no second copy to reach for if streaming is wanted later. `external-chat.ts` keeps the provider resolution the two live callers use, so the resolution itself is not lost. `routes.test.ts` goes with the route, and with it the only test that exercises the flag |
| Leaving it as it is | The drift above: two constructions of the fenced toolset, two venue openings, and a reader who cannot tell which one runs. Every change to either pays twice or silently pays once. The third, the persona, is no longer on this list — ISS-1007 collapsed it |

## The condition that ends this

**Half answered, 2026-09-17 (ISS-1078).** The owner decided the Forge UI's chat should stream — and
decided it streams over the WebSocket, not over this route. ISS-1030 had already recorded why: a
per-request stream cannot reach someone who did not make the request, and a room has more than one
reader. So the conversation route grew a streaming sibling that is not an HTTP response at all:
`POST /api/conversations/:id/messages` still answers inline, and the turn is published to every
reader of the room as `conversation.progress` frames from
`packages/core/src/assistant/conversation-progress.ts`.

What that settles, and what it leaves:

- **The product question is closed.** Streaming is wanted, and it is shipped. The first argument for
  keeping this route — "it is the only streaming surface, and a caret that moves is a property
  somebody may want back" — no longer holds: the caret moves, and `run-turn.ts` is not what moves
  it.
- **ISS-1078 did NOT make this route reachable.** It has no client today for the same reason it had
  none on 2026-09-14. The drift under *What it costs to leave* is unchanged and now buys nothing.
- **What is still owed is one decision and one diff**: remove the route, `run-turn.ts` and the
  `chatProvider` flag together, or name a caller for them. `external-chat.ts` keeps the provider
  resolution the live callers use, and `createTranscriptAccumulator` — the piece of `run-turn.ts`
  worth keeping — is already shared with the socket path rather than copied, so a removal no longer
  takes the canonical-entry derive with it.
