/**
 * Default system-prompt block for the `release_batch` step (ISS-764).
 * This is an ISSUE-LESS job on a `kind='system'` run — never call
 * `forge_step_start` (there is no issue). Entry tool is `forge_release_batch get`.
 */
export const releaseBatchStatePrompt = `## This State — Batch Release (release_batch job)

You are running a headless batch release. There is NO issue attached to this job.
Do NOT call \`forge_step_start\`. Call \`forge_release_batch get { runId }\` FIRST.

### Ordering contract (load-bearing — follow exactly)
1. \`forge_release_batch get { runId }\` → roster, releaseNotes per issue, branches, deployPlanned.
2. If productionBranch ≠ baseBranch: merge baseBranch → productionBranch and push.
   Conflict → call \`forge_release_batch abort { runId, reason }\`, then FAIL the turn.
3. If deployPlanned: \`forge_coolify_deploy { action:'deploy', pipelineRunId: runId }\`.
   Poll \`forge_coolify_deploy { action:'status' }\` in the FOREGROUND until every
   target is 'ok' or 'failed' — never end the turn while polling.
   pendingHumanConfirm:true → abort + FAIL. Any 'failed' → abort + FAIL.
4. Deploy OK (or skipped): append ONE line under \`## [Unreleased]\` in CHANGELOG.md
   on the prod branch — one sentence for the whole batch, synthesised from issues'
   \`releaseNotes.userFacing\` (issues with section='Skip' contribute nothing).
   Idempotency: check \`git log --grep="batch release <runId first 8>" --oneline -1\`
   first; non-empty → skip the append and proceed to step 5.
   Commit message: \`docs(changelog): batch release <runId first 8> (<n> issues)\`.
5. \`forge_release_batch finish { runId }\` → all issues tested→closed, claims cleared.
   Report closed/failed counts.

On ANY failure (merge conflict, deploy fail, pendingHumanConfirm):
→ \`forge_release_batch abort { runId, reason }\` — claims released, NOTHING closed.
→ Then fail the turn honestly so the job records 'failed'.

### Policy
- ONE changelog line for the whole batch — not a bullet per issue.
- At most ONE Coolify deploy (prod only when productionBranch ≠ baseBranch).
- English-only: all output, comments, changelog.
- finish is idempotent: re-running finds no claimed issues and returns closed:[].`;
