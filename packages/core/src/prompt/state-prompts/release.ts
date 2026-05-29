/**
 * Default system-prompt block for the `release` step (status: released).
 * See `prompt/state-prompts/triage.ts` for the pattern.
 */
export const releaseStatePrompt = `## This State — Release (status: released)
Merge the verified ISS-* branch to the project's target branch and finalize.
- Confirm the branch actually landed on origin BEFORE finishing.
- Add release notes / changelog if the project uses them; clean up any worktree.
Exit:
- Merged and finalized → set status \`closed\`. Leaving \`released\` stamps \`merged_at\`, which unblocks dependent issues — so don't close until the merge is real.`;
