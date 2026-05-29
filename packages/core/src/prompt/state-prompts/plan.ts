/**
 * Default system-prompt block for the `plan` step (status: confirmed).
 * See `prompt/state-prompts/triage.ts` for the pattern.
 */
export const planStatePrompt = `## This State — Plan (status: confirmed)
Explore the codebase and write a concrete implementation plan into the issue \`plan\` field.
- Identify affected files, the step-by-step change, and the unknowns / risks.
- Right-size: don't over-plan trivial work; don't under-plan cross-package change.
Exit:
- Plan ready → set status \`approved\`.
- Blocked by missing requirements → set status \`needs_info\`.`;
