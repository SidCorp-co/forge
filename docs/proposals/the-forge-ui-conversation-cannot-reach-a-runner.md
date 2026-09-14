# The Forge UI conversation cannot reach a runner, and a chat that could is what it replaced

**Status: OPEN, and SETTLED as accepted. Named by ISS-1004 step 5 (2026-09-14), which landed the
port and states this loss rather than leaving it to be discovered. ISS-1005 was required to settle
it as one of two things — accepted and named, or a way to reach a runner designed — and took the
first, on the record, for the reason in "What ISS-1005 settled" below. This document stays open
because the fix is still the fix; what closed is the question of whether ISS-1005 would build it.**

## What changed

Until ISS-1004 step 5, the Forge UI's chat was an `agent_sessions` row dispatched to a runner box:
a Claude Code session with the project's repository checked out, a shell, a model-tier pick, a
runner pick, invokable skills, attachments, and per-turn fork, rerun, edit and regenerate.

It is now a conversation. `POST /api/conversations/:id/messages` collects the message into
`conversation_messages`, opens or extends its collector window, and runs one neutral turn — the same
in-core provider turn Rocket.Chat's `fast` answer mode takes — under a fenced project toolset.

That toolset is **not read-only**, and this document said it was until ISS-1005 measured it.
`CHAT_TOOL_ALLOWLIST` permits `forge_issues` create and update and `forge_comments` create, fenced
by `guardIssueWrites`: a created issue is forced to `draft` so it cannot auto-triage and spawn a run,
`data.relations` is refused outright, and an update may only reach
`draft`/`waiting`/`needs_info`/`on_hold`/`closed`. So what the chat surface lost is not the ability
to file or to comment — it already does both. What it lost is the runner's own reach: editing a
file, running a command, driving a pipeline.

What the agent can reach is the project: its issues, its progress, its knowledge, its memory, and
those two writes. What it cannot reach is the repository.

That was the right trade for the condition ISS-1004 was open on — a conversation surface that reads
a session row is two live paths, and the durable conversation had reached nobody — and it is a real
capability loss on the surface people actually use.

## What is missing, precisely

| Gone from the chat surface | Why it did not follow | Where it still is |
|---|---|---|
| The repository, and anything that needs a working tree | A conversation turn runs in core; there is no checkout to run it in | A runner session, reached from the sessions surface |
| Model pick, runner pick | Both name a property of a RUN — the tier it runs at, the device it runs on | `agent_sessions`, unchanged |
| Fork, rerun, per-turn edit, regenerate | All four rewrite a run's turns; `appendMessages` leaves every row already in a conversation alone | The run thread (`session-screen.tsx`), unchanged |
| Invokable skills (the composer's `/` menu) | A skill is dispatched into a runner session | `agent_sessions`, unchanged |
| Attachments | `conversation_messages.images` holds image references and there is no upload endpoint that writes one | — |

## The fix

The seam is already in the turn runner and already has one user.
`ConversationTurnRequest.divertBeforeTurn` exists so an adapter can hand a whole turn to a slower
path and answer through it later; `integrations/rocketchat/turn-inputs.ts` uses it for the `agent`
answer mode, which dispatches a runner-hosted session and delivers its reply through
`agent-chat-bridge.ts` when the session goes terminal. The Forge UI would use the same seam.

## Honest costs

The price of the fix above — a runner-hosted turn reachable from a web conversation — not the price
of the loss it closes.

| Cost | What it takes |
|---|---|
| A transport-neutral runner diversion | `agent-chat.ts` and `agent-chat-bridge.ts` are Rocket.Chat's: they carry `rid`, `tmid`, `connectionId`, `botName` and a REST post. A second copy for `web` is the two-live-paths defect again; extracting them means the metadata becomes a venue plus a window plus a delivery key, and the bridge delivers through `conversationTransport(adapter).deliver` |
| A third bridge firing site, or a neutral one | `lifecycle/transition.ts` names its two bridges by hand and `agent-sessions/routes.ts` PATCH fires them again. A third name there is the cheap version and the wrong shape; the honest one is a terminal-session hook a bridge registers on |
| The answer arrives later than the request | The send route answers inline today, which is why a person sees the reply in the response and not through a socket. A diverted turn cannot, so the route becomes 202-and-a-push, and every one of the three "no answer yet" states on screen has to be right before that is safe |
| Attachments need an upload endpoint of their own | `conversation_messages.images` stores references, not bytes; a browser upload needs somewhere to put the bytes and a URL the image resolver can re-fetch them from |
| The product question under all of it | Whether the Forge UI's agent is a project assistant or a hand on the repository. Both are defensible and they are different products; the port took the first because it is the one the conversation store describes, and reversing it is this document |

## What ISS-1005 settled

ISS-1005 moved the browser's reply onto a door of its own and was required, by its own Rules, to
settle what the surface no longer reaches rather than leave it implied. It **accepted the loss and
named it**, and it did not design a bridge. Two reasons, both recorded on the issue:

1. The only bridge cheap enough to have landed inside ISS-1005 would have run through the toolset —
   and that issue forbids widening `CHAT_TOOL_ALLOWLIST` past its fence outright, because the fence
   is per-key and open by default and that is how `data.relations` reached chat unclassified in
   ISS-868 and let a room retract a live `blocks` edge. The honest bridge is the `divertBeforeTurn`
   seam above, whose costs this document already prices, and none of those costs is ISS-1005's.
2. The reach that went is still one click away and was never removed. `/projects/<slug>/agents` is
   live, still reads `agent_sessions`, and still submits its turns to `/api/agent-sessions/send` —
   a session on a paired box, with the checkout and the shell.

What ISS-1005 added, and what makes "accepted" different from "unmentioned": the persona now tells
the person. `webConversationPersona` states that the assistant can file a draft issue and comment,
cannot edit a file or run a command or drive a pipeline, and names the Agents screen as where a
person starts a session that can. A refusal that names no way out was the actual defect in the
accepted trade, and it is the half this issue closed. `runner-surface-named.test.ts` asserts the
sentence stays true by checking the SEND path of the screen it names, not the sentence itself.

## The condition that ends this

Somebody asks the agent in the Forge UI to look at a file and is told it cannot — and that is the
wrong answer for what Forge is for. Until then this is a named trade and not a defect.
