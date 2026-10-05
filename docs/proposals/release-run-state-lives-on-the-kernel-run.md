# Release run state lives on the kernel's run row

**Removed when:** ISS-213, the open issue for the release context, lands the release-batch run
record below and deletes `pipeline/run-records.ts`'s release writers.


`pipeline_runs` belongs to `pipeline` (`packages/core/src/modules.json`), but `release-batch` keeps
its own state on that row: the columns `release_version` and `release_released_at`, and the
`metadata` keys `abort`, `finish`, `method`, `verification` and `rosterClosed`.

Since ISS-204 every one of these writes goes through the row's owner,
`packages/core/src/pipeline/run-records.ts` (`writeRunMetadata`, `stampReleaseVersion`,
`stampReleaseShipped`), which `release-batch` imports from the pipeline face (the port it went
through until the release sweep moved into `release-batch` was removed in ISS-218). That cleared the `table-writer` finding of
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

## Honest costs

- **Standing as it is costs a kernel row that carries a domain's facts.** `pipeline_runs` holds
  release columns and five metadata keys that no rule of the pipeline's own governs, so a change to
  a release fact is a change to the kernel's row, read from about 96 places.
- **The fix costs one migration and a move of every reader.** The migration has to carry each
  stored value into typed columns and abort naming any run it cannot represent, and the readers in
  the release views, the finish and abort paths and the stranded-release recovery all move in the
  same change, because a reader left on the metadata would read a value nothing writes any more.
- **The port stays until then.** `release-batch` reaches the writer through
  `ReleaseBatchPorts` only because the sweeper imports `release-batch` at load; that indirection is
  paid for as long as this proposal stands.
