---
name: forge-plan
description: "Phase 2 of the autonomous pipeline: explore the codebase and write the plan you are about to execute. Triggers on: /forge-plan, plan this issue, what files does this touch."
survives_kill_switch: false
user_invocable: false
arguments: "issueId"
---

# forge-plan

You are writing this plan for yourself, five minutes from now, and for whoever restarts this session
after it dies. Both of them need the same thing: which files, in what order, and what would make it
wrong.

## Find the real surface

Two halves, and neither substitutes for the other:

- **Derivable** — references, call sites, types. Use the language server.
- **Declared** — couplings nothing links: a string two sides must agree on, files that must change
  together, an effect that happens in SQL or another process. Run `cm impact <path>` on every file
  you intend to touch.

A plan that touched only what the compiler could see is how the other half of a lockstep pair gets
left behind.

## Write it

| Section | Content |
|---|---|
| Files | each path, and one line on what changes in it |
| Order | what must land before what, and why — not a numbered list of everything |
| Blast radius | what else reads this, from `cm impact` plus references |
| Rejected alternatives | each branch you weighed and dropped, and the fact that killed it |
| Not doing | the adjacent thing you deliberately left alone |

The last two rows are load-bearing. Without `Not doing`, phase 5 cannot tell a deliberate boundary
from an oversight, and neither can you on the next round. Without `Rejected alternatives`, nobody can
tell a branch you rejected from one you never thought of — and Forge keeps the issue rather than the
conversation, so a dropped branch that is not in the plan is gone.

An entry that names a branch without the fact that killed it is the same absence in a longer
sentence. When the choice was genuinely forced — one way to do it, or a constraint the issue already
settled — say so and name what forced it. An empty heading, or an invented loser padded in to fill
one, is worse than no section at all: it reads as consideration that never happened.

It goes in the issue's `plan` field, not only in a comment. A plan that lived in the session ends
with the session, which is the whole failure this section exists to close.

## Size it honestly

If the plan touches more than a handful of modules, or the order section has real sequencing in it,
say so in a comment now. It is far cheaper to split at phase 2 than to discover at phase 5 that the
diff cannot be reviewed as one thing.

Splitting means: this issue does the coherent core, and the rest leaves as a `blocks` edge onto
whatever cannot ship without it. It does not mean filing a pile of new issues nobody owns.

## Do not

- Do not plan the ceremony. Branch, worktree, commit, push and merge belong to `forge-drive`; naming
  them here is noise you will read again on every round.
- Do not write code in the plan. A plan that is the diff in prose has cost you a phase and bought
  nothing.
- Do not plan against a symptom you did not reproduce in phase 1. Go back.
