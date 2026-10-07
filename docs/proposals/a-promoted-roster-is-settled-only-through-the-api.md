# A promoted roster is settled only through the API

Found in ISS-1381 r2. When a release batch recorded a `promote` attempt and its finish could not
close an issue, that issue stays at `releasing`, still claimed, because its code may be on
production (`packages/core/src/release-batch/releasing-recovery.ts:recoverStrandedReleasing`). The
comment it gets tells a person what clears the refusal in the product, but settling the issue
afterwards — aborting the batch with `promotedRoster: return-to-gate`, then recording the release —
is `POST /api/projects/:id/release-batches/:runId/abort` and `POST /api/projects/:id/release-records`,
and no screen in `packages/web-v2` offers either. The comment says it is an operator's act.

The choice nobody has made: give the release run screen an abort with the promoted-roster choice
and a release-record form, or keep both as operator acts and say who the operator is per project.
Until one is taken, a person reading such an issue cannot finish it themselves.
