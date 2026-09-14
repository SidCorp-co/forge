---
name: forge-message-shape
description: "The shape every agent-written message to a person must have before Forge will accept it: the two intents, the two audiences, the four cells they make, the rules each cell holds, and the six doors those cells are read at. Read this when a write was refused with a rule id, before writing a comment or a question round, or before adding a rule or a door. Triggers on: /forge-message-shape, my comment was refused, MESSAGE_REFUSED, QUESTION_MESSAGE_REFUSED, what shape does a comment need, message screen, audience and intent."
user_invocable: true
---

# The shape of a message to a person

Forge screens **every message an agent writes for a person to read**, and refuses
the ones that do not fit. This document is that contract. It is served live over
the Forge MCP prompt channel, so the copy you are reading is the current one —
nothing syncs to disk, and there is no second version to go stale.

If a write of yours was refused, the refusal already told you the rule, the shape
and an example. This says why the rule is there and what else is in the set.

## What decides the rules: who reads it, and what it asks of them

Two questions, asked of every message, and **neither of them is about where the
message renders**. A comment on an issue and a line in a chat room are judged by
who reads them and what they claim, not by the transport that carries them.

**The intent** — what the reader owes after reading:

- `ask` — the reader owes an answer. The message is a question put to somebody
  who can settle it.
- `report` — the reader owes nothing. The message tells them something.

**The audience** — what the reader holds:

- `role` (the role holder) — somebody with a role on the project. They can open
  the tracker and check any claim you make, and they are the person who decides.
- `public` (no role) — somebody with no role. They cannot check a claim, cannot
  open an issue you name, and cannot act on a detail about our internals.

Two by two makes **four cells**, and a cell is the only thing that holds rules:

| cell | what it is |
|---|---|
| `role:ask` | a question put to somebody who can answer it |
| `role:report` | a report to somebody holding a role — a comment on an issue, or the assistant's reply in a Forge UI room |
| `public:ask` | **reserved** — see the bottom of this page |
| `public:report` | a reply to somebody who cannot open the tracker to check it |

## The rules, by cell

Each rule has an id. That id is what a refusal names, and it is what to search
for when you want to know why something was refused.

### `role:ask`

| rule | what it wants |
|---|---|
| `non-empty` | there is text |
| `no-room-broadcast` | no `@all`, `@here` or `@channel` — a question goes to the people who can answer it |
| `single-line` | one line per segment; a newline inside an option label renders as two options |
| `no-option-line` | the prompt does not carry its own numbered list — the round already has options, and a line that looks like one is a choice the person was never offered |
| `no-redacted-secret` | nothing the secret scrubber would redact |

### `role:report`

| rule | what it wants |
|---|---|
| `comment-has-text` | there is a body |
| `status-matches-the-row` | if you assert that a named issue is **merged**, **shipped**, **landed** or **closed**, the tracker's row must say so |
| `no-room-broadcast` | as above, with a different reason: carrying a comment into a room pages everyone in a room that did not write it |
| `no-redacted-secret` | as above |

**If you have just merged or closed something, stamp the tracker before you say so.** That is the
refusal's first suggestion and not a formality: the rule reads the row, so a comment reporting a
merge a moment before the mark is written is refused for a claim that is about to be true. Recording
it first makes the claim true and the comment passes unchanged. The alternative the refusal offers —
saying what you did without claiming the tracker's word for it — is for when you genuinely cannot
stamp it.

`issue-references-exist` is deliberately **not** in this cell. Measured on this
project: 6 of 391 comments in an 18-issue sample cite a `forge-plugin` key,
which CLAUDE.md's own carve-out *requires* an agent to do. A reference this
project does not hold is most likely another project's, so it is not judged. A
status **asserted of** an issue this project does hold still is.

### `public:report`

| rule | what it wants |
|---|---|
| `issue-references-exist` | every issue key named is a real issue of this project — the reader cannot check |
| `no-developer-detail` | no file paths, stack frames, branch names or internals |
| `only-verified-citations` | a claim about an issue matches its row |
| `no-empty-promise` | no commitment to do something later that nothing will hold you to |
| `progress-figures-match` | figures quoted match the progress the run was given |

### `public:ask` — reserved

It has rules and it is wired to **no door**. The product has no place where an
agent puts a question to a reader holding no role, and the reply that would sit
there today cannot say which of the two it is. Folding it into `public:report`
would let `no-empty-promise` refuse the one message that reader is there to
answer. The shortfall is priced in `docs/proposals/`.

## What a rule may be about

**A rule is about what the message claims — never about what tags it is made of.**

There is no vocabulary to learn, no prefix to add, no marker to include. Forge
had one: a `forge-*` comment vocabulary that reached 7 of 13,564 fleet comments
and was removed on 2026-09-14. A gate that reintroduced a structured vocabulary
would repeat exactly what was just deleted, and this contract will not carry one.

So: write the sentence you mean. If it is true and it fits the cell, it passes.

## The doors: where a cell is read, and what happens when it refuses

A cell says **what is required**. It says nothing about how many times a message
may be tried again, because the same cell is read in places whose lifecycles
differ — at one, the agent is still on the line; at another, the message posts
minutes later with nobody left to ask. A repair count on the cell would have to
be right for both and can only be right for one.

So the count lives on the **door**. There are seven.

| door | cell | ending | repairs |
|---|---|---|---|
| `comment-write` | `role:report` | refusal | — |
| `question-ask` | `role:ask` | refusal | — |
| `question-delivery` | `role:ask` | refusal | — |
| `chat-sync` | `public:report` | fallback | 1 |
| `web-chat-reply` | `role:report` | fallback | 1 |
| `escalation-synthesis` | `public:report` | fallback | 1 |
| `agent-chat-completion` | `public:report` | fallback | 0 |

**refusal** — the write does not happen and the author is told why. Nothing is
posted in its place. Every one of these has the agent on the line, so telling it
what broke *is* the answer.

**fallback** — somebody asked and is waiting, so something must be said. The door
takes up to its repair count of corrective retries; if those are spent, one fixed
fallback message is posted. Never more than two repairs anywhere.

`web-chat-reply` and `comment-write` are the reason the split cuts both ways.
They read the same cell and end differently: a comment write refuses and tells
its author, because the author is on the line and can fix it; a Forge UI reply
falls back, because somebody pressed enter and is owed something. `public:report`
shows the other half of the same shape — three doors, one ending, two different
repair counts. No single policy on either cell could have been right.

The Forge UI reply is at `role:report` and **not** at `chat-sync`, and the
difference is who is reading. Nobody opens a conversation in the Forge web app
without holding a role on that project, and every later reader is re-checked
before the room is shown to them. So that reader can open the tracker and check —
which makes `no-developer-detail`, a rule written for somebody who cannot, the
wrong rule for them: it refuses a file path, a fenced block and a raw status word,
which are three of the things a person opens the Forge UI to ask for.

`agent-chat-completion` declares **0** deliberately: the runner session whose
final message it carries has already ended, so there is no turn to ask again, and
a budget it could never spend would be a lie in the table.

## Nothing rewrites what an agent wrote

The verdict carries **no message text**. There is no field in it for a corrected
version, so no caller can receive one — the type makes the substitution
unrepresentable rather than merely discouraged.

When a door does repair, it asks the **author** to rewrite, handing it the
problems. The fixed fallback at the end of an exhausted budget is the one message
Forge writes itself, and it is the same message every time: it never wears the
author's voice.

## What a refusal owes its author

A refusal names **the rule it broke**, and carries **the shape** the message
should have had and **an example** that passes. A bare "wrong format" is itself a
defect in this contract — one of those is a bug worth reporting.

Every example shipped with a rule passes every other rule in the cell it belongs
to, so an example can be copied without trading one refusal for the next.

## Adding to this

- **A rule** is a row in a cell. Order inside a cell is load-bearing: the
  compatibility corpus froze the order problems are reported in.
- **A door** is a row in the door table, naming a cell that exists.
- **An audience** is registered, and its cells become screenable with no edit to
  the screen itself — the screen has no branch per audience to add one to.

A project that wants its own version of this document adopts it: create a
project skill of this same name, and that copy is served instead of this one.
