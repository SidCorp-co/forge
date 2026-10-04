# Documentation

> **Scope — this tree is INTERNAL.** `docs/` is engineering documentation, never served and never
> shipped. It is one of four documentation homes, and which page belongs in which is stated once,
> in [modules/guides/where-a-page-lives.md](modules/guides/where-a-page-lives.md).

## Where to go

| I want to | Go here |
|-----------|---------|
| Run Forge for the first time | [quickstart.md](quickstart.md) |
| Know what Forge is for, and what it refuses to claim | [VISION.md](VISION.md) — the constitution; on intent conflicts it wins |
| Understand the system, and where it is going | [proposals/destination/](proposals/destination/) |
| Know which CLI is mine — I write skills, or I write the daemon | [proposals/destination/plugin-core.html](proposals/destination/plugin-core.html) |
| Know which surface answers which question | [proposals/destination/one-question-one-answer.md](proposals/destination/one-question-one-answer.md) |
| Build a core module (its tables, routes and web module) the way every other one is built | [conventions/domain-entities.md](conventions/domain-entities.md) — the pattern, not a description: each rule names its reference code, `scripts/check-module-boundaries.mjs` blocks on its import rules, and `scripts/check-module-shape.mjs` reports the semantic ones |

## Rules for this tree

- **One place per round.** A finding goes into the destination set, not into a new folder that
  will be forgotten.
- **Every claim is measured, with the date and the command.** An unmeasured number rots silently.
- **Deleting a wrong doc is `CLAUDE.md` §"Documentation is deleted, not carried", not a rule of
  this folder.** It is stated once, there, and restating it here would be the second copy that
  rule exists to forbid.
- **`VISION.md` and every file under `proposals/` price what adopting them costs, under
  `## Honest costs`**; a `README.md` at any depth carries this rule instead of a price of its own. The section holds the price of the choices the document makes, not the
  boundaries it draws — one cost per row, as a table or a list, at least twelve words across it,
  and never `TBD`, `none` or `n/a`. A cost nobody has worked out is not a priced trade-off, and a
  section that is present and says nothing is the shape this rule exists to refuse.
  `check-honest-costs` measures it and `scripts/README.md` has the gate's row.
