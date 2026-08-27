---
name: forge-understand
description: "Phase 1 of the autonomous pipeline: decide whether an issue is real work, and reproduce it before anything is planned. Merges the old triage and clarify stages. Triggers on: /forge-understand, is this issue actionable, reproduce this bug, understand this issue."
survives_kill_switch: false
user_invocable: false
arguments: "issueId"
---

# forge-understand

Two questions, in order. Answer the first wrong and everything after it is wasted; answer the
second by guessing and the plan is fiction.

## 1 · Is this work?

Work has a named deliverable, an owner, and a finish someone other than the author can verify.

Four things arrive in the issue tracker that are not work:

| It is actually | What you do |
|---|---|
| a note, a learning, a decision | write it to project memory, comment saying where it went, then `dropped` |
| a question | answer it in a comment; `dropped` if nothing remains to build |
| already done | verify it against the repo, say so with the commit, then `dropped` |
| a duplicate | comment naming the original, then `dropped` |

`dropped`, never `closed` — `closed` stamps `merged_at` and unblocks every dependent as if the work had
shipped.

If it is work but you cannot tell what finished looks like, that is `needs_info`, not a guess.

## 2 · Reproduce it

Nothing proceeds on a described symptom.

**A bug** is reproduced when you have run it and seen it fail. Record the exact command, request or
click path, and the actual output. "I read the code and it looks wrong" is a hypothesis; it is not
reproduction, and it is wrong often enough to matter.

**A feature** is reproduced when you have found the current behaviour it changes and stated it. If
the feature is genuinely new surface with nothing to compare against, say that explicitly rather
than skipping the step silently.

If you cannot reproduce it, do not proceed on the assumption that it is real. Comment with exactly
what you tried and what happened instead, then `needs_info`.

## What you write

Into the issue, before phase 2:

- what is wrong, in one sentence a reader who has not read the code can check
- the reproduction: command or path, expected, actual
- the acceptance criteria — how anyone will know it is fixed

Acceptance criteria are the reviewer's contract in phase 5. Vague criteria there produce a rubber
stamp there. Write them so that a reviewer who has never seen your code can decide pass or fail.

## Do not

- Do not read the codebase broadly here. Read exactly enough to reproduce. Exploration is phase 2.
- Do not write a plan. Naming the fix before reproducing it is how the wrong fix gets planned.
- Do not classify by size and stop. A complexity label is not an understanding.
