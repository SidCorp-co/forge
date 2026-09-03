# Session-group plumbing has no producer

ISS-897 removed `pipelineConfig.sessionGroups` and `states[x].sessionGroup` from the config
schema, the settings surface and every project row: the lane has one dispatching status, so a
group of stages sharing a Claude session describes nothing that can happen.

`jobs/stage-overrides.ts` now emits `sessionGroup: null` unconditionally. It is the only producer,
so these paths are reachable but never taken:

| File | What is now dead |
|---|---|
| `jobs/session-resume.ts` | `findPriorSessionInGroup`, `estimatePeakContextForGroup` |
| `jobs/resume-policy.ts` | the two `overrides.sessionGroup &&` branches |
| `jobs/handle-resume-failed.ts` | the whole handler — it keys on `payload.sessionGroup` |
| `jobs/agent-session-link.ts` | the `metadata.sessionGroup` propagation |
| `jobs/dispatcher.ts`, `jobs/prompt-route.ts`, `runners/adapters/claude-code.ts` | the field's transport |

**Price of leaving it.** Seven files carry a parameter nothing sets, and the next reader has to
run the same trace to learn that. `resume-policy.ts` is 317 lines and its retry-resume path — which
IS live, and serves `maxResumeTokens` / `maxResumeReopenCycles` — reads as if it had two callers.

**What ends it.** Delete the rows above, keeping retry-resume and `onResumeFail` (still reachable:
a drive job's own retry can fail to resume). It was left out of ISS-897 because that issue's
deliverable is the settings surface and the release model, and this deletion has its own blast
radius across the dispatcher.
