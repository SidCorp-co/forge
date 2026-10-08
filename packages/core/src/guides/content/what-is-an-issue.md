## What is an issue?

An issue is a unit of **work** — not a note, not a question, not a record of something already done.

> An issue is a unit of work with a named deliverable and an owner, whose completion someone other than the author can verify.

### The four gates — file it only if it passes all four

| # | Gate | Ask | If it fails |
|---|---|---|---|
| 1 | **Deliverable** | When this is done, what *thing* exists? A diff, a merged branch, a changed config, a deleted file. | If "done" produces only TEXT — an answer, a note, a record — it is not an issue |
| 2 | **Executable** | Can whoever picks it up finish it with what the description says? | If step one is "someone must decide X", the decision is the blocker and the issue does not exist yet |
| 3 | **Verifiable exit** | Can a second person tell done from not-done by observing behaviour? | Clarify it first |
| 4 | **Owner + due signal** | Who will look at it, and what makes it speak up if forgotten? | No owner and no aging signal means filing it BURIES it |

Gate 4 is the one that gets skipped. `draft` means *not yet time to work on this* — never *not sure this is work*. A `draft` nobody owns and nothing ages is a write-only queue.

### Where it goes instead

| You have | It is | Put it |
|---|---|---|
| A session log or summary of what you did | a record | a handoff doc, or project memory |
| A note, learning, or convention | knowledge | `forge_memory_write` (durable business logic → repo `docs/`) |
| An open question needing a human decision | a decision | a comment on the issue that raised it + `waiting` if it blocks that issue; a standing policy question → `docs/proposals/<topic>.md` marked *pending sign-off* |
| An audit or scan finding | an observation | memory, until it becomes work with a deliverable |
| A fix you already made by hand | a record | move the status, capture the learning in memory |

### Residuals — fix them, don't file them

Under-filing ships bugs. Measured case: four separate stages flagged an unauthenticated data leak, each asked for a follow-up to be filed, none was, and the leak shipped.

Filing was the wrong correction. Measured 2026-08-18 on forge-dev: 30 open `draft`s, the oldest untouched for 54 days, most of them fixable defects a stage deferred rather than fixed — two of them (ISS-791, ISS-845) describing drafts being filed and forgotten while themselves sitting filed and forgotten.

So anything a stage wants to hand onward routes as:

1. **You can fix it here** → **fix it**, and declare it under `Extra fixes:` in your comment. This is the default and covers most residuals. A declared extra fix is authorized work, not scope-creep — review judges it on merit.
2. **It must not ship without other work** → a `blocks` edge onto the issue that would otherwise ship without it.
3. **It needs a human decision** → `waiting` + `waitingKind` + `reason` when it blocks this issue; a standing policy question → a line in `docs/proposals/`.

Filing a NEW issue is not on that list. If it fits none of the three, say it in a comment on the issue you are already working on — silence is the only thing that is never acceptable.

### When you find one that is not work — act on it, don't leave it

Finding a filed item that fails the gates is not someone else's job. You are the cheapest person to fix it, because you have just read it.

1. **Comment first** — which gate it fails, and where the content went (the memory entry, the proposals file, the issue it duplicates). A status move with no comment leaves the next reader unable to tell why.
2. **Then move it**: `needs_info` when a human owes you requirements and it could become real work; `dropped` when it is not work at all.
3. **Non-work leaves by `dropped`, never by `closed`.** `closed` means the work shipped, and a close that cannot show it — no `merged_at` on the row — is refused by name (`CLOSE_REQUIRES_SHIPPED`). `dropped` is terminal without the claim, and it expires this issue's outgoing `blocks` edges so nothing is left waiting on an issue that can never land.

Do not move it INTO `draft` — nothing may transition into `draft`, by design. `dropped` is the exit for something that turned out not to be work.

### Then read
Statuses, the four exits from `draft`, and the description contract: guide `pipeline-and-issue-lifecycle`. Which tool for which intent: guide `agent-setup`.

Public copy of this page, no auth required: `GET /api/guides/what-is-an-issue.md`.