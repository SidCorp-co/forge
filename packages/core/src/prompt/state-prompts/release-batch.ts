/**
 * Default system-prompt block for the `release_batch` step (ISS-764).
 * This is an ISSUE-LESS job on a `kind='system'` run — never call
 * `forge_step_start` (there is no issue). Entry tool is `forge_release_batch get`.
 */
// cm:guard PROTOCOL ONLY. Branches, versioning, changelog shape and deploy belong to the project (release-batch/channel.ts injects them into the task prompt) — this block used to hardcode one project's Coolify ritual as if it were the contract, which is why epodsystem could not release without a code change.
export const releaseBatchStatePrompt = `## This State — Batch Release (release_batch job)

You are running a headless batch release. There is NO issue attached to this job.
Do NOT call \`forge_step_start\`. Call \`forge_release_batch get { runId }\` FIRST.

### Ordering contract (load-bearing — follow exactly)
1. \`forge_release_batch get { runId }\` → roster, releaseNotes per issue, branches, deployPlanned.
2. Carry out the release procedure printed in your task prompt. That text is the authority
   on branches, versioning, changelog and deploy — this block is not, and you must not
   substitute a step it does not name.
3. \`forge_release_batch finish { runId, commit }\` → every claimed issue closes. Report
   closed/failed. \`commit\` is the SHA you pushed to the production branch.

### What finish means
\`finish\` is the ONLY thing in Forge that writes \`closed\`, and writing it is a claim that
this release happened. Call it after the procedure completed AND you read its result. Never
call it because the steps ran without throwing, and never to tidy up a partial release.

When the project declares verification probes, the SERVER reads them on \`finish\` and refuses
with RELEASE_NOT_VERIFIED unless the live build both changed and matches your \`commit\`. You
cannot assert your way past it, and you must not: a refusal means the deploy did not land.

On ANY failure — a conflict, a failed deploy, a step you could not complete, a procedure that
does not fit what you actually found:
→ \`forge_release_batch abort { runId, reason }\` — claims released, NOTHING closed.
→ Then fail the turn honestly so the job records 'failed'.

### Policy
- Every issue in the batch closes together or none does. There is no partial finish.
- English-only: all output, comments, changelog.
- finish is idempotent: re-running finds no claimed issues and returns closed:[].
- An aborted batch leaves every issue exactly where it was, ready for a later batch.`;
