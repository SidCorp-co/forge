# A project kind Forge does not know is accepted at write

Found by ISS-1318's judge j2 and refused by name at the mark in round r3. The constraint that would
stop it at write is described here and not built, because it is a migration and parallel lanes
must not choose their own migration numbers.

## What stands

`projects.kind` is a plain `text` column (`packages/core/src/db/schema.ts`). Every route that writes
it checks the value against `projectKinds`: project create and update in
`packages/core/src/projects/routes.ts`, and `forge_projects` in
`packages/core/src/mcp/tools/forge-projects.ts`. A write that goes around every route, such as
direct SQL, a restore or a seed, can still leave a kind like `kiosk`.

`landingShapeOf` (`packages/core/src/issues/landing-evidence.ts`) refuses such a kind with
`UnknownProjectKindError`. Since r3 the mark writer turns that into a `422`
`PROJECT_KIND_UNKNOWN` and writes nothing. The other readers do not translate it:

- issue serialization through `readLandingShape` (`packages/core/src/issues/routes.ts`) and the
  close gate (`packages/core/src/issues/merged-at.ts:refuseUnshippedClose`) let it out as an
  unhandled error;
- the `merged_mark` entry criterion throws inside
  `packages/core/src/issues/transition-evidence.ts:checkTransitionEvidence`, which fails open and
  lets the transition through;
- the release-record blockers (`packages/core/src/release-batch/blockers.ts`) read it as well.

## The fix

A migration adds `CHECK ("kind" IN ('standard', 'website'))` to `projects`. That makes the column
the place that refuses a bad kind, and every reader above can trust the value it reads. If a row
already holds another kind, the migration aborts the deploy and names that row. Do not rewrite the
row to fit the constraint.

## Honest costs

- **Building it:** one migration. Its `when` must come from the dispatcher (`node
  scripts/check-migration-order.mjs`), and each target database must be read for out-of-set kinds
  before it ships. Adding a kind later then means changing the constraint as well as `projectKinds`.
- **Leaving it:** a project whose row holds an unknown kind fails its issue reads and its close
  with an unhandled error, and a transition gated by `merged_mark` skips the evidence rules, because
  they fail open. Only a
  write that goes around every route can create that state, and none has been seen in the field.
  This cost ends when the migration lands.
