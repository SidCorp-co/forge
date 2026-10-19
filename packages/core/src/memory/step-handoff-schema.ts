import { z } from 'zod';
import { testResults } from '../db/schema.js';

const triageHandoff = z.object({
  step: z.literal('triage'),
  schema_version: z.literal(1),
  summary: z.string().min(1).max(2000),
  suggestedApproach: z.string().min(1).max(2000),
  complexity: z.enum(['xs', 's', 'm', 'l', 'xl']),
  risks: z.array(z.string().min(1)).max(5),
  affectedAreas: z.array(z.string().min(1)).max(10),
});

// Clarify-on-happy-path: clarify reproduces bugs / validates UX between
// triage and plan. Its handoff carries the repro evidence + root-cause
// hypothesis so plan starts from verified behavior instead of re-deriving
// the problem from the issue description.
const clarifyHandoff = z.object({
  step: z.literal('clarify'),
  schema_version: z.literal(1),
  outcome: z.enum(['reproduced', 'cannot_reproduce', 'ux_validated', 'ux_ambiguous', 'skipped']),
  // Optional: `skipped` / `cannot_reproduce` outcomes legitimately have no
  // environment to report; don't force the agent to fabricate one (would
  // bounce the handoff write on a Zod diff and burn a retry).
  environment: z.string().max(500).optional(),
  stepsVerified: z
    .array(z.object({ step: z.string().min(1), observation: z.string().min(1).max(500) }))
    .max(15),
  rootCauseHypothesis: z.string().max(2000).optional(),
  openQuestions: z.array(z.string().min(1)).max(10),
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
  decisions: z.array(z.object({ what: z.string().min(1), why: z.string().min(1) })).max(10),
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

const testHandoff = z
  .object({
    step: z.literal('test'),
    schema_version: z.literal(1),
    result: z.enum(testResults),
    resultReason: z.string().trim().min(1).max(500).optional(),
    failures: z.array(z.object({ test: z.string().min(1), trace: z.string().max(500) })).max(20),
    flakyTests: z.array(z.string().min(1)).max(10),
  })
  .refine((value) => value.result === 'pass' || value.result === 'fail' || !!value.resultReason, {
    message: 'resultReason is required when result is blocked_fixture or verified_by_test',
    path: ['resultReason'],
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
  decisions: z.array(z.object({ what: z.string().min(1), why: z.string().min(1) })).max(10),
  reviewItemsResolved: z.array(z.string().min(1)).max(20),
  knownLimitations: z.array(z.string().min(1)).max(5),
});

const driveHandoff = z.object({
  step: z.literal('drive'),
  schema_version: z.literal(1),
  outcome: z.enum(['advanced', 'parked', 'blocked', 'no_change']),
  summary: z.string().min(1).max(2000),
  workDone: z.array(z.string().min(1)).max(15),
  openQuestions: z.array(z.string().min(1)).max(10),
  commitSha: z.string().optional(),
});

export const stepHandoffSchema = z.discriminatedUnion('step', [
  triageHandoff,
  clarifyHandoff,
  planHandoff,
  codeHandoff,
  reviewHandoff,
  testHandoff,
  fixHandoff,
  driveHandoff,
]);
export type StepHandoffPayload = z.infer<typeof stepHandoffSchema>;

export const HANDOFF_STEPS = [
  'triage',
  'clarify',
  'plan',
  'code',
  'review',
  'test',
  'fix',
  'drive',
] as const;
export type HandoffStep = (typeof HANDOFF_STEPS)[number];

export function isHandoffStep(step: string): step is HandoffStep {
  return (HANDOFF_STEPS as readonly string[]).includes(step);
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
    case 'clarify':
      return [
        '{',
        '  "step": "clarify",',
        '  "schema_version": 1,',
        '  "outcome": <"reproduced" | "cannot_reproduce" | "ux_validated" | "ux_ambiguous" | "skipped">,',
        '  "environment": <string ≤500 chars, optional — URL or "local" + how you tested>,',
        '  "stepsVerified": [                        // max 15',
        '    { "step": <string>, "observation": <string ≤500 chars> },',
        '    ...',
        '  ],',
        '  "rootCauseHypothesis": <string ≤2000 chars, optional — code-level guess>,',
        '  "openQuestions": [<string>, ...]          // max 10',
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
        '  "verificationCommands": [<string>, ...]   // max 10; each must run from the repo ROOT — carry your own `cd <dir> &&` when the tool resolves config from the cwd',
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
        '  "result": <"pass" | "fail" | "blocked_fixture" | "verified_by_test">,',
        '  "resultReason": <string 1-500 chars, required for blocked_fixture / verified_by_test>,',
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
    case 'drive':
      return [
        '{',
        '  "step": "drive",',
        '  "schema_version": 1,',
        '  "outcome": <"advanced" | "parked" | "blocked" | "no_change">,',
        '  "summary": <string, 1-2000 chars \u2014 what you did this turn>,',
        '  "workDone": [<string>, ...]               // max 15',
        '  "openQuestions": [<string>, ...]          // max 10',
        '  "commitSha": <string, optional>',
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
 * The driver's termination block: the handoff it records over the CLI, and the statuses it may
 * leave the issue on. It offers neither `waiting` nor `reopen`, the two parks
 * `issues/autonomous-park.ts` rewrites.
 */
export function renderDriveTerminationBlock(scope: HandoffScope): string {
  return [
    '## Before you stop',
    '',
    'Record a handoff. Nothing dispatches after you, so this is not context for a next step —',
    'it is the summary of the turn a human reads on the issue, and the only one that outlives',
    'your session.',
    '',
    '```',
    "forge-runner api issue-step-contexts -X POST -d '{",
    `  "projectId": "${scope.projectId}",`,
    `  "issueId": "${scope.issueId}",`,
    `  "pipelineRunId": "${scope.runId}",`,
    '  "step": "drive",',
    `  "attempt": ${scope.attempt},`,
    '  "payload": <see schema below>',
    "}'",
    '```',
    '',
    'Then leave the issue on one of the statuses your skill lists, and nothing else:',
    '',
    '```',
    `forge-runner api issues/${scope.issueId} -X PATCH -d '{"status":"<status>"}'`,
    '```',
    '',
    'Required JSON shape for the `payload`:',
    '',
    '```json',
    renderHandoffSchemaPrompt('drive'),
    '```',
    '',
    'Rules:',
    '- All fields above are REQUIRED unless marked optional.',
    '- Array fields have a max length; do not exceed it.',
    '- Enum fields must use one of the listed values exactly.',
    '- Do NOT invent fields not listed above.',
  ].join('\n');
}
