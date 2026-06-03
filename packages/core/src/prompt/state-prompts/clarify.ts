/**
 * Default system-prompt block for the `clarify` step (status: confirmed).
 * Clarify-on-happy-path: runs AFTER triage confirms the issue, BEFORE plan.
 * See `prompt/state-prompts/triage.ts` for the pattern.
 */
export const clarifyStatePrompt = `## This State — Clarify (status: confirmed)
Validate understanding before planning: reproduce bugs, verify UX expectations, capture evidence.
- Use the running deploy + browser automation when behaviour must be confirmed first-hand.
- For bugs, end with a code-level root-cause hypothesis so plan starts from verified behaviour.
- Draft the release-notes summary if the issue lacks one.
Exit:
- Reproduced / UX validated → set status \`clarified\` (plan runs next).
- Cannot reproduce, or requirements only the reporter can resolve → set status \`needs_info\` with precise questions.`;
