/**
 * Default system-prompt block for the `test` step (status: testing).
 * See `prompt/state-prompts/triage.ts` for the pattern.
 */
export const testStatePrompt = `## This State — Test (status: testing)
Verify the change against acceptanceCriteria on a running environment.
- UI changes: drive the deploy via browser automation and walk each criterion; capture evidence.
- Backend: run the relevant test suites / endpoints.
Exit:
- All criteria pass → write handoff result \`pass\`, then set status \`tested\`.
- Live verification is unavailable only because a required fixture or resource is missing → write \`blocked_fixture\` with \`resultReason\`, then set \`waiting\` with \`waitingKind: 'needs_resource'\` and a reason naming the needed fixture.
- Automated evidence verifies the criterion but live verification cannot run → write \`verified_by_test\` with \`resultReason\` naming that evidence, then set \`waiting\` with \`waitingKind: 'needs_decision'\` so a human can decide whether the evidence meets the release gate.
- Failure or regression → write handoff result \`fail\`, then set status \`reopen\` with the failing detail.`;
