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
| Not doing | the adjacent thing you deliberately left alone |

The `Not doing` line is load-bearing. Without it, phase 5 cannot tell a deliberate boundary from an
oversight, and neither can you on the next round.

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
