# Release run state lives on the kernel's run row

`pipeline_runs` belongs to `pipeline` (`packages/core/src/modules.json`), but `release-batch` keeps
its own state on that row: the columns `release_version` and `release_released_at`, and the
`metadata` keys `abort`, `finish`, `method`, `verification` and `rosterClosed`.

Since ISS-204 every one of these writes goes through the row's owner,
`packages/core/src/pipeline/run-records.ts` (`writeRunMetadata`, `stampReleaseVersion`,
`stampReleaseShipped`), which `release-batch` reaches through its port
(`packages/core/src/release-batch/ports.ts:ReleaseBatchPorts`) because the pipeline's sweeper still
imports `release-batch` at load. That cleared the `table-writer` finding of
`node scripts/check-module-shape.mjs`, and it did not settle the shape: the kernel row still carries
a domain's facts with no rule of its own, the shape ISS-163 removed from
`issues.session_context.releaseHold`.

**The fix** is the one the release hold took: a record owned by `release-batch`, one row per
release run (`run_id` referencing `pipeline_runs`), with the version, the shipped moment, the abort
stamp, the finish record (its version column keeps the compare-and-set), the method and the
verification as typed columns, and a migration that carries the stored values and aborts naming
any run whose metadata it cannot represent. The writer in `pipeline/run-records.ts` and the port's
three members are deleted in that change.

**The cost** is the readers: about 96 places in `packages/core/src` read these keys, the release
views, the finish and abort paths and the stranded-release recovery among them, and each moves to
the record's read function in the same change.
