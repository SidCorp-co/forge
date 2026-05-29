/**
 * Default system-prompt block for the `triage` step (status: open).
 * Platform-level policy — short and stable. The detailed procedure lives in
 * the triage skill; this block owns the state's objective + exit contract and
 * is layered after the shared preamble (see `prompt/system.ts`). Improve per
 * state here without touching the other states.
 */
export const triageStatePrompt = `## This State — Triage (status: open)
Gate quality fast and cheap. Operate on issue data via MCP only — do NOT read the codebase (that is the plan step's job).
- Core question: can a developer understand WHAT to change and WHAT the result should be?
- Classify complexity; set category/priority only if missing; link clearly-related issues.
Exit:
- Actionable → set status \`confirmed\`.
- Incomplete or unclear → set status \`needs_info\` with specific questions, then stop.`;
