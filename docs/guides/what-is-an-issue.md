# What is an issue?

An issue is a unit of **work**. Not a note, not a question, not a record of
something already done. Getting this wrong is cheap to do and expensive to
carry: the tracker fills with items nobody can finish, and the things that
genuinely need doing stop being visible.

> **Definition.** An issue is a unit of work with a named deliverable and an
> owner, whose completion someone other than the author can verify.

Read [Where it does not belong](#where-it-does-not-belong) if you are about to
file a note, a decision, or an audit finding — those have better homes.

---

## The four gates

File it only if it passes all four.

| # | Gate | Ask | If it fails |
|---|------|-----|-------------|
| 1 | **Deliverable** | When this is done, what *thing* exists? A diff, a merged branch, a changed config, a deleted file. | If "done" produces only **text** — an answer, a note, a record — it is not an issue |
| 2 | **Executable** | Can whoever picks this up actually finish it with what the description says? | If the first step is *"someone must decide X"*, the decision is the blocker. The issue does not exist yet |
| 3 | **Verifiable exit** | Can a second person tell done from not-done by observing behaviour? | If only the author knows when it is finished, it needs clarifying first |
| 4 | **Owner + due signal** | Who will look at it, and what makes it speak up if it is forgotten? | No owner and no aging signal means filing it is *burying* it, not recording it |

Gate 4 is the one people skip. `draft` means *not yet time to work on this* — it
does not mean *not sure this is work*. A `draft` nobody owns and nothing ages is
a write-only queue.

## Where it does not belong

| You have | It is | Put it |
|----------|-------|--------|
| A session log, a summary of what you did | a record | a handoff doc, or project memory |
| A note, learning, or convention | knowledge | project memory (durable business logic → `docs/`) |
| An open question needing a human decision | a decision | a comment on the issue that raised it, plus `waiting` if it blocks that issue. A standing policy question → `docs/proposals/<topic>.md` marked *pending sign-off* |
| An audit or scan finding | an observation | memory, until it becomes work with a deliverable |
| A fix you already made by hand | a record | move the status, capture the learning in memory |

Nobody browses the issue list for documentation. An issue is the wrong shape for
all five: it has no assignee that makes sense, no acceptance criteria, and no
way to be "done".

### Residuals — the opposite mistake

Under-filing is also a failure. A real example: four separate pipeline stages
flagged an unauthenticated data leak, each asked for a follow-up to be filed,
none was, and the leak shipped.

So when a stage or a review wants to hand something onward, it must become one
of exactly three things:

1. **Work with a deliverable** → an issue.
2. **A `blocks` edge** onto the issue that would otherwise ship without it.
3. **A line in a decision doc** (`docs/proposals/`).

Never a fourth option — an unowned `draft`. If it fits none of the three, say it
in a comment on the issue you are already working on.

## When you find one that is not work

Finding a filed item that fails the gates is not someone else's job. Whoever
just read it is the cheapest person to fix it.

1. **Comment first** — which gate it fails, and where the content went (the
   memory entry, the proposals file, the issue it duplicates). A status move
   with no comment leaves the next reader unable to tell why.
2. **Then move it** — `needs_info` when a human owes you requirements and it
   could still become real work; `closed` when it is not work at all.
3. **Closing non-work needs `unmark`.** `closed` auto-stamps `merged_at`, and
   that stamp releases every `blocks` dependent as if the work had shipped.
   Clear it right after, or you silently unblock work that is still blocked.

There is no route back into `draft` — nothing transitions into `draft`, by
design. `closed` + `unmark` is the exit for something that turned out not to be
work.

## draft or open?

`open` auto-triages and immediately starts a pipeline run, which consumes a
runner slot. `draft` never dispatches.

| Situation | Status |
|-----------|--------|
| You want work to start now | `open` |
| Real work, but for later | `draft` |
| You looked at it and are not doing it now | leave `draft` |
| It turned out not to be work | delete it; put the content in memory or docs |

`draft` has three exits, and picking the wrong one is what makes a hands-on
session expensive:

| You have | Set |
|----------|-----|
| Finished it entirely by hand; nothing left for the pipeline | `closed` |
| Wrote **and pushed** the branch yourself; you want review → test → release | `developed` + `sessionContext.branch` |
| Not started; you want the whole thing done for you | `open` |

Closing is not free: `closed` stamps `merged_at`, and that is exactly what
releases everything waiting on this issue. Closing something you *abandoned*
silently unblocks work that should still be blocked — clear the stamp in that
case.

## Writing one

Fill `title`, `description`, `priority`, `category`. Leave the rest to the
pipeline — `plan` and `acceptanceCriteria` are written by the clarify and plan
steps, and pre-filling them removes the reason those steps exist.

The description is a **requirements contract**, not an implementation script. It
is the one channel every later step trusts without re-checking, so what goes in
it decides whether the work explores the real code or just obeys a stale
snapshot.

| Belongs — the stable half | Does not belong — the volatile half |
|---------------------------|-------------------------------------|
| The outcome, and who it serves | Which files or components to touch |
| Business and domain rules | Endpoint-by-endpoint call scripts |
| Invariants, stated as behaviour | "Follow the pattern at `<path>`" |
| What the user must see when it fails | Claims about how it is currently built |
| Explicit out-of-scope | Anything that pre-decides the design |
| Acceptance criteria as observable outcomes | |

External facts the repo cannot know (a vendor API's required call order) are
welcome — labelled as unverified reference material, not as instructions.

## Red flags

| Name | What it looks like |
|------|--------------------|
| `open-as-note` / `draft-as-note` | filing a note, log, or question as an issue |
| `plan-by-hand` | pre-filling `plan` or `acceptanceCriteria` on create |
| `prose-deps` | writing "depends on ISS-42" instead of setting a `blocks` edge |
| `on_hold-from-draft` | parking work that never started; leave it at `draft` |
| `fix-by-hand-and-forget` | fixing something outside the pipeline with no status move and no recorded learning |

## Reading this elsewhere

| Audience | Where |
|----------|-------|
| Anyone, no login | `GET /api/guides/what-is-an-issue.md` — public and unauthenticated |
| An agent | `forge_guide action=get slug=what-is-an-issue` |
| Contributors | this file |

Gate 4's aging signal is **pending sign-off** — the definition names the
requirement; what the signal actually is (an SLA per priority, an automatic
bounce, a surface on someone's attention list) is not decided yet. Filing into
`draft` without it only moves a residual from silently-lost to silently-parked.
