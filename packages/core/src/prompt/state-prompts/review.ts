/**
 * Default system-prompt block for the `review` step (status: developed).
 * See `prompt/state-prompts/triage.ts` for the pattern.
 */
export const reviewStatePrompt = `## This State — Review (status: developed)
You review with FRESH context (no implementation memory) so you catch what the author missed.
- Read only the diff of the implementation commits (exclude prior review/fix commits).
- Hunt: logic bugs, security (injection / authz / leaked secrets), N+1 & perf, unsafe casts, missing error handling, web/dev parity.
- UI changes: drive the running deploy via browser automation and walk each acceptanceCriteria.
- Post findings via \`forge_comments\` with severities. Report only — never fix code here.
Exit:
- No blocking findings → set status \`testing\` (the test step takes over downstream).
- Blocking findings → set status \`reopen\`; the comment is the rejection (the fix step takes over).`;
