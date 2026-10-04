# Release run state lives on the kernel's run row

`pipeline_runs` belongs to `pipeline` (`packages/core/src/modules.json`), but `release-batch` keeps
its own state on that row: the columns `release_version` and `release_released_at`, and the
`metadata` keys `abort`, `finish`, `method`, `verification` and `rosterClosed`. Every one of these
is written by `release-batch`, so after ISS-163 they are the only foreign writes
`node scripts/check-module-shape.mjs` still reports under `table-writer` (9 writes in
`release-batch/abort-stamp.ts`, `finish-record.ts`, `method.ts`, `releasing-recovery.ts`,
`unverified-close.ts` and `version-store.ts`).

They are not moved behind a generic "merge run metadata" writer in `pipeline/runs.ts`: that would
clear the finding while the kernel row kept carrying a domain's facts with no rule of its own, the
shape ISS-163 removed from `issues.session_context.releaseHold`.

**The fix** is the one the release hold took: a record owned by `release-batch`, one row per
release run (`run_id` referencing `pipeline_runs`), with the version, the shipped moment, the abort
stamp, the finish record (its version column keeps the compare-and-set), the method and the
verification as typed columns, and a migration that carries the stored values and aborts naming
any run whose metadata it cannot represent.

**The cost** is the readers: about 96 places in `packages/core/src` read these keys, the release
views, the finish and abort paths and the stranded-release recovery among them, and each moves to
the record's read function in the same change.
