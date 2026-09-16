---
name: forge-message-shape
description: "The shape every agent-written message to a person must have before Forge will accept it: the three intents, the two audiences, the five cells they make, the rules each cell holds, and the eight doors those cells are read at. Read this when a write was refused with a rule id, before writing a comment or a question round, or before adding a rule or a door. Triggers on: /forge-message-shape, my comment was refused, MESSAGE_REFUSED, QUESTION_MESSAGE_REFUSED, what shape does a comment need, message screen, audience and intent."
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

Two audiences and three intents make **five cells** — the pairs are sparse, not a filled grid — and a cell is the only thing that holds rules:

| cell | what it is |
|---|---|
| `role:ask` | a question put to somebody who can answer it |
| `role:report` | a comment on an issue, read by the person who decides |
| `role:chat` | the assistant's reply to somebody holding a role, in a Forge UI room |
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

### `role:chat`

| rule | what it asks |
|---|---|
| `non-empty` | there is text |
| `status-matches-the-row` | as in `role:report` |
| `only-verified-citations` | every issue key named is a real issue of this project |
| `issue-link-shape` | an issue link reads `<base>/projects/<slug>/issues/<documentId>` — never a hash route, never a key or number in the path |
| `no-empty-promise` | no commitment to do something later — a chat turn ends, and nothing will come back to keep it |
| `progress-figures-match` | figures quoted match the progress snapshot this turn was shown |
| `no-redacted-secret` | as above |

This is `public:report` with two rules dropped and two added, and each of the
four is the difference between the two readers. `no-developer-detail` is gone
because this reader holds a role and can act on what it refuses — a file path, a
fenced block, a raw status word are three of the things a person opens the Forge
UI to ask for. `issue-references-exist` is gone for the reason `role:report`
drops it. `status-matches-the-row` and `non-empty` are added.

The three that carried over did so because none of them is about what the reader
may be shown: a citation this project does not hold is wrong wherever it is read,
a promise no later turn will keep is a property of the turn ending, and figures
are checked against the snapshot the model was actually given.

### `public:report`

| rule | what it wants |
|---|---|
| `issue-references-exist` | every issue key named is a real issue of this project — the reader cannot check |
| `no-developer-detail` | no file paths, stack frames, branch names or internals |
| `only-verified-citations` | a claim about an issue matches its row |
| `issue-link-shape` | as in `role:chat` |
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

## Whether to ask at all

Every rule above governs what a question **looks like** once the decision to ask
has been made. None of them asks whether the question deserved to interrupt a
person, and that is the more expensive mistake: a well-formed question nobody
needed costs a human context switch, and a park wrapping a binary choice in six
hundred words passes every rule on this page.

**Uncertainty alone never earns an interruption. Consequential uncertainty does.**
Before you ask, say what becomes irreversible if you guess wrong. If you can name
it — a deploy, a schema change, a message to a customer, a decision somebody else
has already made — ask. If you cannot, you are asking to be relieved of a
judgement that is yours, and the answer is to make it, act, and record what you
decided so it can be corrected cheaply.

The test is reversibility, not confidence. A wrong guess you can undo in an
afternoon is not worth a question; a wrong guess that ships is, even when you
are fairly sure.

This is **judgement, not a screen**. No rule on this page refuses a question for
failing it, because nothing in free text can be checked against it. What is
checked is the typed field: `irreversible_if_wrong` on the issue carries your
answer, and a park that cannot fill it is a park to reconsider rather than one
the platform will refuse for you. Presenting this as enforced when it is not is
the failure mode this section exists to avoid.

## What the message says, and what the issue holds

A message is authored; state is derived. The two are not the same channel, and
putting state in prose is how an issue ends up with everything written and
nothing readable.

So when your comment reports what changed, the facts a surface needs go into the
issue's typed attributes as well — not instead of your comment, and not as a
summary of it:

| what you are saying | the attribute that carries it |
|---|---|
| this part is still owed | `obligation` |
| and this is who owes it | `obligation_owner`, or `obligation_carrier` for the issue it moved to |
| I landed 1 of the 5 things named | `delivered`, `delivered_of` |
| this cannot proceed without a person | `human_required` |
| guessing wrong here is irreversible because… | `irreversible_if_wrong` |

Write them with `forge_issues action=setAttributes`. An `obligation` sent with
neither an owner nor a carrier is refused by name — an obligation nobody owns is
not recorded, it is lost, which is how steps 2-5 of ISS-1002 left without anyone
noticing.

Your prose stays exactly as long as it needs to be. **Brevity is never enforced
on evidence; boundedness is enforced on the views built from it.**

## The doors: where a cell is read, and what happens when it refuses

A cell says **what is required**. It says nothing about how many times a message
may be tried again, because the same cell is read in places whose lifecycles
differ — at one, the agent is still on the line; at another, the message posts
minutes later with nobody left to ask. A repair count on the cell would have to
be right for both and can only be right for one.

So the count lives on the **door**. There are eight.

| door | cell | ending | repairs |
|---|---|---|---|
| `comment-write` | `role:report` | refusal | — |
| `question-ask` | `role:ask` | refusal | — |
| `question-delivery` | `role:ask` | refusal | — |
| `chat-sync` | `public:report` | fallback | 1 |
| `web-chat-reply` | `role:chat` | fallback | 1 |
| `escalation-synthesis` | `public:report` | fallback | 1 |
| `agent-chat-completion` | `public:report` | fallback | 0 |
| `web-agent-completion` | `role:chat` | fallback | 0 |

**refusal** — the write does not happen and the author is told why. Nothing is
posted in its place. Every one of these has the agent on the line, so telling it
what broke *is* the answer.

**fallback** — somebody asked and is waiting, so something must be said. The door
takes up to its repair count of corrective retries; if those are spent, one fixed
fallback message is posted. Never more than two repairs anywhere.

`public:report` is what the door/cell split is for: three doors on one cell, one
ending, two different repair counts. No single number on the cell could have been
right for all three.

The Forge UI reply is at `role:chat` and **not** at `chat-sync`, and the
difference is who is reading. Nobody opens a conversation in the Forge web app
without holding a role on that project, and every later reader is re-checked
before the room is shown to them. So that reader can open the tracker and check —
which makes `no-developer-detail`, a rule written for somebody who cannot, the
wrong rule for them: it refuses a file path, a fenced block and a raw status word,
which are three of the things a person opens the Forge UI to ask for.

`agent-chat-completion` declares **0** deliberately: the runner session whose
final message it carries has already ended, so there is no turn to ask again, and
a budget it could never spend would be a lie in the table.

`web-agent-completion` is the same reply arriving in the Forge UI instead of a
room, and it takes the **cell** of the surface and the **repairs** of the lane:
`role:chat` because its reader holds a role and `no-developer-detail` would refuse
the file path they asked about, and **0** because the session that wrote it has
already ended. It is why `role:chat` is now read at two doors rather than one —
the reader is the same person in both, and only the repair budget differs.

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
