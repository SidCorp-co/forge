# Documentation

> **Scope — this tree is INTERNAL.** `docs/` is engineering documentation. It is **never** served
> to product users and **never** shipped into the app image. **End-user product docs** live in
> [`packages/web-v2/content/help/`](../packages/web-v2/content/help/) and are bundled into the web
> build. Do not put user-facing guides here, and do not put internal docs there.

One folder carries the system's description, and it is the only one. The per-domain module docs,
the architecture set, the RFC folder and the loose proposal notes were deleted on 2026-09-20: they
were written once and consulted rarely, drifted from the code without anything noticing, and
answered the same question in several places at once. Better no document than a wrong one.

## Where to go

| I want to | Go here |
|-----------|---------|
| Run Forge for the first time | [quickstart.md](quickstart.md) |
| Know what Forge is for, and what it refuses to claim | [VISION.md](VISION.md) — the constitution; on intent conflicts it wins |
| Understand the system, and where it is going | [proposals/destination/](proposals/destination/) |
| Know which CLI is mine — I write skills, or I write the daemon | [proposals/destination/plugin-core.html](proposals/destination/plugin-core.html) |
| Know which surface answers which question | [proposals/destination/one-question-one-answer.md](proposals/destination/one-question-one-answer.md) |
| See what the tree does instead of what the set describes | [proposals/destination/module-1-work-lifecycle.md](proposals/destination/module-1-work-lifecycle.md) |
| Know how much of the system the set actually covers | [proposals/destination/coverage.md](proposals/destination/coverage.md) |

## Rules for this tree

- **One place per round.** A finding goes into the destination set, not into a new folder that
  will be forgotten.
- **Every claim is measured, with the date and the command.** An unmeasured number rots silently.
- **Deleting a wrong doc is `CLAUDE.md` §"Documentation is deleted, not carried", not a rule of
  this folder.** It is stated once, there, and restating it here would be the second copy that
  rule exists to forbid.
- **The set states its own coverage.** It is silent on plenty, and an audit run against it must
  not read that silence as approval.
