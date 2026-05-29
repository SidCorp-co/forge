import { z } from 'zod';
import type { JobType } from '../db/schema.js';

/**
 * Step-handoff payload schema (proposal: docs/proposals/step-handoff-memory.md).
 *
 * Each pipeline state that emits a handoff (triage/plan/code/review/test/fix)
 * has a discriminator branch below. The same schema is:
 *   1. Embedded into the user prompt as prose (see `renderHandoffSchemaPrompt`)
 *      so the agent knows the exact shape to send to `forge_memory.write`.
 *   2. Used to validate the payload at the MCP boundary — if the agent emits
 *      malformed JSON, the tool returns a Zod diff so the agent can retry.
 *
 * Steps NOT in this union (clarify, release, custom, pm) do not produce a
 * structured handoff. They terminate normally without a memory write.
 */

const triageHandoff = z.object({
  step: z.literal('triage'),
  schema_version: z.literal(1),
  summary: z.string().min(1).max(2000),
  suggestedApproach: z.string().min(1).max(2000),
  complexity: z.enum(['xs', 's', 'm', 'l', 'xl']),
  risks: z.array(z.string().min(1)).max(5),
  affectedAreas: z.array(z.string().min(1)).max(10),
});

const planHandoff = z.object({
  step: z.literal('plan'),
  schema_version: z.literal(1),
  planSummary: z.string().min(1).max(2000),
  affectedFiles: z.array(z.string().min(1)).max(30),
  acceptanceChecklist: z.array(z.string().min(1)).max(15),
  unknowns: z.array(z.string().min(1)).max(10),
});

const codeHandoff = z.object({
  step: z.literal('code'),
  schema_version: z.literal(1),
  filesModified: z
    .array(
      z.object({
        path: z.string().min(1),
        op: z.enum(['create', 'edit', 'delete']),
      }),
    )
    .max(50),
  decisions: z
    .array(z.object({ what: z.string().min(1), why: z.string().min(1) }))
    .max(10),
  verificationCommands: z.array(z.string().min(1)).max(10),
  knownLimitations: z.array(z.string().min(1)).max(5),
  commitSha: z.string().optional(),
});

const reviewHandoff = z.object({
  step: z.literal('review'),
  schema_version: z.literal(1),
  verdict: z.enum(['pass', 'needs_fix', 'no_change']),
  findings: z
    .array(
      z.object({
        file: z.string().min(1),
        severity: z.enum(['blocker', 'minor']),
        note: z.string().min(1),
      }),
    )
    .max(20),
  reviewedDiffSha: z.string().min(1),
});

const testHandoff = z.object({
  step: z.literal('test'),
  schema_version: z.literal(1),
  result: z.enum(['pass', 'fail']),
  failures: z
    .array(z.object({ test: z.string().min(1), trace: z.string().max(500) }))
    .max(20),
  flakyTests: z.array(z.string().min(1)).max(10),
});

const fixHandoff = z.object({
  step: z.literal('fix'),
  schema_version: z.literal(1),
  filesModified: z
    .array(
      z.object({
        path: z.string().min(1),
        op: z.enum(['create', 'edit', 'delete']),
      }),
    )
    .max(50),
  decisions: z
    .array(z.object({ what: z.string().min(1), why: z.string().min(1) }))
    .max(10),
  reviewItemsResolved: z.array(z.string().min(1)).max(20),
  knownLimitations: z.array(z.string().min(1)).max(5),
});

export const stepHandoffSchema = z.discriminatedUnion('step', [
  triageHandoff,
  planHandoff,
  codeHandoff,
  reviewHandoff,
  testHandoff,
  fixHandoff,
]);
export type StepHandoffPayload = z.infer<typeof stepHandoffSchema>;

export const HANDOFF_STEPS = [
  'triage',
  'plan',
  'code',
  'review',
  'test',
  'fix',
] as const satisfies ReadonlyArray<JobType>;
export type HandoffStep = (typeof HANDOFF_STEPS)[number];

export function isHandoffStep(step: JobType): step is HandoffStep {
  return (HANDOFF_STEPS as readonly JobType[]).includes(step);
}

// ────────────────────────────────────────────────────────────────────
// Prompt rendering
// ────────────────────────────────────────────────────────────────────

/**
 * Render the payload schema for a given step as prose, embedded into the
 * `## Termination protocol` block of the user prompt. Output is stable per
 * step (snapshot-tested) so cache-prefix-hashing remains predictable.
 */
export function renderHandoffSchemaPrompt(step: HandoffStep): string {
  switch (step) {
    case 'triage':
      return [
        '{',
        '  "step": "triage",',
        '  "schema_version": 1,',
        '  "summary": <string, 1-2000 chars — what the issue is about>,',
        '  "suggestedApproach": <string, 1-2000 chars — how to approach it>,',
        '  "complexity": <"xs" | "s" | "m" | "l" | "xl">,',
        '  "risks": [<string>, ...]                  // max 5',
        '  "affectedAreas": [<string>, ...]          // max 10',
        '}',
      ].join('\n');
    case 'plan':
      return [
        '{',
        '  "step": "plan",',
        '  "schema_version": 1,',
        '  "planSummary": <string, 1-2000 chars>,',
        '  "affectedFiles": [<path string>, ...]     // max 30',
        '  "acceptanceChecklist": [<string>, ...]    // max 15',
        '  "unknowns": [<string>, ...]               // max 10',
        '}',
      ].join('\n');
    case 'code':
      return [
        '{',
        '  "step": "code",',
        '  "schema_version": 1,',
        '  "filesModified": [                        // max 50',
        '    { "path": <string>, "op": <"create" | "edit" | "delete"> },',
        '    ...',
        '  ],',
        '  "decisions": [                            // max 10',
        '    { "what": <string>, "why": <string> },',
        '    ...',
        '  ],',
        '  "verificationCommands": [<string>, ...]   // max 10',
        '  "knownLimitations": [<string>, ...]       // max 5',
        '  "commitSha": <string, optional>',
        '}',
      ].join('\n');
    case 'review':
      return [
        '{',
        '  "step": "review",',
        '  "schema_version": 1,',
        '  "verdict": <"pass" | "needs_fix" | "no_change">,',
        '  "findings": [                             // max 20',
        '    { "file": <string>, "severity": <"blocker" | "minor">, "note": <string> },',
        '    ...',
        '  ],',
        '  "reviewedDiffSha": <string, required>',
        '}',
      ].join('\n');
    case 'test':
      return [
        '{',
        '  "step": "test",',
        '  "schema_version": 1,',
        '  "result": <"pass" | "fail">,',
        '  "failures": [                             // max 20',
        '    { "test": <string>, "trace": <string ≤500 chars> },',
        '    ...',
        '  ],',
        '  "flakyTests": [<string>, ...]             // max 10',
        '}',
      ].join('\n');
    case 'fix':
      return [
        '{',
        '  "step": "fix",',
        '  "schema_version": 1,',
        '  "filesModified": [                        // max 50',
        '    { "path": <string>, "op": <"create" | "edit" | "delete"> },',
        '    ...',
        '  ],',
        '  "decisions": [                            // max 10',
        '    { "what": <string>, "why": <string> },',
        '    ...',
        '  ],',
        '  "reviewItemsResolved": [<string>, ...]    // max 20',
        '  "knownLimitations": [<string>, ...]       // max 5',
        '}',
      ].join('\n');
  }
}

/**
 * Scope literals that go into the termination block — the agent does NOT
 * have to guess these; the prompt embeds the exact values it should pass to
 * `forge_memory.write`.
 */
export interface HandoffScope {
  projectId: string;
  issueId: string;
  runId: string;
  attempt: number;
}

/**
 * Render the full `## Termination protocol` block to append to the user
 * prompt. Stable per (step, scope) pair so snapshot tests give meaningful
 * diffs when prompt logic evolves.
 */
export function renderTerminationBlock(opts: {
  step: HandoffStep;
  scope: HandoffScope;
}): string {
  const { step, scope } = opts;
  return [
    '## Termination protocol',
    '',
    'When you finish the work for this state, record a short structured handoff so',
    'the next step inherits your context. This is best-effort context — NOT a',
    'completion gate, so it never blocks your real work.',
    '',
    '1. Call `forge_step_handoff.write` with these scope fields (do not change them):',
    '',
    '   ```json',
    '   {',
    `     "projectId": "${scope.projectId}",`,
    `     "issueId": "${scope.issueId}",`,
    `     "pipelineRunId": "${scope.runId}",`,
    `     "step": "${step}",`,
    `     "attempt": ${scope.attempt},`,
    '     "payload": <see schema below>',
    '   }',
    '   ```',
    '',
    '2. Advance the pipeline state (MANDATORY — not best-effort). Call',
    '   `forge_issues.update` to move the issue `status` to the next state in the',
    '   Pipeline Rules ladder, even if your skill instructions did not mention a',
    '   transition. On success move forward; on a blocking problem branch to',
    '   `reopen` / `needs_info` / `on_hold` instead. An issue left in its current',
    '   status stalls the pipeline forever — never skip this step.',
    '',
    '3. Then respond with `DONE` on a new line as your final assistant text.',
    '',
    'The handoff (step 1) is best-effort context: if its payload fails validation,',
    'fix it and retry, but if you genuinely cannot produce a valid one, still do',
    'step 2 and respond `DONE`. The status advance (step 2) is never optional.',
    '',
    `Required JSON shape for the \`payload\` (step="${step}"):`,
    '',
    '```json',
    renderHandoffSchemaPrompt(step),
    '```',
    '',
    'Rules:',
    '- All fields above are REQUIRED unless marked optional.',
    '- Array fields have a max length; do not exceed it.',
    '- Enum fields must use one of the listed values exactly.',
    '- Do NOT invent fields not listed above.',
  ].join('\n');
}
