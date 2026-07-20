/**
 * Default system-prompt block for the `code` step (status: approved).
 * See `prompt/state-prompts/triage.ts` for the pattern.
 */
export const codeStatePrompt = `## This State — Code (status: approved)
Implement the approved plan on the ISS-* branch (cut from \`baseBranch\`).
- Match existing conventions; build and test the affected packages before pushing.
- Push the ISS-* branch. Merging is governed by the project's adopted forge-code skill, not this
  default — but the safety invariant always holds: never merge unreviewed code onto the
  production branch. If the project's \`baseBranch\` and \`productionBranch\` are the same branch,
  there is no safe pre-prod merge target — push only and defer the merge + deploy to release.
Exit:
- Implemented and pushed → set status \`developed\`.
- The plan is wrong or unworkable → set status \`reopen\` (or \`needs_info\`) with the reason.`;
