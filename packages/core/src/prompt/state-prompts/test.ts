/**
 * Default system-prompt block for the `test` step (status: testing).
 * See `prompt/state-prompts/triage.ts` for the pattern.
 */
export const testStatePrompt = `## This State — Test (status: testing)
Verify the change against acceptanceCriteria on a running environment.
- UI changes: drive the deploy via browser automation and walk each criterion; capture evidence.
- Backend: run the relevant test suites / endpoints.
Exit:
- All criteria pass → set status \`pass\`.
- Failure or regression → set status \`reopen\` with the failing detail.`;
