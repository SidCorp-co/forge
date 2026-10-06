# The pipeline-run vocabulary answers the same question in a dozen places, and the gate cannot see it

**Removed when:** `check-status-tuples.mjs` reads `PIPELINE_RUN_STATUSES` and every inline live-run
tuple is on `LIVE_PIPELINE_RUN_STATUSES`, the web-v2 copy included, which dev ISS-142 carries. The
change that lands it deletes this file.

Found by ISS-1106 criterion 13's second pass, which was closing the two holes that let
`pipeline/runs-rollup.ts` hold a second `LIVE_JOB_STATUSES`. Not fixed there: it is a widening of
the checker's *subject* rather than a gap that criterion exposed, and the collapse it lands is
a dozen call sites nobody has judged.

`scripts/check-status-tuples.mjs` reads three vocabularies, out of their machines in
`packages/contracts/src` (`VOCABULARIES`): `issue` (`issue-machine.ts:ISSUE_STATUSES`), `job`
(`job-machine.ts:JOB_STATUSES`) and `session` (`session-machine.ts:AGENT_SESSION_STATUSES`). The
pipeline-run vocabulary is not one of them: `packages/contracts/src/run-machine.ts:PIPELINE_RUN_STATUSES`,
behind `pipeline_runs.status` — `running`, `paused`, `completed`, `failed`, `cancelled`. The same
module declares `LIVE_PIPELINE_RUN_STATUSES` (`running`, `paused`) and
`TERMINAL_PIPELINE_RUN_STATUSES` (`completed`, `failed`, `cancelled`).

Two consequences:

**A tuple drawn from it is attributed to the wrong vocabulary or to none.**
`['completed', 'failed', 'cancelled']` is a subset of `AGENT_SESSION_STATUSES` as well, so the
checker can only file `TERMINAL_PIPELINE_RUN_STATUSES` under `session` or leave it unattributed,
depending on the prose near it. A session tuple with those three members would pair with it
falsely, and the pairing would read as a finding about the wrong module.

**One question has ten inline answers and one more under another name.** `['running', 'paused']`,
which `LIVE_PIPELINE_RUN_STATUSES` names, is written inline in `pipeline/deploy-confirmations.ts`
(twice), `pipeline/one-shot-reap.ts`, `pipeline/runs-control.ts`, `pipeline/runs.ts` (five times)
and `health/project-health.ts`; it is declared a second time as `LIVE_RUN_STATUSES` in
`packages/web-v2/src/features/project-dashboard/derive.ts`. That copy is the shape this whole
axis exists to refuse: a browser copy of a core answer with no marker and nothing naming the two as
one question. The same pair is also spelled as SQL text (`IN ('running', 'paused')`) in eight core
files, which the checker deliberately does not read. Counted 2026-10-06 with
`rg -U "\[\s*'running',\s*'paused',?\s*\]" packages/core/src` and the `IN (...)` form, tests excluded.

What it would take: add `run` to `VOCABULARIES` and `DISCRIMINATOR` in
`scripts/check-status-tuples.mjs`, move the inline sites onto
`LIVE_PIPELINE_RUN_STATUSES`, and have web-v2 import it from `@forge/contracts/run-machine`, which
it already imports `PIPELINE_RUN_STATUSES` from (`features/pipeline/types.ts`), rather than mark the
pair `differs`, since the two are the same answer and not a coincidence.

## Honest costs

The price of doing this, not of leaving it:

| Cost | What it takes |
|---|---|
| A dozen query predicates get re-read, not renamed | Every inline `['running', 'paused']` has to be read against what ITS query means by live. `paused` is in the set, so a site that meant `running` alone is widened by the move and the widening is silent — this is a behaviour surface in `pipeline/` and `health/`, not a spelling change. |
| A fourth vocabulary makes the gate louder before it makes it quieter | Adding `run` to `VOCABULARIES` turns the tree red at every site at once, so the checker and the collapse have to land in one change or the gate blocks every merge in between — the same rule ISS-1106 landed under. |
| Attribution stays approximate either way | `['completed', 'failed', 'cancelled']` is a subset of `AGENT_SESSION_STATUSES` as well as of `PIPELINE_RUN_STATUSES`, so the discriminator decides by nearby prose. A tuple with no `run` or `session` word near it stays unattributed and is printed rather than measured. |
| It buys nothing a reader has complained about | None of the copies has been observed disagreeing. This is drift before it rots, which is the only kind this axis can catch — and also the kind that is hardest to justify spending a round on. |
