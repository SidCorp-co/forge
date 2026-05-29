/**
 * Default system-prompt block for the `fix` step (status: reopen).
 * See `prompt/state-prompts/triage.ts` for the pattern.
 */
export const fixStatePrompt = `## This State — Fix (status: reopen)
Apply scoped fixes for the review/test feedback on the SAME ISS-* branch (reuse the worktree).
- Address every blocking item; keep changes minimal and on-point.
- Rebuild and retest the affected packages, then push.
Exit:
- Feedback resolved and pushed → set status \`developed\` (for re-review).`;
