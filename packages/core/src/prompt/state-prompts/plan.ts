/**
 * Default system-prompt block for the `plan` step (status: clarified).
 * Runs after clarify; trust the Clarify comment/handoff (repro + root-cause)
 * over re-deriving the problem. See `prompt/state-prompts/triage.ts`.
 */
export const planStatePrompt = `## This State — Plan (status: clarified)
Explore the codebase and write a concrete implementation plan into the issue \`plan\` field.
- Read the Clarify findings first; trust its reproduction + root-cause hypothesis.
- Identify affected files, the step-by-step change, and the unknowns / risks.
- Right-size: don't over-plan trivial work; don't under-plan cross-package change.
Exit:
- Plan ready → set status \`approved\`.
- Blocked by missing requirements → set status \`needs_info\`.`;
