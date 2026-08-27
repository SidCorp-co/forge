---
name: forge-drive
description: "Drive one Forge issue end to end in a single session: understand, plan, code, self-review, fork an independent reviewer, merge, ship. Use when a runner hands you an issue in autonomous mode. Triggers on: /forge-drive, drive this issue, autonomous pipeline, work this issue end to end."
survives_kill_switch: true
user_invocable: false
arguments: "issueId"
---

# forge-drive

You own one issue from open to done, in one session. Nothing dispatches you again — there is no
next job. When you stop, the issue stops.

The cloud is your ledger, not your controller. It records what you declare and blocks exactly two
things: deploy and close. Everything else is yours.

## The loop

| Phase | You produce | Declared before starting |
|---|---|---|
| 1 · understand | a statement of what is wrong and how you reproduced it | `understand` |
| 2 · plan | the files you will touch and why | `plan` |
| 3 · code | a working branch, build green, tests green | `code` |
| 4 · self-review | your own diff read back against the acceptance criteria | `self-review` |
| 5 · review | an independent verdict | `review` |
| 6 · merge | the branch in the base it came from | `merge` |
| 7 · ship | changelog line, close comment | `ship` |

Declare each phase with `forge_phase` **before** you begin it (action `start`), and close it when it
finishes (action `end`, with an outcome). That pair is your resume point: `resume_point` returns the
newest phase you started and never ended, so a session that dies restarts there instead of at phase
1. A phase you never declared did not happen as far as any other session can see — including yours,
after a crash.

Phase 5 can send you back to phase 3. That loop has no counter — go around as many times as the
verdict requires. Re-declare `code` each time so the journal shows the rounds.

## What this project told you about itself

These skills ship in the runner binary and are the same on every project. Nothing about *this*
repo is baked into them. Call `forge_config` with action `get` once, before phase 1, and read
`projectFacts`:

| key | you need it for |
|---|---|
| `build-commands` | phase 3 — proving the branch compiles |
| `test-commands` | phase 3 and phase 5 — a verdict with no test run is an opinion |
| `merge-target` | phase 6, only when the branch does not land in the base it came from |
| `deploy-policy` | phase 7 — whether shipping deploys, and what gates it |
| `reproduction` | phase 1 — the URL, the seed data, the account |
| `done-means` | phase 7 — what this project counts as finished beyond the criteria |

The first two are guaranteed: a project cannot be switched to autonomous mode without them. The
rest may be absent, which means the project has no rule and the ordinary answer applies.

If a fact is wrong or missing something you needed, say so in the close comment. Do not work
around it silently — the next session reads the same map.

## Phase 5 is not yours

You fork a reviewer. You do not review yourself in phase 5 — phase 4 was that, and it is not
sufficient, because you cannot un-know why you wrote the code the way you did.

Give the reviewer:

- the diff
- the acceptance criteria
- the project's `forge-review` skill

Do not give it your transcript, your plan, or your reasoning. It must be able to reach a different
conclusion than you did.

**You never write the verdict.** The reviewer appends one JSON line to the file named by
`FORGE_VERDICT_FILE`; the runner posts it and deletes the file. Pass that variable through to the
reviewer — it is an absolute path and neither of you may resolve it yourselves. Read the line it
wrote and act on it, but never author one, never edit one, and never restate it as the record of
what happened — that is the one move this design exists to prevent.

Check the verdict landed: the `review` phase you close should carry the reviewer's decision, not
your account of it. If `FORGE_VERDICT_FILE` is unset, say so in the phase artifact rather than
proceeding as though a review was recorded.

`request_changes` sends you back to phase 3. Re-declare `code` with `forge_phase` so the journal
shows the round, fix what the findings name, and go round again.

## Statuses you may write

These five, and nothing else. They are kernel statuses — the values `forge_issues` accepts. The
board renders them under different names; write what is in this column, never what you see on a
board.

| Write | Means |
|---|---|
| `open` | claimed, yours |
| `in_progress` | a session is working it |
| `needs_info` | you are asking a human a question — the only park a human's answer restarts |
| `closed` | finished; stamps `merged_at` |
| `dropped` | not work; does not stamp `merged_at` |

## When to stop and ask

Set `needs_info` and say why in a comment when, and only when, a human has something you cannot
get for yourself: a credential, a decision between real tradeoffs, access, or an answer about
intent.

Then **end your session**. Do not wait, poll, or keep the run alive — asking is a stopping point,
not a pause. The comment you leave is the whole question, so write it to be answered by someone who
was not here: what you tried, what you need, and what you will do with each possible answer.

A human answering with a comment is what starts you again. The next session declares its phases from
the same journal, so `forge_phase` action `resume_point` puts it back where you stopped — which is
also why the question has to be in the comment and not only in your head.

Do not set `needs_info` because something is hard, slow, or ambiguous in a way you could resolve
by reading more code. Read more code.

## What you may do without asking

- Merge into the base branch you checked out from. This is yours by default and is not configurable
  away.
- Fix a defect you find on the way, whether or not it is in the acceptance criteria. Declare it in
  the close comment under `Extra fixes:`.

## What the cloud still gates

- **Deploy** — the project config decides whether it happens and how.
- **Close** — `closed` stamps `merged_at` and unblocks every dependent. `dropped` closes without
  stamping; use it when the issue turns out not to be work at all.
- **Merging into a branch you did not check out.** Ask.

## What no longer exists

There are no intermediate statuses. Do not move the issue through `confirmed`, `approved`,
`developed`, `testing` or `released` — those are gone in this mode. The issue is `in_progress` from the
moment you claim it until you finish it.

Do not file new issues for work you found. Fix it and declare it, or say in a comment that it is out
of reach and why. A new issue nobody owns is not a handoff.
