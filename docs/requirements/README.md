# Requirements register — BR / UC

The **business layer** of `Business logic > Module > Feature`. It exists so a product rule has a
**stable id** that both sides of the repo can cite without naming each other's internals:

- `docs/` and the product map cite `BR-nn` / `UC-nn` — never a file path or a function name.
- Source cites the same id in a `cm:edge contract` or a `cm:guard` — never a paragraph of the rule.

The id is the join. That is what makes a Business↔Module map generable rather than maintained by
hand, and it is why [`forge-product-map`](../../packages/core/skills/forge-product-map/SKILL.md)
can keep its own gate ("**NO** `file:line`, function names, module names") and still connect to
code: it cites the id, the id resolves here, and here names the anchor.

**This register is canonical in-repo.** `forge_knowledge` holds the curated product diagrams, but a
cloud entry cannot be checked by a gate that runs on a clone, so the id space lives here.

## The rule

**The business rule you are changing has an id, or you give it one in the same change.** Nothing
requires a `BR-` for a change that alters no product behaviour, and nothing backfills the whole
product at once. The register grows issue by issue; a table with rules nobody verified would be the
wrong-documentation this repo deletes on sight.

## Citation form

`BR-07`, `UC-03` — always with the prefix, never a bare number. A local case counter inside one
test file must not use `BR-`/`UC-` at all: five such labels were renamed on 2026-08-28 for exactly
this reason, because a file-local `UC-5` and a register `UC-5` are indistinguishable to a reader
and to a grep.

## Business rules

| id | Rule | Anchor |
|---|---|---|
| BR-01 | Only a `kind='blocks'` edge gates dispatch: `(from=A, to=B, 'blocks')` means A must reach a terminal status before B may dispatch. Cross-project edges are legal. `relates` / `duplicates` / `parent` are PM metadata a dispatch path must never read. | `packages/core/src/db/schema.ts:2462` (`cm:guard`) |
| BR-02 | Closing an issue auto-stamps `merged_at`, so `closed` counts as done and every `blocks` dependent unblocks as if the work had shipped. An issue that is **not work** must therefore be closed **and** unmarked, never closed alone. | `packages/core/src/issues/apply-transition-close-stamp.test.ts` |
| BR-03 | An issue at `open` is auto-triaged and spawns a pipeline run. `open` is therefore a dispatch instruction, not a filing status; work that must happen later is filed at `draft`. | `packages/core/src/issues/apply-transition.ts` |
| BR-04 | In a decomposed epic the **parent runs last**: `decomposeChildrenPending` holds the parent until every child carries `merged_at`. | `packages/core/src/pipeline/decomposition.ts:34` |
| BR-05 | A `held` job is alive and non-terminal but burns no runner capacity — counted by the per-issue busy gate, excluded from `running_ids` and `runner_load`. It is not an orphan and must not be reaped. | `packages/core/src/jobs/dispatch-gates.ts:522` (`cm:guard`) |

## Use cases

None registered yet. A `UC-nn` is a user journey; add one when an issue ships a journey that the
product map needs to cite.
