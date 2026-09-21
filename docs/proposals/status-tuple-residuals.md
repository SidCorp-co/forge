# The pipeline-run vocabulary answers the same question in twelve places, and the gate cannot see it

Found by ISS-1106 criterion 13's second pass, which was closing the two holes that let
`pipeline/runs-rollup.ts` hold a second `LIVE_JOB_STATUSES`. Not fixed there: it is a widening of
the checker's *subject* rather than a gap that criterion exposed, and the collapse it lands is
twelve call sites nobody has judged.

`scripts/check-status-tuples.mjs` reads three vocabularies — `issueStatuses`, `jobStatuses` and
`agentSessionStatuses`. `pipelineRunStatuses` is not one of them, and it is the vocabulary behind
`pipeline_runs.status`: `running`, `paused`, `completed`, `failed`, `cancelled`.

Two consequences, both measured on `iss-1106-c13-live-tuple` by adding the vocabulary and reading
what came back:

**A tuple drawn from it is attributed to the wrong vocabulary or to none.**
`['completed', 'failed', 'cancelled']` is a subset of `agentSessionStatuses` as well, so
`TERMINAL_PIPELINE_RUN_STATUSES` is grouped today as a *session* answer. Nothing collides with it
yet, so nothing is wrong today; a session tuple with those three members would pair with it falsely,
and the pairing would read as a finding about the wrong module.

**One question has eleven inline answers and a twelfth under a second name.** With the vocabulary
added, `['paused', 'running']` — which `issues/issue-lease.ts` already names
`LIVE_PIPELINE_RUN_STATUSES` — is written inline at `pipeline/deploy-confirmations.ts:38` and `:196`,
`pipeline/runs-control.ts:171`, `pipeline/runs.ts:78`, `:141`, `:209`, `:240`, `:267`, `:353`,
`projects/health-aggregates.ts:128` and `tests/integration/jobless-run-reap-e2e.test.ts:99`, and
declared a second time as `LIVE_RUN_STATUSES` in
`packages/web-v2/src/features/project-dashboard/derive.ts:136`. That last pair is the shape this
whole axis exists to refuse: a browser copy of a core answer with no marker, no parity test and
nothing naming the two as one question.

What it would take: add `run` to `VOCABULARIES` and `DISCRIMINATOR` in
`scripts/check-status-tuples.mjs`, move the eleven inline sites onto `LIVE_PIPELINE_RUN_STATUSES`,
and resolve the web-v2 declaration the way the other browser copies were resolved — into
`@forge/contracts/status-sets` with a row in `packages/core/src/db/status-sets-parity.test.ts`
binding it, rather than a `differs` marker, since the two are the same answer and not a coincidence.

## Honest costs

The price of doing this, not of leaving it:

| Cost | What it takes |
|---|---|
| Eleven query predicates get re-read, not renamed | Every inline `['paused', 'running']` has to be read against what ITS query means by live. `paused` is in the set, so a site that meant `running` alone is widened by the move and the widening is silent — this is a behaviour surface in `pipeline/` and `projects/`, not a spelling change. |
| A twelfth vocabulary makes the gate louder before it makes it quieter | Adding `run` to `VOCABULARIES` turns the tree red at twelve sites at once, so the checker and the collapse have to land in one change or the gate blocks every merge in between — the same rule ISS-1106 landed under. |
| A contracts export and a parity row, for the browser half | `LIVE_RUN_STATUSES` in web-v2 is a real second answer, so it moves into `@forge/contracts/status-sets` with a row in `status-sets-parity.test.ts`. That is a seventh mirror to keep, and each mirror is a thing that can be forgotten. |
| Attribution stays approximate either way | `['completed', 'failed', 'cancelled']` is a subset of `agentSessionStatuses` as well as of `pipelineRunStatuses`, so the discriminator decides by nearby prose. A tuple with no `run` or `session` word near it stays unattributed and is printed rather than measured. |
| It buys nothing a reader has complained about | None of the twelve has been observed disagreeing. This is drift before it rots, which is the only kind this axis can catch — and also the kind that is hardest to justify spending a round on. |
