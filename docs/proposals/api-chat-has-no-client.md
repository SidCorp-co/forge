# `POST /api/chat` is mounted, answers, and has no client

**Status: OPEN. Measured by ISS-1005 (2026-09-14) at `483ff67e`, recorded rather than acted on
because removing an SSE surface is a product decision and there is nothing to prove the removal
against.**

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

1. **It is the only streaming surface.** The conversation path answers in one HTTP response, by
   design — `conversation-routes.ts` states why, and it is the right call for a caller that must be
   able to tell a delivered answer from a lost one. But a caret that moves while the model thinks is
   a product property somebody may want back, and `run-turn.ts` is where it lives.
2. **There is nothing to prove a removal against.** No client means no regression test can show the
   removal is safe and none can show it is not. That is an argument for a decision, not for a diff.
3. **ISS-1005 was instructed to correct an annotation inside that file**, which presumes the file
   survives the issue that found this.

## What it costs to leave

Two live answerers on one store. Each has its own toolset construction, its own venue opening, its
own persona assembly, and only one of them is reached. A change to the fenced toolset, the provider
resolution or the venue rules has two sites, and a reader cannot tell from either which one runs.
That is the same shape ISS-1005 exists to collapse, one level down.

## Honest costs

The price of deciding either way, not the price of the drift.

| Cost | What it takes |
|---|---|
| Keeping it, and giving the conversation route a streaming sibling | Two surfaces stay, and the second grows: the send route answers inline today because that is what lets a caller tell a delivered answer from a lost one, and a streaming reply cannot. Every one of the three "no answer yet" states on screen has to be right before a 202-and-a-push is safe, which is the same bill `the-forge-ui-conversation-cannot-reach-a-runner.md` prices for a diverted turn |
| Removing it | `assistant/routes.ts`, `run-turn.ts` and the `chatProvider` flag go together, and `run-turn.ts` is the only SSE turn loop in the codebase — there is no second copy to reach for if streaming is wanted later. `external-chat.ts` keeps the provider resolution the two live callers use, so the resolution itself is not lost. `routes.test.ts` goes with the route, and with it the only test that exercises the flag |
| Leaving it as it is | The drift above: two constructions of the fenced toolset, two venue openings, two persona assemblies, and a reader who cannot tell which one runs. Every change to any of the three pays twice or silently pays once |

## The condition that ends this

Somebody decides whether the Forge UI's chat should stream. If yes, `/api/chat` is the surface to
reach for and the conversation route grows a streaming sibling. If no, the route, `run-turn.ts` and
the `chatProvider` flag go together in one change, and `external-chat.ts` keeps the resolution the
two live callers actually use.
