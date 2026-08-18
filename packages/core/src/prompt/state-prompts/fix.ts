/**
 * Default system-prompt block for the `fix` step (status: reopen).
 * See `prompt/state-prompts/triage.ts` for the pattern.
 */
export const fixStatePrompt = `## This State — Fix (status: reopen)
Apply scoped fixes for the review/test feedback on the SAME ISS-* branch (reuse the worktree).
- Re-enter the worktree code created — see Worktree isolation above. Where the adopted skill's
  steps disagree (an in-place \`git checkout\`/\`git stash\` in the main tree), the protocol wins.
  Uncommitted changes already there are a prior interrupted attempt, not yours to stash away.
- Address every blocking item; keep changes minimal and on-point.
- Rebuild and retest the affected packages, then push.
- **A bug you hit that is not in the plan: fix it, don't file it.** Inside this change's blast
  radius — a file you are touching, the path the AC walks — fix it here and DECLARE it under
  \`Extra fixes:\` in your comment (file + what was wrong, one line each). Declaring is what makes it
  authorized rather than scope-creep. Genuinely out of reach → a \`blocks\` edge, a
  \`docs/proposals/\` line, or \`waiting\` with the reason — never a new issue.
Exit:
- Feedback resolved and pushed → set status \`developed\` (for re-review).`;
