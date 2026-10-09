# Pattern catalog

One entry per change kind, each naming the file to copy, the shape of its tests and the lines a
reviewer checks the diff against (REQ-36 BC-4). An issue's design names, for each criterion, the
entry it follows; reusing an entry needs no approval, and a pattern no entry covers waits on one
reviewer (BC-2) and lands its entry in the same change (BC-3). The rules are drawn by the approved
Issue lifecycle design (`design-check`) and Issue to release design (`admissible`, `rule-merge`).

| Entry | Change kind | Take it when the change |
|---|---|---|
| [Core module](core-module.md) | Core module | adds a module, a table, a status machine, an outbox event, a read model or a permission, or changes which module may import which; every other entry builds on it |
| [API route](api-route.md) | API route | adds or changes a REST route, its body, query, answer or refusals |
| [Screen](screen.md) | Screen | adds or changes a page, panel or form of the web app, or its words |
| [Assistant tool](assistant-tool.md) | Assistant tool | adds or changes a tool the chat model or an agent session calls |
| [Migration](migration.md) | Migration | changes core's database schema or moves rows a new shape strands |
| [Runner actor](runner-actor.md) | Runner actor | adds or changes a long-lived task of the `forge-runner` daemon |

## What an entry holds

Each entry is one page here, opening with its `**Change kind:**` and the issue that introduced it
(`**Introduced by:** ISS-n`), then three sections:

- **Reference** — the tracked files a new change of this kind copies, each named from the
  repository root.
- **Test shape** — the existing tests that show how this kind is tested, and where a new test goes,
  what it asserts and which runner collects it.
- **Review checklist** — numbered lines a reviewer checks against the diff and the evidence,
  rerunning nothing (BC-8).

`scripts/check-pattern-catalog.mjs` (the knowledge axis, run by `pnpm verify`) refuses an entry
missing any of the three, a reference or test file no tracked file carries, an entry with no
introducing issue, and an entry this index does not link. Core reads the catalog from
`packages/contracts/src/pattern-catalog.ts`, which `node scripts/check-pattern-catalog.mjs --write`
generates from these pages; `pnpm verify` refuses it when it disagrees with them. Module shape is
enforced by `scripts/check-module-boundaries.mjs` and `scripts/check-module-shape.mjs` (the
relations axis); the Core module entry points at them and restates none of their rules.

## Naming a pattern on an issue

`POST /api/issues/:id/patterns` `{ pattern: '<slug>', summary?, run? }`, the slug being an entry's
file name without `.md`. A catalogued slug is recorded as reuse and needs no approval. A slug no entry
holds is a new pattern: it is recorded as new, with the summary saying what it is, and waits on its
reviewer. `GET /api/issues/:id/patterns` lists what an issue named. It also says whether the project
reads a catalog at all (`catalog.declared`), any return the issue has not answered (`returned`), and
which pending patterns the caller may decide (`decidable`).

Only a project whose declared repository is this one reads this catalog, from the build it runs.
Naming a pattern on any other project is refused `PATTERN_CATALOG_UNDECLARED`, so a run reads
`catalog.declared` first and names none where it is false.

## The new-pattern approval

- **One reviewer decides.** `POST /api/issues/:id/patterns/:patternId/decision`
  `{ decision: 'approved' | 'returned', reason, run? }` is sent by a holder of `patterns.approve`,
  a person or an agent. It is never the run that named the pattern, or, for a pattern a person
  named, that person's account (`PATTERN_REVIEWER_IS_AUTHOR`). A box's runs share one credential.
  A box's call is the run holding the issue there, or the run its `run` names (the run id the box
  declared). A call that cannot be told apart from the naming run is refused
  `PATTERN_REVIEWER_RUN_UNNAMED`, never guessed. The decision records who, which run, when and why.
  The issue page lists an issue's new patterns, and a reviewer who may decide one approves or
  returns it there.
- **While it waits, the issue is held.** Every dispatch door refuses or withholds it as
  `PATTERN_REVIEW_PENDING`: the move to `in_progress`, a run session over it, the admissible list,
  a pool claim, a queued job, the issue list and its standing. Its work step cannot move to build,
  test or release.
- **A return holds until it is answered.** The reason is posted on the issue. Until the issue names
  a catalogued pattern instead, or names the slug again with a revised summary, its work step cannot
  move to build and it cannot move to `awaiting_release` (`PATTERN_RETURNED`). A returned pattern
  cannot be retracted. The issue stays dispatchable, because a run has to take it to answer.
- **The entry lands in the same change.** The approved pattern's page is added here, with its three
  sections and `**Introduced by:**` naming the issue, in the change that introduces the pattern. The
  merge mark (`POST /api/issues/:id/merge`) reads that change: the `changedPaths` the box sends for
  the marked commit, or the repository at that commit. It refuses `PATTERN_ENTRY_MISSING` until the
  page is in the change (`packages/core/src/issues/pattern-entry.ts`). The design puts this on the
  merge check, which takes it over before the merge once it exists (ISS-472). The move to
  `awaiting_release` does not read the catalog: the running build holds a page only after a release.
