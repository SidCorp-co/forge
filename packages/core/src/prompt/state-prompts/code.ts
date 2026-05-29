/**
 * Default system-prompt block for the `code` step (status: approved).
 * See `prompt/state-prompts/triage.ts` for the pattern.
 */
export const codeStatePrompt = `## This State — Code (status: approved)
Implement the approved plan on the ISS-* branch (cut from \`baseBranch\`).
- Match existing conventions; build and test the affected packages before pushing.
- Push the ISS-* branch — do NOT merge here.
Exit:
- Implemented and pushed → set status \`developed\`.
- The plan is wrong or unworkable → set status \`reopen\` (or \`needs_info\`) with the reason.`;
