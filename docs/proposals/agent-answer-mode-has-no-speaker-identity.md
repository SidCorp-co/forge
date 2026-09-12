# `agent` answer-mode runs a direct message under no speaker identity

- Status: **open question, raised from ISS-987** — nothing is broken today, and nothing decides it.
- Related: `packages/core/src/integrations/rocketchat/turn-principal.ts` ·
  `packages/core/src/integrations/rocketchat/agent-chat.ts:startAgentChat` ·
  `packages/core/src/assistant/tools/principal.ts:buildChatToolContext`

## What ISS-987 settled, and the half it could not reach

ISS-987 made a direct message run as the person who spoke: `resolveTurnPrincipal` resolves the
speaker through `assistant/identity/speaker-link.ts` and the turn's tool context is fenced to that
Forge user, refusing by name when the speaker maps to nobody. That covers both consumers of
`buildChatToolContext` the issue named — the fast provider turn via `images.ts:prepareFastTurn`,
and the escalation bridge's synthesis, which now reads a principal stored at dispatch.

`agent` answer-mode is a third lane and uses neither. `startAgentChat` dispatches a
runner-hosted Claude session, and that session's authority is its own job credential — project
scoped, not person scoped. So in a project with `agentConfig.rocketChatAnswerMode = 'agent'`, a
direct message is *gated* on the speaker resolving (the refusal in `handle` runs before the
answer-mode branch, so an unlinked speaker is still refused by name) but the turn that follows
does not run as them.

## Why this is a question and not a defect

The lane never claimed to. A runner session acts as an agent with a project credential, the same as
any pipeline job, and that was true before ISS-987 — the issue did not widen the gap, it only made
the other two lanes narrower and so made the asymmetry visible. Nothing in the field is wrong
today.

What is now inconsistent is what a reader would predict: two of three lanes attribute a DM's writes
to the person who typed it, and the third attributes them to the project. A person who links their
account to get correct attribution gets it in `fast` mode and not in `agent` mode, with no signal
saying which they are in.

## What deciding it would require

Not a fix so much as a choice about what a runner session may speak as. Threading a person's
identity into a dispatched session means either the session carries a principal alongside its job
credential, or the writes it makes are attributed at the boundary rather than at the tool. Both are
decisions about the job credential's meaning, which is kernel territory — `VISION:
kernel-hard-policy-soft` — and neither belongs in an integration issue.

The cheap interim, if the asymmetry starts costing anything: say so in the room. `agent` mode
already posts an ack; it could name whose authority the answer will be computed under.

## Honest costs

Priced against adopting a fix, not against the asymmetry itself — nobody is answered as the wrong
person today.

| Cost | Who pays it, and when |
|---|---|
| The job credential stops meaning one thing | Giving a runner session a person's identity turns "this box, this project" into "this box, this project, on behalf of this human". Paid by every existing reader of that credential at once. |
| A re-audit of four authority readers, not a plumbing change | `questions/read.ts:answerAs`'s authority gate, comment authorship, the fabrication guard's `agency` split and `requireDevice`-shaped checks each conclude something from a credential that would now carry more. Paid before the first dispatch, or it is paid as a wrong attribution afterwards. |
| Kernel tolerance, spent | `VISION: kernel-hard-policy-soft` puts zero tolerance on a representable-looking wrong value in session and authority. A second principal on the credential is exactly that shape, so this cannot ship behind a normalization. |
| The cheap alternative buys silence, not symmetry | Declaring that `agent` mode answers as the project and never as a person costs one ack line in the room, and leaves the asymmetry permanent. Paid by every future reader who expects the `fast` behaviour. |
| One more document that has to stay true | This file claims `startAgentChat` dispatches under a job credential, that `buildChatToolContext` has exactly two Rocket.Chat consumers, and that the speaker refusal precedes the answer-mode branch. Paid by whoever moves one of those three and not this file. |
| Doing nothing has a bill with no alarm on it | A reader's model is wrong in one of three lanes, and it comes due the first time someone reconciles who authored a chat-filed issue against who typed the message. No owner, no signal — paid quietly and late. |
