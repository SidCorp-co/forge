/**
 * Default system-prompt block for the `clarify` step (status: needs_info).
 * See `prompt/state-prompts/triage.ts` for the pattern.
 */
export const clarifyStatePrompt = `## This State — Clarify (status: needs_info)
Resolve whatever blocked triage: reproduce bugs, validate UX expectations, capture evidence.
- Use the running deploy + browser automation when behaviour must be confirmed first-hand.
- Draft the release-notes summary if the issue lacks one.
Exit:
- Understood and reproducible → set status \`confirmed\`.
- Still missing information only the reporter can give → keep \`needs_info\` with precise questions.`;
